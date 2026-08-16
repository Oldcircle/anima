/**
 * PbtA 世界侧掷骰（PLAN-grounding M3 · 游戏设计镜头「失败前进的骰子」）
 *
 * LLM 玩家不会掷骰子——采样永远漂向叙事连贯，让它自己决定"篡改是否成功"，
 * 它写的是它想要的剧情。一切不确定性必须世界侧 roll，模型只负责扮演结果。
 *
 * 三段（Powered by the Apocalypse 2d6，+0 修正）：
 * - 10+  success      强成功（≈16.7%）：目标达成，代价轻微
 * - 7-9  cost         付代价的成功（≈41.7%）：目标达成，但留下明显代价
 * - ≤6   complication 带并发症的失败（≈41.7%）：目标没达成，且事态推进——
 *                     fail forward：失败永远制造新处境，不是"什么都没发生"
 *
 * 并发症占比刻意偏高——世界是对手不是舞台；戏剧引擎的燃料正是这一段。
 */

export type PbtaOutcome = "success" | "cost" | "complication";

export interface PbtaRoll {
  outcome: PbtaOutcome;
  total: number;
  dice: [number, number];
}

/** 世界侧掷骰。rng 可注入（测试钉死结果用），默认 Math.random。 */
export function rollPbta(rng: () => number = Math.random): PbtaRoll {
  const d = () => 1 + Math.floor(rng() * 6);
  const dice: [number, number] = [d(), d()];
  const total = dice[0] + dice[1];
  const outcome: PbtaOutcome = total >= 10 ? "success" : total >= 7 ? "cost" : "complication";
  return { outcome, total, dice };
}
