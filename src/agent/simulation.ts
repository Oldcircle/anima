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
import type { LLMProvider } from "../providers/types.js";
import type { ActionDefinition } from "../actions/types.js";
import { RelationshipManager } from "../world/relationships.js";
import { rollWeather } from "../world/weather.js";
import { rollRandomEvents, type RandomEvent } from "../world/events.js";
import { processGossipSpread, type GossipItem } from "../world/gossip.js";
import { getTodayFestival, type Festival } from "../world/festivals.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { runAgentTick, describeObservableAction, type AgentConfig, type AgentTickResult } from "./agent-loop.js";
import { runReflection, type ReflectionResult } from "./reflection.js";
import { ConversationTracker, buildConversationRequest } from "./conversation-mode.js";
import { ImpressionStore } from "../memory/impressions.js";
import { updateImpressionsBidirectional } from "./impression-updater.js";
import { shouldObserve, generateObservation, type ObservationResult } from "./observation-reasoning.js";
import { tickMoodlets, generateNeedMoodlets, addMoodlet } from "../world/moodlets.js";
import { checkPromotion, applyPromotion, type PromotionResult } from "../world/career.js";

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
  conversations: ConversationTracker;
  impressions: ImpressionStore;

  constructor(
    world: World,
    eventBus: EventBus,
    config: SimulationConfig,
  ) {
    this.world = world;
    this.eventBus = eventBus;
    this.relationships = new RelationshipManager();
    this.memory = new ShortTermMemory();
    this.conversations = new ConversationTracker();
    this.impressions = new ImpressionStore();
    this._provider = config.provider;
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
    // 0. 每天凌晨更新天气 + 检查节日
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

    // 1. 衰减需求 + Moodlet 管理
    this.world.decayNeeds();
    this.world.setTick(gameTime.tick);
    for (const c of this.world.getAllCharacters()) {
      tickMoodlets(c, gameTime.tick);
      generateNeedMoodlets(c, gameTime.tick);
    }

    // 1.5 随机事件
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

    // 2. 并行决策所有未忙碌角色
    const results: AgentTickResult[] = [];
    const promises: Promise<AgentTickResult>[] = [];

    for (const [id, config] of this._configs) {
      const state = this.world.getCharacter(id);
      if (!state) continue;

      promises.push(runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory, impressions: this.impressions }));
    }

    const agentResults = await Promise.all(promises);
    results.push(...agentResults);

    // 3. talk 产生的关系变化（共享关系）+ 记录对话（含 manner）
    for (const r of results) {
      if (r.action?.name === "talk" && r.action.args.target && r.result?.success !== false) {
        const targetId = this._resolveCharacterId(r.action.args.target as string);
        // RelationshipManager 是对称关系，同一条 talk 只应推动一次，
        // 否则会因为“你对我说话 / 我对你说话”被重复加分，亲密度涨得过快。
        this.relationships.modify(r.characterId, targetId, 2, gameTime.tick, r.result?.description ?? "聊天");
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

    // 3.5 反应轮：信箱有新消息的角色获得额外决策机会
    // 限制：每 tick 最多 1 轮反应，每对角色每 tick 最多交换 2 次，对话后冷却 2 tick
    const MAX_REACTION_ROUNDS = 3;
    const pairExchangeCount = new Map<string, number>();
    const pairKey = (a: string, b: string) => [a, b].sort().join(":");
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
        // 检测是否有活跃对话
        if (partnerId && this.conversations.isActiveConversation(id, partnerId, gameTime.tick)) {
          const partnerConfig = this._configs.get(partnerId);
          const partnerState = this.world.getCharacter(partnerId);
          if (partnerConfig && partnerState) {
            const location = this.world.getLocation(state.locationId);
            const rel = this.relationships.get(id, partnerId);
            const recentMemories = this.memory.formatForPrompt(id, 5);
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
            });
            r = await runAgentTick({
              config, world: this.world, eventBus: this.eventBus, gameTime,
              relationships: this.relationships, memory: this.memory,
              impressions: this.impressions, conversationRequest,
            });
          } else {
            r = await runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory, impressions: this.impressions });
          }
        } else {
          r = await runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory, impressions: this.impressions });
        }

        reactionResults.push(r);

        // 立即处理 talk 效果：关系变化 + 对话记录 + 信箱投递（已在 executeAction 中完成）
        // 这样下一个 reactor 能看到这条消息
        if (r.action?.name === "talk" && r.action.args.target && r.result?.success !== false) {
          hasNewTalk = true;
          const targetId = this._resolveCharacterId(r.action.args.target as string);
          this.relationships.modify(r.characterId, targetId, 2, gameTime.tick, r.result?.description ?? "回复");
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

    // 3.6 互动后印象更新：对有足够交流的角色对生成/更新叙事印象
    // Fire-and-forget：不阻塞 tick 循环
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

    // 清理过期对话
    this.conversations.cleanup(gameTime.tick);

    // 3.7 社会观察推理：空闲角色解读同地点其他人的行为
    // Fire-and-forget，不阻塞 tick 循环
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
          action: c.currentAction ? describeObservableAction(c.name, c.currentAction.name) : "",
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

    // 4. 八卦传播
    const locationCharMap = new Map<string, string[]>();
    for (const loc of this.world.getAllLocations()) {
      if (loc.presentCharacters.length > 1) {
        locationCharMap.set(loc.id, [...loc.presentCharacters]);
      }
    }
    const gossips = processGossipSpread({
      recentEvents: this.eventBus.history.slice(-20),
      charactersAtLocation: locationCharMap,
      memory: this.memory,
      currentTick: gameTime.tick,
    });

    // 4. 每天 23:00 触发反思
    let reflections: ReflectionResult[] | undefined;
    if (gameTime.hour === 23 && gameTime.minute === 0) {
      const dayStartTick = gameTime.tick - 92; // 当天 00:00 起
      reflections = [];
      const reflectionPromises = Array.from(this._configs.values()).map((config) =>
        runReflection({
          card: config.card,
          memory: this.memory,
          relationships: this.relationships,
          provider: this._provider,
          modelId: config.modelId,
          dayStartTick,
          dayEndTick: gameTime.tick,
        }),
      );
      reflections = await Promise.all(reflectionPromises);

      // 反思结果回写 life state（愿望/担忧）
      for (const r of reflections) {
        const charState = this.world.getCharacter(r.characterId);
        if (charState?.life) {
          if (r.wish) charState.life.currentGoal = r.wish;
          if (r.concern) charState.life.currentConcern = r.concern;
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
    }

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
