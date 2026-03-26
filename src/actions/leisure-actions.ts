/**
 * Leisure Actions — 休闲行为工具
 */

import type { ActionDefinition, ActionResult, ActionContext } from "./types.js";

export const readAction: ActionDefinition = {
  tool: {
    name: "read",
    description: "阅读书籍或报纸。在图书馆、咖啡馆或家里都可以。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "阅读什么（可选）" },
      },
    },
  },
  handler: (args, ctx): ActionResult => ({
    description: `阅读${args.book ?? "一本书"}`,
    effects: [
      { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 10 },
      { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -3 },
      { type: "need_change", targetId: ctx.characterId, field: "social", delta: -3 },
    ],
    duration: 4, // 1 小时
  }),
};

export const exploreAction: ActionDefinition = {
  tool: {
    name: "explore",
    description: "探索周围环境，散步，欣赏风景。适合在自然区域或广场。",
    parameters: {
      type: "object",
      properties: {
        area: { type: "string", description: "探索什么（如 '海边的贝壳', '森林小径'）" },
      },
    },
  },
  handler: (args, ctx): ActionResult => ({
    description: `散步探索：${args.area ?? "四处走走"}`,
    effects: [
      { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 8 },
      { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -5 },
    ],
    duration: 4,
  }),
};

export const drinkAction: ActionDefinition = {
  tool: {
    name: "drink",
    description: "喝酒或饮料。在酒吧（12金币）或咖啡馆（8金币）消费。",
    parameters: {
      type: "object",
      properties: {
        beverage: { type: "string", description: "喝什么（如 '啤酒', '咖啡', '茶'）" },
      },
    },
  },
  handler: (args, ctx): ActionResult => {
    const cost = ctx.locationId === "bar" ? 12 : 8;
    if (ctx.gold < cost) {
      return { description: `想喝${args.beverage ?? "饮料"}，但钱不够（需要${cost}金币，只有${ctx.gold}）`, effects: [], success: false };
    }
    return {
      description: `喝了${args.beverage ?? "一杯饮料"}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 8 },
        { type: "need_change", targetId: ctx.characterId, field: "hunger", delta: 5 },
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: 5 },
        { type: "need_change", targetId: ctx.characterId, field: "bladder", delta: -15 },
      ],
      duration: 2,
    };
  },
};

export const journalAction: ActionDefinition = {
  tool: {
    name: "journal",
    description: "写日记或随笔，整理心情。独处时效果更好。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "写什么（可选）" },
      },
    },
  },
  handler: (args, ctx): ActionResult => ({
    description: `写日记：${(args.topic as string) ?? "记录今天的事"}`,
    effects: [
      { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 8 },
      { type: "need_change", targetId: ctx.characterId, field: "social", delta: -2 },
    ],
    duration: 2,
  }),
};

export const practiceAction: ActionDefinition = {
  tool: {
    name: "practice",
    description: "练习某项技能（乐器、绘画、手工等）。消耗精力但很有成就感。",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "练习什么（如 '吉他', '画画'）" },
      },
    },
  },
  handler: (args, ctx): ActionResult => {
    const skill = (args.skill as string) ?? "技能";
    return {
      description: `练习${skill}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 10 },
        { type: "need_change", targetId: ctx.characterId, field: "energy", delta: -8 },
        { type: "skill_up", targetId: ctx.characterId, skill, delta: 0.1 },
      ],
      duration: 4,
    };
  },
};

export const ALL_LEISURE_ACTIONS: ActionDefinition[] = [readAction, exploreAction, drinkAction, journalAction, practiceAction];
