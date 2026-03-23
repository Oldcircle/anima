/**
 * Temporal Decay — 记忆时间衰减
 *
 * 从 OpenClaw 提取并适配为游戏时间。
 * 原版基于现实时间文件系统日期，这里基于游戏 tick。
 */

export interface TemporalDecayConfig {
  enabled: boolean;
  /** 半衰期（游戏天数） */
  halfLifeDays: number;
}

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: true,
  halfLifeDays: 14,
};

const TICKS_PER_DAY = 96;

export function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 0;
  }
  return Math.LN2 / halfLifeDays;
}

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = toDecayLambda(params.halfLifeDays);
  const clampedAge = Math.max(0, params.ageInDays);
  if (lambda <= 0 || !Number.isFinite(clampedAge)) {
    return 1;
  }
  return Math.exp(-lambda * clampedAge);
}

export function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

/** 基于游戏 tick 计算记忆衰减 */
export function applyDecayByTick<T extends { score: number; tick: number }>(
  items: T[],
  currentTick: number,
  config: Partial<TemporalDecayConfig> = {},
): T[] {
  const { enabled, halfLifeDays } = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...config };
  if (!enabled) return [...items];

  return items.map((item) => {
    const ageInDays = Math.max(0, currentTick - item.tick) / TICKS_PER_DAY;
    const decayedScore = applyTemporalDecayToScore({
      score: item.score,
      ageInDays,
      halfLifeDays,
    });
    return { ...item, score: decayedScore };
  });
}
