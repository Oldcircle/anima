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

  /** 格式化为 prompt 文本（含对话来回状态标注） */
  formatForPrompt(characterId: string, count = 8): string {
    const entries = this.getRecent(characterId, count);
    if (entries.length === 0) return "";

    // 第一遍：从最新到最旧倒序扫描，统计每个对话对象的连续未回复 talk 次数
    // 通过 relatedCharacterId 匹配（统一用角色 ID，避免 ID/名字不一致问题）
    const unrepliedCount = new Map<string, number>();
    const frozen = new Set<string>(); // 已遇到回复，停止计数
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

    // 第二遍：渲染，在最新一条未回复 talk 上追加标注
    const annotated = new Set<string>();
    const lines: string[] = [];

    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const prefix = e.type === "conversation" ? "💬" : e.type === "thought" ? "💭" : "📌";
      let line = `${prefix} ${e.content}`;

      if (e.type === "event" && e.relatedCharacterId && e.content.match(/^对.+?说：/)) {
        const cid = e.relatedCharacterId;
        const count = unrepliedCount.get(cid) ?? 0;
        if (count >= 2 && !annotated.has(cid)) {
          line += `（你已经连续${count}次找对方说话，但对方没有回应你）`;
          annotated.add(cid);
        }
      }

      lines.unshift(line);
    }

    return lines.join("\n");
  }

  /** 清空角色记忆 */
  clear(characterId: string): void {
    this._memories.delete(characterId);
  }
}
