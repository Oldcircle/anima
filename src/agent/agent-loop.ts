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

  // 如果在对话中，跳过
  if (state.inConversation) {
    return { characterId: card.id, thought: "", skipped: true, skipReason: "对话中" };
  }

  // 获取上下文
  const location = world.getLocation(state.locationId);
  const nearbyIds = world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id);

  // 日程兜底：如果没有新刺激，按日程行动（不调 LLM）
  const hasLowNeed = state.needs.hunger < 25 || state.needs.energy < 20 || state.needs.social < 15;
  const hasNearby = nearbyIds.length > 0;
  const recentMemoryCount = params.memory?.getRecent(card.id, 3).length ?? 0;
  const needsLLM = hasLowNeed || hasNearby || recentMemoryCount < 2;

  if (!needsLLM) {
    // 按日程执行：找到当前时间段的日程，转化为行为
    const hourStr = `${String(gameTime.hour).padStart(2, "0")}:00`;
    const routine = card.dailyRoutine[hourStr];
    if (routine) {
      // 简单映射日程到默认工具
      const defaultAction = routine.includes("营业") || routine.includes("工作") || routine.includes("钓鱼") || routine.includes("烤")
        ? { name: "work", arguments: { activity: routine } }
        : routine.includes("午餐") || routine.includes("吃")
        ? { name: "eat", arguments: { location: state.locationId } }
        : routine.includes("散步") || routine.includes("探索")
        ? { name: "explore", arguments: { area: routine } }
        : routine.includes("阅读") || routine.includes("读")
        ? { name: "read", arguments: { book: routine } }
        : null;

      if (defaultAction) {
        const actionDef = actions.find((a) => a.tool.name === defaultAction.name);
        if (actionDef) {
          return await executeAction(
            defaultAction as any, actions, card, state, world, eventBus, gameTime,
            `（按日程）${routine}`,
          );
        }
      }
    }
  }
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
    weather: world.weather,
    festivalHint: getTodayFestival(gameTime.season, gameTime.seasonDay)?.promptHint,
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

  // 经济效果
  if (toolCall.name === "work") {
    state.gold += getWorkIncome(card.occupation);
  } else if (toolCall.name === "eat" || toolCall.name === "drink") {
    const cost = getConsumptionCost(toolCall.name, state.locationId);
    state.gold = Math.max(0, state.gold - cost);
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
