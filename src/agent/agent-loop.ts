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

  // 如果在对话中，跳过
  if (state.inConversation) {
    return { characterId: card.id, thought: "", skipped: true, skipReason: "对话中" };
  }

  // 获取上下文
  const location = world.getLocation(state.locationId);
  const nearbyIds = world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id);
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
    allLocationNames,
    recentMemories,
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
    // LLM 失败时回退到日程兜底
    return handleFallback(card, state, gameTime, world, eventBus);
  }

  const thought = response.content;

  // 如果没有工具调用，也回退
  if (response.toolCalls.length === 0) {
    return { characterId: card.id, thought, skipped: true, skipReason: "LLM 未调用工具" };
  }

  // 执行第一个工具调用
  const toolCall = response.toolCalls[0]!;
  const result = await executeAction(toolCall, actions, card, state, world, eventBus, gameTime, thought);

  // 存入短期记忆
  if (params.memory && result.result) {
    params.memory.add(card.id, {
      tick: gameTime.tick,
      type: "event",
      content: result.result.description,
      importance: toolCall.name === "talk" ? 7 : 4,
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

  const ctx = {
    characterId: card.id,
    locationId: state.locationId,
    tick: gameTime.tick,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id),
  };

  const result = actionDef.handler(toolCall.arguments, ctx);

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

/** 日程兜底：LLM 失败时按日程执行 */
function handleFallback(
  card: CharacterCard,
  state: CharacterState,
  gameTime: GameTime,
  world: World,
  eventBus: EventBus,
): AgentTickResult {
  const hourStr = `${String(gameTime.hour).padStart(2, "0")}:00`;
  const routine = card.dailyRoutine[hourStr];

  return {
    characterId: card.id,
    thought: `（日程兜底）${routine ?? "自由活动"}`,
    skipped: true,
    skipReason: "LLM 失败，使用日程兜底",
  };
}
