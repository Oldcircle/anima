/**
 * Career Progression — 职业晋升系统
 *
 * 每天反思时检查：角色技能是否达到下一职业等级的要求。
 * 达标 → 自动晋升 → 更新 occupation/income → 写入记忆。
 */

import type { CharacterState, Location, CareerLevel } from "./types.js";
import type { LifeState } from "../character/types.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import { addMoodlet } from "./moodlets.js";

export interface PromotionResult {
  characterId: string;
  oldTitle: string;
  newTitle: string;
  newIncome: number;
  newLevel: number;
}

/**
 * 检查角色是否满足晋升条件。
 * 返回晋升结果，或 null 表示不满足。
 */
export function checkPromotion(
  state: CharacterState,
  locations: Location[],
): PromotionResult | null {
  const life = state.life;
  if (!life) return null;

  // 找到角色的工作地点
  const workplace = locations.find((l) => l.id === life.workplace);
  if (!workplace?.careerTrack || workplace.careerTrack.length === 0) return null;

  // 找到当前等级（通过 title 匹配）
  const currentIdx = workplace.careerTrack.findIndex((c) => c.title === life.occupation);
  if (currentIdx < 0) {
    // 当前 occupation 不在 career track 里，尝试匹配第一级
    return null;
  }

  const nextLevel = workplace.careerTrack[currentIdx + 1];
  if (!nextLevel) return null; // 已经是最高级

  // 检查技能要求
  for (const [skill, required] of Object.entries(nextLevel.required_skill)) {
    const current = life.skills[skill] ?? 0;
    if (current < required) return null; // 技能不够
  }

  return {
    characterId: state.id,
    oldTitle: life.occupation,
    newTitle: nextLevel.title,
    newIncome: nextLevel.income,
    newLevel: nextLevel.level,
  };
}

/**
 * 执行晋升：更新 life state + 写入记忆 + 添加 confident moodlet。
 */
export function applyPromotion(
  state: CharacterState,
  result: PromotionResult,
  memory: ShortTermMemory,
  tick: number,
): void {
  if (!state.life) return;

  state.life.occupation = result.newTitle;
  state.life.income = result.newIncome;

  // 写入记忆
  memory.add(state.id, {
    tick,
    type: "thought",
    content: `[晋升] 从${result.oldTitle}升职为${result.newTitle}了！收入从${result.newIncome}提高了。`,
    importance: 9,
  });

  // 添加 confident moodlet（持续 48 tick = 12 小时）
  addMoodlet(state, "confident", 4, `升职为${result.newTitle}了`, 48, "work", tick);
}
