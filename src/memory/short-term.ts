/**
 * Short-Term Memory — 角色短期记忆
 *
 * 每个角色维护一个滑动窗口，记录最近的事件和对话摘要。
 * 在 prompt 构建时注入，让角色有连续性。
 */

import { tickToGameTime } from "../core/tick-engine.js";

/** tick → "HH:MM" */
function _tickTime(tick: number): string {
  const gt = tickToGameTime(tick);
  return `${String(gt.hour).padStart(2, "0")}:${String(gt.minute).padStart(2, "0")}`;
}

export interface MemoryEntry {
  tick: number;
  type: "event" | "conversation" | "thought" | "observation";
  content: string;
  importance: number; // 1-10
  /** 对话相关记忆的对方 ID（talk 发出/收到时记录） */
  relatedCharacterId?: string;
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
    // 滑动窗口
    if (entries.length > this._maxEntries) {
      this._memories.set(characterId, entries.slice(-this._maxEntries));
    }
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

  /** 格式化为 prompt 文本（含时间戳、连续压缩、对话标注） */
  formatForPrompt(characterId: string, count = 10): string {
    const entries = this.getRecent(characterId, count);
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
        const startTime = _tickTime(repeatStartTick);
        const endTime = _tickTime(entries[lines.length + repeatCount - 1]?.tick ?? repeatStartTick);
        lines.push(`📌 [${startTime}-${endTime}] ${prevContent}（连续${repeatCount}次，考虑换个事做）`);
      }
      repeatCount = 0;
    };

    const annotated = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const time = _tickTime(e.tick);
      const prefix = e.type === "conversation" ? "💬" : e.type === "thought" ? "💭" : "📌";

      // 连续相同行为压缩（只压缩 event 类型）
      if (e.type === "event" && e.content === prevContent) {
        if (repeatCount === 0) repeatStartTick = entries[i - 1]?.tick ?? e.tick;
        repeatCount++;
        continue;
      }

      // 输出之前的重复
      if (repeatCount > 1) {
        const startTime = _tickTime(repeatStartTick);
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
      const startTime = _tickTime(repeatStartTick);
      const endTime = _tickTime(entries[entries.length - 1]?.tick ?? repeatStartTick);
      lines.push(`📌 [${startTime}-${endTime}] ${prevContent}（连续${repeatCount}次，考虑换个事做）`);
    }

    return lines.join("\n");
  }

  /** 清空角色记忆 */
  clear(characterId: string): void {
    this._memories.delete(characterId);
  }
}
