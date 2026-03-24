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
import { runAgentTick, type AgentConfig, type AgentTickResult } from "./agent-loop.js";
import { runReflection, type ReflectionResult } from "./reflection.js";
import { ConversationTracker, buildConversationRequest } from "./conversation-mode.js";
import { ImpressionStore } from "../memory/impressions.js";
import { updateImpressionsBidirectional } from "./impression-updater.js";

export interface SimulationConfig {
  characters: CharacterCard[];
  actions: ActionDefinition[];
  provider: LLMProvider;
  modelId: string;
  /** 玩家角色 ID（如果有）。玩家不调 LLM，由前端操控 */
  playerId?: string;
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
  private _playerId?: string;
  private _backgroundTasks = new Set<Promise<unknown>>();

  world: World;
  eventBus: EventBus;
  relationships: RelationshipManager;
  memory: ShortTermMemory;
  conversations: ConversationTracker;
  impressions: ImpressionStore;

  get playerId(): string | undefined { return this._playerId; }

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
    this._playerId = config.playerId;

    this.eventBus.on((event) => {
      this.recordWitnessObservations(event);
    });

    for (const card of config.characters) {
      // 玩家不注册为 AI Agent（不调 LLM）
      if (card.id === config.playerId) continue;
      this._configs.set(card.id, {
        card,
        actions: config.actions,
        provider: config.provider,
        modelId: config.modelId,
      });
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

    // 1. 衰减需求
    this.world.decayNeeds();
    this.world.setTick(gameTime.tick);

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

    // 3. talk 产生的关系变化（双向）+ 记录对话
    for (const r of results) {
      if (r.action?.name === "talk" && r.action.args.target && r.result?.success !== false) {
        const targetId = this._resolveCharacterId(r.action.args.target as string);
        this.relationships.modify(r.characterId, targetId, 3, gameTime.tick, r.result?.description ?? "聊天");
        this.relationships.modify(targetId, r.characterId, 2, gameTime.tick, `${r.characterId} 对你说话`);
        // 记录到对话追踪器
        const charState = this.world.getCharacter(r.characterId);
        this.conversations.recordTalk(
          r.characterId,
          charState?.name ?? r.characterId,
          targetId,
          r.action.args.message as string ?? "",
          gameTime.tick,
        );
      }
    }

    // 3.5 反应轮：信箱有新消息的角色获得额外决策机会
    // 如果检测到活跃对话，使用对话模式（更丰富的 prompt + 更高 token）
    const MAX_REACTION_ROUNDS = 3;
    for (let round = 0; round < MAX_REACTION_ROUNDS; round++) {
      // 找到信箱有新消息的角色
      const reactors: Array<{ id: string; config: AgentConfig }> = [];
      for (const [id, config] of this._configs) {
        const state = this.world.getCharacter(id);
        if (!state) continue;
        if (state.inbox.length === 0) continue;
        // 只有长时间行为（工作/睡觉 等 >1h）才阻止反应
        if (state.currentAction && state.currentAction.remainingTicks > 4) continue;
        reactors.push({ id, config });
      }

      if (reactors.length === 0) break; // 没有人需要反应

      // 对每个 reactor，判断是否使用对话模式
      const reactionPromises = reactors.map(({ id, config }) => {
        const state = this.world.getCharacter(id)!;
        // 找出信箱中最近消息的发送者
        const lastMsg = state.inbox[state.inbox.length - 1];
        const partnerId = lastMsg ? this._resolveCharacterId(lastMsg.fromId) : undefined;

        // 检测是否有活跃对话
        if (partnerId && this.conversations.isActiveConversation(id, partnerId, gameTime.tick)) {
          const partnerConfig = this._configs.get(partnerId);
          const partnerState = this.world.getCharacter(partnerId);
          if (partnerConfig && partnerState) {
            const location = this.world.getLocation(state.locationId);
            const rel = this.relationships.get(id, partnerId);
            const recentMemories = this.memory.formatForPrompt(id, 5);
            const impressionText = this.impressions.formatForPrompt(id, partnerId);
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
            });
            // 使用对话模式 prompt，但复用标准 agent tick 的执行逻辑
            return runAgentTick({
              config, world: this.world, eventBus: this.eventBus, gameTime,
              relationships: this.relationships, memory: this.memory,
              impressions: this.impressions, conversationRequest,
            });
          }
        }

        // 非对话模式：使用标准 agent tick
        return runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory, impressions: this.impressions });
      });
      const reactionResults = await Promise.all(reactionPromises);
      results.push(...reactionResults);

      // 处理反应中产生的 talk 关系变化（双向）+ 记录对话
      for (const r of reactionResults) {
        if (r.action?.name === "talk" && r.action.args.target && r.result?.success !== false) {
          const targetId = this._resolveCharacterId(r.action.args.target as string);
          this.relationships.modify(r.characterId, targetId, 3, gameTime.tick, r.result?.description ?? "回复");
          this.relationships.modify(targetId, r.characterId, 2, gameTime.tick, `${r.characterId} 回复了你`);
          const charState = this.world.getCharacter(r.characterId);
          this.conversations.recordTalk(
            r.characterId,
            charState?.name ?? r.characterId,
            targetId,
            r.action.args.message as string ?? "",
            gameTime.tick,
          );
        }
      }

      // 如果没有人回复 talk，停止反应轮
      const hasNewTalk = reactionResults.some((r) => r.action?.name === "talk");
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

  /**
   * 执行玩家动作 — 和 AI 角色走完全相同的执行管道
   * @returns ActionResult if action found, null if unknown action
   */
  async executePlayerAction(
    actionName: string,
    args: Record<string, unknown>,
  ): Promise<import("./agent-loop.js").AgentTickResult | null> {
    if (!this._playerId) return null;

    const state = this.world.getCharacter(this._playerId);
    if (!state) return null;

    const actionDef = this._actions.find((a) => a.tool.name === actionName);
    if (!actionDef) return null;

    const location = this.world.getLocation(state.locationId);
    const ctx: import("../actions/types.js").ActionContext = {
      characterId: this._playerId,
      locationId: state.locationId,
      locationType: location?.type ?? "public",
      tick: this.world.tick,
      nearbyCharacters: this.world.getCharactersAtLocation(state.locationId).filter((id) => id !== this._playerId),
      gold: state.gold,
      needs: { ...state.needs },
    };

    const result = actionDef.handler(args, ctx);

    // 约束失败：广播事件但不应用效果
    if (result.success === false) {
      const event: import("../core/event-bus.js").WorldEvent = {
        id: crypto.randomUUID(),
        tick: this.world.tick,
        type: `action.${actionName}.failed`,
        actorId: this._playerId,
        locationId: state.locationId,
        description: `${state.name} ${result.description}`,
        effects: [],
        witnesses: this.world.getCharactersAtLocation(state.locationId).filter((id) => id !== this._playerId),
      };
      await this.eventBus.emit(event);

      return {
        characterId: this._playerId,
        thought: "",
        action: { name: actionName, args },
        result,
      };
    }

    // 应用效果（和 agent-loop 中的 executeAction 一致）
    for (const effect of result.effects) {
      switch (effect.type) {
        case "need_change":
          if (effect.field && effect.delta !== undefined) {
            this.world.modifyNeed(effect.targetId, effect.field as any, effect.delta);
          }
          break;
        case "location_change":
          if (effect.value) {
            this.world.moveCharacter(effect.targetId, effect.value);
          }
          break;
        case "inbox_message":
          if (effect.message) {
            this.world.sendMessage(effect.targetId, {
              fromId: this._playerId,
              fromName: state.name,
              content: effect.message,
              tick: this.world.tick,
            });
          }
          break;
      }
    }

    // 经济效果
    const { getWorkIncome, getConsumptionCost } = await import("../world/economy.js");
    if (actionName === "work") {
      state.gold += getWorkIncome("冒险者"); // 玩家默认职业
    } else if (actionName === "eat" || actionName === "drink") {
      const cost = getConsumptionCost(actionName, state.locationId);
      state.gold = Math.max(0, state.gold - cost);
    } else if (actionName === "give_gift") {
      state.gold = Math.max(0, state.gold - 20);
    }

    // 多 tick 行为
    if (result.duration && result.duration > 1) {
      state.currentAction = { name: actionName, remainingTicks: result.duration - 1 };
    } else {
      state.currentAction = undefined;
    }

    // 广播事件
    const event: import("../core/event-bus.js").WorldEvent = {
      id: crypto.randomUUID(),
      tick: this.world.tick,
      type: `action.${actionName}`,
      actorId: this._playerId,
      targetId: args.target as string | undefined,
      locationId: state.locationId,
      description: `${state.name} ${result.description}`,
      effects: result.effects.map((e) => ({
        type: e.type, targetId: e.targetId, field: e.field, delta: e.delta, value: e.value,
      })),
      witnesses: this.world.getCharactersAtLocation(state.locationId).filter((id) => id !== this._playerId),
    };
    await this.eventBus.emit(event);

    // talk 产生关系变化
    if (actionName === "talk" && args.target) {
      const targetId = this._resolveCharacterId(args.target as string);
      this.relationships.modify(this._playerId, targetId, 3, this.world.tick, result.description);
    }

    // 存入玩家记忆
    this.memory.add(this._playerId, {
      tick: this.world.tick,
      type: "event",
      content: result.description,
      importance: actionName === "talk" ? 7 : 4,
      relatedCharacterId: actionName === "talk" ? args.target as string : undefined,
    });

    return {
      characterId: this._playerId,
      thought: "",
      action: { name: actionName, args },
      result,
    };
  }

  /** 获取玩家可用的行为列表 */
  getPlayerActions(): Array<{ name: string; description: string }> {
    return this._actions.map((a) => ({ name: a.tool.name, description: a.tool.description }));
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
    // 1. 直接匹配 ID（AI 角色或玩家）
    if (this._configs.has(raw)) return raw;
    if (this._playerId === raw) return raw;
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
