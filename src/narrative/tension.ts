/**
 * Tension Index — 叙事张力指标
 *
 * 给 LLM 导演（N4）提供"现在世界够不够紧"的判断。
 * 公式 v1（DESIGN-revival A 件；单测锁形状不锁数值）：
 *   tension = 0.35 × unresolved 项
 *           + 0.45 × top3 压力对均值（pressure-graph pair 公式）
 *           + 0.20 × beat 干旱项（距上次 beat 触发的 tick 数）
 *   归一化到 0..100
 *
 * 历史：N2 版只有 unresolved 项接了真数据，另两个插座恒 0——
 * tension 封顶 40，导演 pacing 的 "tension > 40" 判据永假。
 * A 件把两个插座接上真数据（压力对 → 原 volatility 插座；beatLastTrigger → 干旱插座），
 * 上限回到 100。
 */

import type { World } from "../world/world.js";

export interface TensionInputs {
  unresolvedCount: number;
  /** top-3 压力对均值 0..100（pressure-graph 每 tick 重算后传入） */
  pairPressureTop3Avg: number;
  /** 距上一次 beat 触发的 tick 数（beat 干旱项） */
  ticksSinceLastBeat: number;
}

export function computeTensionIndex(inputs: TensionInputs): number {
  // 各项归一化到 0..100，再加权
  const a = Math.min(100, inputs.unresolvedCount * 20);                        // 5 个 unresolved = 100
  const b = Math.max(0, Math.min(100, inputs.pairPressureTop3Avg));
  const c = Math.min(100, (Math.max(0, inputs.ticksSinceLastBeat) / 96) * 100); // 1 游戏天无 beat = 100
  return Math.round(a * 0.35 + b * 0.45 + c * 0.2);
}

/**
 * 每 tick 末更新世界 tension。
 * unresolved 与干旱项直接从 narrative_state 读；压力对均值由 pressure-graph 传入
 * （不传时按 0 处理——独立调用仍可跑，只是少了压力项）。
 */
export function updateWorldTension(
  world: World,
  extras?: { pairPressureTop3Avg?: number },
): number {
  const ns = world.narrative;
  const w = ns.getWorld();
  const tension = computeTensionIndex({
    unresolvedCount: w.unresolvedEvents.length,
    pairPressureTop3Avg: extras?.pairPressureTop3Avg ?? 0,
    ticksSinceLastBeat: ns.getTicksSinceLastBeat(world.tick),
  });
  ns.setTensionIndex(tension);
  return tension;
}
