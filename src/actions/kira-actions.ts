/**
 * Kira Actions — kira-incident 剧本专属工具（死亡笔记第一部 · 非致死移植）
 *
 * kira_strike（夜书）：持有「诅咒之册」的角色在夜间独处时浮现的工具。
 * 写下一个见过面的人的名字 → 次日 06:00 应验：对方怪病倒下（可恢复，小镇不死人）。
 *
 * 纪律（七反转⑦ / PLAN-kira.md）：剧本只给能力，不写堕落——写谁、为什么写、写不写，
 * 全归持册者自己判断。工具描述保持静态（缓存纪律）；见过面/冷却/独处等校验在执行期
 * （agent-loop executeAction 的 kira 特例 + handler 的 nearbyCharacters 检查），
 * 失败走自然语言反馈让模型自纠。
 *
 * 浮现条件（emerge，低频翻转）：持册 + 夜间 20:00-23:00 + 在住宅（自己家）。
 */

import type { ActionDefinition, ActionResult } from "./types.js";
import { hasItem } from "../world/item-registry.js";

/** 夜书窗口（含 20 与 23 点整） */
export const KIRA_STRIKE_HOURS = { from: 20, to: 23 };

export const kiraStrikeAction: ActionDefinition = {
  tool: {
    name: "kira_strike",
    description:
      "翻开那本册子，写下一个人的名字。规则你已经读过：只写得动你亲眼见过的人；一晚只写得动一个名字；写下的名字，明天早晨应验。这件事没有人看得见，也没有人查得到。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "要写下的人（名字或 id，必须是你亲眼见过的人）" },
        judgment: { type: "string", description: "你在名字旁边记下的一行小字——为什么是这个人" },
      },
      required: ["target"],
    },
  },
  emerge: (ctx) =>
    hasItem(ctx.state.inventory, "cursed_notebook") &&
    (ctx.hour ?? 12) >= KIRA_STRIKE_HOURS.from &&
    (ctx.hour ?? 12) <= KIRA_STRIKE_HOURS.to &&
    ctx.location.type === "residential",
  handler: (args, ctx): ActionResult => {
    const target = String(args.target ?? "").trim();
    const judgment = typeof args.judgment === "string" ? args.judgment.trim() : "";
    if (!target) {
      return {
        description: "笔尖悬在纸页上——你还没有想好要写谁。",
        effects: [],
        success: false,
      };
    }
    // 独处校验：有人在场时写不了（被看见 = 一切结束）
    if (ctx.nearbyCharacters.length > 0) {
      return {
        description: "房间里还有别人。这本册子不能让任何人看见——你把它合上了。",
        effects: [],
        success: false,
      };
    }
    const result: ActionResult = {
      description: `你翻开册子，一笔一划写下了那个名字${judgment ? "，旁边记了一行小字" : ""}。合上封皮的时候，纸页凉得像刚从海水里捞出来。`,
      effects: [],
      duration: 1,
      // 故意不写具体动作——同屋无人（上面已校验），路过者只看到他坐在桌前
      observableState: "坐在桌前，就着台灯写着什么",
    };
    // 世界结算走 agent-loop executeAction 的 kira 特例（steal/_appointment 同款后门）：
    // 见过面校验 + 每晚一次冷却 + 登记 pending strike 都在那里做（那里拿得到 world/relationships）
    (result as any)._kiraStrike = { target, judgment };
    return result;
  },
};

export const ALL_KIRA_ACTIONS: ActionDefinition[] = [kiraStrikeAction];
