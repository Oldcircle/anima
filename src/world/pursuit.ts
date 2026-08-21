/**
 * Pursuit — 有人在追求什么（给世界装上「方向」）
 *
 * 诊断的另一半：失业解决了"没有输"，这一层解决"没有想要"。
 *
 * 此前 `aspiration` 只是注入 prompt 的一行字符串（"成为世界上最厉害的人"），
 * 被拿去当聊天话题——**没有进度、没有障碍、没有期限、没有失败态**。
 * 而 `needs` 全是恒稳态：饿了吃、累了睡、把你推回平衡点。
 *
 * **需求是回归性的，目标是方向性的。** 只有恒稳态的世界里没人在往哪儿走，
 * 所有人都只是在原地维持——这是《模拟人生》的驱动力，不是动画的。
 *
 * 追求要真的算数，必须满足三条（缺一条就退回成一句漂亮话）：
 * 1. **进度机械可测**：绑在真实世界状态上（金币/技能/关系/持有物），不是 LLM 自评
 * 2. **有期限**：无限期的愿望不产生压力。到期就结算
 * 3. **失败是不可逆的**：错过了就是错过了，不能重来——这是「输」的第二种形式，
 *    不是失去已有的，是**永远错过想要的**
 *
 * 本期只做**作者预埋**（角色卡 `pursuit:` 字段）+ 机械进度，零 LLM。
 * 运行期自生成（从反思里长出新目标）留后续。
 */

import type { CharacterState } from "./types.js";

/** 进度绑在哪种世界状态上——每一种都必须是引擎能直接读出来的数 */
export type PursuitMetric =
  | { kind: "gold" }                              // 攒钱
  | { kind: "skill"; skill: string }               // 练手艺
  | { kind: "relationship"; target: string }       // 和某人的关系
  | { kind: "item"; itemId: string };              // 攒够某样东西

export interface PursuitDef {
  id: string;
  /** 一句话，进 prompt 用角色自己的口吻 */
  summary: string;
  metric: PursuitMetric;
  target: number;
  /** 从开局起第几天到期（不给=无期限，但**强烈建议给**——无限期的愿望不产生压力） */
  deadlineDay?: number;
  /** 达成时角色自己会怎么想（进长期记忆） */
  onAchieved?: string;
  /** 错过时角色自己会怎么想（进长期记忆，且**不可逆**） */
  onFailed?: string;
}

export interface PursuitState extends PursuitDef {
  status: "active" | "achieved" | "failed";
  /** 上次结算时的进度（用于探测"有进展/停滞"） */
  lastProgress: number;
  settledDay?: number;
}

export function pursuitsEnabled(): boolean {
  return process.env.ANIMA_PURSUIT !== "0";
}

/** YAML `pursuit:` 逐字段显式映射（对齐 visible_to 泄漏教训：绝不整体 cast） */
export function normalizePursuit(v: unknown): PursuitDef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== "string" || !o.summary.trim()) return undefined;
  if (typeof o.target !== "number" || !Number.isFinite(o.target) || o.target <= 0) return undefined;
  const m = o.metric as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || typeof m.kind !== "string") return undefined;

  let metric: PursuitMetric | undefined;
  if (m.kind === "gold") metric = { kind: "gold" };
  else if (m.kind === "skill" && typeof m.skill === "string") metric = { kind: "skill", skill: m.skill };
  else if (m.kind === "relationship" && typeof m.target === "string") metric = { kind: "relationship", target: m.target };
  else if (m.kind === "item" && typeof m.item_id === "string") metric = { kind: "item", itemId: m.item_id };
  if (!metric) return undefined;

  return {
    id: typeof o.id === "string" && o.id ? o.id : `pursuit_${metric.kind}`,
    summary: o.summary.trim(),
    metric,
    target: Math.floor(o.target),
    deadlineDay: typeof o.deadline_day === "number" && Number.isFinite(o.deadline_day)
      ? Math.floor(o.deadline_day) : undefined,
    onAchieved: typeof o.on_achieved === "string" ? o.on_achieved : undefined,
    onFailed: typeof o.on_failed === "string" ? o.on_failed : undefined,
  };
}

export interface ProgressDeps {
  state: CharacterState;
  /** 关系读取（relationship 类进度用） */
  getRelationLevel?: (a: string, b: string) => number | undefined;
}

/** 当前进度——**从真实世界状态读**，不问任何人 */
export function readProgress(p: PursuitDef, deps: ProgressDeps): number {
  const { state } = deps;
  switch (p.metric.kind) {
    case "gold":
      return state.gold;
    case "skill":
      return state.life?.skills?.[p.metric.skill] ?? 0;
    case "relationship":
      return Math.max(0, deps.getRelationLevel?.(state.id, p.metric.target) ?? 0);
    case "item": {
      const id = p.metric.itemId;
      return (state.inventory ?? []).filter((i) => i.defId === id).reduce((n, i) => n + (i.quantity ?? 1), 0);
    }
  }
}

export type PursuitOutcome =
  | { kind: "progress"; current: number; delta: number }
  | { kind: "achieved"; current: number }
  | { kind: "failed"; current: number; short: number };

/**
 * 日结算（每天 06:00）。**有副作用**：改 status / lastProgress。
 * 已结算的追求不再返回任何东西——达成与失败都是**一次性、不可逆**的。
 */
export function settlePursuit(p: PursuitState, day: number, deps: ProgressDeps): PursuitOutcome | undefined {
  if (!pursuitsEnabled() || p.status !== "active") return undefined;
  const current = readProgress(p, deps);
  const delta = current - p.lastProgress;
  p.lastProgress = current;

  if (current >= p.target) {
    p.status = "achieved";
    p.settledDay = day;
    return { kind: "achieved", current };
  }
  // 到期未达成 = 永久失败。错过了就是错过了
  if (p.deadlineDay !== undefined && day >= p.deadlineDay) {
    p.status = "failed";
    p.settledDay = day;
    return { kind: "failed", current, short: p.target - current };
  }
  return { kind: "progress", current, delta };
}

/**
 * 注入此刻区的一行（动态，不碰缓存稳定区）。
 * 只报**进度与剩余时间**——怎么去够它归角色，世界不给建议。
 */
export function describePursuit(p: PursuitState, day: number, deps: ProgressDeps): string | undefined {
  if (!pursuitsEnabled() || p.status !== "active") return undefined;
  const current = readProgress(p, deps);
  const left = p.target - current;
  const daysLeft = p.deadlineDay !== undefined ? p.deadlineDay - day : undefined;
  const timeText =
    daysLeft === undefined ? "" :
    daysLeft <= 0 ? "——**今天就是最后期限**。" :
    daysLeft === 1 ? "——只剩今明两天了。" :
    `——还剩 ${daysLeft} 天。`;
  return `你一直想着的那件事：${p.summary}（${current}/${p.target}，还差 ${left}）${timeText}`;
}
