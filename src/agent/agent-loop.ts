/**
 * Agent Loop — 单角色决策循环
 *
 * 每个 tick 对角色执行：构建 prompt → LLM 决策 → 执行行为 → 更新世界
 */

import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";
import type { World } from "../world/world.js";
import type { EventBus, WorldEvent } from "../core/event-bus.js";
import type { GameTime } from "../core/tick-engine.js";
import type { LLMProvider, LLMRequest, ToolCall } from "../providers/types.js";
import type { ActionDefinition, ActionResult } from "../actions/types.js";
import type { RelationshipManager } from "../world/relationships.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import { getWorkIncome, getConsumptionCost } from "../world/economy.js";
import { getTodayFestival } from "../world/festivals.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt-builder.js";
import { v4 as uuid } from "uuid";

export interface AgentConfig {
  card: CharacterCard;
  actions: ActionDefinition[];
  provider: LLMProvider;
  modelId: string;
}

export interface AgentTickResult {
  characterId: string;
  thought: string;
  action?: { name: string; args: Record<string, unknown> };
  result?: ActionResult;
  skipped?: boolean;
  skipReason?: string;
}

export async function runAgentTick(params: {
  config: AgentConfig;
  world: World;
  eventBus: EventBus;
  gameTime: GameTime;
  relationships?: RelationshipManager;
  memory?: ShortTermMemory;
}): Promise<AgentTickResult> {
  const { config, world, eventBus, gameTime } = params;
  const { card, actions, provider, modelId } = config;

  const state = world.getCharacter(card.id);
  if (!state) {
    return { characterId: card.id, thought: "", skipped: true, skipReason: "角色不存在" };
  }

  // 如果正在执行多 tick 行为，跳过（惰性决策）
  if (state.currentAction && state.currentAction.remainingTicks > 0) {
    state.currentAction.remainingTicks--;
    return {
      characterId: card.id,
      thought: `继续${state.currentAction.name}`,
      skipped: true,
      skipReason: `执行中: ${state.currentAction.name} (还剩 ${state.currentAction.remainingTicks} tick)`,
    };
  }

  // 获取上下文
  const location = world.getLocation(state.locationId);
  const nearbyIds = world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id);

  // 消费信箱消息
  const inboxMessages = params.world.consumeInbox(card.id);

  const nearbyCharacters = nearbyIds
    .map((id) => world.getCharacter(id))
    .filter((c): c is CharacterState => c !== undefined)
    .map((c) => {
      const rel = params.relationships?.get(card.id, c.id);
      return { id: c.id, name: c.name, relationship: rel };
    });

  const recentEvents = eventBus.query({ actorId: card.id, limit: 5 });
  const recentMemories = params.memory?.formatForPrompt(card.id, 8) ?? "";

  // 构建 prompt
  const systemPrompt = buildSystemPrompt(card);
  const allLocationNames = world.getAllLocations().map((l) => ({ id: l.id, name: l.name }));
  const userPrompt = buildUserPrompt({
    card,
    state,
    gameTime,
    nearbyCharacters,
    recentEvents,
    locationName: location?.name ?? state.locationId,
    locationType: location?.type ?? "public",
    allLocationNames,
    recentMemories,
    weather: world.weather,
    festivalHint: getTodayFestival(gameTime.season, gameTime.seasonDay)?.promptHint,
    inboxMessages,
  });

  const request: LLMRequest = {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: actions.map((a) => a.tool),
    temperature: 0.8,
    maxTokens: 512,
  };

  // 调用 LLM
  let response;
  try {
    response = await provider.chat(request, modelId);
  } catch (err) {
    return { characterId: card.id, thought: "", skipped: true, skipReason: "LLM 调用失败" };
  }

  const thought = response.content;

  // 如果没有工具调用，也回退
  if (response.toolCalls.length === 0) {
    return { characterId: card.id, thought, skipped: true, skipReason: "LLM 未调用工具" };
  }

  // 执行第一个工具调用
  const toolCall = response.toolCalls[0]!;
  const result = await executeAction(toolCall, actions, card, state, world, eventBus, gameTime, thought);

  // 收到的信箱消息存入记忆，并给读信者加社交
  if (inboxMessages.length > 0) {
    for (const msg of inboxMessages) {
      if (params.memory) {
        params.memory.add(card.id, {
          tick: msg.tick,
          type: "conversation",
          content: `${msg.fromName}对你说：「${msg.content}」`,
          importance: 7,
          relatedCharacterId: msg.fromId,
        });
      }
      // 收到消息本身也提升社交
      world.modifyNeed(card.id, "social", 5);
    }
  }

  // 存入短期记忆
  if (params.memory && result.result) {
    const isFailed = result.result.success === false;
    params.memory.add(card.id, {
      tick: gameTime.tick,
      type: "event",
      content: isFailed ? `[失败] ${result.result.description}` : result.result.description,
      importance: isFailed ? 8 : toolCall.name === "talk" ? 7 : 4,
      relatedCharacterId: toolCall.name === "talk" ? toolCall.arguments.target as string : undefined,
    });
  }

  return result;
}

async function executeAction(
  toolCall: ToolCall,
  actions: ActionDefinition[],
  card: CharacterCard,
  state: CharacterState,
  world: World,
  eventBus: EventBus,
  gameTime: GameTime,
  thought: string,
): Promise<AgentTickResult> {
  const actionDef = actions.find((a) => a.tool.name === toolCall.name);
  if (!actionDef) {
    return { characterId: card.id, thought, skipped: true, skipReason: `未知行为: ${toolCall.name}` };
  }

  const location = world.getLocation(state.locationId);
  const ctx = {
    characterId: card.id,
    locationId: state.locationId,
    locationType: location?.type ?? "public",
    tick: gameTime.tick,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id),
    gold: state.gold,
    needs: { ...state.needs },
  };

  const result = actionDef.handler(toolCall.arguments, ctx);

  // 约束失败：不应用效果，不设 duration，但广播事件和存记忆
  if (result.success === false) {
    const event: WorldEvent = {
      id: uuid(),
      tick: gameTime.tick,
      type: `action.${toolCall.name}.failed`,
      actorId: card.id,
      locationId: state.locationId,
      description: `${card.name} ${result.description}`,
      effects: [],
      witnesses: world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id),
    };
    await eventBus.emit(event);

    return {
      characterId: card.id,
      thought,
      action: { name: toolCall.name, args: toolCall.arguments },
      result,
    };
  }

  // 应用效果
  for (const effect of result.effects) {
    switch (effect.type) {
      case "need_change":
        if (effect.field && effect.delta !== undefined) {
          world.modifyNeed(effect.targetId, effect.field as any, effect.delta);
        }
        break;
      case "location_change":
        if (effect.value) {
          world.moveCharacter(effect.targetId, effect.value);
        }
        break;
      case "inbox_message":
        if (effect.message) {
          world.sendMessage(effect.targetId, {
            fromId: card.id,
            fromName: card.name,
            content: effect.message,
            tick: gameTime.tick,
          });
        }
        break;
    }
  }

  // 经济效果
  if (toolCall.name === "work") {
    state.gold += getWorkIncome(card.occupation);
  } else if (toolCall.name === "eat" || toolCall.name === "drink") {
    const cost = getConsumptionCost(toolCall.name, state.locationId);
    state.gold = Math.max(0, state.gold - cost);
  } else if (toolCall.name === "give_gift") {
    state.gold = Math.max(0, state.gold - 20);
  } else if (toolCall.name === "steal") {
    const stolenAmount = (result as any)._stolenAmount;
    if (typeof stolenAmount === "number") {
      state.gold += stolenAmount;
    }
  } else if (toolCall.name === "beg") {
    const begAmount = (result as any)._begAmount;
    if (typeof begAmount === "number") {
      state.gold += begAmount;
    }
  }

  // 设置多 tick 行为
  if (result.duration && result.duration > 1) {
    state.currentAction = { name: toolCall.name, remainingTicks: result.duration - 1 };
  } else {
    state.currentAction = undefined;
  }

  // 广播事件
  const event: WorldEvent = {
    id: uuid(),
    tick: gameTime.tick,
    type: `action.${toolCall.name}`,
    actorId: card.id,
    targetId: toolCall.arguments.target as string | undefined,
    locationId: state.locationId,
    description: `${card.name} ${result.description}`,
    effects: result.effects.map((e) => ({
      type: e.type,
      targetId: e.targetId,
      field: e.field,
      delta: e.delta,
      value: e.value,
    })),
    witnesses: world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id),
  };
  await eventBus.emit(event);

  return {
    characterId: card.id,
    thought,
    action: { name: toolCall.name, args: toolCall.arguments },
    result,
  };
}

