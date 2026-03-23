/**
 * Simulation — 多角色世界模拟引擎
 *
 * 每个 tick：衰减需求 → 并行决策所有角色（信箱驱动对话）
 */

import type { CharacterCard } from "../character/types.js";
import type { World } from "../world/world.js";
import type { EventBus } from "../core/event-bus.js";
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
    const isNight = gameTime.hour >= 23 || gameTime.hour < 5;
    const results: AgentTickResult[] = [];
    const promises: Promise<AgentTickResult>[] = [];

    for (const [id, config] of this._configs) {
      const state = this.world.getCharacter(id);
      if (!state) continue;

      // 夜间自动睡觉（不调 LLM，节省 token）
      if (isNight && !state.currentAction) {
        // 送角色回家睡觉
        const homeId = config.card.home;
        if (state.locationId !== homeId) {
          this.world.moveCharacter(id, homeId);
        }
        state.currentAction = { name: "sleep", remainingTicks: 20 }; // ~5 小时
        this.world.modifyNeed(id, "energy", 100);
        this.world.modifyNeed(id, "hygiene", 10);
        results.push({ characterId: id, thought: "该睡觉了", skipped: true, skipReason: "夜间休息" });
        continue;
      }

      promises.push(runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory }));
    }

    const agentResults = await Promise.all(promises);
    results.push(...agentResults);

    // 3. talk 产生的关系变化
    for (const r of results) {
      if (r.action?.name === "talk" && r.action.args.target) {
        const targetId = this._resolveCharacterId(r.action.args.target as string);
        this.relationships.modify(r.characterId, targetId, 3, gameTime.tick, r.result?.description ?? "聊天");
      }
    }

    // 3.5 反应轮：信箱有新消息的角色获得额外决策机会
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

      // 并行执行反应
      const reactionPromises = reactors.map(({ config }) =>
        runAgentTick({ config, world: this.world, eventBus: this.eventBus, gameTime, relationships: this.relationships, memory: this.memory }),
      );
      const reactionResults = await Promise.all(reactionPromises);
      results.push(...reactionResults);

      // 处理反应中产生的 talk 关系变化
      for (const r of reactionResults) {
        if (r.action?.name === "talk" && r.action.args.target) {
          const targetId = this._resolveCharacterId(r.action.args.target as string);
          this.relationships.modify(r.characterId, targetId, 3, gameTime.tick, r.result?.description ?? "回复");
        }
      }

      // 如果没有人回复 talk，停止反应轮
      const hasNewTalk = reactionResults.some((r) => r.action?.name === "talk");
      if (!hasNewTalk) break;
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
