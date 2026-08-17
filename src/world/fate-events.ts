/**
 * Fate Events — 命运事件层
 *
 * 随机事件系统（events.ts）管的是"野花/日落/流浪猫"级的每 tick 微扰；
 * 命运事件层管的是**每 3-7 天一件、有真实状态后果的意外**——丢钱真丢钱、
 * 着凉真没劲、打碎东西真赔钱。importance 8-9 + moodlet + intent 强制占据注意力，
 * 公开发生的会被在场者目击（进记忆、可谈论、可传八卦）。
 *
 * 设计红线：只造"处境"不写"结果"——事件把角色推进一个要应对的局面，
 * 怎么应对（省着花/多接活/找人借/回家躺着）由角色自己决定。
 * off 档不启用（治愈系基线不挨命运毒打）。
 */

import type { Season, Weather, CharacterState } from "./types.js";

export type FateGoldDelta =
  | { kind: "fraction"; fraction: number; min: number }   // 按比例损失（至少 min）
  | { kind: "flat"; amount: number };                      // 定额（正=获得，负=损失，损失以身上的钱为限）

export interface FateEvent {
  id: string;
  name: string;
  /** 主角视角描述，{character} 替换为角色名 */
  template: string;
  importance: 8 | 9;
  /** 相对权重（条件过滤后归一化抽取） */
  weight: number;
  goldDelta?: FateGoldDelta;
  needEffects?: Array<{ field: "hunger" | "energy" | "social" | "fun" | "hygiene"; delta: number }>;
  moodlet?: {
    emotion: "happy" | "sad" | "angry" | "embarrassed" | "anxious" | "confident" | "lonely" | "grateful";
    intensity: number;
    reason: string;
    durationTicks: number;
  };
  /** 注入 intent：这事要占据接下来几小时的注意力 */
  intentSummary?: string;
  /** 目击文案（同地点他人的观察记忆），缺省 = 私事没人看见 */
  witnessTemplate?: string;
  /**
   * 器物层留痕（PLAN-grounding：事件要在**世界本体**留下痕迹，不能只活在记忆文本里）。
   * `objects` 是候选名（按优先级在当事人所在地点逐个解析，取第一个命中的——
   * 各商业地点的"摆货的那件家什"不同名：货架/展示柜/酒架/花艺台/吧台）；
   * 全不命中静默跳过——器物层是增强不是硬依赖。
   * 留下的 trace 由 examine 与重访 diff 两条通道接住：**当时不在场的人过后也能看出这里出过事**。
   * 只对"物理上真的发生在世界里"的事件声明（丢钱/着凉是私事，不该在货架上留痕）。
   * trace 文案不点器物名（它挂在器物下渲染），这样一条文案能配所有候选。
   */
  objectTrace?: { objects: string[]; text: string };
  conditions?: {
    weather?: Weather[];
    season?: Season[];
    /** 只在这类地点发生（按当事人所在地点 type） */
    locationType?: Array<"residential" | "commercial" | "public" | "nature" | "special">;
    /** 身上至少有这么多钱才可能丢钱 */
    minGold?: number;
  };
}

/** 命运事件间隔：3-7 游戏天（96 tick/天） */
export const FATE_INTERVAL_MIN_TICKS = 3 * 96;
export const FATE_INTERVAL_MAX_TICKS = 7 * 96;

export const FATE_EVENTS: FateEvent[] = [
  {
    id: "wallet_hole",
    name: "口袋破洞丢了钱",
    template: "{character}发现口袋不知什么时候破了个洞，里面的钱丢了一小半",
    importance: 8,
    weight: 3,
    goldDelta: { kind: "fraction", fraction: 0.4, min: 5 },
    moodlet: { emotion: "anxious", intensity: 4, reason: "钱丢了一小半，心疼得直抽抽", durationTicks: 24 },
    intentSummary: "口袋破了个洞，钱丢了一小半——这几天得省着花，最好多接点活把窟窿补回来。",
    conditions: { minGold: 12 },
  },
  {
    id: "shop_mishap",
    name: "失手打碎了东西",
    template: "{character}在店里失手碰掉了架子上的东西，摔得粉碎，只好掏钱照价赔了",
    importance: 8,
    weight: 3,
    goldDelta: { kind: "flat", amount: -10 },
    moodlet: { emotion: "embarrassed", intensity: 3, reason: "在店里当众打碎了东西", durationTicks: 16 },
    witnessTemplate: "{character}在店里失手打碎了东西，红着脸掏钱赔——那声脆响半条街都听见了",
    objectTrace: {
      objects: ["货架", "展示柜", "酒架", "花艺台", "吧台"],
      text: "上面空出一块，边角还留着没扫干净的碎渣",
    },
    conditions: { locationType: ["commercial"] },
  },
  {
    id: "caught_cold",
    name: "着凉了",
    template: "{character}这两天没顾上自己，身上一阵阵发冷，脑袋昏沉——是着凉了",
    importance: 8,
    weight: 3,
    needEffects: [{ field: "energy", delta: -20 }, { field: "fun", delta: -8 }],
    moodlet: { emotion: "sad", intensity: 4, reason: "着凉了，浑身发冷没劲", durationTicks: 32 },
    intentSummary: "身上发冷、脑袋昏沉——今天撑不了太久，想早点回去歇着。",
    conditions: { weather: ["rainy", "stormy", "snowy"] },
  },
  {
    id: "windfall_purse",
    name: "捡到无主钱袋",
    template: "{character}在路边捡到一个小钱袋，等了半天没人来找，四下也没别人",
    importance: 8,
    weight: 1,
    goldDelta: { kind: "flat", amount: 18 },
    moodlet: { emotion: "happy", intensity: 3, reason: "白捡了一小笔钱，今天运气不错", durationTicks: 16 },
    conditions: { locationType: ["public", "nature"] },
  },
];

/** 条件过滤：这个事件此刻能不能落在这个角色头上 */
export function fateEventEligible(
  event: FateEvent,
  ctx: { weather: Weather; season: Season; locationType?: string; gold: number },
): boolean {
  const c = event.conditions;
  if (!c) return true;
  if (c.weather && !c.weather.includes(ctx.weather)) return false;
  if (c.season && !c.season.includes(ctx.season)) return false;
  if (c.locationType && (!ctx.locationType || !c.locationType.includes(ctx.locationType as never))) return false;
  if (c.minGold !== undefined && ctx.gold < c.minGold) return false;
  return true;
}

/** 按权重从符合条件的池子里抽一件（rng 可注入便于测试），无候选返回 undefined */
export function pickFateEvent(
  pool: FateEvent[],
  ctx: { weather: Weather; season: Season; locationType?: string; gold: number },
  rng: () => number = Math.random,
): FateEvent | undefined {
  const eligible = pool.filter((e) => fateEventEligible(e, ctx));
  if (eligible.length === 0) return undefined;
  const total = eligible.reduce((s, e) => s + e.weight, 0);
  let roll = rng() * total;
  for (const e of eligible) {
    roll -= e.weight;
    if (roll <= 0) return e;
  }
  return eligible[eligible.length - 1];
}

/** 结算金币变化（损失以身上的钱为限，返回实际变化量，负=损失） */
export function applyFateGold(state: CharacterState, delta: FateGoldDelta): number {
  if (delta.kind === "flat") {
    const change = delta.amount >= 0 ? delta.amount : -Math.min(state.gold, -delta.amount);
    state.gold += change;
    return change;
  }
  const loss = Math.min(state.gold, Math.max(delta.min, Math.round(state.gold * delta.fraction)));
  state.gold -= loss;
  return -loss;
}
