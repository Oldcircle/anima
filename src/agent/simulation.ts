/**
 * Simulation — 多角色世界模拟引擎
 *
 * 每个 tick：衰减需求 → 并行决策所有角色（信箱驱动对话）
 */

import type { CharacterCard } from "../character/types.js";
import type { World } from "../world/world.js";
import type { EventBus } from "../core/event-bus.js";
import type { WorldEvent } from "../core/event-bus.js";
import type { GameTime } from "../core/tick-engine.js";
import type { Appointment, CharacterState } from "../world/types.js";
import { tickToGameTime } from "../core/tick-engine.js";
import type { LLMProvider } from "../providers/types.js";
import type { ActionDefinition } from "../actions/types.js";
import { RelationshipManager } from "../world/relationships.js";
import { rollWeather } from "../world/weather.js";
import { computeTemperature, isSheltered, climateNeedEffects, applyClimateMoodlet } from "../world/climate.js";
import { applyDailyUpkeep, financeMoodlet } from "../world/economy.js";
import { rollRandomEvents, type RandomEvent } from "../world/events.js";
import { processGossipSpread, type GossipItem } from "../world/gossip.js";
import { getTodayFestival, type Festival } from "../world/festivals.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { LongTermMemoryStore, formatSharedHistory } from "../memory/long-term.js";
import { runAgentTick, describeObservableAction, type AgentConfig, type AgentTickResult } from "./agent-loop.js";
import { runReflection, type ReflectionResult } from "./reflection.js";
import { ConversationTracker, buildConversationRequest } from "./conversation-mode.js";
import { extractPromise, mightContainPromise, extractTransaction, mightContainTransaction, type ExtractedTransaction } from "./promise-extractor.js";
import { ImpressionStore } from "../memory/impressions.js";
import { updateImpressionsBidirectional } from "./impression-updater.js";
import { shouldObserve, generateObservation, type ObservationResult } from "./observation-reasoning.js";
import { tickMoodlets, generateNeedMoodlets, addMoodlet } from "../world/moodlets.js";
import { APPOINTMENT_GRACE_TICKS, APPOINTMENT_EARLY_TICKS, describeAppointmentTime } from "../world/appointments.js";
import { getBreakLevel } from "./break-config.js";
import { FATE_EVENTS, FATE_INTERVAL_MIN_TICKS, FATE_INTERVAL_MAX_TICKS, pickFateEvent, applyFateGold } from "../world/fate-events.js";
import { getItemDef, resolveItem, hasItem, removeFromInventory, addToInventory } from "../world/item-registry.js";
import { generateMorningPlan } from "./morning-plan.js";
import { checkPromotion, applyPromotion, type PromotionResult } from "../world/career.js";
import { detectBehaviorPatterns } from "../world/behavior-chains.js";
import { PressureGraph, countMissedAppointmentsByPair } from "../narrative/pressure-graph.js";
import { BeatEngine, getBeatCooldownTicks, type BeatDefinition, type BeatReadyEvent } from "../narrative/beat-engine.js";
import { buildBeatContext, type BeatContextExtras } from "../narrative/expression.js";
import type { FateEvent } from "../world/fate-events.js";
import { Director, type DirectorConfig } from "../narrative/director.js";
import { observePulses } from "../narrative/pulse-store.js";

export interface SimulationConfig {
  characters: CharacterCard[];
  actions: ActionDefinition[];
  provider: LLMProvider;
  modelId: string;
}

export interface TickSummary {
  tick: number;
  gameTime: GameTime;
  results: AgentTickResult[];
  reflections?: ReflectionResult[];
  randomEvents?: Array<{ event: RandomEvent; affectedCharacters: string[] }>;
  gossips?: GossipItem[];
}

export type SimulationListener = (summary: TickSummary) => void;

export class Simulation {
  private _configs: Map<string, AgentConfig> = new Map();
  private _provider: LLMProvider;
  private _modelId: string;
  private _actions: ActionDefinition[];
  private _listeners: SimulationListener[] = [];
  private _backgroundTasks = new Set<Promise<unknown>>();
  private _lastObservationTick = new Map<string, number>();
  /** 对话冷却：pairKey → 上次深度对话结束的 tick。冷却 2 tick 后才能再次进入反应轮 */
  private _conversationCooldown = new Map<string, number>();

  world: World;
  eventBus: EventBus;
  relationships: RelationshipManager;
  memory: ShortTermMemory;
  longTerm: LongTermMemoryStore;
  conversations: ConversationTracker;
  impressions: ImpressionStore;
  /** N3：规则导演 */
  beatEngine: BeatEngine;
  /** A 件：戏剧压力图谱（确定性零 LLM 每 tick 重算；valence 环形缓冲为内存态，重启归零可容忍） */
  pressureGraph: PressureGraph = new PressureGraph();
  /** N4: LLM 导演（可选，未配置时为 undefined） */
  director?: Director;
  /** N6.4: phase-specific 工具映射 (active_phase → ActionDefinition[]) */
  phaseTools: Record<string, ActionDefinition[]> = {};
  /** 上一次扫描 beats 的 game day（避免同一天扫多次） */
  private _lastBeatScanDay = -1;
  /** 印象更新在飞标记（防同一对并发重复计分） */
  private _impressionPending = new Set<string>();
  /** valence 已计分水位：每对角色已评过态度的交换条数（防同一批台词反复计分） */
  private _valenceWatermark = new Map<string, number>();
  /** 上一次跑日节奏检查的 game day */
  private _lastPacingDay = -1;

  constructor(
    world: World,
    eventBus: EventBus,
    config: SimulationConfig,
  ) {
    this.world = world;
    this.eventBus = eventBus;
    this.relationships = new RelationshipManager();
    this.memory = new ShortTermMemory();
    this.longTerm = new LongTermMemoryStore();
    this.conversations = new ConversationTracker();
    this.impressions = new ImpressionStore();
    this.beatEngine = new BeatEngine();
    this._provider = config.provider;
    this._modelId = config.modelId;
    this._actions = config.actions;
    this.eventBus.on((event) => {
      this.recordWitnessObservations(event);
    });

    for (const card of config.characters) {
      this._configs.set(card.id, {
        card,
        actions: config.actions,
        provider: config.provider,
        modelId: config.modelId,
      });
    }

    // 自动检测同事关系：共享 workplace 的角色设为 colleague
    this._initColleagueBonds(config.characters);
  }

  /** 检测共享工作地点的角色，自动设置 colleague bond */
  private _initColleagueBonds(characters: CharacterCard[]): void {
    const workplaceMap = new Map<string, string[]>();
    for (const card of characters) {
      const wp = card.life?.workplace;
      if (wp) {
        const existing = workplaceMap.get(wp) ?? [];
        existing.push(card.id);
        workplaceMap.set(wp, existing);
      }
    }
    for (const [, ids] of workplaceMap) {
      if (ids.length >= 2) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            this.relationships.setBond(ids[i]!, ids[j]!, "colleague", 0, "同事");
          }
        }
      }
    }
  }

  onTick(listener: SimulationListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  // === 热重载 API（前端 CRUD 用） ===
  //
  // 这些方法**不**能在 runOneTick 执行期间直接调用，否则会破坏正在跑的
  // agent 决策。API 层应把变更塞进 _pendingMutations，runOneTick 会在
  // 开头一次性 drain。

  private _pendingMutations: Array<() => void> = [];

  /** 入队一个会修改世界/配置的变更，下一个 tick 开头执行。 */
  enqueueMutation(fn: () => void): void {
    this._pendingMutations.push(fn);
  }

  /** 立刻 drain 所有 pending 变更（runOneTick 内部调用）。 */
  drainMutations(): void {
    if (this._pendingMutations.length === 0) return;
    const queue = this._pendingMutations;
    this._pendingMutations = [];
    for (const fn of queue) {
      try { fn(); } catch (e) { console.error("[mutation] failed:", e); }
    }
  }

  /** 新增或更新角色卡。已存在则替换 agent 配置；新角色还会加入 world。 */
  upsertCharacter(card: CharacterCard & { disabled?: boolean }): void {
    if (card.disabled) {
      // 软停用：从 agent 配置和 world 移除，但磁盘 YAML 保留
      this._configs.delete(card.id);
      this.world.removeCharacter(card.id);
      return;
    }
    this._configs.set(card.id, {
      card,
      actions: this._actions,
      provider: this._provider,
      modelId: this._modelId,
    });
    if (!this.world.getCharacter(card.id)) {
      this.world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    } else {
      // 已存在角色：同步可能更新过的 gender / 名字
      const cs = this.world.getCharacter(card.id)!;
      cs.gender = card.gender;
      cs.name = card.name;
    }
  }

  /** 真删角色（停用 + 移除磁盘条目由 API 层负责）。 */
  removeCharacterCompletely(id: string): void {
    this._configs.delete(id);
    this.world.removeCharacter(id);
  }

  /** 获取已注册的角色 ID 列表。 */
  getCharacterIds(): string[] {
    return Array.from(this._configs.keys());
  }

  /** 获取已注册角色卡（用于前端编辑回填）。 */
  getCharacterCard(id: string): CharacterCard | undefined {
    return this._configs.get(id)?.card;
  }

  /** 替换 LLM provider，所有 agent 配置同步更新。 */
  setProvider(provider: LLMProvider, modelId: string): void {
    this._provider = provider;
    this._modelId = modelId;
    for (const [id, cfg] of this._configs) {
      this._configs.set(id, { ...cfg, provider, modelId });
    }
  }

  /** 等待所有后台印象/衍生任务完成，便于测试和日志收尾 */
  async waitForBackgroundTasks(): Promise<void> {
    while (this._backgroundTasks.size > 0) {
      const batch = Array.from(this._backgroundTasks);
      await Promise.allSettled(batch);
    }
  }

  private _trackBackgroundTask<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      this._backgroundTasks.delete(tracked);
    });
    this._backgroundTasks.add(tracked);
    return tracked;
  }

  /** 同一对角色连续对话超过此轮数时，强制冷却让他们去做别的事 */
  private static MAX_CONVERSATION_TURNS = 8;

  private _getTalkCooldownTargets(characterId: string, tick: number): string[] {
    const state = this.world.getCharacter(characterId);
    if (!state) return [];
    return this.world.getCharactersAtLocation(state.locationId)
      .filter((id) => id !== characterId)
      .filter((otherId) => {
        // 原有的短暂冷却（连续 talk 后 2 tick 内不能再 talk 同一人）
        const cooldownTick = this._conversationCooldown.get([characterId, otherId].sort().join(":"));
        if (cooldownTick !== undefined && (tick - cooldownTick) < 2) return true;
        // 对话轮数上限：同一对角色连续聊了太久，强制停下
        const history = this.conversations.getHistory(characterId, otherId);
        const recentTurns = history.filter((e) => tick - e.tick <= 10).length;
        if (recentTurns >= Simulation.MAX_CONVERSATION_TURNS) return true;
        return false;
      });
  }

  private recordWitnessObservations(event: WorldEvent): void {
    if (!isSociallyObservableEvent(event.type)) return;

    for (const witnessId of event.witnesses) {
      if (witnessId === event.targetId) continue;
      this.memory.add(witnessId, {
        tick: event.tick,
        type: "observation",
        content: `你看到${event.description}`,
        importance: event.type === "action.steal" ? 8 : 5,
        relatedCharacterId: event.actorId,
      });
    }
  }

  /** 运行单个 tick */
  async runOneTick(gameTime: GameTime): Promise<TickSummary> {
    // -1. 应用 API 层入队的角色/地点/provider 变更（保证 tick 内一致）
    this.drainMutations();

    // D2: 让 director 的 pulse store 把已过观察窗口的 pulse 自动 observe 回填
    const pulseStore = this.director?.getPulseStore();
    if (pulseStore) {
      observePulses(pulseStore, this.memory, gameTime.tick);
    }

    // 0/0b. 每日环境：天气 / 节日 / 生活开销
    this._applyDailyEnvironment(gameTime);

    // 1. 衰减需求 + Moodlet 管理
    this.world.decayNeeds();
    this.world.setTick(gameTime.tick);
    // 1.0a 压力图谱（A 件）：每 tick 重算——收边 → pair/char 压力回写 setPressure → tension 真数据
    this.pressureGraph.update({
      world: this.world,
      relationships: this.relationships,
      impressions: this.impressions,
      tick: gameTime.tick,
    });
    // 1.0b BeatEngine 扫描（N3）：每 4 tick（每游戏小时）扫一次
    // 原设计只在 22:00 扫，但有时间条件的 beat（如 hour >= 11）会被错过
    if (gameTime.tick % 4 === 0) {
      this.runBeatScan(gameTime);
    }
    // 1.0c LLM Director 日节奏检查（N4）：每天 06:00 一次
    if (gameTime.hour === 6 && gameTime.minute === 0) {
      this.runDailyPacingCheck(gameTime);
    }
    // 1.0d 约定结算：到点检查赴约/爽约，产生记忆/情绪/关系变化（在角色决策前，
    // 让"被放鸽子"的记忆和情绪能进入本 tick 的 prompt）
    this.resolveAppointments(gameTime);
    // 1.0e 晨间打算：每天 06:00 各角色给自己定今天想做的 1-3 件事（fire-and-forget）
    if (gameTime.hour === 6 && gameTime.minute === 0) {
      this.runMorningPlans(gameTime);
    }
    // 1.0f 气候压力 + moodlet 管理 + 行为链检测
    this._applyClimateAndMoodlets(gameTime);

    // 1.0g 力竭昏睡：energy 逼近 0 的角色当场撑不住睡着（needs 第一次真正咬人）
    this._applyExhaustionCollapse(gameTime);

    // 1.0g2 饿倒：hunger 逼近 0 持续挨饿 → 眼前发黑当场倒下（挨饿咬人，饭钱才有分量）
    this._applyStarvationCollapse(gameTime);

    // 1.0g3 怪病倒下的苏醒结算（kira-incident 诅咒应验的下半场）
    this._applyCursedCollapseRecovery(gameTime);

    // 1.0h argue 机械兜底：疙瘩攒够且撞见对方 → 注入"把话挑明"的 intent（决策前，进本 tick prompt）
    this._applyConfrontationFallback(gameTime);

    // 1.0i 讨债：欠了两天以上的账，债主撞见欠债人会想起来提一嘴
    this._applyDebtCollection(gameTime);

    // 1.5 随机事件
    const triggeredEvents = this._rollRandomEvents(gameTime);

    // 1.6 命运事件层：每 3-7 天一件有真实状态后果的意外（丢钱/赔钱/着凉/横财）
    const fateEvent = this._maybeRollFateEvent(gameTime);
    if (fateEvent) triggeredEvents.push(fateEvent);

    // 2. 并行决策所有未忙碌角色
    const results = await this._gatherAgentDecisions(gameTime);

    // 3. talk 产生的关系变化（共享关系）+ 记录对话（含 manner）
    this._applyTalkEffects(results, gameTime);

    // 3.5 反应轮：信箱有新消息的角色获得额外决策机会
    await this._runReactionRounds(results, gameTime);

    // 3.55 冲突当刻晋升长期记忆：吵架/偷窃被抓不该 48 小时后蒸发
    this._promoteConflictsToLongTerm(results, gameTime);

    // 3.6 互动后印象更新（fire-and-forget）+ 承诺抽取（对话结束时）+ 清理过期对话
    this._scheduleImpressionUpdates(results, gameTime);
    this._schedulePromiseExtraction(gameTime);
    this.conversations.cleanup(gameTime.tick);

    // 3.7 社会观察推理（fire-and-forget）
    this._scheduleObservations(gameTime);

    // 4. 八卦传播
    const gossips = this._processGossip(gameTime);

    // 4b. 每天 23:00 反思 + 职业晋升
    const reflections = await this._runNightlyReflection(gameTime);

    const summary: TickSummary = {
      tick: gameTime.tick, gameTime, results, reflections,
      randomEvents: triggeredEvents.length > 0 ? triggeredEvents : undefined,
      gossips: gossips.length > 0 ? gossips : undefined,
    };

    // 通知监听器
    for (const listener of this._listeners) {
      listener(summary);
    }

    return summary;
  }

  /** 0/0b. 每日环境：凌晨滚天气、早 8 点应用节日效果、早 7 点扣生活开销 */
  private _applyDailyEnvironment(gameTime: GameTime): void {
    // 0. 每天凌晨更新天气
    if (gameTime.hour === 0 && gameTime.minute === 0) {
      const newWeather = rollWeather(gameTime.season);
      this.world.setWeather(newWeather);
    }

    const festival = getTodayFestival(gameTime.season, gameTime.seasonDay);
    // 节日效果在早上 8 点应用一次
    if (festival && gameTime.hour === 8 && gameTime.minute === 0) {
      for (const c of this.world.getAllCharacters()) {
        for (const eff of festival.effects) {
          this.world.modifyNeed(c.id, eff.field, eff.delta);
        }
        this.memory.add(c.id, {
          tick: gameTime.tick,
          type: "observation",
          content: `今天是${festival.name}！${festival.description}`,
          importance: 8,
        });
      }
    }

    // 0b. 每天 07:00 扣一次生活开销（房租+杂用）——生计压力，让"赚钱活下去"有分量
    if (gameTime.hour === 7 && gameTime.minute === 0) {
      for (const c of this.world.getAllCharacters()) {
        applyDailyUpkeep(c, gameTime.tick, this.memory);
      }
    }

    // 0c. 每天 06:00 疙瘩淡化（3 游戏天没解开就自然淡了）+ 关系空窗衰减 + 店铺补货
    if (gameTime.hour === 6 && gameTime.minute === 0) {
      // kira-incident：昨夜写下的名字晨间应验（无剧本时 pending 恒空，零开销）
      this._resolveKiraStrikes(gameTime);
      for (const rel of this.relationships.getAll()) {
        if (rel.grudge && gameTime.tick - rel.grudge.sinceTick > 288) {
          this.relationships.clearGrudge(rel.characterA, rel.characterB);
        }
      }
      // 关系空窗衰减：超过 1 游戏天（96 tick）无任何互动的对，每天向 0 回落 1.5。
      // 与 talk 递减收益 + per-tick 去重合起来打破 valence 正向通胀——关系要维护，不是只涨不跌。
      this.relationships.applyIdleDecay(gameTime.tick, 96, 1.5);
      // 店铺每日补货：有员工工具的店 + 任何已开始追踪库存的店（prepare 会让无 workerTools 的店
      // 进入追踪——不补货就会毒化成永久缺货）。补足到 2 而非覆盖写 2：员工备到 8 的货不隔夜蒸发。
      for (const loc of this.world.getAllLocations()) {
        const tracked = loc.stock !== undefined;
        const hasWorkers = !!(loc.workerTools && loc.workerTools.length > 0);
        if (loc.shop && loc.shop.length > 0 && (hasWorkers || tracked)) {
          loc.stock = loc.stock ?? {};
          for (const item of loc.shop) {
            loc.stock[item.id] = Math.max(loc.stock[item.id] ?? 0, 2);
          }
        }
      }
      // 食物腐坏：鲜货过了保质期就馊了，只能扔——囤不了，得吃新鲜的
      this._sweepSpoiledFood(gameTime);
      // 店铺拉黑到期解禁（顺手清掉过期条目，别让名单越攒越长）
      for (const loc of this.world.getAllLocations()) {
        if (!loc.bans) continue;
        for (const [cid, until] of Object.entries(loc.bans)) {
          if (gameTime.tick >= until) delete loc.bans[cid];
        }
      }
    }
  }

  /** 每天 06:00 清一次馊掉的鲜货（ItemDef.perishTicks + 实例 obtainedTick 判定） */
  private _sweepSpoiledFood(gameTime: GameTime): void {
    for (const c of this.world.getAllCharacters()) {
      const spoiled: string[] = [];
      c.inventory = (c.inventory ?? []).filter((item) => {
        const def = getItemDef(item.defId);
        if (!def?.perishTicks || item.obtainedTick === undefined) return true;
        if (gameTime.tick - item.obtainedTick <= def.perishTicks) return true;
        spoiled.push(item.quantity > 1 ? `${def.name}×${item.quantity}` : def.name);
        return false;
      });
      if (spoiled.length > 0) {
        this.memory.add(c.id, {
          tick: gameTime.tick, type: "event",
          content: `早上翻出背包里的${spoiled.join("、")}，已经放馊了，捏着鼻子扔了——早知道就趁新鲜吃掉`,
          importance: 4,
        });
        console.log(`🦠 [馊了] ${c.name}: ${spoiled.join("、")}`);
      }
    }
  }

  /** 1.0f 气候压力（露天暴露耗 needs + moodlet）+ moodlet 生命周期 + 行为链后果涟漪 */
  private _applyClimateAndMoodlets(gameTime: GameTime): void {
    const climateTemp = computeTemperature(gameTime.season, this.world.weather, gameTime.hour);
    for (const c of this.world.getAllCharacters()) {
      tickMoodlets(c, gameTime.tick);
      generateNeedMoodlets(c, gameTime.tick);
      financeMoodlet(c, gameTime.tick);
      const sheltered = isSheltered(this.world.getLocation(c.locationId));
      const climateEff = climateNeedEffects(climateTemp, this.world.weather, sheltered);
      for (const [field, delta] of Object.entries(climateEff)) {
        this.world.modifyNeed(c.id, field, delta);
      }
      applyClimateMoodlet(c, climateTemp, this.world.weather, sheltered, gameTime.tick);
      // 生病拖着不治是有代价的：着凉/生病 moodlet 存续期每 tick 额外耗精力
      // （买药一吃就好——take_medicine；不治就虚上一整段）
      if (c.moodlets.some((m) => m.reason.includes("着凉"))) {
        this.world.modifyNeed(c.id, "energy", -1);
      }
      // 怪病（kira-incident）：比着凉更重且吃药无效（take_medicine 只认着凉）
      if (c.moodlets.some((m) => m.reason.includes("怪病"))) {
        this.world.modifyNeed(c.id, "energy", -1);
      }
      // 行为链检测 → 后果涟漪
      const chainMoodlets = detectBehaviorPatterns(c, gameTime.tick);
      for (const m of chainMoodlets) {
        addMoodlet(c, m.emotion, m.intensity, m.reason, m.expiresAtTick - gameTime.tick, m.source, gameTime.tick);
      }
    }
  }

  /** 1.5 随机事件：按时段/季节/天气掷事件，施加 needs 影响 + 写观察记忆 */
  private _rollRandomEvents(gameTime: GameTime): Array<{ event: RandomEvent; affectedCharacters: string[] }> {
    const triggeredEvents: Array<{ event: RandomEvent; affectedCharacters: string[] }> = [];
    const randomEvents = rollRandomEvents({
      hour: gameTime.hour,
      season: gameTime.season,
      weather: this.world.weather,
    });
    for (const event of randomEvents) {
      const allChars = this.world.getAllCharacters();
      // 随机选一个角色作为事件主角
      const target = allChars[Math.floor(Math.random() * allChars.length)];
      if (!target) continue;

      const affected: string[] = [];
      if (event.scope === "location") {
        const charsAtLoc = this.world.getCharactersAtLocation(target.locationId);
        for (const cid of charsAtLoc) {
          for (const eff of event.effects) {
            this.world.modifyNeed(cid, eff.field, eff.delta);
          }
          affected.push(cid);
          const desc = event.template.replace("{character}", target.name);
          this.memory.add(cid, { tick: gameTime.tick, type: "observation", content: desc, importance: 5 });
        }
      } else {
        for (const eff of event.effects) {
          this.world.modifyNeed(target.id, eff.field, eff.delta);
        }
        affected.push(target.id);
        const desc = event.template.replace("{character}", target.name);
        this.memory.add(target.id, { tick: gameTime.tick, type: "observation", content: desc, importance: 5 });
      }
      triggeredEvents.push({ event, affectedCharacters: affected });
    }
    return triggeredEvents;
  }

  /** 下一件命运事件的到期 tick（瞬态不入档：读档后重新起算一个 3-7 天窗口，无伤大雅） */
  private _nextFateAt: number | undefined;

  /**
   * 1.6 命运事件层：随机事件管"流浪猫"级微扰，这里管**每 3-7 天一件、有真实状态后果的意外**。
   * 只造处境不写结果：事件把角色推进要应对的局面，怎么应对由角色自己决定。
   * 白天（8-21 点）才落地（夜里顺延），落在醒着的角色头上；off 档不启用（治愈系基线）。
   */
  private _maybeRollFateEvent(gameTime: GameTime): { event: RandomEvent; affectedCharacters: string[] } | undefined {
    if (getBreakLevel() === "off") return undefined;
    if (this._nextFateAt === undefined) {
      this._nextFateAt = gameTime.tick + FATE_INTERVAL_MIN_TICKS +
        Math.floor(Math.random() * (FATE_INTERVAL_MAX_TICKS - FATE_INTERVAL_MIN_TICKS));
      return undefined;
    }
    if (gameTime.tick < this._nextFateAt) return undefined;
    if (gameTime.hour < 8 || gameTime.hour >= 21) return undefined; // 顺延到白天

    // 随机挑一个醒着的角色
    const awake = this.world.getAllCharacters().filter((s) => {
      const a = s.currentAction?.name;
      return a !== "sleep" && a !== "nap" && a !== "collapse_asleep" && a !== "collapse_starving" && a !== "collapse_cursed";
    });
    const target = awake[Math.floor(Math.random() * awake.length)];
    if (!target) return undefined;

    const loc = this.world.getLocation(target.locationId);
    const event = pickFateEvent(FATE_EVENTS, {
      weather: this.world.weather,
      season: gameTime.season,
      locationType: loc?.type,
      gold: target.gold,
    });
    if (!event) return undefined; // 此情此景无事可落，下 tick 再试
    this._nextFateAt = gameTime.tick + FATE_INTERVAL_MIN_TICKS +
      Math.floor(Math.random() * (FATE_INTERVAL_MAX_TICKS - FATE_INTERVAL_MIN_TICKS));

    // ── 结算真实状态后果（与 beat auto_events 共用的 fate 包装应用路径）──
    const { goldChange, affected } = this._applyFateOutcome(target, event, gameTime.tick);
    console.log(`🎲 [命运] ${event.name} → ${target.name}${goldChange !== 0 ? ` (金币 ${goldChange > 0 ? "+" : ""}${goldChange})` : ""}`);

    // 走 randomEvents 通道下发前端（effects 已在上面结算，这里只带展示字段）
    return {
      event: {
        id: event.id, name: event.name, description: event.name,
        template: event.template, effects: [], scope: "self", probability: 0,
      },
      affectedCharacters: affected,
    };
  }

  /**
   * fate 包装的统一结算路径：金币/需求/moodlet/intent/记忆+LTM/目击。
   * 被两条通路共用：随机命运层 _maybeRollFateEvent + beat auto_events（B4）。
   * 红线：只造处境不写结果——落的是状态与注意力，怎么应对归角色。
   */
  private _applyFateOutcome(
    target: CharacterState,
    event: FateEvent,
    tick: number,
  ): { goldChange: number; affected: string[]; description: string } {
    let goldChange = 0;
    if (event.goldDelta) goldChange = applyFateGold(target, event.goldDelta);
    for (const eff of event.needEffects ?? []) {
      this.world.modifyNeed(target.id, eff.field, eff.delta);
    }
    if (event.moodlet) {
      addMoodlet(target, event.moodlet.emotion, event.moodlet.intensity,
        event.moodlet.reason, event.moodlet.durationTicks, "event", tick);
    }
    if (event.intentSummary) {
      this.world.setIntent(target.id, {
        kind: "recover", source: "action",
        summary: event.intentSummary,
        createdTick: tick, expiresAt: tick + 12,
      });
    }
    const desc = event.template.replace("{character}", target.name) +
      (goldChange !== 0 ? `（${goldChange > 0 ? "+" : ""}${goldChange} 金币）` : "");
    this.memory.add(target.id, { tick, type: "event", content: desc, importance: event.importance });
    this.longTerm.add(target.id, { tick, type: "event", importance: event.importance, content: desc });

    const affected = [target.id];
    if (event.witnessTemplate) {
      const witnessDesc = event.witnessTemplate.replace("{character}", target.name);
      for (const otherId of this.world.getCharactersAtLocation(target.locationId)) {
        if (otherId === target.id) continue;
        this.memory.add(otherId, {
          tick, type: "observation", content: witnessDesc,
          importance: 6, relatedCharacterId: target.id,
        });
        affected.push(otherId);
      }
    }
    return { goldChange, affected, description: desc };
  }

  /** 2. 并行决策所有未忙碌角色（活跃对话中的角色走 conversation 模式请求） */
  private async _gatherAgentDecisions(gameTime: GameTime): Promise<AgentTickResult[]> {
    const promises: Promise<AgentTickResult>[] = [];

    for (const [id, config] of this._configs) {
      const state = this.world.getCharacter(id);
      if (!state) continue;

      // Bug #3 修复：主循环也检测对话活跃，活跃时用 conversation mode
      // 这能让角色在主决策点也能看到完整对话历史 + "不要重复"指令
      let conversationRequest: import("../providers/types.js").LLMRequest | undefined;
      const activePartnerId = this._findActiveConversationPartner(id, gameTime.tick);
      if (activePartnerId) {
        const partnerConfig = this._configs.get(activePartnerId);
        const partnerState = this.world.getCharacter(activePartnerId);
        if (partnerConfig && partnerState) {
          const location = this.world.getLocation(state.locationId);
          const rel = this.relationships.get(id, activePartnerId);
          const recentMemoriesText = this.memory.formatForPrompt(id, 12, gameTime.tick);
          const impressionText = this.impressions.formatForPrompt(id, activePartnerId);
          const wpId = state.life?.workplace ?? config.card.life?.workplace;
          const wpName = wpId ? this.world.getLocation(wpId)?.name : undefined;
          conversationRequest = buildConversationRequest({
            card: config.card,
            state,
            partnerCard: partnerConfig.card,
            partnerState,
            history: this.conversations.getHistory(id, activePartnerId),
            gameTime,
            locationName: location?.name ?? state.locationId,
            atmosphere: location?.atmosphere,
            weather: this.world.weather,
            relationship: rel,
            impressionText,
            recentMemories: recentMemoriesText,
            actions: this._actions,
            workplaceName: wpName,
            colleagueNames: this.relationships.getRelationshipsOf(id)
              .filter((r) => r.relationship.bond === "colleague")
              .map((r) => this.world.getCharacter(r.otherId)?.name)
              .filter((n): n is string => !!n),
            wantToDiscuss: this.world.getWantToDiscuss(id, gameTime.tick, activePartnerId),
            sharedHistory: this._sharedHistoryFor(id, activePartnerId, gameTime.tick),
          });
        }
      }

      promises.push(runAgentTick({
        config,
        world: this.world,
        eventBus: this.eventBus,
        gameTime,
        talkCooldownTargets: this._getTalkCooldownTargets(id, gameTime.tick),
        relationships: this.relationships,
        memory: this.memory,
        impressions: this.impressions,
        phaseTools: this._getActivePhaseTools(),
        conversationRequest,
      }));
    }

    return await Promise.all(promises);
  }

  /** 3. talk 产生的关系变化（共享关系）+ 记录对话（含 manner）+ social moodlet */
  private _applyTalkEffects(results: AgentTickResult[], gameTime: GameTime): void {
    for (const r of results) {
      if (r.action?.name === "talk" && r.action.args.target && r.result?.success !== false) {
        const targetId = this._resolveCharacterId(r.action.args.target as string);
        // talk 推动关系：按水位递减 + 每对每 tick 只计一次（防反应轮级联棘轮），
        // 疙瘩期冻结加分——全部收敛进 registerTalk（尬聊不等于和好，和好走道歉/安慰/送礼）
        this.relationships.registerTalk(r.characterId, targetId, gameTime.tick);
        const charState = this.world.getCharacter(r.characterId);
        this.conversations.recordTalk(
          r.characterId,
          charState?.name ?? r.characterId,
          targetId,
          r.action.args.message as string ?? "",
          gameTime.tick,
          r.action.args.manner as string | undefined,
        );
        // 对话产生 happy moodlet
        if (charState) {
          addMoodlet(charState, "happy", 2, "和人聊了天", 8, "social", gameTime.tick);
        }
        const targetState = this.world.getCharacter(targetId);
        if (targetState) {
          addMoodlet(targetState, "happy", 1, "有人找我说话", 8, "social", gameTime.tick);
        }
      }
    }
  }

  /**
   * 1.0g 力竭昏睡：energy ≤ 3 的角色当场撑不住睡着——needs 归零第一次有机制后果。
   * 此前 energy 0 和满值的行为空间几乎一样（4/7 角色精力 0 还在完整敬语寒暄）。
   * 昏睡 8 tick（2 游戏小时），期间每 tick 恢复少量精力；在公共场合睡着会被人看见、留下记忆。
   */
  private _applyExhaustionCollapse(gameTime: GameTime): void {
    for (const state of this.world.getAllCharacters()) {
      // 昏睡中：每 tick 恢复一点精力（按时长摊销，不是一次性满电）
      if (state.currentAction?.name === "collapse_asleep") {
        this.world.modifyNeed(state.id, "energy", 9);
        continue;
      }
      const energy = state.needs.energy ?? 100;
      if (energy > 3) continue;
      if (state.currentAction?.name === "sleep" || state.currentAction?.name === "nap") continue;
      if (state.currentAction?.name === "collapse_starving") continue; // 饿倒优先，不叠加覆盖
      if (state.currentAction?.name === "collapse_cursed") continue; // 怪病倒下同理

      state.currentAction = { name: "collapse_asleep", remainingTicks: 8 };
      const loc = this.world.getLocation(state.locationId);
      const isPublic = loc?.type !== "residential";
      this.memory.add(state.id, {
        tick: gameTime.tick, type: "event",
        content: isPublic ? `你累得当场撑不住，在${loc?.name ?? "外面"}睡着了` : "你累得撑不住，倒头就睡着了",
        importance: 8,
      });
      this.longTerm.add(state.id, {
        tick: gameTime.tick, type: "event", importance: 8,
        content: isPublic ? `你在${loc?.name ?? "外面"}当众累晕睡着（那天真的透支了）` : "你累到直接晕睡过去",
      });
      if (isPublic) {
        addMoodlet(state, "embarrassed", 3, "在外面当众睡着了", 16, "need", gameTime.tick);
        this.world.setObservableState(state.id, {
          actionName: "collapse_asleep",
          source: "action",
          summary: "撑不住趴在那里睡着了，怎么都叫不太醒。",
          createdTick: gameTime.tick,
          expiresAt: gameTime.tick + 8,
        });
        // 在场者亲眼看见（进各自记忆——可谈论、可传八卦）
        for (const otherId of this.world.getCharactersAtLocation(state.locationId)) {
          if (otherId === state.id) continue;
          this.memory.add(otherId, {
            tick: gameTime.tick, type: "observation",
            content: `${state.name}累得当场睡着了，就趴在${loc?.name ?? "那里"}`,
            importance: 6,
            relatedCharacterId: state.id,
          });
        }
      }
      console.log(`😵 [力竭] ${state.name} 在 ${loc?.name ?? state.locationId} 撑不住睡着了 (energy=${energy})`);
    }
  }

  /**
   * kira-incident 诅咒应验：每天 06:00 把昨夜 pending 的名字兑现成「怪病倒下」。
   * 非致死移植（PLAN-kira.md）：倒下 8 tick 叫不醒 + 怪病 moodlet 2 天（每 tick 掉精力、
   * 吃药无效）+ 本人/目击者/全镇三层记忆——只造事实，怎么解读（撞邪/天罚/有人动手）归角色。
   * 引擎侧不点名任何调查者：侦探线靠剧本 seeds + 角色卡自己咬钩（七反转⑦）。
   */
  private _resolveKiraStrikes(gameTime: GameTime): void {
    if (this.world.kira.pending.length === 0) return;
    const due = this.world.kira.pending.splice(0);
    for (const strike of due) {
      const victim = this.world.getCharacter(strike.target);
      if (!victim) continue;
      if (victim.currentAction?.name === "collapse_cursed") continue; // 不叠加
      victim.currentAction = { name: "collapse_cursed", remainingTicks: 8 };
      addMoodlet(victim, "anxious", 5, "怪病：夜里心口像被一只手攥住过，浑身没力气", 192, "need", gameTime.tick);
      this.world.kira.total += 1;
      this.world.kira.victims.push(victim.id);
      const nth = this.world.kira.total;
      this.memory.add(victim.id, {
        tick: gameTime.tick, type: "event",
        content: "天蒙蒙亮的时候，心口像被一只看不见的手攥住——你眼前一黑倒了下去，怎么也爬不起来。这不是累，也不像任何你得过的病",
        importance: 9,
      });
      this.longTerm.add(victim.id, {
        tick: gameTime.tick, type: "event", importance: 9,
        content: "得过一场来路不明的怪病：毫无征兆在清晨倒下，人事不省了两个钟头",
      });
      const loc = this.world.getLocation(victim.locationId);
      for (const otherId of loc?.presentCharacters ?? []) {
        if (otherId === victim.id) continue;
        this.memory.add(otherId, {
          tick: gameTime.tick, type: "event",
          content: `你亲眼看见${victim.name}毫无征兆地倒了下去，脸色白得吓人，怎么叫都叫不醒`,
          importance: 8, relatedCharacterId: victim.id,
        });
      }
      // 全镇风声（不在场者）：只给事实不给解读；第 2 例起把"和上一个一样"的模式摆上桌
      for (const c of this.world.getAllCharacters()) {
        if (c.id === victim.id) continue;
        if ((loc?.presentCharacters ?? []).includes(c.id)) continue;
        this.memory.add(c.id, {
          tick: gameTime.tick, type: "event",
          content: nth === 1
            ? `镇上传开了：${victim.name}清早莫名其妙倒下了，人事不省——谁也说不出是什么病`
            : `${victim.name}也倒下了，和之前倒下的人一模一样：清早、毫无征兆、叫不醒。这已经是第 ${nth} 个了`,
          importance: nth >= 2 ? 8 : 6, relatedCharacterId: victim.id,
        });
      }
      console.log(`📓 [kira] 应验：${victim.id} 怪病倒下（第 ${nth} 例）${strike.judgment ? `｜册上小字："${strike.judgment.slice(0, 40)}"` : ""}`);
    }
  }

  /** 怪病倒下的苏醒结算：最后一 tick 勉强缓过来，带后怕 + "这病不对劲"的念头。 */
  private _applyCursedCollapseRecovery(gameTime: GameTime): void {
    for (const state of this.world.getAllCharacters()) {
      if (state.currentAction?.name !== "collapse_cursed") continue;
      if (state.currentAction.remainingTicks === 1) {
        addMoodlet(state, "anxious", 4, "怪病过后浑身发虚——这病来得太不对劲了", 48, "need", gameTime.tick);
        this.world.setIntent(state.id, {
          kind: "recover", source: "action",
          summary: "今天清早莫名其妙倒下了，人事不省两个钟头——这不是普通的病。得跟人说说，或者弄明白到底怎么回事。",
          createdTick: gameTime.tick, expiresAt: gameTime.tick + 8,
        });
      }
    }
  }

  /** 饿倒的持续饥饿水位（characterId → 开始挨饿的 tick），瞬态不入档 */
  private _starvingSince = new Map<string, number>();

  /**
   * 1.0g2 饿倒：hunger ≤ 2 持续 8 tick（2 游戏小时）→ 饿得眼前发黑当场倒下。
   * 7 天基线终局全员 hunger=0 却谈笑风生——挨饿必须咬人，饭钱才有分量（与经济调参配套）。
   * 倒下 6 tick 叫不醒；结束时勉强缓过来（+15 hunger，灌了点水不是吃饱）带虚弱 moodlet +
   * "必须马上弄吃的" intent（beg/steal/cook 的浮现供给都在，绝境行为有出口）；
   * 公共场合被目击进他人记忆，可谈论可传八卦。
   */
  private _applyStarvationCollapse(gameTime: GameTime): void {
    for (const state of this.world.getAllCharacters()) {
      // 饿倒中：最后一 tick 勉强缓过来（只在 remainingTicks===1 时结算一次）
      if (state.currentAction?.name === "collapse_starving") {
        if (state.currentAction.remainingTicks === 1) {
          this.world.modifyNeed(state.id, "hunger", 15);
          addMoodlet(state, "anxious", 4, "刚饿倒过一次，浑身发虚", 24, "need", gameTime.tick);
          this.world.setIntent(state.id, {
            kind: "recover",
            source: "action",
            summary: "刚刚饿晕倒过——必须马上弄到吃的，什么办法都行。",
            createdTick: gameTime.tick,
            expiresAt: gameTime.tick + 8,
          });
        }
        continue;
      }
      const hunger = state.needs.hunger ?? 100;
      if (hunger > 2) {
        this._starvingSince.delete(state.id);
        continue;
      }
      // 睡着/昏睡不触发（醒着挨饿才算数，也避免和力竭昏睡叠加）
      const acting = state.currentAction?.name;
      if (acting === "sleep" || acting === "nap" || acting === "collapse_asleep") continue;
      const since = this._starvingSince.get(state.id);
      if (since === undefined) {
        this._starvingSince.set(state.id, gameTime.tick);
        continue;
      }
      if (gameTime.tick - since < 8) continue;

      this._starvingSince.delete(state.id);
      state.currentAction = { name: "collapse_starving", remainingTicks: 6 };
      const loc = this.world.getLocation(state.locationId);
      const isPublic = loc?.type !== "residential";
      this.memory.add(state.id, {
        tick: gameTime.tick, type: "event",
        content: isPublic
          ? `你饿得眼前发黑，在${loc?.name ?? "外面"}直接倒下了`
          : "你饿得眼前发黑，倒在了家里",
        importance: 9,
      });
      this.longTerm.add(state.id, {
        tick: gameTime.tick, type: "event", importance: 9,
        content: isPublic
          ? `你在${loc?.name ?? "外面"}饿晕倒下（那几天真的揭不开锅）`
          : "你饿晕倒在家里（那几天真的揭不开锅）",
      });
      if (isPublic) {
        this.world.setObservableState(state.id, {
          actionName: "collapse_starving",
          source: "action",
          summary: "脸色煞白地倒在那里，看样子是饿的。",
          createdTick: gameTime.tick,
          expiresAt: gameTime.tick + 6,
        });
        for (const otherId of this.world.getCharactersAtLocation(state.locationId)) {
          if (otherId === state.id) continue;
          this.memory.add(otherId, {
            tick: gameTime.tick, type: "observation",
            content: `${state.name}饿晕倒在${loc?.name ?? "那里"}，脸色煞白——看着让人心里一沉`,
            importance: 7,
            relatedCharacterId: state.id,
          });
        }
      }
      console.log(`🥀 [饿倒] ${state.name} 在 ${loc?.name ?? state.locationId} 饿晕了 (hunger=${hunger})`);
    }
  }

  /**
   * 3.55 冲突当刻晋升长期记忆：argue / steal 被抓这类"有重量的事"直接写入 LTM（双方视角），
   * 之后对话时会作为"你们之间实际发生过的"注入——上周的架不会像没吵过一样。
   */
  private _promoteConflictsToLongTerm(results: AgentTickResult[], gameTime: GameTime): void {
    for (const r of results) {
      if (r.result?.success === false || !r.action) continue;
      const targetRaw = r.action.args.target as string | undefined;

      // 记录机制层真实转移的时刻（口头交易落账的防重复结算依据）
      if (targetRaw && ["give", "repay_debt", "borrow_money"].includes(r.action.name)) {
        const tid = this._resolveCharacterId(targetRaw);
        this._pairTransferTick.set([r.characterId, tid].sort().join(":"), gameTime.tick);
      }

      if (r.action.name === "argue" && targetRaw) {
        const targetId = this._resolveCharacterId(targetRaw);
        const actorName = this.world.getCharacter(r.characterId)?.name ?? r.characterId;
        const targetName = this.world.getCharacter(targetId)?.name ?? targetId;
        const reason = (r.action.args.reason as string | undefined) ?? "";
        this.longTerm.add(r.characterId, {
          tick: gameTime.tick, type: "event", importance: 8,
          content: `你和${targetName}大吵了一架${reason ? `（${reason}）` : ""}`,
          relatedCharacterId: targetId,
        });
        this.longTerm.add(targetId, {
          tick: gameTime.tick, type: "event", importance: 8,
          content: `${actorName}当面冲你发了火${reason ? `（${reason}）` : ""}`,
          relatedCharacterId: r.characterId,
        });
        // 结下疙瘩：吵完不是下一 tick 就忘
        this.relationships.setGrudge(r.characterId, targetId, reason || "那次不欢而散", r.characterId, gameTime.tick);
      }

      // 疙瘩的解开：道歉性的 talk / comfort / give 都算把话说开了
      if (targetRaw && ["talk", "comfort", "give"].includes(r.action.name)) {
        const targetId = this._resolveCharacterId(targetRaw);
        const rel = this.relationships.get(r.characterId, targetId);
        if (rel.grudge && gameTime.tick - rel.grudge.sinceTick >= 2) {
          const message = (r.action.args.message as string | undefined) ?? (r.action.args.words as string | undefined) ?? "";
          // 道歉性 talk 只认肇事方（受害者的习惯性"对不起"不构成和解——真嗣的口癖不该替对方免责）；
          // comfort/give 是主动示好动作，哪边做都算递了台阶
          const isInstigator = rel.grudge.instigatorId === r.characterId;
          const isApology = r.action.name !== "talk"
            ? true
            : isInstigator && /对不起|抱歉|是我不对|我道歉|别生气|不该那样/.test(message);
          if (isApology) {
            this.relationships.clearGrudge(r.characterId, targetId);
            this.relationships.modify(r.characterId, targetId, 3, gameTime.tick, "把话说开了");
            const actorName = this.world.getCharacter(r.characterId)?.name ?? r.characterId;
            const targetName = this.world.getCharacter(targetId)?.name ?? targetId;
            for (const [meId, text] of [
              [r.characterId, `你主动跟${targetName}把之前的疙瘩说开了`],
              [targetId, `${actorName}主动来把之前的疙瘩说开了`],
            ] as const) {
              this.memory.add(meId, { tick: gameTime.tick, type: "event", content: text, importance: 7, relatedCharacterId: meId === r.characterId ? targetId : r.characterId });
              this.longTerm.add(meId, { tick: gameTime.tick, type: "event", content: text, importance: 7, relatedCharacterId: meId === r.characterId ? targetId : r.characterId });
            }
            console.log(`🕊️ [和解] ${r.characterId} ↔ ${targetId}（${r.action.name}）`);
          }
        }
      }

      // 借钱：人情账要双方都记住、且活得比 48 小时长（欠着的钱是关系里的一根刺/一份情）
      const borrowOutcome = (r.result as any)?._borrowOutcome as { lenderId: string; amount: number; granted: boolean } | undefined;
      if (r.action.name === "borrow_money" && borrowOutcome) {
        const borrowerName = this.world.getCharacter(r.characterId)?.name ?? r.characterId;
        const lenderName = this.world.getCharacter(borrowOutcome.lenderId)?.name ?? borrowOutcome.lenderId;
        if (borrowOutcome.granted) {
          this.memory.add(borrowOutcome.lenderId, {
            tick: gameTime.tick, type: "event",
            content: `${borrowerName}拉下脸跟你开口借钱，你借了${borrowOutcome.amount}金币——看得出他是真的难`,
            importance: 7, relatedCharacterId: r.characterId,
          });
          this.longTerm.add(r.characterId, {
            tick: gameTime.tick, type: "event", importance: 8,
            content: `你欠着${lenderName}的${borrowOutcome.amount}金币（难处时人家伸了手，哪天手头松了得还上）`,
            relatedCharacterId: borrowOutcome.lenderId,
          });
          this.longTerm.add(borrowOutcome.lenderId, {
            tick: gameTime.tick, type: "event", importance: 7,
            content: `${borrowerName}难处时找你借了${borrowOutcome.amount}金币，还欠着`,
            relatedCharacterId: r.characterId,
          });
          console.log(`🤝 [借钱] ${borrowOutcome.lenderId} → ${r.characterId}: ${borrowOutcome.amount} 金币`);
        } else {
          this.memory.add(borrowOutcome.lenderId, {
            tick: gameTime.tick, type: "event",
            content: `${borrowerName}跟你开口借钱，你没借——心里多少有点过意不去`,
            importance: 6, relatedCharacterId: r.characterId,
          });
        }
      }

      // 还钱：销账进双方 LTM——"他守信"和"我不欠人"都值得被长久记住
      const repayOutcome = (r.result as any)?._repayOutcome as { lenderId: string; amount: number } | undefined;
      if (r.action.name === "repay_debt" && repayOutcome) {
        const borrowerName = this.world.getCharacter(r.characterId)?.name ?? r.characterId;
        const lenderName = this.world.getCharacter(repayOutcome.lenderId)?.name ?? repayOutcome.lenderId;
        this.memory.add(repayOutcome.lenderId, {
          tick: gameTime.tick, type: "event",
          content: `${borrowerName}把欠你的${repayOutcome.amount}金币当面还上了`,
          importance: 7, relatedCharacterId: r.characterId,
        });
        this.longTerm.add(r.characterId, {
          tick: gameTime.tick, type: "event", importance: 7,
          content: `你把欠${lenderName}的${repayOutcome.amount}金币还清了，不欠人了`,
          relatedCharacterId: repayOutcome.lenderId,
        });
        this.longTerm.add(repayOutcome.lenderId, {
          tick: gameTime.tick, type: "event", importance: 7,
          content: `${borrowerName}把欠的${repayOutcome.amount}金币还了——这人守信`,
          relatedCharacterId: r.characterId,
        });
        console.log(`💰 [还钱] ${r.characterId} → ${repayOutcome.lenderId}: ${repayOutcome.amount} 金币`);
      }

      if (r.action.name === "steal" && r.result?.description?.includes("抓住")) {
        // 被抓的偷窃：受害者在 description 里（"伸手去摸XX的钱袋"）
        const m = r.result.description.match(/伸手去摸(.+?)的钱袋/);
        const victimName = m?.[1];
        const victim = victimName
          ? this.world.getAllCharacters().find((c) => c.name === victimName)
          : undefined;
        const actorName = this.world.getCharacter(r.characterId)?.name ?? r.characterId;
        this.longTerm.add(r.characterId, {
          tick: gameTime.tick, type: "event", importance: 9,
          content: `你偷${victimName ?? "别人"}的东西被当场抓住了`,
          relatedCharacterId: victim?.id,
        });
        if (victim) {
          this.longTerm.add(victim.id, {
            tick: gameTime.tick, type: "event", importance: 9,
            content: `你抓到${actorName}偷你的东西`,
            relatedCharacterId: r.characterId,
          });
          this.relationships.setGrudge(r.characterId, victim.id, "偷东西被当场抓住", r.characterId, gameTime.tick);
        }
      }
    }
  }

  /**
   * 3.5 反应轮：信箱有新消息的角色获得额外决策机会（就地把反应结果追加进 results）。
   * 限制：每 tick 最多 3 轮反应，每对角色每 tick 最多交换 2 次，对话后冷却 2 tick。
   */
  private async _runReactionRounds(results: AgentTickResult[], gameTime: GameTime): Promise<void> {
    const MAX_REACTION_ROUNDS = 3;
    const pairExchangeCount = new Map<string, number>();
    const pairKey = (a: string, b: string) => [a, b].sort().join(":");
    for (const r of results) {
      if (r.action?.name !== "talk" || !r.action.args.target || r.result?.success === false) continue;
      const targetId = this._resolveCharacterId(r.action.args.target as string);
      const pk = pairKey(r.characterId, targetId);
      const newCount = (pairExchangeCount.get(pk) ?? 0) + 1;
      pairExchangeCount.set(pk, newCount);
      if (newCount >= 2) {
        this._conversationCooldown.set(pk, gameTime.tick);
      }
    }
    for (let round = 0; round < MAX_REACTION_ROUNDS; round++) {
      const reactors: Array<{ id: string; config: AgentConfig }> = [];
      for (const [id, config] of this._configs) {
        const state = this.world.getCharacter(id);
        if (!state) continue;
        if (state.inbox.length === 0) continue;
        // 力竭昏睡/饿倒叫不醒：不进反应轮（消息留到醒后消费，也避免双重扣 remainingTicks）
        if (state.currentAction?.name === "collapse_asleep" || state.currentAction?.name === "collapse_starving") continue;
        // 有信箱消息时，即使在执行多 tick 行为也允许进入反应轮
        // （agent-loop 会中断行为来回应）
        // 检查对话对的交换次数限制 + 跨 tick 冷却
        const lastMsg = state.inbox[state.inbox.length - 1];
        if (lastMsg) {
          const pk = pairKey(id, this._resolveCharacterId(lastMsg.fromId));
          if ((pairExchangeCount.get(pk) ?? 0) >= 2) continue;
          const cooldownTick = this._conversationCooldown.get(pk);
          if (cooldownTick !== undefined && (gameTime.tick - cooldownTick) < 2) continue;
        }
        reactors.push({ id, config });
      }

      if (reactors.length === 0) break;

      // 串行执行反应轮：每个 reactor 执行后立即处理 talk 效果，
      // 这样下一个 reactor 能看到前面角色刚说的话（信箱已更新）
      const reactionResults: AgentTickResult[] = [];
      let hasNewTalk = false;
      for (const { id, config } of reactors) {
        const state = this.world.getCharacter(id)!;
        // 找出信箱中最近消息的发送者
        const lastMsg = state.inbox[state.inbox.length - 1];
        const partnerId = lastMsg ? this._resolveCharacterId(lastMsg.fromId) : undefined;

        let r: AgentTickResult;
        // 检测是否有活跃对话（对方必须还在同一地点，理由同 _findActiveConversationPartner）
        const partnerStillHere = partnerId
          && this.world.getCharacter(partnerId)?.locationId === state.locationId;
        if (partnerId && partnerStillHere && this.conversations.isActiveConversation(id, partnerId, gameTime.tick)) {
          const partnerConfig = this._configs.get(partnerId);
          const partnerState = this.world.getCharacter(partnerId);
          if (partnerConfig && partnerState) {
            const location = this.world.getLocation(state.locationId);
            const rel = this.relationships.get(id, partnerId);
            const recentMemories = this.memory.formatForPrompt(id, 12, gameTime.tick);
            const impressionText = this.impressions.formatForPrompt(id, partnerId);
            const wpId = state.life?.workplace ?? config.card.life?.workplace;
            const wpName = wpId ? this.world.getLocation(wpId)?.name : undefined;
            const conversationRequest = buildConversationRequest({
              card: config.card,
              state,
              partnerCard: partnerConfig.card,
              partnerState,
              history: this.conversations.getHistory(id, partnerId),
              gameTime,
              locationName: location?.name ?? state.locationId,
              atmosphere: location?.atmosphere,
              weather: this.world.weather,
              relationship: rel,
              impressionText,
              recentMemories,
              actions: this._actions,
              workplaceName: wpName,
              colleagueNames: this.relationships.getRelationshipsOf(id)
                .filter((r) => r.relationship.bond === "colleague")
                .map((r) => this.world.getCharacter(r.otherId)?.name)
                .filter((n): n is string => !!n),
              wantToDiscuss: this.world.getWantToDiscuss(id, gameTime.tick, partnerId),
              sharedHistory: this._sharedHistoryFor(id, partnerId, gameTime.tick),
            });
            r = await runAgentTick({
              config,
              world: this.world,
              eventBus: this.eventBus,
              gameTime,
              talkCooldownTargets: this._getTalkCooldownTargets(id, gameTime.tick),
              relationships: this.relationships,
              memory: this.memory,
              impressions: this.impressions,
              conversationRequest,
            });
          } else {
            r = await runAgentTick({
              config,
              world: this.world,
              eventBus: this.eventBus,
              gameTime,
              talkCooldownTargets: this._getTalkCooldownTargets(id, gameTime.tick),
              relationships: this.relationships,
              memory: this.memory,
              impressions: this.impressions,
            });
          }
        } else {
          r = await runAgentTick({
            config,
            world: this.world,
            eventBus: this.eventBus,
            gameTime,
            talkCooldownTargets: this._getTalkCooldownTargets(id, gameTime.tick),
            relationships: this.relationships,
            memory: this.memory,
            impressions: this.impressions,
          });
        }

        reactionResults.push(r);

        // 立即处理 talk 效果：关系变化 + 对话记录 + 信箱投递（已在 executeAction 中完成）
        // 这样下一个 reactor 能看到这条消息
        if (r.action?.name === "talk" && r.action.args.target && r.result?.success !== false) {
          hasNewTalk = true;
          const targetId = this._resolveCharacterId(r.action.args.target as string);
          // 与主轮一致收敛进 registerTalk：疙瘩冻结 + 递减 + 每对每 tick 只计一次。
          // 对话大头在反应轮，per-tick 去重就靠这条兜住（同一 tick 主轮已计则这里自动跳过）
          this.relationships.registerTalk(r.characterId, targetId, gameTime.tick);
          const charState = this.world.getCharacter(r.characterId);
          this.conversations.recordTalk(
            r.characterId,
            charState?.name ?? r.characterId,
            targetId,
            r.action.args.message as string ?? "",
            gameTime.tick,
            r.action.args.manner as string | undefined,
          );
          // 更新对话对交换计数 + 冷却
          const pk = pairKey(r.characterId, targetId);
          const newCount = (pairExchangeCount.get(pk) ?? 0) + 1;
          pairExchangeCount.set(pk, newCount);
          if (newCount >= 2) {
            this._conversationCooldown.set(pk, gameTime.tick);
          }
        }
      }
      results.push(...reactionResults);

      // 如果没有人回复 talk，停止反应轮
      if (!hasNewTalk) break;
    }
  }

  /**
   * 3.6 互动后印象更新：对有足够交流的角色对生成/更新叙事印象（fire-and-forget，不阻塞 tick）。
   */
  private _scheduleImpressionUpdates(results: AgentTickResult[], gameTime: GameTime): void {
    const impressionPromises: Promise<void>[] = [];
    const processedPairs = new Set<string>();
    for (const r of results) {
      if (r.action?.name === "talk" && r.action.args.target) {
        const targetId = this._resolveCharacterId(r.action.args.target as string);
        const pairKey = [r.characterId, targetId].sort().join(":");
        if (processedPairs.has(pairKey)) continue;

        const history = this.conversations.getHistory(r.characterId, targetId);
        // 首次印象只需 2 条交换，更新需 4 条 + 冷却期（每 4 tick / 游戏 1 小时最多更新一次）
        const existingImp = this.impressions.get(r.characterId, targetId);
        const minExchanges = existingImp ? 4 : 2;
        const cooldownOk = !existingImp || (gameTime.tick - existingImp.lastUpdated) >= 4;
        // 在飞门：上一次更新还没返回时不再调度（防同批台词并发计分两份）
        if (history.length >= minExchanges && cooldownOk && !this._impressionPending.has(pairKey)) {
          processedPairs.add(pairKey);
          const cardA = this._configs.get(r.characterId)?.card;
          const cardB = this._configs.get(targetId)?.card;
          if (cardA && cardB) {
            // valence 水位线：态度只评上次计分之后新增的台词——
            // 印象可以看全量上下文，但同一批台词不能反复推高/压低关系
            const prevMark = this._valenceWatermark.get(pairKey) ?? 0;
            const newSince = history.length > prevMark ? history.length - prevMark : history.length;
            this._valenceWatermark.set(pairKey, history.length);
            this._impressionPending.add(pairKey);
            impressionPromises.push(
              updateImpressionsBidirectional({
                cardA, cardB,
                exchanges: history,
                impressions: this.impressions,
                provider: this._provider,
                modelId: this._configs.get(r.characterId)!.modelId,
                tick: gameTime.tick,
                relationships: this.relationships,
                valenceOnLastN: Math.max(1, newSince),
                // A 件 §4.5：valence 落地即记入压力图内存环形缓冲（近窗波动/B1 预过滤数据源）
                onValence: (a, b, valence, tick) => this.pressureGraph.recordValence(a, b, valence, tick),
              }).finally(() => this._impressionPending.delete(pairKey)),
            );
          }
        }
      }
    }
    // Fire-and-forget: 印象生成不阻塞 tick 循环
    if (impressionPromises.length > 0) {
      this._trackBackgroundTask(Promise.all(impressionPromises)).catch((err) => {
        console.warn(`[tick ${gameTime.tick}] 印象生成失败:`, err?.message ?? err);
      });
    }
  }

  /**
   * 3.65 承诺抽取（fire-and-forget）：对话结束时检查双方有没有"说定"的见面承诺，
   * 有就自动落成 appointment——「明天中午咖啡馆见」不再说完就蒸发。
   * 预过滤（≥4 句 + 含时间词）控制成本；已有约定的对不重复抽。
   */
  private _schedulePromiseExtraction(gameTime: GameTime): void {
    for (const conv of this.conversations.getEndingConversations(gameTime.tick)) {
      // 对话真正结束：valence 水位清零，下一场对话从头计
      this._valenceWatermark.delete([conv.charA, conv.charB].sort().join(":"));
      this._scheduleTransactionSettlement(conv, gameTime);
      if (!mightContainPromise(conv.history)) continue;
      const cardA = this._configs.get(conv.charA)?.card;
      const cardB = this._configs.get(conv.charB)?.card;
      if (!cardA || !cardB) continue;
      // 这对角色已有 pending 约定就不再抽（arrange_meet 或上次对话已经定过）
      const existing = this.world.getUpcomingAppointments(conv.charA, gameTime.tick)
        .some((a) => a.proposerId === conv.charB || a.targetId === conv.charB);
      if (existing) continue;

      const publicLocations = this.world.getAllLocations()
        .filter((l) => l.type !== "residential")
        .map((l) => ({ id: l.id, name: l.name }));

      const task = extractPromise({
        history: conv.history,
        charAId: cardA.id, charAName: cardA.name,
        charBId: cardB.id, charBName: cardB.name,
        locations: publicLocations,
        // 时间基准 = 说最后一句话的时刻（抽取发生在对话结束后 9+ tick，
        // 用抽取时刻解析会把"今晚18:00"静默滚到明天）
        currentTick: conv.history[conv.history.length - 1]?.tick ?? gameTime.tick,
        provider: this._provider,
        modelId: this._modelId,
      }).then((p) => {
        // 约定时刻已经过去（对话拖太久/边界情况）：宁可丢弃也不错记到明天
        if (p && p.atTick <= gameTime.tick) return;
        if (!p) return;
        const ok = this.world.addAppointment({
          id: `promise_${gameTime.tick}_${p.proposerId}_${p.targetId}`,
          proposerId: p.proposerId,
          targetId: p.targetId,
          locationId: p.locationId,
          atTick: p.atTick,
          activity: p.activity,
          status: "pending",
          createdTick: gameTime.tick,
        });
        if (!ok) return;
        const proposerName = this.world.getCharacter(p.proposerId)?.name ?? p.proposerId;
        const targetName = this.world.getCharacter(p.targetId)?.name ?? p.targetId;
        for (const [meId, otherName] of [[p.proposerId, targetName], [p.targetId, proposerName]] as const) {
          this.memory.add(meId, {
            tick: gameTime.tick,
            type: "event",
            content: `你和${otherName}说好了${p.timeText}在${p.locationName}见面${p.activity ? `（${p.activity}）` : ""}`,
            importance: 7,
            relatedCharacterId: meId === p.proposerId ? p.targetId : p.proposerId,
          });
        }
        console.log(`🤝 [承诺→约定] ${proposerName} ↔ ${targetName}: ${p.timeText} @ ${p.locationName}${p.activity ? ` (${p.activity})` : ""}`);
      }).catch((err: any) => {
        console.warn(`🤝 [承诺抽取] ${conv.charA}↔${conv.charB} 失败:`, err?.message ?? err);
      });
      this._trackBackgroundTask(task);
    }
  }

  /** 每对角色最近一次"机制层真实转移"的 tick（give/repay/borrow），防止口头交易落账重复结算 */
  private _pairTransferTick = new Map<string, number>();

  /**
   * 3.66 口头交易落账（防幻觉·收编而不是禁止）：
   * 对话里"当场交割"的钱/物（"给你，拿着""这是4金币"），机制层往往什么都没发生，
   * 但双方记忆/观察/印象会把它固化成"事实"（牛奶债案）。对话结束时抽取并机械结算：
   * 嘴上成的交易账本跟上；给不出的（没钱/没物/物品不存在）记日志不结算——空头支票账本不认。
   */
  private _scheduleTransactionSettlement(
    conv: { charA: string; charB: string; history: import("./conversation-mode.js").ConversationExchange[] },
    gameTime: GameTime,
  ): void {
    if (!mightContainTransaction(conv.history)) return;
    const cardA = this._configs.get(conv.charA)?.card;
    const cardB = this._configs.get(conv.charB)?.card;
    if (!cardA || !cardB) return;
    // 对话窗口内已有一次真实机制转移（give/还钱/借钱）→ 大概率就是这笔，别重复结算
    const firstTick = conv.history[0]?.tick ?? gameTime.tick;
    const mechTick = this._pairTransferTick.get([conv.charA, conv.charB].sort().join(":"));
    if (mechTick !== undefined && mechTick >= firstTick) return;

    const task = extractTransaction({
      history: conv.history,
      charAId: cardA.id, charAName: cardA.name,
      charBId: cardB.id, charBName: cardB.name,
      provider: this._provider,
      modelId: this._modelId,
    }).then((tx) => {
      if (tx) this._settleSpokenTransaction(tx, gameTime);
    }).catch((err: any) => {
      console.warn(`💱 [口头交易抽取] ${conv.charA}↔${conv.charB} 失败:`, err?.message ?? err);
    });
    this._trackBackgroundTask(task);
  }

  /** 结算一笔口头交易：金币以身上的钱为限；物品必须真实存在且给的人真持有 */
  private _settleSpokenTransaction(tx: ExtractedTransaction, gameTime: GameTime): void {
    const giver = this.world.getCharacter(tx.fromId);
    const receiver = this.world.getCharacter(tx.toId);
    if (!giver || !receiver) return;
    if (tx.gold > 0) {
      const amount = Math.min(tx.gold, giver.gold);
      if (amount <= 0) {
        console.log(`💱 [口头交易] 空头支票：${giver.name} 说给 ${receiver.name} ${tx.gold} 金币，身上没钱，账本不认`);
      } else {
        giver.gold -= amount;
        receiver.gold += amount;
        console.log(`💱 [口头交易→落账] ${giver.name} → ${receiver.name}: ${amount} 金币${amount < tx.gold ? `（口头说 ${tx.gold}，身上只够 ${amount}）` : ""}`);
      }
    }
    if (tx.itemName) {
      const def = resolveItem(tx.itemName);
      if (!def) {
        console.log(`💱 [口头交易] 世界里没有「${tx.itemName}」，无法落账（虚构物品，靠真实边界闸压制）`);
        return;
      }
      const qty = Math.max(1, tx.qty ?? 1);
      // 路径一：给的人自己带着 → 人对人转移
      if (hasItem(giver.inventory ?? [], def.id)) {
        const n = Math.min(qty, giver.inventory.filter((i) => i.defId === def.id).reduce((s, i) => s + i.quantity, 0));
        removeFromInventory(giver.inventory, def.id, n);
        addToInventory(receiver.inventory, def.id, n, { giftedBy: giver.name, obtainedTick: gameTime.tick });
        console.log(`💱 [口头交易→落账] ${giver.name} → ${receiver.name}: ${def.name}${n > 1 ? `×${n}` : ""}`);
        return;
      }
      // 路径二：柜台代买（半日实测实锤——真嗣口头卖了三个可颂，明日香真以为自己有，
      // 连撞 3 次 eat 失败）：给的人是店员、卖的是自家货架 → 按 buy 语义结算
      const workplaceId = giver.life?.workplace;
      const shopLoc = workplaceId ? this.world.getLocation(workplaceId) : undefined;
      const shopItem = shopLoc?.shop?.find((s) => s.id === def.id);
      if (shopLoc && shopItem) {
        const price = shopItem.price;
        const affordable = Math.min(qty, Math.floor(receiver.gold / Math.max(1, price)));
        const inStock = shopLoc.stock?.[def.id] === undefined ? affordable : Math.min(affordable, shopLoc.stock[def.id]!);
        if (inStock <= 0) {
          console.log(`💱 [口头交易] 柜台结算失败：${receiver.name} 买 ${def.name}×${qty}，钱不够或没货，账本不认`);
          return;
        }
        receiver.gold -= price * inStock;
        if (shopLoc.stock?.[def.id] !== undefined) shopLoc.stock[def.id]! -= inStock;
        addToInventory(receiver.inventory, def.id, inStock, { obtainedTick: gameTime.tick });
        console.log(`💱 [口头交易→柜台结算] ${receiver.name} 在${shopLoc.name}买下 ${def.name}×${inStock}（付 ${price * inStock} 金币，${giver.name} 经手）`);
        return;
      }
      console.log(`💱 [口头交易] ${giver.name} 身上没有${def.name}也不卖它，无法落账`);
    }
  }

  /**
   * 3.7 社会观察推理：空闲角色解读同地点其他人的行为（fire-and-forget，不阻塞 tick）。
   */
  private _scheduleObservations(gameTime: GameTime): void {
    const observationPromises: Promise<void>[] = [];
    for (const [id, config] of this._configs) {
      const state = this.world.getCharacter(id);
      if (!state) continue;
      const nearby = this.world.getCharactersAtLocation(state.locationId)
        .filter((cid) => cid !== id);
      if (!shouldObserve(state, this._lastObservationTick.get(id), gameTime.tick, nearby.length)) continue;

      const visibleCharacters = nearby
        .map((cid) => this.world.getCharacter(cid))
        .filter((c): c is NonNullable<typeof c> => c !== undefined)
        .map((c) => ({
          id: c.id,
          name: c.name,
          action: this.world.getObservableState(c.id, gameTime.tick)?.summary
            ?? (c.currentAction ? describeObservableAction(c.name, c.currentAction.name) : ""),
          stayDuration: undefined as number | undefined,
        }))
        .filter((c) => c.action.length > 0);

      if (visibleCharacters.length === 0) continue;

      const location = this.world.getLocation(state.locationId);
      this._lastObservationTick.set(id, gameTime.tick);

      observationPromises.push(
        generateObservation(
          { observerCard: config.card, observerState: state, visibleCharacters, locationName: location?.name ?? state.locationId, tick: gameTime.tick },
          this._provider,
          config.modelId,
          this.impressions,
        ).then((result) => {
          if (result) {
            this.memory.add(result.observerId, {
              tick: result.tick,
              type: "observation",
              content: `你注意到${this.world.getCharacter(result.targetId)?.name ?? result.targetId}的情况，心想：${result.reasoning}`,
              importance: 6,
              relatedCharacterId: result.targetId,
            });
          }
        }),
      );
    }
    if (observationPromises.length > 0) {
      this._trackBackgroundTask(Promise.all(observationPromises)).catch((err) => {
        console.warn(`[tick ${gameTime.tick}] 观察推理失败:`, err?.message ?? err);
      });
    }
  }

  /** 4. 八卦传播：同地点多人时把最近事件扩散成传闻记忆 */
  private _processGossip(gameTime: GameTime): ReturnType<typeof processGossipSpread> {
    const locationCharMap = new Map<string, string[]>();
    for (const loc of this.world.getAllLocations()) {
      if (loc.presentCharacters.length > 1) {
        locationCharMap.set(loc.id, [...loc.presentCharacters]);
      }
    }
    return processGossipSpread({
      recentEvents: this.eventBus.history.slice(-20),
      charactersAtLocation: locationCharMap,
      memory: this.memory,
      currentTick: gameTime.tick,
    });
  }

  /**
   * 4b. 每天 23:00 触发反思：回写愿望/担忧 life state + 职业晋升检查。
   * 非 23:00 返回 undefined。
   */
  private async _runNightlyReflection(gameTime: GameTime): Promise<ReflectionResult[] | undefined> {
    if (!(gameTime.hour === 23 && gameTime.minute === 0)) return undefined;

    const dayStartTick = gameTime.tick - 92; // 当天 00:00 起
    const reflectionPromises = Array.from(this._configs.values()).map((config) => {
      const planState = this.world.getCharacter(config.card.id);
      return runReflection({
        card: config.card,
        memory: this.memory,
        relationships: this.relationships,
        provider: this._provider,
        modelId: config.modelId,
        dayStartTick,
        dayEndTick: gameTime.tick,
        todayPlan: planState?.todayPlan?.day === gameTime.day ? planState.todayPlan.items : undefined,
      });
    });
    const reflections = await Promise.all(reflectionPromises);

    // 反思结果回写 life state（愿望/担忧）+ lastReflection（晨间打算直接读它）+ 长期记忆
    for (const r of reflections) {
      const charState = this.world.getCharacter(r.characterId);
      if (charState?.life) {
        if (r.wish) charState.life.currentGoal = r.wish;
        if (r.concern) charState.life.currentConcern = r.concern;
      }
      if (charState) {
        charState.lastReflection = {
          day: gameTime.day,
          insights: r.insights,
          mood: r.mood,
          wish: r.wish,
          concern: r.concern,
        };
      }
      // 反思在发生当刻进入长期记忆——人生从此有跨越 48 小时的传记
      for (const insight of r.insights) {
        this.longTerm.add(r.characterId, {
          tick: gameTime.tick,
          type: "reflection",
          content: `[反思] ${insight}`,
          importance: 9,
        });
      }
    }

    // 职业晋升检查（每天反思时）
    const allLocations = this.world.getAllLocations();
    for (const charState of this.world.getAllCharacters()) {
      const promotion = checkPromotion(charState, allLocations);
      if (promotion) {
        applyPromotion(charState, promotion, this.memory, gameTime.tick);
        console.log(`🎉 [晋升] ${charState.name}: ${promotion.oldTitle} → ${promotion.newTitle}`);
      }
    }
    return reflections;
  }

  /** 运行 N 个 tick */
  async runTicks(count: number, startTick: number): Promise<TickSummary[]> {
    const { tickToGameTime } = await import("../core/tick-engine.js");
    const summaries: TickSummary[] = [];
    for (let i = 0; i < count; i++) {
      const gt = tickToGameTime(startTick + i);
      const summary = await this.runOneTick(gt);
      summaries.push(summary);
    }
    return summaries;
  }

  /**
   * 组装对话 prompt 的"你们之间实际发生过的"段：
   * 长期记忆里关于对方的条目 + 关系史最近几条。没有共同历史时返回 undefined（刚认识就是刚认识）。
   */
  private _sharedHistoryFor(id: string, partnerId: string, currentTick: number): string | undefined {
    const formatTime = (tick: number): string => {
      const gt = tickToGameTime(tick);
      const hhmm = `${String(gt.hour).padStart(2, "0")}:${String(gt.minute).padStart(2, "0")}`;
      const dayDiff = tickToGameTime(currentTick).day - gt.day;
      if (dayDiff <= 0) return hhmm;
      return dayDiff === 1 ? `昨天${hhmm}` : `${dayDiff}天前${hhmm}`;
    };
    return formatSharedHistory({
      longTermAbout: this.longTerm.getAbout(id, partnerId, 4),
      relationHistory: this.relationships.get(id, partnerId).history,
      formatTime,
    });
  }

  /** 把 LLM 返回的 target（可能是 ID 或名字）解析为角色 ID */
  _resolveCharacterId(raw: string): string {
    // 1. 直接匹配 ID
    if (this._configs.has(raw)) return raw;
    const charByRaw = this.world.getCharacter(raw);
    if (charByRaw) return raw;

    // 2. 按名字精确匹配（忽略大小写）
    const lower = raw.toLowerCase();
    for (const c of this.world.getAllCharacters()) {
      if (c.name.toLowerCase() === lower) return c.id;
    }

    // 3. 部分匹配（名字包含）— 要求唯一匹配
    const partialMatches = this.world.getAllCharacters().filter(
      (c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()),
    );
    if (partialMatches.length === 1) {
      return partialMatches[0]!.id;
    }
    if (partialMatches.length > 1) {
      console.warn(`[resolveCharacterId] "${raw}" 匹配到多个角色: ${partialMatches.map((c) => c.name).join(", ")}，使用第一个`);
      return partialMatches[0]!.id;
    }

    // 4. 匹配不上，记录警告并原样返回（后续 talk handler 会拦截）
    console.warn(`[resolveCharacterId] "${raw}" 无法匹配任何角色`);
    return raw;
  }

  // ── N3: BeatEngine 扫描 ──

  /** 将 scenario 加载的 beats 灌入 engine（CLI / 测试 setup 用）。 */
  loadBeats(beats: BeatDefinition[]): void {
    this.beatEngine.setBeats(beats);
    // 旧档 migrate（B4/§4.5）：cooldown 型不进 triggeredBeats 一次性集合——
    // 旧语义下被 markBeatTriggered 过的 cooldown beat 要从集合里放出来，否则永不再触发。
    const cooldownIds = new Set(
      beats.filter((b) => getBeatCooldownTicks(b) !== null).map((b) => b.id),
    );
    this.beatEngine.setTriggered(
      this.world.narrative.getWorld().triggeredBeats.filter((id) => !cooldownIds.has(id)),
    );
    // 读档后同步逐 beat 触发史 + 最近触发 tick（随档权威副本在 narrative_state.world.beatLastTrigger）
    const beatLastTrigger = this.world.narrative.getWorld().beatLastTrigger;
    this.beatEngine.setBeatLastTrigger(beatLastTrigger);
    const triggerTicks = Object.values(beatLastTrigger);
    this.beatEngine.setLastTriggerTick(triggerTicks.length > 0 ? Math.max(...triggerTicks) : undefined);
  }

  /** 启用 LLM 导演（N4）。可选 — 不调即不启用。
   * D1: 自动注入 simulation 的 memory + impressions 给 director 的 read 工具。
   * D2/D4: pulse store / agenda store 由 Director 内部默认创建。 */
  enableDirector(config: DirectorConfig): void {
    this.director = new Director({
      ...config,
      memory: config.memory ?? this.memory,
      impressions: config.impressions ?? this.impressions,
    });
  }

  /** 注册 phase-specific 工具（N6.4）。CLI 启动时调一次。 */
  registerPhaseTools(byPhase: Record<string, ActionDefinition[]>): void {
    this.phaseTools = byPhase;
  }

  private _getActivePhaseTools(): ActionDefinition[] {
    const phase = this.world.narrative.getWorld().activePhase;
    if (!phase) return [];
    return this.phaseTools[phase] ?? [];
  }

  /**
   * Bug #3 修复用：查找该角色当前是否在和某人对话中。
   * 返回最近一次对话的对方 id，如果没有活跃对话返回 undefined。
   * 主 agent 循环会用这个来决定是否进入 conversation mode。
   */
  private _findActiveConversationPartner(charId: string, currentTick: number): string | undefined {
    let bestPartner: string | undefined;
    let bestTick = -1;
    const myLocation = this.world.getCharacter(charId)?.locationId;
    for (const other of this._configs.keys()) {
      if (other === charId) continue;
      // 对方已经不在同一地点 → 对话已经物理上结束了，不能再进会话模式。
      // 此前只看 3-tick 时间窗：B 离开后 A 仍被喂"请回应对方"的 prompt，
      // 模型自然选 talk，然后撞上"talk 不在可用列表"（人都走了哪来的 talk）。
      if (this.world.getCharacter(other)?.locationId !== myLocation) continue;
      if (this.conversations.isActiveConversation(charId, other, currentTick)) {
        // 找最近一次 talk 的 partner
        const history = this.conversations.getHistory(charId, other);
        const lastTick = history.length > 0 ? history[history.length - 1]!.tick : -1;
        if (lastTick > bestTick) {
          bestTick = lastTick;
          bestPartner = other;
        }
      }
    }
    return bestPartner;
  }

  /**
   * 把 scenario 的 seeds.yml 应用到世界状态（N6.3）。
   * 只在新存档场景调用 — 已读档时不要再 apply 否则覆盖玩家进度。
   */
  applySeeds(seeds: {
    activePhase?: string;
    unresolvedEvents?: Array<{ id: string; summary: string; involved?: string[]; visibleTo?: string[] | "*" }>;
    characterRelationships?: Array<{ a: string; b: string; level?: number; type?: string; bond?: string }>;
    initialRumors?: Array<{ content: string; sourceCharId?: string | null; spreadTo?: string[] }>;
  }): void {
    const ns = this.world.narrative;
    if (seeds.activePhase) {
      ns.setActivePhase(seeds.activePhase);
    }
    for (const e of seeds.unresolvedEvents ?? []) {
      ns.addUnresolvedEvent({
        id: e.id,
        summary: e.summary,
        involved: e.involved ?? [],
        visibleTo: e.visibleTo ?? "*",
        createdTick: this.world.tick,
      });
    }
    for (const r of seeds.characterRelationships ?? []) {
      this.relationships.set(r.a, r.b, r.level ?? 0, (r.type as any) ?? "stranger");
      if (r.bond) {
        this.relationships.setBond(r.a, r.b, r.bond as any, this.world.tick);
      }
    }
    for (const r of seeds.initialRumors ?? []) {
      ns.getWorld().rumors.push({
        content: r.content,
        sourceCharId: r.sourceCharId ?? undefined,
        tick: this.world.tick,
        reachedChars: r.spreadTo ?? [],
      });
    }
    console.log(
      `🌱 Seeds 已应用: ${seeds.unresolvedEvents?.length ?? 0} 未解决事件, ` +
        `${seeds.characterRelationships?.length ?? 0} 关系, ` +
        `${seeds.initialRumors?.length ?? 0} 流言, ` +
        `phase=${seeds.activePhase ?? "(无)"}`,
    );
  }

  /**
   * B4 扩展点：beat on_trigger.auto_events 的事件类型注册表。
   * 本阶段内置 "fate"（走 _applyFateOutcome 的 fate 包装）；
   * S3 的硬事件原语（theft_with_perp / accident_damage / letter_arrival）注册进来后自动可用。
   */
  private _autoEventHandlers: Record<string, (payload: Record<string, unknown>, ctx: { tick: number; beatId: string }) => void> = {
    fate: (payload, ctx) => {
      const targetId = typeof payload.target === "string" ? payload.target : undefined;
      const target = targetId ? this.world.getCharacter(targetId) : undefined;
      const fate = payload.fate as Partial<FateEvent> | undefined;
      if (!target || !fate || typeof fate.template !== "string") {
        console.warn(`🎬 [auto_event] fate 载荷不合法（beat=${ctx.beatId}, target=${targetId}）——跳过`);
        return;
      }
      const event: FateEvent = {
        id: typeof fate.id === "string" ? fate.id : `beat_${ctx.beatId}`,
        name: typeof fate.name === "string" ? fate.name : `beat:${ctx.beatId}`,
        template: fate.template,
        importance: fate.importance === 9 ? 9 : 8,
        weight: 0, // 机械注入不参与抽取
        goldDelta: fate.goldDelta,
        needEffects: fate.needEffects,
        moodlet: fate.moodlet,
        intentSummary: fate.intentSummary,
        witnessTemplate: fate.witnessTemplate,
      };
      const { goldChange } = this._applyFateOutcome(target, event, ctx.tick);
      this.eventBus.emit({
        id: `auto_event_${ctx.beatId}_${event.id}_${ctx.tick}`,
        tick: ctx.tick,
        type: "narrative.auto_event",
        actorId: "__beat_engine__",
        targetId: target.id,
        locationId: target.locationId,
        description: event.template.replace("{character}", target.name),
        effects: [],
        witnesses: [],
      });
      console.log(`🎬 [auto_event] fate → ${target.name}（beat=${ctx.beatId}${goldChange !== 0 ? `, 金币 ${goldChange > 0 ? "+" : ""}${goldChange}` : ""}）`);
    },
  };

  /** 注册 auto_events 事件类型（S3 硬事件原语接入点）。重复注册以后到者为准。 */
  registerAutoEventHandler(
    type: string,
    handler: (payload: Record<string, unknown>, ctx: { tick: number; beatId: string }) => void,
  ): void {
    this._autoEventHandlers[type] = handler;
  }

  /** B4：组装 BeatContext.extras（每次扫描现算；kira 计数仅单次连续 sim 有效——瞬态不入档） */
  private _buildBeatExtras(): BeatContextExtras {
    const w = this.world.narrative.getWorld();
    const gold: Record<string, number> = {};
    const charPressures: Record<string, number> = {};
    for (const c of this.world.getAllCharacters()) {
      gold[c.id] = c.gold;
      charPressures[c.id] = this.world.narrative.getCharacter(c.id).pressure;
    }
    const events: BeatContextExtras["events"] = {};
    for (const e of w.unresolvedEvents) events[e.id] = e.status ?? "fresh";
    return {
      pressure: {
        summary: this.pressureGraph.formatHotspotSummary(this.world),
        topPairs: this.pressureGraph.getTopPairs(3).map((p) => ({ a: p.a, b: p.b, pressure: p.pressure })),
      },
      kira: {
        total: this.world.kira.total,
        victimCount: this.world.kira.victims.length,
        pendingCount: this.world.kira.pending.length,
        lastStrikeDay: this.world.kira.lastStrikeDay,
      },
      charPressures,
      gold,
      appointments: {
        pendingCount: this.world.getAllAppointments().filter((a) => a.status === "pending").length,
        missedByPair: countMissedAppointmentsByPair(this.world.getAllAppointments()),
      },
      events,
      beatLastTrigger: { ...w.beatLastTrigger },
    };
  }

  /**
   * 跑一次 BeatEngine.scan。
   * 1) 构建 BeatContext（从 narrative_state + relationships + needs 拼 + extras）
   * 2) scan
   * 3) 把触发的 beats 写回 narrative_state（一次性 beat 进 triggeredBeats；cooldown 型只记触发 tick）
   * 4) emit 事件到 event bus（N4 director 订阅）+ 机械载荷（auto_seeds / new_phase / auto_events）
   */
  runBeatScan(gameTime: GameTime): BeatReadyEvent[] {
    if (this.beatEngine.getBeats().length === 0) return [];

    // 幂等：最少间隔 4 tick（1 游戏小时）
    if (this._lastBeatScanDay !== undefined && gameTime.tick - this._lastBeatScanDay < 4) return [];
    this._lastBeatScanDay = gameTime.tick;

    // 构建上下文
    const allChars = this.world.getAllCharacters();
    const charRelationships: Record<string, Record<string, { level: number; type: string; bond?: string; trust: number }>> = {};
    const charNeeds: Record<string, Record<string, number>> = {};
    const charLocations: Record<string, string> = {};
    for (const c of allChars) {
      const rels: Record<string, { level: number; type: string; bond?: string; trust: number }> = {};
      for (const { otherId, relationship: rel } of this.relationships.getRelationshipsOf(c.id)) {
        rels[otherId] = {
          level: rel.level,
          type: rel.type,
          bond: rel.bond,
          // 简单 trust 派生：level 0..100 → 0..1
          trust: Math.max(0, Math.min(1, rel.level / 100)),
        };
      }
      charRelationships[c.id] = rels;
      charNeeds[c.id] = { ...c.needs };
      charLocations[c.id] = c.locationId;
    }

    const ctx = buildBeatContext({
      narrative: this.world.narrative.getSnapshot(),
      tick: gameTime.tick,
      characterRelationships: charRelationships,
      characterNeeds: charNeeds,
      characterLocations: charLocations,
      extras: this._buildBeatExtras(),
    });

    const ready = this.beatEngine.scan(ctx);

    if (ready.length === 0) return [];

    const beats = this.beatEngine.getBeats();
    const scanDay = Math.floor(gameTime.tick / 96) + 1;
    console.log(`🎬 [beat] scan @ day ${scanDay} tick ${gameTime.tick}: ${ready.length} beat(s) ready`);
    for (const ev of ready) {
      const def = beats.find((b) => b.id === ev.beatId);
      const cooldown = def ? getBeatCooldownTicks(def) : null;
      console.log(`   → ${ev.beatId} (${ev.reason}${cooldown !== null ? `, cooldown=${cooldown}` : ""}) ${ev.description ?? ""}`);
      // cooldown 型不进 triggeredBeats 一次性集合（B4/§4.5）——触发史只在 beatLastTrigger
      if (cooldown === null) {
        this.world.narrative.markBeatTriggered(ev.beatId);
      }
      // 触发 tick 随档（A 件干旱项 + B4 cooldown 型 beat 的数据源）
      this.world.narrative.recordBeatTrigger(ev.beatId, gameTime.tick);
      // 同步 emit 到 event bus，N4 director 会订阅
      this.eventBus.emit({
        id: `beat_${ev.beatId}_${gameTime.tick}`,
        tick: gameTime.tick,
        type: "beat.ready",
        actorId: "__beat_engine__",
        locationId: "__system__",
        description: `Beat 触发: ${ev.beatId} (${ev.reason})`,
        effects: [],
        witnesses: [],
      });
    }

    // B4 机械载荷：new_phase 直接应用（scan 在 tick 开头同步执行，与 markBeatTriggered 同一写入窗）
    for (const ev of ready) {
      const newPhase = ev.payload?.new_phase;
      if (typeof newPhase === "string" && newPhase.length > 0) {
        this.world.narrative.setActivePhase(newPhase);
        console.log(`🎬 [beat] new_phase 应用: ${ev.beatId} → active_phase=${newPhase}`);
      }
    }

    // B4 机械载荷：auto_events 走 enqueueMutation（下一 tick 开头统一落账，不在 scan 中途改角色状态）
    for (const ev of ready) {
      const autoEvents = ev.payload?.auto_events;
      if (!Array.isArray(autoEvents)) continue;
      for (const raw of autoEvents) {
        if (!raw || typeof raw !== "object" || typeof (raw as Record<string, unknown>).type !== "string") {
          console.warn(`🎬 [auto_event] 载荷不是带 type 的对象（beat=${ev.beatId}）——跳过`);
          continue;
        }
        const payload = raw as Record<string, unknown>;
        const type = payload.type as string;
        const beatId = ev.beatId;
        this.enqueueMutation(() => {
          const handler = this._autoEventHandlers[type];
          if (!handler) {
            console.warn(`🎬 [auto_event] 未注册的事件类型 "${type}"（beat=${beatId}）——跳过（S3 注册后自动可用）`);
            return;
          }
          handler(payload, { tick: this.world.tick, beatId });
        });
      }
    }

    // D3: beat 触发时自动应用 auto_seeds（机械保证核心话题进入角色 prompt）
    for (const ev of ready) {
      const def = beats.find((b) => b.id === ev.beatId);
      if (def?.auto_seeds) {
        for (const seed of def.auto_seeds) {
          const ok = this.world.addWantToDiscuss(seed.char, seed.topic, seed.urgency, seed.target, gameTime.tick);
          if (ok) {
            console.log(`🌱 [auto_seed] ${seed.char}: [${seed.urgency}] ${seed.topic.slice(0, 50)}`);
          }
          // high urgency + targetChar → 自动注入 intent 让角色去找人
          if (seed.urgency === "high" && seed.target) {
            const targetName = this.world.getCharacter(seed.target)?.name ?? seed.target;
            this.world.setIntent(seed.char, {
              kind: "plan",
              summary: `必须找${targetName}谈谈——${seed.topic.slice(0, 40)}`,
              source: "action",
              targetId: seed.target,
              createdTick: gameTime.tick,
              expiresAt: gameTime.tick + 16,
            });
            console.log(`💡 [auto_intent] ${seed.char}: 必须找${targetName}谈谈`);
          }
        }
      }
    }

    // N4: 异步派给 LLM Director（不阻塞 tick）
    if (this.director?.isEnabled()) {
      for (const ev of ready) {
        const def = beats.find((b) => b.id === ev.beatId);
        const task = this.director.handleBeatReady(ev, this.world, def).catch((err) => {
          console.warn(`🎬 [director] handleBeatReady 失败: ${err.message}`);
          return null;
        });
        this._backgroundTasks.add(task);
        task.finally(() => this._backgroundTasks.delete(task));
      }
    }

    return ready;
  }

  /** argue 兜底的每对冷却水位（observer:target → 上次注入 tick），瞬态不入档 */
  private _confrontNudgeAt = new Map<string, number>();

  /**
   * argue 机械兜底（下行通路的最后一环）：
   * 7 天基线证明机制通道（argue→grudge→和解）和提示词许可都在，但模型从不主动开吵——
   * 「闹掰」上半环从不注册，「和好」下半环永远不可达。
   * 当摩擦已在机制里落账（疙瘩攒满 3 条，或 2 条且关系已跌负）且两人撞在同一地点时，
   * 给受气方注入一条"把话挑明"的 intent——只配时机与注意力，不写结果：
   * 吵不吵、怎么吵、还是继续咽下去，仍由角色自己决定。
   * off 档不启用（保 A/B 基线）；已有 grudge 的对子交给积怨状态机，不重复驱动。
   */
  private _applyConfrontationFallback(gameTime: GameTime): void {
    if (getBreakLevel() === "off") return;
    const COOLDOWN_TICKS = 48; // 同一对至少隔半个游戏天再催一次
    for (const me of this.world.getAllCharacters()) {
      const acting = me.currentAction?.name;
      if (acting === "sleep" || acting === "collapse_asleep" || acting === "collapse_starving") continue;
      if (this.world.getCurrentIntent(me.id, gameTime.tick)) continue; // 已有心事在身，不叠加
      for (const otherId of this.world.getCharactersAtLocation(me.locationId)) {
        if (otherId === me.id) continue;
        const frictions = this.impressions.get(me.id, otherId)?.frictions ?? [];
        if (frictions.length < 2) continue;
        const rel = this.relationships.get(me.id, otherId);
        if (rel.grudge) continue;
        const boiling = frictions.length >= 3 || rel.level <= -10;
        if (!boiling) continue;
        const key = `${me.id}:${otherId}`;
        const last = this._confrontNudgeAt.get(key);
        if (last !== undefined && gameTime.tick - last < COOLDOWN_TICKS) continue;
        this._confrontNudgeAt.set(key, gameTime.tick);
        const otherName = this.world.getCharacter(otherId)?.name ?? otherId;
        this.world.setIntent(me.id, {
          kind: "recover",
          source: "action",
          targetId: otherId,
          summary: `对${otherName}攒的不满已经压不住了（${frictions[frictions.length - 1]}）。这回别再咽下去，把话当面挑明。`,
          createdTick: gameTime.tick,
          expiresAt: gameTime.tick + 6,
        });
        console.log(`⚡ [argue-fallback] ${me.id} → ${otherId} (疙瘩=${frictions.length}, level=${Math.round(rel.level)})`);
        break; // 一次只压一桩心事
      }
    }
  }

  /** 讨债提醒的每对冷却水位（lender:borrower → 上次催的 tick），瞬态不入档 */
  private _debtNudgeAt = new Map<string, number>();

  /**
   * 1.0i 讨债：账欠了 2 天以上、债主和欠债人撞在同一地点 → 债主起"提一嘴"的念头。
   * 只给念头不写台词：委婉还是撕破脸看债主自己；欠债人拖着不还，
   * 债主的印象/疙瘩会自然变化，最终能走到 argue 兜底那条线上。
   */
  private _applyDebtCollection(gameTime: GameTime): void {
    const OVERDUE_TICKS = 192;       // 欠满 2 游戏天才好意思催
    const NUDGE_COOLDOWN = 96;       // 同一笔账每天最多催一次
    for (const borrower of this.world.getAllCharacters()) {
      for (const debt of borrower.debts ?? []) {
        if (gameTime.tick - debt.borrowedTick < OVERDUE_TICKS) continue;
        const lender = this.world.getCharacter(debt.lenderId);
        if (!lender || lender.locationId !== borrower.locationId) continue;
        const acting = lender.currentAction?.name;
        if (acting === "sleep" || acting === "collapse_asleep" || acting === "collapse_starving") continue;
        if (this.world.getCurrentIntent(lender.id, gameTime.tick)) continue;
        const key = `${lender.id}:${borrower.id}`;
        const last = this._debtNudgeAt.get(key);
        if (last !== undefined && gameTime.tick - last < NUDGE_COOLDOWN) continue;
        this._debtNudgeAt.set(key, gameTime.tick);
        const days = Math.floor((gameTime.tick - debt.borrowedTick) / 96);
        this.world.setIntent(lender.id, {
          kind: "recover",
          source: "action",
          targetId: borrower.id,
          summary: `${borrower.name}借你的${debt.amount}金币已经${days}天了还没还，人就在眼前——要不要提一嘴，怎么提，你自己拿捏。`,
          createdTick: gameTime.tick,
          expiresAt: gameTime.tick + 6,
        });
        console.log(`💰 [讨债] ${lender.id} 惦记起 ${borrower.id} 欠的 ${debt.amount} 金币（${days} 天）`);
      }
    }
  }

  /** kept 结算的公共部分：记忆 + moodlet + 关系 + LTM（三种兑现路径共用，只差记忆措辞） */
  private _settleAppointmentKept(
    a: Appointment,
    proposer: CharacterState,
    target: CharacterState,
    gameTime: GameTime,
    contentFor: (other: CharacterState) => string,
    logNote: string,
  ): void {
    this.world.markAppointment(a.id, "kept");
    this.relationships.modify(a.proposerId, a.targetId, 3, gameTime.tick, "如约见面");
    for (const [me, other] of [[proposer, target], [target, proposer]] as const) {
      const content = contentFor(other);
      this.memory.add(me.id, {
        tick: gameTime.tick,
        type: "event",
        content,
        importance: 7,
        relatedCharacterId: other.id,
      });
      addMoodlet(me, "happy", 3, "赴约见到了人", 12, "social", gameTime.tick);
      this.longTerm.add(me.id, {
        tick: gameTime.tick, type: "event", importance: 7,
        content,
        relatedCharacterId: other.id,
      });
    }
    console.log(`📅 [约定] 兑现${logNote}: ${a.proposerId} ↔ ${a.targetId}`);
  }

  /**
   * 约定结算（约定系统）：
   * - 提前兑现窗（到点前 4 tick）：双方已在约定地点且聊上了 → kept（提前履行不算爽约）
   * - 宽限窗（到点后 2 tick）内双方同时在约定地点 → kept：双方记忆 + happy + 关系 +3；
   *   双方在同一个别的地点且聊上了 → 也算 kept（换了地方但人见上了）
   * - 窗口过后：在场者被放鸽子（记忆/sad/关系 −5/recover intent），
   *   缺席者留愧疚记忆 + intent（道歉行为的涌现钩子）；双方都没到则扯平
   * 已知简化：结算时刻才看在场，"等了一会儿先走了"会被判为没来（v1 接受）。
   */
  private resolveAppointments(gameTime: GameTime): void {
    // 提前兑现：到点前 1 小时内双方已在约定地点碰上且正在对话（对话是硬证据，防止同事同店整天被误判）
    for (const a of this.world.getEarlyWindowAppointments(gameTime.tick, APPOINTMENT_EARLY_TICKS)) {
      const proposer = this.world.getCharacter(a.proposerId);
      const target = this.world.getCharacter(a.targetId);
      if (!proposer || !target) continue; // 角色缺失留给到点结算处理
      const locName = this.world.getLocation(a.locationId)?.name ?? a.locationId;
      const bothHere = proposer.locationId === a.locationId && target.locationId === a.locationId;
      if (bothHere && this.conversations.isActiveConversation(a.proposerId, a.targetId, gameTime.tick)) {
        this._settleAppointmentKept(a, proposer, target, gameTime,
          (other) => `你和${other.name}提前在${locName}碰了面，约好的事顺势就办了`, "(提前)");
      }
    }

    for (const a of this.world.getDueAppointments(gameTime.tick)) {
      const proposer = this.world.getCharacter(a.proposerId);
      const target = this.world.getCharacter(a.targetId);
      if (!proposer || !target) {
        this.world.markAppointment(a.id, "missed");
        continue;
      }
      const locName = this.world.getLocation(a.locationId)?.name ?? a.locationId;
      const pHere = proposer.locationId === a.locationId;
      const tHere = target.locationId === a.locationId;

      if (pHere && tHere) {
        this._settleAppointmentKept(a, proposer, target, gameTime,
          (other) => `你和${other.name}如约在${locName}碰了面`, "");
        continue;
      }

      // 换了地方但人见上了：双方在同一个别的地点且正在对话 → 也算兑现
      if (
        proposer.locationId === target.locationId &&
        this.conversations.isActiveConversation(a.proposerId, a.targetId, gameTime.tick)
      ) {
        const actualLocName = this.world.getLocation(proposer.locationId)?.name ?? proposer.locationId;
        this._settleAppointmentKept(a, proposer, target, gameTime,
          (other) => `你和${other.name}约的是${locName}，结果在${actualLocName}碰上了，约的事也算成了`, "(换地点)");
        continue;
      }

      // 宽限窗内：再等等（人可能在路上）
      if (gameTime.tick <= a.atTick + APPOINTMENT_GRACE_TICKS) continue;

      // 窗口过了 → 爽约结算
      const waiter = pHere ? proposer : tHere ? target : undefined;
      const absentee = pHere ? target : tHere ? proposer : undefined;
      // 单方爽约记缺席者（压力图爽约计数的派生依据）；双爽约不记（不计入压力）
      this.world.markAppointment(a.id, "missed", absentee?.id);
      if (waiter && absentee) {
        this.relationships.modify(waiter.id, absentee.id, -5, gameTime.tick, "被放了鸽子");
        this.memory.add(waiter.id, {
          tick: gameTime.tick,
          type: "event",
          content: `你在${locName}等${absentee.name}，说好的时间过了，对方一直没来`,
          importance: 8,
          relatedCharacterId: absentee.id,
        });
        addMoodlet(waiter, "sad", 4, "被放了鸽子", 16, "social", gameTime.tick);
        this.world.setIntent(waiter.id, {
          kind: "recover",
          source: "action",
          targetId: absentee.id,
          summary: `${absentee.name}放了你鸽子，这事挂在心上。`,
          createdTick: gameTime.tick,
          expiresAt: gameTime.tick + 8,
        });
        this.memory.add(absentee.id, {
          tick: gameTime.tick,
          type: "event",
          content: `你想起来你和${waiter.name}约了在${locName}见面，结果你没去`,
          importance: 8,
          relatedCharacterId: waiter.id,
        });
        this.world.setIntent(absentee.id, {
          kind: "recover",
          source: "action",
          targetId: waiter.id,
          summary: `你放了${waiter.name}的鸽子，心里有点过意不去。`,
          createdTick: gameTime.tick,
          expiresAt: gameTime.tick + 8,
        });
        // 爽约进长期记忆——"她上次放过我鸽子"从此可以被真实引用
        this.longTerm.add(waiter.id, {
          tick: gameTime.tick, type: "event", importance: 8,
          content: `${absentee.name}放了你鸽子（说好在${locName}见面，人没来）`,
          relatedCharacterId: absentee.id,
        });
        this.longTerm.add(absentee.id, {
          tick: gameTime.tick, type: "event", importance: 8,
          content: `你放了${waiter.name}的鸽子（约在${locName}，你没去）`,
          relatedCharacterId: waiter.id,
        });
        console.log(`📅 [约定] 爽约: ${absentee.id} 放了 ${waiter.id} 鸽子 @ ${locName}`);
      } else {
        for (const [me, other] of [[proposer, target], [target, proposer]] as const) {
          this.memory.add(me.id, {
            tick: gameTime.tick,
            type: "event",
            content: `你和${other.name}约了在${locName}见面，结果你们俩都没去`,
            importance: 5,
            relatedCharacterId: other.id,
          });
        }
        console.log(`📅 [约定] 双方爽约: ${a.proposerId} ↔ ${a.targetId}`);
      }
    }
  }

  /**
   * 晨间打算（fire-and-forget）：昨日反思的愿望/担忧 + 今日约定 + 天气 → 今天想做的 1-3 件事，
   * 写入 state.todayPlan 全天注入 prompt。反思(昨晚)→打算(早上)→行动(全天)→反思回顾(今晚) 闭环。
   */
  private runMorningPlans(gameTime: GameTime): void {
    for (const [id, config] of this._configs) {
      const state = this.world.getCharacter(id);
      if (!state) continue;
      if (state.todayPlan?.day === gameTime.day) continue; // 幂等
      const life = state.life ?? config.card.life;
      const wpName = life?.workplace ? this.world.getLocation(life.workplace)?.name : undefined;
      const todayEnd = (gameTime.day + 1) * 96;
      const todayAppointments = this.world.getUpcomingAppointments(id, gameTime.tick)
        .filter((a) => a.atTick < todayEnd)
        .map((a) => {
          const otherId = a.proposerId === id ? a.targetId : a.proposerId;
          const otherName = this.world.getCharacter(otherId)?.name ?? otherId;
          const locName = this.world.getLocation(a.locationId)?.name ?? a.locationId;
          return `${describeAppointmentTime(a.atTick, gameTime.tick)}在${locName}和${otherName}见面`;
        });
      // 直接读昨晚反思的完整结果（state.lastReflection），
      // 不再靠 getRecentThoughts 字符串匹配碰运气（记忆被挤出就断链）
      const lastRef = state.lastReflection && gameTime.day - state.lastReflection.day <= 1
        ? state.lastReflection
        : undefined;

      const task = generateMorningPlan({
        card: config.card,
        state,
        provider: this._provider,
        modelId: config.modelId,
        yesterdayWish: lastRef?.wish ?? state.life?.currentGoal,
        yesterdayConcern: lastRef?.concern ?? state.life?.currentConcern,
        yesterdayInsights: lastRef?.insights ?? [],
        todayAppointments,
        weather: this.world.weather,
        workplaceName: wpName,
        townLocations: this.world.getAllLocations()
          .filter((l) => l.type !== "residential")
          .map((l) => l.name),
        townPeople: this.world.getAllCharacters()
          .filter((c) => c.id !== id)
          .map((c) => c.name),
        isFirstDay: gameTime.day === 0,
      }).then((result) => {
        const s = this.world.getCharacter(id);
        if (s && result.items.length > 0) {
          s.todayPlan = { day: gameTime.day, items: result.items };
          console.log(`🌅 [晨间打算] ${id}: ${result.items.join(" / ")}`);
        }
      }).catch((err: any) => {
        console.warn(`🌅 [晨间打算] ${id} 失败:`, err?.message ?? err);
      });
      this._trackBackgroundTask(task);
    }
  }

  /** 每天 06:00 触发 LLM 导演的节奏检查（N4） */
  runDailyPacingCheck(gameTime: GameTime): void {
    if (!this.director?.isEnabled()) return;
    const day = Math.floor(gameTime.tick / 96) + 1;
    if (this._lastPacingDay === day) return;
    this._lastPacingDay = day;

    const task = this.director.handleDailyPacing(this.world, gameTime.tick).catch((err) => {
      console.warn(`🎬 [director] handleDailyPacing 失败: ${err.message}`);
      return null;
    });
    this._backgroundTasks.add(task);
    task.finally(() => this._backgroundTasks.delete(task));
  }
}

function isSociallyObservableEvent(type: string): boolean {
  return [
    "action.talk",
    "action.gossip",
    "action.give_gift",
    "action.comfort",
    "action.argue",
    "action.steal",
    "action.beg",
  ].includes(type);
}
