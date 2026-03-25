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
import type { ImpressionStore } from "../memory/impressions.js";
import { getWorkIncome, getConsumptionCost } from "../world/economy.js";
import { getTodayFestival } from "../world/festivals.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt-builder.js";
import { buildToolList, type ToolBuildContext } from "./tool-builder.js";
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
  impressions?: ImpressionStore;
  /** 对话模式覆盖：如果提供，跳过标准 prompt 构建，直接使用这个 LLM request */
  conversationRequest?: LLMRequest;
}): Promise<AgentTickResult> {
  const { config, world, eventBus, gameTime } = params;
  const { card, actions, provider, modelId } = config;

  const state = world.getCharacter(card.id);
  if (!state) {
    return { characterId: card.id, thought: "", skipped: true, skipReason: "角色不存在" };
  }

  // 如果正在执行多 tick 行为：
  // - 有信箱消息时中断行为来回应（真人被搭话也会停下来）
  // - 没有消息时继续执行
  if (state.currentAction && state.currentAction.remainingTicks > 0) {
    const hasInboxMessages = state.inbox.length > 0;
    if (!hasInboxMessages) {
      state.currentAction.remainingTicks--;
      return {
        characterId: card.id,
        thought: `继续${state.currentAction.name}`,
        skipped: true,
        skipReason: `执行中: ${state.currentAction.name} (还剩 ${state.currentAction.remainingTicks} tick)`,
      };
    }
    // 有人对我说话了 — 中断当前行为来回应
    state.currentAction = undefined;
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
      // 可观察状态：描述这个角色当前在做什么
      const currentAction = c.currentAction
        ? describeObservableAction(c.name, c.currentAction.name)
        : undefined;
      return { id: c.id, name: c.name, relationship: rel ? { level: rel.level, type: rel.type, bond: rel.bond } : undefined, currentAction };
    });

  const recentEvents = eventBus.query({ actorId: card.id, limit: 5 });
  const recentMemories = params.memory?.formatForPrompt(card.id, 8) ?? "";

  // 动态组装工具列表（情境工具系统）
  const dynamicActions = buildToolList({
    state,
    card,
    location: location ?? { id: state.locationId, name: state.locationId, type: "public", presentCharacters: [] },
    nearbyCharacters: nearbyCharacters.map((c) => ({ id: c.id, name: c.name })),
    allLocations: world.getAllLocations(),
    gold: state.gold,
    relationships: params.relationships,
  });

  // 构建 prompt
  const workplaceId = state.life?.workplace ?? card.life?.workplace;
  const workplaceName = workplaceId ? world.getLocation(workplaceId)?.name : undefined;
  const systemPrompt = buildSystemPrompt(card, workplaceName);
  const userPrompt = buildUserPrompt({
    card,
    state,
    gameTime,
    nearbyCharacters,
    recentEvents,
    locationName: location?.name ?? state.locationId,
    locationType: location?.type ?? "public",
    allLocationNames: [], // 不再需要，地点信息在 go_to 工具参数里
    recentMemories,
    weather: world.weather,
    festivalHint: getTodayFestival(gameTime.season, gameTime.seasonDay)?.promptHint,
    inboxMessages,
    atmosphere: location?.atmosphere,
    impressions: params.impressions,
    characterNames: new Map(world.getAllCharacters().map((c) => [c.id, c.name])),
  });

  // 对话模式：如果提供了 conversationRequest，使用它替代标准 prompt
  const request: LLMRequest = params.conversationRequest ?? (() => {
    const isSocialScene = nearbyCharacters.length > 0 || inboxMessages.length > 0;
    return {
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: dynamicActions.map((a) => a.tool),
      temperature: 0.8,
      maxTokens: isSocialScene ? 1024 : 512,
    };
  })();

  // 调用 LLM
  let response;
  try {
    response = await provider.chat(request, modelId);
  } catch (err: any) {
    console.error(`[${card.id}] LLM 调用失败:`, err?.message ?? err);
    return { characterId: card.id, thought: "", skipped: true, skipReason: "LLM 调用失败" };
  }

  const thought = response.content;

  // 检测 token 截断
  if (response.finishReason === "length") {
    console.warn(`[${card.id}] ⚠️ LLM 输出被截断 (finish_reason=length)，maxTokens 可能不够`);
  }

  // 如果没有工具调用，也回退
  if (response.toolCalls.length === 0) {
    console.warn(`[${card.id}] LLM 未调用工具 | thought: ${thought.slice(0, 60)} | 可用工具: ${dynamicActions.map(a => a.tool.name).join(",")}`);
    return { characterId: card.id, thought, skipped: true, skipReason: "LLM 未调用工具" };
  }

  // 执行第一个工具调用
  const toolCall = response.toolCalls[0]!;
  const availableNames = dynamicActions.map(a => a.tool.name);
  console.log(`[${card.id}] 工具=${toolCall.name} | 可用=${availableNames.join(",")}`);
  if (!availableNames.includes(toolCall.name)) {
    console.log(`[${card.id}] ⚠️ 不存在的工具: ${toolCall.name}`);
  }
  const result = await executeAction(toolCall, dynamicActions, card, state, world, eventBus, gameTime, thought);

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

  // 存入短期记忆：行为结果
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

  // 存入短期记忆：内心想法（让角色记住自己想过什么）
  if (params.memory && thought && thought.length > 5) {
    params.memory.add(card.id, {
      tick: gameTime.tick,
      type: "thought",
      content: truncateThought(thought, 150),
      importance: 3,
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
  // 确定当前工作技能：如果角色在自己的工作地点，提取第一个技能作为工作技能
  const life = state.life ?? card.life;
  let workSkill: string | undefined;
  if (life && state.locationId === life.workplace) {
    const skillKeys = Object.keys(life.skills);
    workSkill = skillKeys.length > 0 ? skillKeys[0] : undefined;
  }
  const ctx = {
    characterId: card.id,
    locationId: state.locationId,
    locationType: location?.type ?? "public",
    tick: gameTime.tick,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id),
    gold: state.gold,
    needs: { ...state.needs },
    workSkill,
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
      case "skill_up":
        if (effect.skill && effect.delta !== undefined && state.life) {
          const current = state.life.skills[effect.skill] ?? 0;
          state.life.skills[effect.skill] = Math.min(10, current + effect.delta);
        }
        break;
    }
  }

  // 经济效果
  // 地点工具的消费（eat/drink/buy 等）
  const toolCost = (result as any)?._cost;
  if (typeof toolCost === "number") {
    state.gold = Math.max(0, state.gold - toolCost);
  }
  if (toolCall.name === "work") {
    state.gold += state.life?.income ?? card.life?.income ?? getWorkIncome(card.occupation);
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

/** 截断思考文本，在中文句号/！/？处断开 */
function truncateThought(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  // 找最后一个句子结束符
  const lastSentenceEnd = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
  );
  if (lastSentenceEnd > maxChars * 0.4) {
    return slice.slice(0, lastSentenceEnd + 1);
  }
  return slice + "…";
}

/** 将 action name 转为第三人称可观察的描述 */
export function describeObservableAction(name: string, action: string): string {
  const descriptions: Record<string, string> = {
    eat: "正在吃东西",
    sleep: "在睡觉",
    work: "在工作",
    read: "在看书",
    hobby: "在做自己的事",
    drink: "在喝东西",
    explore: "在四处逛逛",
    wash: "不在（在洗漱）",
    gossip: "在跟人聊八卦",
    talk: "在跟人说话",
  };
  return descriptions[action] ?? `在${action}`;
}

