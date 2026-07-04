/**
 * Short-Term Memory — 角色短期记忆
 *
 * 每个角色维护一个滑动窗口，记录最近的事件和对话摘要。
 * 在 prompt 构建时注入，让角色有连续性。
 */

import { tickToGameTime, TICKS_PER_DAY } from "../core/tick-engine.js";
import { mmrRerank } from "./mmr.js";
import { calculateTemporalDecayMultiplier } from "./temporal-decay.js";

/** tick → "HH:MM"；传入 currentTick 时跨天记忆加"昨天"/"N天前"前缀，让模型分得清昨晚和刚才 */
function _tickTime(tick: number, currentTick?: number): string {
  const gt = tickToGameTime(tick);
  const hhmm = `${String(gt.hour).padStart(2, "0")}:${String(gt.minute).padStart(2, "0")}`;
  if (currentTick === undefined) return hhmm;
  const dayDiff = tickToGameTime(currentTick).day - gt.day;
  if (dayDiff <= 0) return hhmm;
  return dayDiff === 1 ? `昨天${hhmm}` : `${dayDiff}天前${hhmm}`;
}

export interface MemoryEntry {
  tick: number;
  type: "event" | "conversation" | "thought" | "observation";
  content: string;
  importance: number; // 1-10
  /** 对话相关记忆的对方 ID（talk 发出/收到时记录） */
  relatedCharacterId?: string;
}

/**
 * prompt 记忆检索的重排配置。
 * 此前注入 prompt 的记忆是纯 recency（取最近 N 条），importance 只参与淘汰不参与检索，
 * 也没有多样性去重 → 反思容易被琐事挤出、同类行为反复刷屏。
 * 这里在「已选出的最近窗口」内做一次加权打分 + MMR 多样性重排（不触碰长期记忆，控制影响范围）。
 */
export interface RetrievalRerankConfig {
  enabled: boolean;
  /** 加权打分的时间衰减半衰期（游戏天）。窗口内最多约 2 天，用短半衰期让"新"真有梯度。 */
  halfLifeDays: number;
  /** MMR λ：0=最多样、1=最相关。0.7 偏相关但足够挤掉雷同措辞的冗余记忆。 */
  lambda: number;
}

export const DEFAULT_RETRIEVAL_RERANK: RetrievalRerankConfig = {
  // 默认开启；`ANIMA_MEM_RERANK=0` 可关掉，用于同一份构建的 A/B（baseline 与现状逐字一致）。
  enabled: process.env.ANIMA_MEM_RERANK !== "0",
  halfLifeDays: 2,
  lambda: 0.7,
};

/**
 * 原始候选池 = count × 此系数（天然被 _maxEntries=30 封顶）。
 * 比旧的 ×2 略宽，给重排足够挑选空间；关闭重排时 slice(-count) 结果不受系数影响 → baseline 不变。
 */
const RETRIEVAL_POOL_MULTIPLIER = 3;

/**
 * 在最近窗口内选出注入 prompt 的 count 条记忆：
 * 1. 打分 = importance × 时间衰减（越新越重，但重要的旧记忆不会瞬间归零）；
 * 2. MMR 用 Jaccard 相似度去冗余，雷同措辞只留代表、腾位置给多样内容；
 * 3. 选完按 tick 正序还原，让下游的时间戳/跨天前缀/连续压缩照常工作。
 *
 * 候选 ≤ count（或关闭时）原样返回最近 count 条 —— 与旧的纯 recency 行为逐字一致，
 * 因此 baseline（enabled=false）永远等于改动前的输出。
 */
export function rerankRecentForPrompt(
  candidates: MemoryEntry[],
  count: number,
  currentTick: number | undefined,
  config: RetrievalRerankConfig = DEFAULT_RETRIEVAL_RERANK,
): MemoryEntry[] {
  if (!config.enabled || candidates.length <= count) {
    return candidates.slice(-count);
  }

  const scored = candidates.map((entry, i) => {
    const decay =
      currentTick === undefined
        ? 1
        : calculateTemporalDecayMultiplier({
            ageInDays: Math.max(0, currentTick - entry.tick) / TICKS_PER_DAY,
            halfLifeDays: config.halfLifeDays,
          });
    // id 用下标保证唯一（内容/tick 可能重复），MMR 的 tokenCache 才不会串味
    return { id: String(i), score: entry.importance * decay, content: entry.content, entry };
  });

  const ranked = mmrRerank(scored, { enabled: true, lambda: config.lambda });
  return ranked
    .slice(0, count)
    .map((s) => s.entry)
    .sort((a, b) => a.tick - b.tick);
}

export class ShortTermMemory {
  private _memories = new Map<string, MemoryEntry[]>();
  private _maxEntries: number;

  constructor(maxEntries = 30) {
    this._maxEntries = maxEntries;
  }

  /** 添加记忆 */
  add(characterId: string, entry: MemoryEntry): void {
    let entries = this._memories.get(characterId);
    if (!entries) {
      entries = [];
      this._memories.set(characterId, entries);
    }
    entries.push(entry);
    // 窗口满时按重要性淘汰：琐事先忘，反思/冲突/约定留得更久
    while (entries.length > this._maxEntries) {
      this._evictOne(entries, entry.tick);
    }
  }

  /**
   * 淘汰一条记忆，让 importance 真正参与保留（此前是纯 FIFO，反思和路过琐事同速蒸发）：
   * 1. 超过 2 个游戏天的旧记忆无条件先走——再重要的事也会淡；
   * 2. 否则在最旧的一半里挑重要性最低的丢，平分时丢更旧的。
   * 效果：反思(9)/失败与冲突(8)/对话(7) 能活过一晚，琐事(3-4)先被挤出。
   */
  private _evictOne(entries: MemoryEntry[], currentTick: number): void {
    const HARD_EXPIRE_TICKS = 192; // 2 个游戏天
    const expiredIdx = entries.findIndex((e) => currentTick - e.tick > HARD_EXPIRE_TICKS);
    if (expiredIdx >= 0) {
      entries.splice(expiredIdx, 1);
      return;
    }
    const candidateEnd = Math.max(1, Math.floor(entries.length / 2));
    let evictIdx = 0;
    for (let i = 1; i < candidateEnd; i++) {
      if (entries[i]!.importance < entries[evictIdx]!.importance) evictIdx = i;
    }
    entries.splice(evictIdx, 1);
  }

  /** 获取角色最近的记忆 */
  getRecent(characterId: string, count = 10): MemoryEntry[] {
    const entries = this._memories.get(characterId) ?? [];
    return entries.slice(-count);
  }

  /** 获取一天的所有记忆（用于反思） */
  getDayMemories(characterId: string, dayStartTick: number, dayEndTick: number): MemoryEntry[] {
    const entries = this._memories.get(characterId) ?? [];
    return entries.filter((e) => e.tick >= dayStartTick && e.tick <= dayEndTick);
  }

  /**
   * 拿出最近的纯想法（thought 类型），按时间正序。
   * 用于 prompt 单独渲染"你刚才想过的"段落。
   */
  getRecentThoughts(characterId: string, count = 5): MemoryEntry[] {
    const entries = this._memories.get(characterId) ?? [];
    const thoughts = entries.filter((e) => e.type === "thought");
    return thoughts.slice(-count);
  }

  /**
   * 格式化为 prompt 文本（含时间戳、连续压缩、对话标注）
   * 注意：thought 类型已被 prompt-builder 单独成段，这里跳过它们避免重复。
   * @param currentTick 当前游戏 tick；传入时跨天记忆会带"昨天"/"N天前"前缀
   */
  formatForPrompt(characterId: string, count = 10, currentTick?: number): string {
    // 拉宽原始候选（× MULTIPLIER，天然被 _maxEntries 封顶），过滤掉已单独成段的 thought，
    // 再在窗口内做「重要性 × 时间衰减」加权 + MMR 多样性重排选出 count 条。
    // 关闭重排（ANIMA_MEM_RERANK=0）时退化为取最近 count 条，与旧的纯 recency 行为逐字一致。
    const pool = this.getRecent(characterId, count * RETRIEVAL_POOL_MULTIPLIER);
    const candidates = pool.filter((e) => e.type !== "thought");
    const entries = rerankRecentForPrompt(candidates, count, currentTick);
    if (entries.length === 0) return "";

    // 第一遍：对话未回复检测
    const unrepliedCount = new Map<string, number>();
    const frozen = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (!e.relatedCharacterId) continue;
      if (e.type === "conversation") {
        frozen.add(e.relatedCharacterId);
      } else if (e.type === "event" && e.content.match(/^对.+?说：/)) {
        if (!frozen.has(e.relatedCharacterId)) {
          unrepliedCount.set(e.relatedCharacterId, (unrepliedCount.get(e.relatedCharacterId) ?? 0) + 1);
        }
      }
    }

    // 第二遍：正序渲染，压缩连续相同行为，加时间戳
    const lines: string[] = [];
    let prevContent = "";
    let repeatCount = 0;
    let repeatStartTick = 0;

    const flushRepeat = () => {
      if (repeatCount > 1) {
        const startTime = _tickTime(repeatStartTick, currentTick);
        const endTime = _tickTime(entries[lines.length + repeatCount - 1]?.tick ?? repeatStartTick, currentTick);
        lines.push(`📌 [${startTime}-${endTime}] ${prevContent}（连续${repeatCount}次，考虑换个事做）`);
      }
      repeatCount = 0;
    };

    const annotated = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const time = _tickTime(e.tick, currentTick);
      const prefix = e.type === "conversation" ? "💬" : e.type === "thought" ? "💭" : "📌";

      // 连续相同行为压缩（只压缩 event 类型）
      if (e.type === "event" && e.content === prevContent) {
        if (repeatCount === 0) repeatStartTick = entries[i - 1]?.tick ?? e.tick;
        repeatCount++;
        continue;
      }

      // 输出之前的重复
      if (repeatCount > 1) {
        const startTime = _tickTime(repeatStartTick, currentTick);
        lines.push(`📌 [${startTime}-${time}] ${prevContent}（连续${repeatCount}次，考虑换个事做）`);
        repeatCount = 0;
      } else if (repeatCount === 1) {
        repeatCount = 0;
      }

      let line = `${prefix} [${time}] ${e.content}`;

      // 对话未回复标注
      if (e.type === "event" && e.relatedCharacterId && e.content.match(/^对.+?说：/)) {
        const cid = e.relatedCharacterId;
        const cnt = unrepliedCount.get(cid) ?? 0;
        if (cnt >= 2 && !annotated.has(cid)) {
          line += `（你已经连续${cnt}次找对方说话，但对方没有回应你）`;
          annotated.add(cid);
        }
      }

      lines.push(line);
      prevContent = e.type === "event" ? e.content : "";
      if (e.type === "event" && prevContent) repeatCount = 1;
    }

    // 最后一组重复
    if (repeatCount > 1) {
      const startTime = _tickTime(repeatStartTick, currentTick);
      const endTime = _tickTime(entries[entries.length - 1]?.tick ?? repeatStartTick, currentTick);
      lines.push(`📌 [${startTime}-${endTime}] ${prevContent}（连续${repeatCount}次，考虑换个事做）`);
    }

    return lines.join("\n");
  }

  /** 清空角色记忆 */
  clear(characterId: string): void {
    this._memories.delete(characterId);
  }
}
