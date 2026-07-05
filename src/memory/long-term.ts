/**
 * Long-Term Memory Store — 运行时长期记忆
 *
 * 此前长期记忆只是存档瞬间的快照（importance≥7 的短期记忆复制一份进 DB），
 * 运行期间没有任何路径读它 → 角色永远活在 48 小时的短期记忆气泡里，
 * "她上次放过我鸽子"这类带历史重量的引用机制上不可能发生。
 *
 * 现在：重要的事（反思/冲突/约定结算/被偷被抓）在**发生当刻**写入这里，
 * 对话时按对象检索"你们之间发生过的"注入 prompt，存档时全量持久化。
 */

export interface LongTermEntry {
  tick: number;
  type: string;
  content: string;
  importance: number;
  relatedCharacterId?: string;
}

const MAX_ENTRIES_PER_CHAR = 200;

export class LongTermMemoryStore {
  private _entries = new Map<string, LongTermEntry[]>();

  /** 写入一条长期记忆（同内容同 tick 去重；超容量时丢弃重要性最低的最旧条目） */
  add(characterId: string, entry: LongTermEntry): void {
    let list = this._entries.get(characterId);
    if (!list) {
      list = [];
      this._entries.set(characterId, list);
    }
    if (list.some((e) => e.tick === entry.tick && e.content === entry.content)) return;
    list.push(entry);
    if (list.length > MAX_ENTRIES_PER_CHAR) {
      let dropIdx = 0;
      for (let i = 1; i < Math.floor(list.length / 2); i++) {
        if (list[i]!.importance < list[dropIdx]!.importance) dropIdx = i;
      }
      list.splice(dropIdx, 1);
    }
  }

  /** 关于某个人的长期记忆（最近的在后），用于对话时注入"你们之间发生过的" */
  getAbout(characterId: string, otherId: string, count = 5): LongTermEntry[] {
    const list = this._entries.get(characterId) ?? [];
    return list
      .filter((e) => e.relatedCharacterId === otherId)
      .slice(-count);
  }

  /** 最重要的长期记忆（重要性优先，同重要性取新的） */
  getTop(characterId: string, count = 10): LongTermEntry[] {
    const list = this._entries.get(characterId) ?? [];
    return [...list]
      .sort((a, b) => b.importance - a.importance || b.tick - a.tick)
      .slice(0, count);
  }

  all(characterId: string): LongTermEntry[] {
    return this._entries.get(characterId) ?? [];
  }

  allCharacterIds(): string[] {
    return [...this._entries.keys()];
  }

  /** 读档恢复：整体替换某角色的长期记忆 */
  restore(characterId: string, entries: LongTermEntry[]): void {
    this._entries.set(characterId, [...entries].sort((a, b) => a.tick - b.tick));
  }

  clear(characterId: string): void {
    this._entries.delete(characterId);
  }
}

/**
 * 把关于某人的长期记忆 + 关系史格式化成对话 prompt 的"你们之间发生过的"段。
 * 返回 undefined 表示没有任何共同历史（刚认识）。
 */
export function formatSharedHistory(params: {
  longTermAbout: LongTermEntry[];
  relationHistory: string[];
  /** tick → 显示时间的函数（跨天标注） */
  formatTime: (tick: number) => string;
}): string | undefined {
  const lines: string[] = [];
  for (const e of params.longTermAbout) {
    lines.push(`- [${params.formatTime(e.tick)}] ${e.content}`);
  }
  for (const h of params.relationHistory.slice(-3)) {
    if (!lines.some((l) => l.includes(h))) lines.push(`- ${h}`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}
