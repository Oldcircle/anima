/**
 * Social Actions — 扩展社交行为工具
 */

import type { ActionDefinition, ActionResult, ActionContext } from "./types.js";

export const gossipAction: ActionDefinition = {
  tool: {
    name: "gossip",
    description: "和某人分享八卦或小道消息。需要在同一地点。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "对象角色 ID" },
        about: { type: "string", description: "八卦内容（关于谁或什么事）" },
      },
      required: ["target", "about"],
    },
  },
  handler: (args, ctx): ActionResult => ({
    description: `和${args.target}聊八卦：${args.about}`,
    effects: [
      { type: "need_change", targetId: ctx.characterId, field: "social", delta: 20 },
      { type: "need_change", targetId: args.target as string, field: "social", delta: 15 },
      { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: 5 },
    ],
    duration: 2,
  }),
};

export const giveGiftAction: ActionDefinition = {
  tool: {
    name: "give_gift",
    description: "送礼物给某人。会大幅提升关系。需要在同一地点。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "对象角色 ID" },
        item: { type: "string", description: "礼物名称" },
      },
      required: ["target", "item"],
    },
  },
  handler: (args, ctx): ActionResult => ({
    description: `送了${args.item}给${args.target}`,
    effects: [
      { type: "relationship_change", targetId: ctx.characterId, field: args.target as string, delta: 5 },
      { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: 10 },
      { type: "need_change", targetId: args.target as string, field: "happiness", delta: 15 },
    ],
    duration: 1,
  }),
};

export const comfortAction: ActionDefinition = {
  tool: {
    name: "comfort",
    description: "安慰某个看起来不开心的人。需要在同一地点。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "对象角色 ID" },
        words: { type: "string", description: "安慰的话" },
      },
      required: ["target"],
    },
  },
  handler: (args, ctx): ActionResult => ({
    description: `安慰${args.target}：${args.words ?? "一切都会好起来的"}`,
    effects: [
      { type: "need_change", targetId: args.target as string, field: "happiness", delta: 15 },
      { type: "need_change", targetId: args.target as string, field: "social", delta: 10 },
      { type: "need_change", targetId: ctx.characterId, field: "social", delta: 8 },
      { type: "relationship_change", targetId: ctx.characterId, field: args.target as string, delta: 3 },
    ],
    duration: 2,
  }),
};

export const ALL_SOCIAL_ACTIONS: ActionDefinition[] = [gossipAction, giveGiftAction, comfortAction];
