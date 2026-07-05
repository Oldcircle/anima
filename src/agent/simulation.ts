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
import { ImpressionStore } from "../memory/impressions.js";
import { updateImpressionsBidirectional } from "./impression-updater.js";
import { shouldObserve, generateObservation, type ObservationResult } from "./observation-reasoning.js";
import { tickMoodlets, generateNeedMoodlets, addMoodlet } from "../world/moodlets.js";
import { APPOINTMENT_GRACE_TICKS, describeAppointmentTime } from "../world/appointments.js";
import { generateMorningPlan } from "./morning-plan.js";
import { checkPromotion, applyPromotion, type PromotionResult } from "../world/career.js";
import { detectBehaviorPatterns } from "../world/behavior-chains.js";
import { updateWorldTension } from "../narrative/tension.js";
import { BeatEngine, type BeatDefinition, type BeatReadyEvent } from "../narrative/beat-engine.js";
import { buildBeatContext } from "../narrative/expression.js";
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
  /** N4: LLM 导演（可选，未配置时为 undefined） */
  director?: Director;
  /** N6.4: phase-specific 工具映射 (active_phase → ActionDefinition[]) */
  phaseTools: Record<string, ActionDefinition[]> = {};
  /** 上一次扫描 beats 的 game day（避免同一天扫多次） */
  private _lastBeatScanDay = -1;
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
    // 1.0a 叙事张力（N2）：每 tick 末更新 tension_index
    updateWorldTension(this.world);
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

    // 1.5 随机事件
    const triggeredEvents = this._rollRandomEvents(gameTime);

    // 2. 并行决策所有未忙碌角色
    const results = await this._gatherAgentDecisions(gameTime);

    // 3. talk 产生的关系变化（共享关系）+ 记录对话（含 manner）
    this._applyTalkEffects(results, gameTime);

    // 3.5 反应轮：信箱有新消息的角色获得额外决策机会
    await this._runReactionRounds(results, gameTime);

    // 3.55 冲突当刻晋升长期记忆：吵架/偷窃被抓不该 48 小时后蒸发
    this._promoteConflictsToLongTerm(results, gameTime);

    // 3.6 互动后印象更新（fire-and-forget）+ 清理过期对话
    this._scheduleImpressionUpdates(results, gameTime);
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
        // RelationshipManager 是对称关系，同一条 talk 只应推动一次，
        // 否则会因为“你对我说话 / 我对你说话”被重复加分，亲密度涨得过快。
        this.relationships.modify(r.characterId, targetId, 1, gameTime.tick, r.result?.description ?? "聊天");
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
   * 3.55 冲突当刻晋升长期记忆：argue / steal 被抓这类"有重量的事"直接写入 LTM（双方视角），
   * 之后对话时会作为"你们之间实际发生过的"注入——上周的架不会像没吵过一样。
   */
  private _promoteConflictsToLongTerm(results: AgentTickResult[], gameTime: GameTime): void {
    for (const r of results) {
      if (r.result?.success === false || !r.action) continue;
      const targetRaw = r.action.args.target as string | undefined;

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
          this.relationships.modify(r.characterId, targetId, 1, gameTime.tick, r.result?.description ?? "回复");
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
        if (history.length >= minExchanges && cooldownOk) {
          processedPairs.add(pairKey);
          const cardA = this._configs.get(r.characterId)?.card;
          const cardB = this._configs.get(targetId)?.card;
          if (cardA && cardB) {
            impressionPromises.push(
              updateImpressionsBidirectional({
                cardA, cardB,
                exchanges: history,
                impressions: this.impressions,
                provider: this._provider,
                modelId: this._configs.get(r.characterId)!.modelId,
                tick: gameTime.tick,
              }),
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
    this.beatEngine.setTriggered(this.world.narrative.getWorld().triggeredBeats);
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
   * 跑一次 BeatEngine.scan。
   * 1) 构建 BeatContext（从 narrative_state + relationships + needs 拼）
   * 2) scan
   * 3) 把触发的 beats 写回 narrative_state
   * 4) emit 事件到 event bus（N4 director 订阅）
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
    });

    const ready = this.beatEngine.scan(ctx);

    if (ready.length === 0) return [];

    const scanDay = Math.floor(gameTime.tick / 96) + 1;
    console.log(`🎬 [beat] scan @ day ${scanDay} tick ${gameTime.tick}: ${ready.length} beat(s) ready`);
    for (const ev of ready) {
      console.log(`   → ${ev.beatId} (${ev.reason}) ${ev.description ?? ""}`);
      this.world.narrative.markBeatTriggered(ev.beatId);
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

    // D3: beat 触发时自动应用 auto_seeds（机械保证核心话题进入角色 prompt）
    const beats = this.beatEngine.getBeats();
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

  /**
   * 约定结算（约定系统）：
   * - 宽限窗（到点后 2 tick）内双方同时在场 → kept：双方记忆 + happy + 关系 +3
   * - 窗口过后：在场者被放鸽子（记忆/sad/关系 −5/recover intent），
   *   缺席者留愧疚记忆 + intent（道歉行为的涌现钩子）；双方都没到则扯平
   * 已知简化：结算时刻才看在场，"等了一会儿先走了"会被判为没来（v1 接受）。
   */
  private resolveAppointments(gameTime: GameTime): void {
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
        this.world.markAppointment(a.id, "kept");
        this.relationships.modify(a.proposerId, a.targetId, 3, gameTime.tick, "如约见面");
        for (const [me, other] of [[proposer, target], [target, proposer]] as const) {
          this.memory.add(me.id, {
            tick: gameTime.tick,
            type: "event",
            content: `你和${other.name}如约在${locName}碰了面`,
            importance: 7,
            relatedCharacterId: other.id,
          });
          addMoodlet(me, "happy", 3, "赴约见到了人", 12, "social", gameTime.tick);
          this.longTerm.add(me.id, {
            tick: gameTime.tick, type: "event", importance: 7,
            content: `你和${other.name}如约在${locName}碰了面`,
            relatedCharacterId: other.id,
          });
        }
        console.log(`📅 [约定] 兑现: ${a.proposerId} ↔ ${a.targetId} @ ${locName}`);
        continue;
      }

      // 宽限窗内：再等等（人可能在路上）
      if (gameTime.tick <= a.atTick + APPOINTMENT_GRACE_TICKS) continue;

      // 窗口过了 → 爽约结算
      this.world.markAppointment(a.id, "missed");
      const waiter = pHere ? proposer : tHere ? target : undefined;
      const absentee = pHere ? target : tHere ? proposer : undefined;
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
