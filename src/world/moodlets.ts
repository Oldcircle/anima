/**
 * Moodlet System — 临时情绪效果
 *
 * 借鉴模拟人生 4：情绪不是一个数值，是一叠有原因、有时效的感受。
 * 主导情绪 = 最高 intensity 的 moodlet 类型。
 */

import type { Moodlet, CharacterState } from "./types.js";
import { v4 as uuid } from "uuid";

export type MoodletEmotion = Moodlet["emotion"];

/** 添加一个 moodlet 到角色 */
export function addMoodlet(
  state: CharacterState,
  emotion: MoodletEmotion,
  intensity: number,
  reason: string,
  durationTicks: number,
  source: Moodlet["source"],
  currentTick: number,
): void {
  // 同原因的 moodlet 不叠加，刷新时间和强度
  const existing = state.moodlets.find((m) => m.reason === reason);
  if (existing) {
    existing.intensity = Math.max(existing.intensity, intensity);
    existing.expiresAtTick = currentTick + durationTicks;
    return;
  }

  state.moodlets.push({
    id: uuid(),
    emotion,
    intensity: Math.min(5, Math.max(1, intensity)),
    reason,
    expiresAtTick: currentTick + durationTicks,
    source,
  });

  // 上限 10 个 moodlet
  if (state.moodlets.length > 10) {
    state.moodlets.sort((a, b) => a.intensity - b.intensity);
    state.moodlets.shift();
  }
}

/** 清理过期的 moodlet */
export function tickMoodlets(state: CharacterState, currentTick: number): void {
  state.moodlets = state.moodlets.filter((m) => m.expiresAtTick > currentTick);
}

/** 获取主导情绪（最高 intensity 的 moodlet） */
export function getDominantMood(state: CharacterState): { emotion: MoodletEmotion; reason: string } | null {
  if (state.moodlets.length === 0) return null;
  const sorted = [...state.moodlets].sort((a, b) => b.intensity - a.intensity);
  return { emotion: sorted[0]!.emotion, reason: sorted[0]!.reason };
}

const EMOTION_LABELS: Record<MoodletEmotion, string> = {
  happy: "开心",
  sad: "难过",
  angry: "生气",
  embarrassed: "尴尬",
  anxious: "焦虑",
  confident: "自信",
  lonely: "孤独",
  grateful: "感激",
};

/** 格式化 moodlet 列表为 prompt 注入的自然语言 */
export function formatMoodlets(state: CharacterState): string {
  if (state.moodlets.length === 0) return "";

  const lines = state.moodlets
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5)
    .map((m) => {
      const prefix = m.intensity >= 4 ? "很" : m.intensity >= 2 ? "有点" : "隐隐";
      return `- ${prefix}${EMOTION_LABELS[m.emotion]}（${m.reason}）`;
    });

  const dominant = getDominantMood(state);
  const dominantLine = dominant ? `你整体的情绪偏向：${EMOTION_LABELS[dominant.emotion]}` : "";

  return `## 你现在的心情\n${lines.join("\n")}\n${dominantLine}`;
}

/** 根据需求状态自动产生 moodlet（每 tick 检查） */
export function generateNeedMoodlets(state: CharacterState, currentTick: number): void {
  const { needs } = state;

  // 长期社交缺乏 → lonely
  if (needs.social < 15) {
    addMoodlet(state, "lonely", 4, "一个人太久了", 4, "need", currentTick);
  } else if (needs.social < 25) {
    addMoodlet(state, "lonely", 2, "有点想找人说话", 4, "need", currentTick);
  }

  // 饥饿 → anxious
  if (needs.hunger < 15) {
    addMoodlet(state, "anxious", 3, "饿得慌", 4, "need", currentTick);
  }

  // 精力极低 → sad
  if (needs.energy < 15) {
    addMoodlet(state, "sad", 3, "累到不想动", 4, "need", currentTick);
  }
}
