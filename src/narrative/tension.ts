/**
 * Tension Index — 叙事张力指标
 *
 * 给 LLM 导演（N4）提供"现在世界够不够紧"的判断。
 * 公式（DESIGN-narrative O3）：
 *   tension = unresolved_events_count × 0.4
 *           + recent_relationship_volatility × 0.3
 *           + tick_since_last_beat × 0.3
 *   归一化到 0..100
 *
 * N2 阶段只接入 unresolved 项；relationship_volatility 和 last_beat 等
 * N3/N4 引入对应数据后再补，先用 0 占位以保证公式可跑。
 */

import type { World } from "../world/world.js";

export interface TensionInputs {
  unresolvedCount: number;
  relationshipVolatility: number;  // 0..1，N3+ 接入
  ticksSinceLastBeat: number;       // N3+ 接入
}

export function computeTensionIndex(inputs: TensionInputs): number {
  // 各项归一化到 0..100，再加权
  const a = Math.min(100, inputs.unresolvedCount * 20);          // 5 个 unresolved = 100
  const b = Math.min(100, inputs.relationshipVolatility * 100);
  const c = Math.min(100, inputs.ticksSinceLastBeat * 2);        // 50 tick 无 beat = 100
  return Math.round(a * 0.4 + b * 0.3 + c * 0.3);
}

export function updateWorldTension(world: World): number {
  const ns = world.narrative;
  const w = ns.getWorld();
  const tension = computeTensionIndex({
    unresolvedCount: w.unresolvedEvents.length,
    relationshipVolatility: 0, // TODO N3
    ticksSinceLastBeat: 0,      // TODO N3
  });
  ns.setTensionIndex(tension);
  return tension;
}
