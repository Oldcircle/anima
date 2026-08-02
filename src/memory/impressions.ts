/**
 * Character Impressions — 角色间叙事性印象系统
 *
 * 替代纯数字关系（亲密度 24），用 LLM 生成的叙事描述：
 * "咖啡馆工作的女孩，礼貌但有距离感。她说'请容我'，像大家闺秀。"
 *
 * 印象在每次有意义的互动（对话 2+ 轮）后由 LLM 反思步骤生成/更新。
 */

export interface CharacterImpression {
  /** 被印象的角色 ID */
  characterId: string;
  /** 一句话总结："咖啡馆工作的女孩，礼貌但有距离感" */
  summary: string;
  /** 细节观察（最多 5 条，FIFO） */
  observations: string[];
  /** 角色心中给对方的标签："有秘密的人"、"热心的邻居" */
  mentalLabel: string;
  /** 未解疑惑（最多 3 条） */
  unresolved: string[];
  /**
   * 累积的疙瘩/变凉信号（最多 3 条，FIFO）——下行叙事记忆。
   * 对称于 unresolved：让「第三次放我鸽子」这种积怨能攒起来，而不是每次对话被覆盖。
   * 纯叙事可见，不直接改关系数值（关系数值由 valence −3..+3 负责）。
   */
  frictions?: string[];
  /**
   * C4 疑惑槽节流（DESIGN-revival §3）：每条 unresolved 的"未解次数"——该疑惑
   * 经历过多少次印象更新仍未解（首次登记 = 1，之后每次 merge 存活 +1）。
   * 未解 ≥2 次才注回 prompt，切断"模型读到自己上轮的疑惑→本轮接着试探"的反馈回路。
   * 随档结构用 Record 不用 Map（§4.5）；旧档缺此字段时读档 normalize 为成熟值。
   */
  unresolvedCounts?: Record<string, number>;
  /** 最后更新的 tick */
  lastUpdated: number;
}

/**
 * C4 疑惑槽节流：只取"未解 ≥ minCount 次"的疑惑注回 prompt。
 * minCount ≤ 1 = 不节流（off 档治愈系基线行为）；缺计数的条目视为已成熟（旧档兼容）。
 */
export function filterMatureUnresolved(imp: CharacterImpression, minCount: number): string[] {
  if (minCount <= 1) return imp.unresolved;
  return imp.unresolved.filter((q) => (imp.unresolvedCounts?.[q] ?? minCount) >= minCount);
}

/** 把计数 Record 归一到当前 unresolved 列表：只留现存疑惑的计数，缺省 defaultCount */
function normalizeCounts(
  unresolved: string[],
  counts: Record<string, number> | undefined,
  defaultCount: number,
): Record<string, number> | undefined {
  if (unresolved.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const q of unresolved) out[q] = counts?.[q] ?? defaultCount;
  return out;
}

/**
 * 印象存储。每个角色对其他角色的印象独立管理。
 * Key: "observerId:targetId"
 */
export class ImpressionStore {
  private _data: Map<string, CharacterImpression> = new Map();

  private _key(observerId: string, targetId: string): string {
    return `${observerId}:${targetId}`;
  }

  /** 获取 observer 对 target 的印象 */
  get(observerId: string, targetId: string): CharacterImpression | undefined {
    return this._data.get(this._key(observerId, targetId));
  }

  /** 设置/更新印象 */
  set(observerId: string, impression: CharacterImpression): void {
    const key = this._key(observerId, impression.characterId);

    // 限制 observations 最多 5 条
    if (impression.observations.length > 5) {
      impression.observations = impression.observations.slice(-5);
    }
    // 限制 unresolved 最多 3 条
    if (impression.unresolved.length > 3) {
      impression.unresolved = impression.unresolved.slice(-3);
    }
    // 限制 frictions 最多 3 条
    if (impression.frictions && impression.frictions.length > 3) {
      impression.frictions = impression.frictions.slice(-3);
    }

    // C4：疑惑计数归一——只保留现存疑惑的计数，缺省 1（首次登记）
    impression.unresolvedCounts = normalizeCounts(impression.unresolved, impression.unresolvedCounts, 1);

    this._data.set(key, impression);
  }

  /** 合并新观察到已有印象（保留旧观察，追加新的） */
  merge(observerId: string, update: CharacterImpression): void {
    const existing = this.get(observerId, update.characterId);
    if (!existing) {
      this.set(observerId, update);
      return;
    }

    // 合并：summary 和 mentalLabel 总是用最新的
    existing.summary = update.summary;
    existing.mentalLabel = update.mentalLabel;
    existing.lastUpdated = update.lastUpdated;

    // observations 追加新的，保留最近 5 条
    for (const obs of update.observations) {
      if (!existing.observations.includes(obs)) {
        existing.observations.push(obs);
      }
    }
    if (existing.observations.length > 5) {
      existing.observations = existing.observations.slice(-5);
    }

    // unresolved 追加新的，保留最近 3 条。
    // C4 疑惑计数：存量疑惑又挺过一次印象更新仍未解 → 次数 +1；新登记 = 1
    const counts: Record<string, number> = {};
    for (const q of existing.unresolved) {
      counts[q] = (existing.unresolvedCounts?.[q] ?? 1) + 1;
    }
    for (const q of update.unresolved) {
      if (!existing.unresolved.includes(q)) {
        existing.unresolved.push(q);
        counts[q] = update.unresolvedCounts?.[q] ?? 1;
      }
    }
    if (existing.unresolved.length > 3) {
      existing.unresolved = existing.unresolved.slice(-3);
    }
    existing.unresolvedCounts = normalizeCounts(existing.unresolved, counts, 1);

    // frictions 追加新的，保留最近 3 条（对称于 unresolved，让积怨能累积成弧线）
    if (update.frictions && update.frictions.length > 0) {
      if (!existing.frictions) existing.frictions = [];
      for (const f of update.frictions) {
        if (!existing.frictions.includes(f)) existing.frictions.push(f);
      }
      if (existing.frictions.length > 3) {
        existing.frictions = existing.frictions.slice(-3);
      }
    }

    this._data.set(this._key(observerId, update.characterId), existing);
  }

  /** 获取某角色对所有人的印象 */
  getAllFor(observerId: string): CharacterImpression[] {
    const results: CharacterImpression[] = [];
    for (const [key, imp] of this._data) {
      if (key.startsWith(`${observerId}:`)) {
        results.push(imp);
      }
    }
    return results;
  }

  /**
   * 格式化印象为 prompt 文本。
   * opts.unresolvedMinCount：C4 疑惑槽节流——未解 ≥ 该次数的疑惑才注回
   * （调用方用 break-config.unresolvedThrottleMinCount() 取档位值；缺省 1 = 不节流基线）。
   */
  formatForPrompt(observerId: string, targetId: string, opts?: { unresolvedMinCount?: number }): string | undefined {
    const imp = this.get(observerId, targetId);
    if (!imp) return undefined;

    const parts: string[] = [];
    parts.push(imp.summary);

    if (imp.observations.length > 0) {
      parts.push(`你注意到：${imp.observations.join("；")}`);
    }

    if (imp.mentalLabel) {
      parts.push(`你觉得这是个「${imp.mentalLabel}」。`);
    }

    // 疙瘩放在疑惑之前——积怨是关系走向的底色，优先让角色看见
    if (imp.frictions && imp.frictions.length > 0) {
      parts.push(`你对TA的疙瘩：${imp.frictions.join("；")}`);
    }

    const injectable = filterMatureUnresolved(imp, opts?.unresolvedMinCount ?? 1);
    if (injectable.length > 0) {
      parts.push(`你的疑惑：${injectable.join("；")}`);
    }

    return parts.join("\n");
  }

  /** 所有数据（用于序列化） */
  getAll(): Array<{ observerId: string; impression: CharacterImpression }> {
    const results: Array<{ observerId: string; impression: CharacterImpression }> = [];
    for (const [key, imp] of this._data) {
      const observerId = key.split(":")[0]!;
      results.push({ observerId, impression: imp });
    }
    return results;
  }

  /** 数据量 */
  get size(): number {
    return this._data.size;
  }
}
