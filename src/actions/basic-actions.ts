/**
 * Basic Actions — 基础行为工具（Phase 1: eat, sleep, go_to, talk, work）
 */

import type { ActionDefinition, ActionResult, ActionContext } from "./types.js";

export const eatAction: ActionDefinition = {
  tool: {
    name: "eat",
    description: "去吃饭，恢复饥饿值。可以在咖啡馆、酒吧或家里吃。",
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
    return {
      description: `在${location}吃了${food}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: 50 },
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: 5 },
      ],
      duration: 2, // 30 分钟
    };
  },
};

export const sleepAction: ActionDefinition = {
  tool: {
    name: "sleep",
    description: "回家睡觉，恢复精力。只能在晚上或精力很低时使用。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    return {
      description: "回家睡觉了",
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: 100 },
        { type: "need_change", targetId: ctx.characterId, field: "hygiene", delta: -5 },
      ],
      duration: 32, // 8 小时
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
    description: "对某人说一句话。消息会送到对方的信箱，对方在下一个 tick 看到并决定是否回应。不会阻塞。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "对话对象的角色 ID",
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
    return {
      description: `对${target}说：「${message}」`,
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
    description: "在工作地点工作（花店、渔场等），赚取金币。",
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
    const activity = (args.activity as string) ?? "工作";
    return {
      description: `在工作：${activity}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -15 },
        { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: -10 },
      ],
      duration: 8, // 2 小时
    };
  },
};

import { ALL_SOCIAL_ACTIONS } from "./social-actions.js";
import { ALL_LEISURE_ACTIONS } from "./leisure-actions.js";

export const ALL_BASIC_ACTIONS: ActionDefinition[] = [
  eatAction,
  sleepAction,
  goToAction,
  talkAction,
  workAction,
  ...ALL_SOCIAL_ACTIONS,
  ...ALL_LEISURE_ACTIONS,
];
