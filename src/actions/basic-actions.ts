/**
 * Basic Actions — 基础行为工具（eat, sleep, go_to, talk, work, wash）
 *
 * 约束检查在 handler 内：不满足前置条件 → success: false
 */

import type { ActionDefinition, ActionResult, ActionContext, ActionEffect } from "./types.js";
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
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 3 },
      ],
      duration: 2,
    };
  },
};

export const sleepAction: ActionDefinition = {
  tool: {
    name: "sleep",
    description: "回家睡觉，恢复精力。必须在自己家里才能睡。精力充足时不需要睡觉。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    if (ctx.locationType !== "residential") {
      return { description: "这里不是家，睡不了，得先回家", effects: [], success: false };
    }
    if (ctx.needs.energy >= 80) {
      return { description: "你精力充沛，现在不需要睡觉", effects: [], success: false };
    }
    return {
      description: "回家睡觉了",
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: 100 },
        { type: "need_change", targetId: ctx.characterId, field: "bladder", delta: -25 },
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
        { type: "need_change", targetId: ctx.characterId, field: "bladder", delta: -3 },
      ],
      duration: 1,
    };
  },
};

export const talkAction: ActionDefinition = {
  tool: {
    name: "talk",
    description: "在当前地点当面对某人说话。对方必须在同一位置。消息送到对方信箱，在场的人也可能注意到。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "对话对象的角色 ID（必须在同一地点）",
        },
        message: {
          type: "string",
          description: "你说出口的话（只写台词，不写心理描写）。像正常人说话一样，一两句到三四句都可以，不要太长。",
        },
        manner: {
          type: "string",
          description: "你说话时的动作、表情、语气（可选，简短白描，如'低头搓着围裙边角'、'视线移向窗外'）",
        },
      },
      required: ["target", "message"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = args.target as string;
    const message = args.message as string;
    const manner = args.manner as string | undefined;

    // 约束：对方必须在同一地点
    if (!ctx.nearbyCharacters.includes(target)) {
      return {
        description: `想和${target}说话，但对方不在这里`,
        effects: [],
        success: false,
      };
    }

    // 构建叙事描述
    const mannerText = manner ? `${manner}，` : "";
    const description = `${mannerText}对${target}说：「${message}」`;

    return {
      description,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 3 },
        { type: "need_change", targetId: target, field: "social", delta: 1 },
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 2 },
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
    const effects: ActionEffect[] = [
      { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -15 },
      { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: -10 },
      { type: "need_change", targetId: ctx.characterId, field: "fun", delta: -10 },
      { type: "need_change", targetId: ctx.characterId, field: "bladder", delta: -10 },
    ];
    // 工作时提升对应技能
    if (ctx.workSkill) {
      effects.push({ type: "skill_up", targetId: ctx.characterId, skill: ctx.workSkill, delta: 0.1 });
    }
    return {
      description: `在工作：${activity}`,
      effects,
      duration: 8,
    };
  },
};

export const washAction: ActionDefinition = {
  tool: {
    name: "wash",
    description: "洗澡/梳洗，恢复卫生值。必须在家里才能洗。卫生值高于 80 时不需要洗。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    if (ctx.locationType !== "residential") {
      return { description: "这里没法洗澡，得先回家", effects: [], success: false };
    }
    if (ctx.needs.hygiene >= 80) {
      return { description: "你已经很干净了，不需要再洗", effects: [], success: false };
    }
    return {
      description: "洗了个澡，焕然一新",
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "hygiene", delta: 100 },
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 5 },
      ],
      duration: 2,
    };
  },
};

export const useToiletAction: ActionDefinition = {
  tool: {
    name: "use_toilet",
    description: "上厕所，恢复膀胱值。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => ({
    description: "上厕所",
    effects: [
      { type: "need_change", targetId: ctx.characterId, field: "bladder", delta: 100 },
    ],
    duration: 1,
  }),
};

export const napAction: ActionDefinition = {
  tool: {
    name: "nap",
    description: "小睡一会儿，恢复少量精力。精力低于 60 时才需要。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    if (ctx.needs.energy >= 60) {
      return { description: "精力还行，不需要小睡", effects: [], success: false };
    }
    return {
      description: "小睡了一会儿",
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: 25 },
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: -5 },
      ],
      duration: 4,
    };
  },
};

export const cookAction: ActionDefinition = {
  tool: {
    name: "cook",
    description: "做饭，恢复饥饿值并获得乐趣。需要在家，花费 5 金币。",
    parameters: {
      type: "object",
      properties: {
        dish: {
          type: "string",
          description: "做什么菜（可选）",
        },
      },
    },
  },
  handler: (args, ctx): ActionResult => {
    if (ctx.locationType !== "residential") {
      return { description: "这里没有厨房，得回家才能做饭", effects: [], success: false };
    }
    if (ctx.gold < 5) {
      return { description: `想做饭但买不起食材（需要5金币，只有${ctx.gold}）`, effects: [], success: false };
    }
    const dish = (args.dish as string) ?? "一顿家常菜";
    return {
      description: `做了${dish}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: 60 },
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 5 },
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -8 },
        { type: "need_change", targetId: ctx.characterId, field: "hygiene", delta: -5 },
      ],
      duration: 3,
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
  useToiletAction,
  napAction,
  cookAction,
  ...ALL_SOCIAL_ACTIONS,
  ...ALL_LEISURE_ACTIONS,
  ...ALL_GRAY_ACTIONS,
];
