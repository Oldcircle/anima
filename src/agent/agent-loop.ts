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
import { narrateAction } from "../memory/memory-narrator.js";
import { applySocialModifier } from "./social-modifier.js";
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
  talkCooldownTargets?: string[];
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
    world.setIntent(card.id, {
      kind: "recover",
      source: "action",
      summary: `刚才还在${describeInterruptedAction(state.currentAction.name)}，被人叫住了。`,
      createdTick: gameTime.tick,
      expiresAt: gameTime.tick + 4,
    });
    state.currentAction = undefined;
  }

  const currentIntent = world.getCurrentIntent(card.id, gameTime.tick);

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
      const observable = world.getObservableState(c.id, gameTime.tick);
      const currentAction = observable?.summary
        ?? (c.currentAction ? describeObservableAction(c.name, c.currentAction.name) : undefined);
      return { id: c.id, name: c.name, relationship: rel ? { level: rel.level, type: rel.type, bond: rel.bond } : undefined, currentAction };
    });

  const recentEvents = eventBus.query({ actorId: card.id, limit: 5 });
  const recentMemories = params.memory?.formatForPrompt(card.id, 12) ?? "";

  // 动态组装工具列表（情境工具系统）
  const dynamicActions = buildToolList({
    state,
    card,
    location: location ?? { id: state.locationId, name: state.locationId, type: "public", presentCharacters: [] },
    nearbyCharacters: nearbyCharacters.map((c) => ({ id: c.id, name: c.name })),
    talkCooldownTargets: params.talkCooldownTargets,
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: gameTime.hour,
    relationships: params.relationships,
  });

  // 构建 prompt
  const workplaceId = state.life?.workplace ?? card.life?.workplace;
  const workplaceName = workplaceId ? world.getLocation(workplaceId)?.name : undefined;
  // 查找同事名字（bond=colleague 的关系）
  const colleagueNames: string[] = [];
  if (params.relationships) {
    for (const { otherId, relationship: rel } of params.relationships.getRelationshipsOf(card.id)) {
      if (rel.bond === "colleague") {
        const other = world.getCharacter(otherId);
        if (other) colleagueNames.push(other.name);
      }
    }
  }
  const systemPrompt = buildSystemPrompt(card, workplaceName, colleagueNames);
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
    currentIntent,
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
    persistInboxContext({ world, characterId: card.id, inboxMessages, memory: params.memory });
    updateCurrentIntent({
      world,
      characterId: card.id,
      gameTime,
      inboxMessages,
    });
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
    persistInboxContext({ world, characterId: card.id, inboxMessages, memory: params.memory });
    updateCurrentIntent({
      world,
      characterId: card.id,
      gameTime,
      inboxMessages,
    });
    return { characterId: card.id, thought, skipped: true, skipReason: "LLM 未调用工具" };
  }

  // 执行第一个工具调用
  const toolCall = response.toolCalls[0]!;
  const availableNames = dynamicActions.map(a => a.tool.name);
  console.log(`[${card.id}] 工具=${toolCall.name} | 可用=${availableNames.join(",")}`);
  if (!availableNames.includes(toolCall.name)) {
    console.log(`[${card.id}] ⚠️ 不存在的工具: ${toolCall.name}`);
  }
  const result = await executeAction(toolCall, dynamicActions, card, state, world, eventBus, gameTime, thought, params.relationships);

  // 收到的信箱消息存入记忆，并给读信者加社交
  persistInboxContext({ world, characterId: card.id, inboxMessages, memory: params.memory });

  // 存入短期记忆：行为结果（自然语言回忆，不是系统日志）
  if (params.memory && result.result) {
    const isFailed = result.result.success === false;
    const location = world.getLocation(state.locationId);
    // 将 target ID 解析为显示名，让记忆里是"对丰川祥子说"而不是"对sakiko说"
    const narrateArgs = { ...toolCall.arguments };
    if (narrateArgs.target) {
      const targetChar = world.getCharacter(narrateArgs.target as string);
      if (targetChar) narrateArgs.target = targetChar.name;
    }
    const narrated = narrateAction({
      toolName: toolCall.name,
      args: narrateArgs,
      description: result.result.description,
      locationName: location?.name,
      characterName: state.name,
      success: result.result.success,
    });
    params.memory.add(card.id, {
      tick: gameTime.tick,
      type: "event",
      content: narrated,
      importance: isFailed ? 8 : toolCall.name === "talk" ? 7 : 4,
      relatedCharacterId: toolCall.name === "talk" ? toolCall.arguments.target as string : undefined,
    });
  }

  // 存入短期记忆：内心想法（让角色记住自己想过什么）
  if (params.memory && thought && thought.length > 5) {
    params.memory.add(card.id, {
      tick: gameTime.tick,
      type: "thought",
      content: truncateThought(thought, 200),
      importance: 3,
    });
  }

  updateCurrentIntent({
    world,
    characterId: card.id,
    gameTime,
    inboxMessages,
    result,
  });

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
  relationships?: RelationshipManager,
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
  // 员工工具收入（worker_tools 中带 income 的）
  const workerIncome = (result as any)?._workerIncome;
  if (typeof workerIncome === "number") {
    state.gold += workerIncome;
  }
  // 旧 work 兜底（向后兼容）
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

  // 物品效果
  const buyItem = (result as any)?._buyItem;
  const eatImmediate = (result as any)?._eatImmediate;
  if (buyItem && typeof buyItem === "object") {
    state.gold = Math.max(0, state.gold - buyItem.price);
    if (!eatImmediate) {
      // 普通购买：物品入背包
      const { addToInventory } = await import("../world/item-registry.js");
      addToInventory(state.inventory, buyItem.defId, 1, { obtainedTick: world.tick });
    }
    // eatImmediate: 买了直接吃，不入背包（效果已在 effects 中）
  }
  const useItem = (result as any)?._useItem;
  if (typeof useItem === "string" && !eatImmediate) {
    // 从背包消耗（eatImmediate 时不需要，因为没入过背包）
    const { removeFromInventory, getItemDef, hasItem: checkHas } = await import("../world/item-registry.js");
    const def = getItemDef(useItem);
    if (def?.type === "consumable" || def?.type === "material" || (def?.type === "gift" && def.effects)) {
      if (checkHas(state.inventory, useItem)) {
        removeFromInventory(state.inventory, useItem, 1);
      } else {
        console.warn(`[${card.id}] 想使用 ${useItem} 但背包里没有`);
      }
    }
  }
  const giveItem = (result as any)?._giveItem;
  if (giveItem && typeof giveItem === "object") {
    const { removeFromInventory, addToInventory } = await import("../world/item-registry.js");
    const removed = removeFromInventory(state.inventory, giveItem.defId, 1);
    if (removed) {
      const target = world.getCharacter(giveItem.targetId);
      if (target) {
        addToInventory(target.inventory, giveItem.defId, 1, {
          giftedBy: state.name,
          obtainedTick: world.tick,
        });
      }
    }
  }

  // 社交修正：有认识的人在场时自动调整效果
  let socialObservableOverride: string | undefined;
  if (relationships) {
    const nearbyIds = world.getCharactersAtLocation(state.locationId).filter((id) => id !== card.id);
    const socialMod = applySocialModifier({
      actionName: toolCall.name,
      result,
      actorId: card.id,
      nearbyCharacterIds: nearbyIds,
      relationships,
      getCharacterName: (id) => world.getCharacter(id)?.name ?? id,
    });
    if (socialMod.applied) {
      // 应用额外效果
      for (const effect of socialMod.extraEffects) {
        if (effect.type === "need_change" && effect.field && effect.delta !== undefined) {
          world.modifyNeed(effect.targetId, effect.field as any, effect.delta);
        }
      }
      socialObservableOverride = socialMod.observableState;
    }
  }

  // 行为链追踪
  if (!state.recentActions) state.recentActions = [];
  state.recentActions.push({ actionId: toolCall.name, tick: world.tick });
  // 只保留最近 16 tick
  if (state.recentActions.length > 16) {
    state.recentActions = state.recentActions.slice(-16);
  }

  // 设置多 tick 行为
  if (result.duration && result.duration > 1) {
    state.currentAction = { name: toolCall.name, remainingTicks: result.duration - 1 };
  } else {
    state.currentAction = undefined;
  }

  const observableSummary = socialObservableOverride ?? result.observableState ?? deriveObservableState({
    toolName: toolCall.name,
    args: toolCall.arguments,
    result,
    world,
    actorId: card.id,
    tick: gameTime.tick,
  });
  if (observableSummary) {
    world.setObservableState(card.id, {
      actionName: toolCall.name,
      source: "action",
      summary: observableSummary,
      targetId: typeof toolCall.arguments.target === "string" ? resolveCharacterId(world, toolCall.arguments.target) : undefined,
      createdTick: gameTime.tick,
      expiresAt: gameTime.tick + Math.max(result.duration ?? 1, 2),
    });
  } else if (!state.currentAction) {
    world.clearObservableState(card.id);
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

function persistInboxContext(params: {
  world: World;
  characterId: string;
  inboxMessages: { fromId: string; fromName: string; content: string; tick: number }[];
  memory?: ShortTermMemory;
}): void {
  const { world, characterId, inboxMessages, memory } = params;
  if (inboxMessages.length === 0) return;
  for (const msg of inboxMessages) {
    if (memory) {
      memory.add(characterId, {
        tick: msg.tick,
        type: "conversation",
        content: `${msg.fromName}对你说：「${msg.content}」`,
        importance: 7,
        relatedCharacterId: msg.fromId,
      });
    }
    world.modifyNeed(characterId, "social", 5);
  }
}

function updateCurrentIntent(params: {
  world: World;
  characterId: string;
  gameTime: GameTime;
  inboxMessages: { fromId: string; fromName: string; content: string; tick: number }[];
  result?: AgentTickResult;
}): void {
  const { world, characterId, gameTime, inboxMessages, result } = params;

  if (result?.result?.success === false && result.action) {
    world.setIntent(characterId, {
      kind: "recover",
      source: "action",
      targetId: typeof result.action.args.target === "string" ? result.action.args.target as string : undefined,
      summary: `刚才想${result.result.description}，这件事还挂在心上。`,
      createdTick: gameTime.tick,
      expiresAt: gameTime.tick + 4,
    });
    return;
  }

  const latestMessage = inboxMessages[inboxMessages.length - 1];
  const actionTarget = typeof result?.action?.args.target === "string"
    ? result.action.args.target as string
    : undefined;
  const repliedToLatest = result?.action?.name === "talk"
    && latestMessage
    && actionTarget === latestMessage.fromId;

  if (latestMessage && !repliedToLatest) {
    world.setIntent(characterId, {
      kind: "reply",
      source: "message",
      targetId: latestMessage.fromId,
      summary: `${latestMessage.fromName}刚刚对你说了「${truncateLine(latestMessage.content, 24)}」，你还没回应。`,
      createdTick: gameTime.tick,
      expiresAt: gameTime.tick + 4,
    });
    return;
  }

  if (result?.action?.name === "talk" && result.result?.success !== false && actionTarget && repliedToLatest) {
    const targetName = world.getCharacter(resolveCharacterId(world, actionTarget))?.name ?? actionTarget;
    world.setIntent(characterId, {
      kind: "follow_up",
      source: "action",
      targetId: resolveCharacterId(world, actionTarget),
      summary: `刚和${targetName}搭上话，也许还能顺着聊下去。`,
      createdTick: gameTime.tick,
      expiresAt: gameTime.tick + 1,
    });
    return;
  }

  if (result?.action?.name === "go_to" && result.result?.success !== false) {
    const rawLocation = result.action.args.location as string | undefined;
    const locationName = rawLocation ? (world.getLocation(rawLocation)?.name ?? rawLocation) : "这里";
    world.setIntent(characterId, {
      kind: "plan",
      source: "movement",
      summary: `刚到${locationName}。先看看这里现在适合做什么。`,
      createdTick: gameTime.tick,
      expiresAt: gameTime.tick + 2,
    });
    return;
  }

  if (result?.action && result.result?.success !== false) {
    const existing = world.getCurrentIntent(characterId, gameTime.tick);
    if (existing && existing.targetId && actionTarget && existing.targetId === actionTarget) {
      world.clearIntent(characterId);
    }
  }
}

function deriveObservableState(params: {
  toolName: string;
  args: Record<string, unknown>;
  result: ActionResult;
  world: World;
  actorId: string;
  tick: number;
}): string | undefined {
  const { toolName, args, result, world } = params;
  const targetId = typeof args.target === "string" ? resolveCharacterId(world, args.target) : undefined;
  const targetName = targetId ? (world.getCharacter(targetId)?.name ?? args.target as string) : undefined;
  const item = typeof args.item === "string" ? args.item : undefined;
  const message = typeof args.message === "string" ? args.message : undefined;
  const manner = typeof args.manner === "string" ? args.manner : undefined;

  switch (toolName) {
    case "go_to": {
      const rawLocation = typeof args.location === "string" ? args.location : undefined;
      const locationName = rawLocation ? (world.getLocation(rawLocation)?.name ?? rawLocation) : "别处";
      return `刚走进${locationName}，像是在找个能待下来的位置。`;
    }
    case "talk":
      return `${manner ? `${manner}，` : ""}正和${targetName ?? "旁边的人"}说话。`;
    case "eat":
      return `正在慢慢吃${item ?? "手里的食物"}。`;
    case "drink":
      return `手里端着${item ?? "一杯饮料"}，慢慢喝着。`;
    case "use_toilet":
      return "刚从洗手间回来。";
    case "cook":
      return "在厨房里忙着做饭，锅里冒着热气。";
    case "buy":
      return `手里拿着刚买的${item ?? "东西"}。`;
    case "give":
      return `正把${item ?? "手里的东西"}递给${targetName ?? "对方"}。`;
    case "prepare":
      return `正在做${item ?? "店里的东西"}，动作很熟练。`;
    case "journal":
      return "低头写着什么，神情很专注。";
    case "practice_music":
      return "在安静地练习吉他。";
    case "read":
      return "抱着一本书看得有些入神。";
    case "collect_shells":
      return "蹲在地上认真挑拣贝壳。";
    case "walk":
    case "walk_beach":
      return "沿着路慢慢走着，像在想事情。";
    case "comfort":
      return `正低声安慰${targetName ?? "旁边的人"}。`;
    case "argue":
      return `和${targetName ?? "旁边的人"}之间的气氛有点僵。`;
    default:
      return fallbackObservableState(toolName, result.description, message);
  }
}

function fallbackObservableState(toolName: string, description: string, message?: string): string | undefined {
  const generic: Record<string, string> = {
    work: "在埋头工作。",
    knead_dough: "在揉面团，动作很专注。",
    bake: "守在烤箱边忙着看火。",
    make_coffee: "在吧台后做咖啡。",
    serve_customer: "在招呼客人、收拾桌面。",
    clean_table: "正弯腰擦着桌子。",
    arrange_flowers: "在修剪花枝、整理花束。",
    shelve_books: "抱着一摞书在整理书架。",
    help_reader: "正耐心给读者指路。",
    rest: "安静地坐着休息。",
  };
  if (generic[toolName]) return generic[toolName];
  if (toolName === "talk" && message) return `刚说了句：「${truncateLine(message, 18)}」`;
  if (!description) return undefined;
  return `刚才${description.replace(/^在/, "").replace(/^回家/, "")}`;
}

function resolveCharacterId(world: World, raw: string): string {
  const charById = world.getCharacter(raw);
  if (charById) return raw;
  const lower = raw.toLowerCase();
  const exact = world.getAllCharacters().find((c) => c.name.toLowerCase() === lower);
  return exact?.id ?? raw;
}

function truncateLine(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "…";
}

function describeInterruptedAction(actionName: string): string {
  const interrupted: Record<string, string> = {
    sleep: "睡觉",
    cook: "做饭",
    read: "看书",
    work: "忙工作",
    knead_dough: "揉面团",
    bake: "看着面包出炉",
    make_coffee: "做咖啡",
    rest: "发呆休息",
  };
  return interrupted[actionName] ?? `忙着${actionName}`;
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
    rest: "安静地休息着",
    cook: "在做饭",
    use_toilet: "刚离开去洗手间了",
    knead_dough: "在揉面团",
    bake: "在看着烤箱",
    make_coffee: "在做咖啡",
    serve_customer: "在招呼客人",
    clean_table: "在擦桌子",
    give: "在把东西递给别人",
    prepare: "在做店里的东西",
  };
  return descriptions[action] ?? `在${action}`;
}
