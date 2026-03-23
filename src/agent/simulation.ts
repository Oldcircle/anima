/**
 * Simulation — 多角色世界模拟引擎
 *
 * 每个 tick：衰减需求 → 并行决策所有角色 → 处理对话
 */

import type { CharacterCard } from "../character/types.js";
import type { World } from "../world/world.js";
import type { EventBus } from "../core/event-bus.js";
import type { TickEngine, GameTime } from "../core/tick-engine.js";
import type { LLMProvider } from "../providers/types.js";
import type { ActionDefinition } from "../actions/types.js";
import { RelationshipManager } from "../world/relationships.js";
import { rollWeather, weatherDescription } from "../world/weather.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { runAgentTick, type AgentConfig, type AgentTickResult } from "./agent-loop.js";
import { runConversation, type ConversationResult } from "./conversation.js";
import { runReflection, type ReflectionResult } from "./reflection.js";

export interface SimulationConfig {
  characters: CharacterCard[];
  actions: ActionDefinition[];
  provider: LLMProvider;
  modelId: string;
  /** 对话用的模型（可选，默认同 modelId） */
  conversationModelId?: string;
}

export interface TickSummary {
  tick: number;
  gameTime: GameTime;
  results: AgentTickResult[];
  conversations: ConversationResult[];
  reflections?: ReflectionResult[];
}

export type SimulationListener = (summary: TickSummary) => void;

export class Simulation {
  private _configs: Map<string, AgentConfig> = new Map();
  private _conversationModelId: string;
  private _provider: LLMProvider;
  private _actions: ActionDefinition[];
  private _listeners: SimulationListener[] = [];
  private _pendingConversations: Array<{
    initiatorId: string;
    targetId: string;
    intent: string;
    openingLine: string;
  }> = [];

  world: World;
  eventBus: EventBus;
  relationships: RelationshipManager;
  memory: ShortTermMemory;

  constructor(
    world: World,
    eventBus: EventBus,
    config: SimulationConfig,
  ) {
    this.world = world;
    this.eventBus = eventBus;
    this.relationships = new RelationshipManager();
    this.memory = new ShortTermMemory();
    this._provider = config.provider;
    this._actions = config.actions;
    this._conversationModelId = config.conversationModelId ?? config.modelId;

    for (const card of config.characters) {
      this._configs.set(card.id, {
        card,
        actions: config.actions,
        provider: config.provider,
        modelId: config.modelId,
      });

      // 从角色卡初始化关系
      for (const [otherId, rel] of Object.entries(card.relationships)) {
        this.relationships.set(card.id, otherId, rel.level, rel.type as any);
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

  /** 运行单个 tick */
  async runOneTick(gameTime: GameTime): Promise<TickSummary> {
    // 0. 每天凌晨更新天气
    if (gameTime.hour === 0 && gameTime.minute === 0) {
      const newWeather = rollWeather(gameTime.season);
      this.world.setWeather(newWeather);
    }

    // 1. 衰减需求
    this.world.decayNeeds();
    this.world.setTick(gameTime.tick);

    // 2. 并行决策所有未忙碌角色
    const results: AgentTickResult[] = [];
    const promises: Promise<AgentTickResult>[] = [];

    for (const [id, config] of this._configs) {
      const state = this.world.getCharacter(id);
      if (!state) continue;
      if (state.inConversation) {
        results.push({ characterId: id, thought: "", skipped: true, skipReason: "对话中" });
        continue;
      }

      promises.push(runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory }));
    }

    const agentResults = await Promise.all(promises);
    results.push(...agentResults);

    // 3. 检查是否有角色发起了 talk → 触发对话
    const conversations: ConversationResult[] = [];
    for (const r of results) {
      if (r.action?.name === "talk" && r.action.args.target) {
        const rawTarget = r.action.args.target as string;
        // 模糊匹配：先按 ID，再按名字
        const targetId = this._resolveCharacterId(rawTarget);
        const initiatorCard = this._configs.get(r.characterId)?.card;
        const targetCard = this._configs.get(targetId)?.card;

        if (initiatorCard && targetCard) {
          // 检查双方是否在同一地点
          const initiatorState = this.world.getCharacter(r.characterId);
          const targetState = this.world.getCharacter(targetId);
          if (initiatorState && targetState && initiatorState.locationId === targetState.locationId) {
            const conv = await runConversation({
              initiator: initiatorCard,
              target: targetCard,
              intent: (r.action.args.intent as string) ?? "",
              openingLine: (r.action.args.opening_line as string) ?? "",
              provider: this._provider,
              modelId: this._conversationModelId,
              world: this.world,
              gameTime,
            });
            conversations.push(conv);

            // 更新关系
            this.relationships.modify(
              r.characterId,
              targetId,
              conv.relationshipDelta,
              gameTime.tick,
              conv.summary,
            );

            // 存入双方记忆
            const locName = this.world.getLocation(conv.locationId)?.name ?? conv.locationId;
            const convSnippet = conv.messages.slice(0, 2).map(m => m.content).join(" / ");
            this.memory.add(r.characterId, { tick: gameTime.tick, type: "conversation", content: `和${targetCard.name}在${locName}聊天：${convSnippet}`, importance: 6 });
            this.memory.add(targetId, { tick: gameTime.tick, type: "conversation", content: `和${initiatorCard.name}在${locName}聊天：${convSnippet}`, importance: 6 });
          }
        }
      }
    }

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
          modelId: this._conversationModelId,
          dayStartTick,
          dayEndTick: gameTime.tick,
        }),
      );
      reflections = await Promise.all(reflectionPromises);
    }

    const summary: TickSummary = { tick: gameTime.tick, gameTime, results, conversations, reflections };

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
  private _resolveCharacterId(raw: string): string {
    // 1. 直接匹配 ID
    if (this._configs.has(raw)) return raw;

    // 2. 按名字匹配（忽略大小写）
    const lower = raw.toLowerCase();
    for (const [id, config] of this._configs) {
      if (config.card.name.toLowerCase() === lower) return id;
    }

    // 3. 部分匹配（名字包含）
    for (const [id, config] of this._configs) {
      if (config.card.name.toLowerCase().includes(lower) || lower.includes(config.card.name.toLowerCase())) {
        return id;
      }
    }

    // 4. 匹配不上，原样返回
    return raw;
  }
}
