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
  /** 最后更新的 tick */
  lastUpdated: number;
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

    // unresolved 追加新的，保留最近 3 条
    for (const q of update.unresolved) {
      if (!existing.unresolved.includes(q)) {
        existing.unresolved.push(q);
      }
    }
    if (existing.unresolved.length > 3) {
      existing.unresolved = existing.unresolved.slice(-3);
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

  /** 格式化印象为 prompt 文本 */
  formatForPrompt(observerId: string, targetId: string): string | undefined {
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

    if (imp.unresolved.length > 0) {
      parts.push(`你的疑惑：${imp.unresolved.join("；")}`);
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
