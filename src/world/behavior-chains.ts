/**
 * Behavior Chains — 行为链追踪与后果涟漪
 *
 * 检测角色最近的行为模式，触发对应的 Moodlet。
 * 连续工作 → 过劳，长期独处 → 孤僻，连续喝酒 → 宿醉。
 */

import type { CharacterState, Moodlet } from "./types.js";

/** 行为模式定义 */
interface BehaviorPattern {
  id: string;
  /** 检测函数：返回是否匹配 */
  detect: (state: CharacterState, currentTick: number) => boolean;
  /** 匹配时产生的 Moodlet */
  moodlet: Omit<Moodlet, "id" | "expiresAtTick">;
  /** Moodlet 持续 tick 数 */
  duration: number;
  /** 同一模式的冷却 tick 数（避免重复触发） */
  cooldown: number;
}

// 工作相关 action 名称
const WORK_ACTIONS = new Set(["work", "knead_dough", "bake", "serve_customer", "make_coffee", "clean_table", "shelve_books", "help_reader", "arrange_flowers"]);
const SOCIAL_ACTIONS = new Set(["talk", "gossip", "comfort", "give", "invite_out", "share_secret"]);
const ALCOHOL_ACTIONS = new Set(["drink_alcohol"]);

const PATTERNS: BehaviorPattern[] = [
  {
    id: "overwork",
    detect: (state, tick) => {
      const recent = (state.recentActions ?? []).filter(a => a.tick >= tick - 12);
      const workCount = recent.filter(a => WORK_ACTIONS.has(a.actionId)).length;
      return workCount >= 8; // 最近 12 tick 中有 8 次工作行为
    },
    moodlet: { emotion: "anxious", intensity: 3, reason: "连续工作太久了，身心俱疲", source: "event" },
    duration: 8,
    cooldown: 16,
  },
  {
    id: "lonely",
    detect: (state, tick) => {
      const recent = (state.recentActions ?? []).filter(a => a.tick >= tick - 8);
      const socialCount = recent.filter(a => SOCIAL_ACTIONS.has(a.actionId)).length;
      return recent.length >= 4 && socialCount === 0 && (state.needs.social ?? 100) < 30;
    },
    moodlet: { emotion: "lonely", intensity: 3, reason: "好久没和人说话了", source: "need" },
    duration: 8,
    cooldown: 12,
  },
  {
    id: "bored_stiff",
    detect: (state, tick) => {
      const recent = (state.recentActions ?? []).filter(a => a.tick >= tick - 6);
      const idleCount = recent.filter(a => a.actionId === "idle" || a.actionId === "rest").length;
      return idleCount >= 4;
    },
    moodlet: { emotion: "sad", intensity: 2, reason: "无聊到发霉", source: "need" },
    duration: 6,
    cooldown: 8,
  },
  {
    id: "hangover",
    detect: (state, tick) => {
      // 检测前一天（最近 96 tick）是否喝了 2 次以上酒
      const recent = (state.recentActions ?? []).filter(a => a.tick >= tick - 96);
      // 检测是否用了含 alcohol trait 的物品（通过 use action + beer/wine 等）
      const drinkCount = recent.filter(a => a.actionId === "use" || ALCOHOL_ACTIONS.has(a.actionId)).length;
      // 简化判断：如果最近有大量 bar 相关行为
      const barActions = recent.filter(a => a.actionId === "drink" || a.actionId === "beer").length;
      return barActions >= 2 || drinkCount >= 3;
    },
    moodlet: { emotion: "sad", intensity: 3, reason: "昨晚喝多了，头疼欲裂", source: "event" },
    duration: 16,
    cooldown: 96,
  },
  {
    id: "social_exhaustion",
    detect: (state, tick) => {
      const recent = (state.recentActions ?? []).filter(a => a.tick >= tick - 8);
      const socialCount = recent.filter(a => SOCIAL_ACTIONS.has(a.actionId)).length;
      return socialCount >= 6 && (state.needs.social ?? 0) > 80;
    },
    moodlet: { emotion: "anxious", intensity: 2, reason: "和太多人说了太多话，想一个人待会儿", source: "social" },
    duration: 6,
    cooldown: 12,
  },
];

/** 最近触发的模式记录（避免重复触发） */
const recentTriggers = new Map<string, number>(); // key = "characterId:patternId", value = tick

/**
 * 检测角色的行为模式，返回需要添加的 Moodlet 列表。
 * 应在每个 tick 结束时调用。
 */
export function detectBehaviorPatterns(state: CharacterState, currentTick: number): Moodlet[] {
  const results: Moodlet[] = [];

  for (const pattern of PATTERNS) {
    const triggerKey = `${state.id}:${pattern.id}`;
    const lastTrigger = recentTriggers.get(triggerKey) ?? -Infinity;

    // 冷却中
    if (currentTick - lastTrigger < pattern.cooldown) continue;

    // 已有同类 moodlet
    if (state.moodlets.some(m => m.id === `chain_${pattern.id}`)) continue;

    if (pattern.detect(state, currentTick)) {
      results.push({
        ...pattern.moodlet,
        id: `chain_${pattern.id}`,
        expiresAtTick: currentTick + pattern.duration,
      });
      recentTriggers.set(triggerKey, currentTick);
    }
  }

  return results;
}

/** 重置触发记录（测试用） */
export function resetBehaviorChainTriggers(): void {
  recentTriggers.clear();
}
