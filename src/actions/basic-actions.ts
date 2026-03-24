/**
 * Basic Actions — 基础行为工具（eat, sleep, go_to, talk, work, wash）
 *
 * 约束检查在 handler 内：不满足前置条件 → success: false
 */

import type { ActionDefinition, ActionResult, ActionContext } from "./types.js";
import { getConsumptionCost } from "../world/economy.js";

export const eatAction: ActionDefinition = {
  tool: {
    name: "eat",
    description: "去吃饭，恢复饥饿值。在家免费，在商业地点需要 15 金币。",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "吃饭的地点 ID（如 cafe, bar, 或自己的家）",
        },
        food: {
          type: "string",
          description: "吃什么（可选，如 '面条', '三明治'）",
        },
      },
      required: ["location"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const food = (args.food as string) ?? "一顿简单的饭";
    const location = args.location as string;
    const cost = getConsumptionCost("eat", location);
    if (cost > 0 && ctx.gold < cost) {
      return { description: `想在${location}吃饭，但钱不够（需要${cost}金币，只有${ctx.gold}）`, effects: [], success: false };
    }
    return {
      description: `在${location}吃了${food}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: 50 },
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: 10 },
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: 5 },
      ],
      duration: 2,
    };
  },
};

export const sleepAction: ActionDefinition = {
  tool: {
    name: "sleep",
    description: "回家睡觉，恢复精力。必须在自己家里才能睡。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    if (ctx.locationType !== "residential") {
      return { description: "这里不是家，睡不了，得先回家", effects: [], success: false };
    }
    return {
      description: "回家睡觉了",
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: 100 },
      ],
      duration: 32,
    };
  },
};

export const goToAction: ActionDefinition = {
  tool: {
    name: "go_to",
    description: "移动到小镇中的某个地点。",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "目标地点 ID（如 cafe, plaza, beach, library, shop, bar, farm, forest）",
        },
      },
      required: ["location"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const location = args.location as string;
    return {
      description: `前往${location}`,
      effects: [
        { type: "location_change", targetId: ctx.characterId, value: location },
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -2 },
      ],
      duration: 1,
    };
  },
};

export const talkAction: ActionDefinition = {
  tool: {
    name: "talk",
    description: "在当前地点当面对某人说一句话。对方必须在你当前的位置才能交谈。消息会送到对方的信箱，对方在下一个 tick 看到并决定是否回应。不会阻塞，在场的人也可能注意到。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "对话对象的角色 ID（必须在同一地点）",
        },
        message: {
          type: "string",
          description: "你要说的话",
        },
      },
      required: ["target", "message"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = args.target as string;
    const message = args.message as string;

    // 约束：对方必须在同一地点
    if (!ctx.nearbyCharacters.includes(target)) {
      return {
        description: `想和${target}说话，但对方不在这里`,
        effects: [],
        success: false,
      };
    }

    return {
      description: `当面向${target}说：「${message}」`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 12 },
        { type: "need_change", targetId: target, field: "social", delta: 8 },
        { type: "relationship_change", targetId: ctx.characterId, field: target, delta: 1 },
        { type: "inbox_message", targetId: target, fromName: ctx.characterId, message },
      ],
    };
  },
};

export const workAction: ActionDefinition = {
  tool: {
    name: "work",
    description: "在工作地点工作（花店、渔场等），赚取金币。精力太低（<10）时干不动。",
    parameters: {
      type: "object",
      properties: {
        activity: {
          type: "string",
          description: "具体工作内容（可选，如 '整理花束', '修补渔网'）",
        },
      },
    },
  },
  handler: (args, ctx): ActionResult => {
    if (ctx.needs.energy < 10) {
      return { description: "太累了，干不动活，需要先休息", effects: [], success: false };
    }
    const activity = (args.activity as string) ?? "工作";
    return {
      description: `在工作：${activity}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -15 },
        { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: -10 },
      ],
      duration: 8,
    };
  },
};

export const washAction: ActionDefinition = {
  tool: {
    name: "wash",
    description: "洗澡/梳洗，恢复卫生值。必须在家里才能洗。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    if (ctx.locationType !== "residential") {
      return { description: "这里没法洗澡，得先回家", effects: [], success: false };
    }
    return {
      description: "洗了个澡，焕然一新",
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "hygiene", delta: 100 },
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: 5 },
      ],
      duration: 2,
    };
  },
};

import { ALL_SOCIAL_ACTIONS } from "./social-actions.js";
import { ALL_LEISURE_ACTIONS } from "./leisure-actions.js";
import { ALL_GRAY_ACTIONS } from "./gray-actions.js";

export const ALL_BASIC_ACTIONS: ActionDefinition[] = [
  eatAction,
  sleepAction,
  goToAction,
  talkAction,
  workAction,
  washAction,
  ...ALL_SOCIAL_ACTIONS,
  ...ALL_LEISURE_ACTIONS,
  ...ALL_GRAY_ACTIONS,
];
