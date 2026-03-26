/**
 * Relationship Actions — 关系转变行为工具
 *
 * 这些工具只在特定关系深度时才出现在工具列表中（由 tool-builder 控制）。
 * 不是所有人都能告白/分享秘密——关系需要先达到一定深度。
 */

import type { ActionDefinition, ActionResult, ActionContext } from "./types.js";

/** 邀请出去玩 — friend+ 才出现 */
export const inviteOutAction: ActionDefinition = {
  tool: {
    name: "invite_out",
    description: "邀请在场的某人一起去别的地方走走。需要你们已经是朋友。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "邀请对象的角色 ID" },
        activity: { type: "string", description: "想一起做什么（如 '去海边散步', '去喝咖啡'）" },
      },
      required: ["target", "activity"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = args.target as string;
    if (!ctx.nearbyCharacters.includes(target)) {
      return { description: `想邀请${target}，但对方不在这里`, effects: [], success: false };
    }
    return {
      description: `邀请${target}一起${args.activity}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 8 },
        { type: "need_change", targetId: target, field: "social", delta: 8 },
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 10 },
        { type: "need_change", targetId: target, field: "fun", delta: 10 },
        { type: "relationship_change", targetId: ctx.characterId, field: target, delta: 3 },
        { type: "inbox_message", targetId: target, fromName: ctx.characterId, message: `要不要一起${args.activity}？` },
      ],
      duration: 1,
    };
  },
};

/** 分享秘密 — close_friend+ 才出现 */
export const shareSecretAction: ActionDefinition = {
  tool: {
    name: "share_secret",
    description: "和某人分享一个你平时不会说的秘密或心里话。需要你们已经非常信任彼此。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "对象角色 ID" },
        secret: { type: "string", description: "你想说的心里话或秘密" },
      },
      required: ["target", "secret"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = args.target as string;
    if (!ctx.nearbyCharacters.includes(target)) {
      return { description: `想和${target}说心里话，但对方不在`, effects: [], success: false };
    }
    return {
      description: `对${target}说了心里话：${args.secret}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 12 },
        { type: "need_change", targetId: target, field: "social", delta: 10 },
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 5 },
        { type: "relationship_change", targetId: ctx.characterId, field: target, delta: 5 },
        { type: "inbox_message", targetId: target, fromName: ctx.characterId, message: args.secret as string },
      ],
      duration: 2,
    };
  },
};

export const ALL_RELATIONSHIP_ACTIONS: ActionDefinition[] = [inviteOutAction, shareSecretAction];
