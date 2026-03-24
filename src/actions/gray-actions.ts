/**
 * Gray Actions — 灰色/负面行为工具
 *
 * 真实的人不只做好事。压力、贫穷、愤怒会驱动灰色行为。
 * 这些行为不是"系统惩罚"，而是 Agent 在困境中的可选出路。
 */

import type { ActionDefinition, ActionResult, ActionContext, ActionEffect } from "./types.js";

export const argueAction: ActionDefinition = {
  tool: {
    name: "argue",
    description: "和某人吵架/争论。会损害关系（-10），双方心情变差（-15），但能释放压力（社交+5）。慎用。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "吵架对象的角色 ID" },
        reason: { type: "string", description: "吵架原因" },
      },
      required: ["target", "reason"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = args.target as string;
    const reason = (args.reason as string) ?? "一些分歧";
    return {
      description: `和${target}吵了一架：${reason}`,
      effects: [
        { type: "relationship_change", targetId: ctx.characterId, field: target, delta: -10 },
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: -15 },
        { type: "need_change", targetId: target, field: "happiness", delta: -15 },
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 5 },
        { type: "need_change", targetId: target, field: "social", delta: 5 },
      ],
      duration: 2,
    };
  },
};

export const stealAction: ActionDefinition = {
  tool: {
    name: "steal",
    description: "偷窃金币（20~40）。有 40% 概率被当场抓住，被发现后全镇居民对你的关系大幅下降（-20）。只有走投无路时才该这么做。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "偷谁（角色 ID 或 'shop'）" },
      },
      required: ["target"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = (args.target as string) ?? "shop";
    const stolenAmount = 20 + Math.floor(Math.random() * 21); // 20~40
    const caught = Math.random() < 0.4;

    if (caught) {
      // 被发现：没偷到钱，全镇关系 -20
      const effects: ActionEffect[] = [
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: -25 },
      ];
      // 对所有附近的人关系 -20
      for (const witnessId of ctx.nearbyCharacters) {
        effects.push({ type: "relationship_change", targetId: ctx.characterId, field: witnessId, delta: -20 });
      }
      return {
        description: `试图偷${target}的钱，但被当场抓住了！所有人都看到了`,
        effects,
        duration: 1,
      };
    }

    // 成功偷到
    return {
      description: `悄悄偷了${stolenAmount}金币`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: -5 },
      ],
      // gold 变化在 agent-loop 的经济效果中处理，这里通过 description 传递金额
      duration: 1,
      // 存一个标记让 agent-loop 知道偷了多少钱
      _stolenAmount: stolenAmount,
    } as ActionResult & { _stolenAmount: number };
  },
};

export const begAction: ActionDefinition = {
  tool: {
    name: "beg",
    description: "向路人乞讨（获得 5~15 金币）。自尊受损（快乐 -10）。没钱又饿的时候的最后手段。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: (_args, ctx): ActionResult => {
    const received = 5 + Math.floor(Math.random() * 11); // 5~15
    return {
      description: `在街上乞讨，获得了${received}金币`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "happiness", delta: -10 },
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: -5 },
      ],
      _begAmount: received,
    } as ActionResult & { _begAmount: number };
  },
};

export const ALL_GRAY_ACTIONS: ActionDefinition[] = [argueAction, stealAction, begAction];
