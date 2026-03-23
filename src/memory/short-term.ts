/**
 * Short-Term Memory — 角色短期记忆
 *
 * 每个角色维护一个滑动窗口，记录最近的事件和对话摘要。
 * 在 prompt 构建时注入，让角色有连续性。
 */

export interface MemoryEntry {
  tick: number;
  type: "event" | "conversation" | "thought" | "observation";
  content: string;
  importance: number; // 1-10
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

  /** 格式化为 prompt 文本 */
  formatForPrompt(characterId: string, count = 8): string {
    const entries = this.getRecent(characterId, count);
    if (entries.length === 0) return "";

    return entries
      .map((e) => {
        const prefix = e.type === "conversation" ? "💬" : e.type === "thought" ? "💭" : "📌";
        return `${prefix} ${e.content}`;
      })
      .join("\n");
  }

  /** 清空角色记忆 */
  clear(characterId: string): void {
    this._memories.delete(characterId);
  }
}
