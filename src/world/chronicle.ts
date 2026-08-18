/**
 * Chronicle — 世界编年史（自动值班的观察者）
 *
 * 问题：模拟一跑起来，控制台就是几千行 emoji 日志的洪水。人盯不过来，
 * 而真正值得知道的事——案子破了、有人翻脸了、两个人在没人安排的情况下撞到一起——
 * 淹在里面。以前只能长跑完人肉翻 log 才知道发生过什么。
 *
 * 编年史只做一件事：**把"值得知道的事"从洪水里捞出来，按重要性排好**。两类来源——
 *
 * ① **重大事件**：机械可判的世界节点（立案/破案/冤案/篡改/饿倒/绝境行为/命运/beat/应验…）。
 *    这些点上本来就有 emoji 日志，在同一处补一条 record 即可，零新增判断。
 * ② **涌现**：没人编排却发生了的巧合（见 emergence.ts）。这才是这个项目真正的产出——
 *    每条都必须带**机械判据** `evidence`（凭什么说它是涌现），不许"我觉得这段挺有意思"。
 *
 * 纪律：
 * - **零 LLM**：全部机械判定。观察一场戏不该再花一次钱
 * - **幂等**：条目 id 由内容决定，每 tick 重跑的探测器不会把同一件事记两遍
 * - **随档**：编年史是世界状态（一局跑完的账），读档要还在（对齐 world_objects 模式）
 * - 观察者通道：不进任何角色 prompt
 */

export type ChronicleKind =
  | "case"        // 案件：立案/发现/指控/破案/冤案/冷案
  | "crime"       // 罪行本身：失窃/篡改/失言
  | "emergence"   // 涌现：无人编排的巧合（带机械判据）
  | "relationship"// 关系：翻脸/和解/结仇
  | "survival"    // 生存：饿倒/病倒/绝境行为
  | "economy"     // 经济：债务/讨债/大额转移
  | "fate"        // 命运事件层
  | "beat"        // 剧本节拍
  | "canon"       // 正典：新事实进入世界
  | "milestone";  // 机制首演等里程碑

export interface ChronicleEntry {
  /** 内容决定的稳定 id：探测器每 tick 重跑也只落一条 */
  id: string;
  tick: number;
  day: number;
  kind: ChronicleKind;
  /** 1-10。面板默认只看 ≥7，长跑时把噪音挡在外面 */
  importance: number;
  emoji: string;
  /** 一句话，脱离上下文也读得懂——这是给"不想看细节的人"看的那一行 */
  title: string;
  detail?: string;
  actors: string[];
  locationId?: string;
  /** 涌现类必填：凭什么判定这是涌现（机械判据，不是形容词） */
  evidence?: string;
}

/** 编年史上限（FIFO）。7 天长跑按经验落 200-400 条，500 够用且不占内存 */
export const MAX_CHRONICLE_ENTRIES = 500;
/** 面板默认阈值：低于此的条目属于"背景噪音"，要手动放开才看 */
export const DEFAULT_MIN_IMPORTANCE = 7;

export interface ChronicleSnapshot {
  entries: ChronicleEntry[];
  /** 机制首演记账：哪些机制已经演过了（首演只算一次） */
  firsts: string[];
  /** 关系正负号快照，用于探测"关系反转"（pairKey → -1/0/1） */
  relSign: Record<string, number>;
}

/** 一天的小结：不想逐条看的人，一天看一段 */
export interface DayDigest {
  day: number;
  entries: ChronicleEntry[];
  /** 当天最重的一条 */
  headline?: ChronicleEntry;
  emergenceCount: number;
  byKind: Array<{ kind: ChronicleKind; count: number }>;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class Chronicle {
  private _entries: ChronicleEntry[] = [];
  private _ids = new Set<string>();
  private _firsts = new Set<string>();
  private _relSign = new Map<string, number>();

  /**
   * 落一条。id 重复即视为同一件事（幂等），返回 false。
   * 探测器每 tick 都会重跑，靠这个去重而不是靠"记得上次跑到哪"。
   */
  record(entry: ChronicleEntry): boolean {
    if (this._ids.has(entry.id)) return false;
    this._ids.add(entry.id);
    this._entries.push(entry);
    if (this._entries.length > MAX_CHRONICLE_ENTRIES) {
      const dropped = this._entries.splice(0, this._entries.length - MAX_CHRONICLE_ENTRIES);
      for (const d of dropped) this._ids.delete(d.id);
    }
    return true;
  }

  /**
   * 机制首演：某个机制在这一局里第一次发生，本身就值得记一笔
   * （accuse 第一次被用、第一次有人卖血、第一次有人动手脚…）。
   * 返回 true 表示确实是首演（调用方据此决定要不要 record）。
   */
  claimFirst(mechanism: string): boolean {
    if (this._firsts.has(mechanism)) return false;
    this._firsts.add(mechanism);
    return true;
  }

  hasFirst(mechanism: string): boolean {
    return this._firsts.has(mechanism);
  }

  /** 关系正负号快照读写（关系反转探测器用） */
  getRelSign(a: string, b: string): number | undefined {
    return this._relSign.get(pairKey(a, b));
  }
  setRelSign(a: string, b: string, sign: number): void {
    this._relSign.set(pairKey(a, b), sign);
  }

  list(filter?: {
    minImportance?: number;
    kind?: ChronicleKind;
    actor?: string;
    day?: number;
    /** 只看涌现 */
    emergenceOnly?: boolean;
    limit?: number;
  }): ChronicleEntry[] {
    let rows = this._entries;
    const min = filter?.minImportance;
    if (min !== undefined) rows = rows.filter((e) => e.importance >= min);
    if (filter?.kind) rows = rows.filter((e) => e.kind === filter.kind);
    if (filter?.actor) rows = rows.filter((e) => e.actors.includes(filter.actor!));
    if (filter?.day !== undefined) rows = rows.filter((e) => e.day === filter.day);
    if (filter?.emergenceOnly) rows = rows.filter((e) => e.kind === "emergence");
    const limit = filter?.limit ?? 200;
    // 最新在前；同 tick 内重的在前
    return [...rows].sort((a, b) => b.tick - a.tick || b.importance - a.importance).slice(0, limit);
  }

  /** 按天分组的小结，最新的一天在前 */
  digests(filter?: { minImportance?: number }): DayDigest[] {
    const min = filter?.minImportance ?? 0;
    const byDay = new Map<number, ChronicleEntry[]>();
    for (const e of this._entries) {
      if (e.importance < min) continue;
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day)!.push(e);
    }
    return [...byDay.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([day, entries]) => {
        const sorted = [...entries].sort((a, b) => b.importance - a.importance || b.tick - a.tick);
        const kinds = new Map<ChronicleKind, number>();
        for (const e of entries) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
        return {
          day,
          entries: [...entries].sort((a, b) => a.tick - b.tick),
          headline: sorted[0],
          emergenceCount: entries.filter((e) => e.kind === "emergence").length,
          byKind: [...kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
        };
      });
  }

  get size(): number {
    return this._entries.length;
  }

  clear(): void {
    this._entries = [];
    this._ids.clear();
    this._firsts.clear();
    this._relSign.clear();
  }

  getSnapshot(): ChronicleSnapshot {
    return {
      entries: this._entries,
      firsts: [...this._firsts],
      relSign: Object.fromEntries(this._relSign),
    };
  }

  /** 读档：逐字段规范化 + 丢弃坏条目（对齐 world_objects 的读档纪律） */
  replaceSnapshot(snapshot: unknown): void {
    this.clear();
    const snap = snapshot as Partial<ChronicleSnapshot> | null;
    if (!snap || typeof snap !== "object") return;
    if (Array.isArray(snap.entries)) {
      for (const raw of snap.entries.slice(-MAX_CHRONICLE_ENTRIES)) {
        const e = raw as Partial<ChronicleEntry>;
        if (!e || typeof e !== "object") continue;
        if (typeof e.id !== "string" || typeof e.title !== "string") continue;
        if (typeof e.tick !== "number" || !Number.isFinite(e.tick)) continue;
        this.record({
          id: e.id,
          tick: e.tick,
          day: typeof e.day === "number" ? e.day : Math.floor(e.tick / 96),
          kind: (e.kind as ChronicleKind) ?? "milestone",
          importance: typeof e.importance === "number" ? e.importance : 5,
          emoji: typeof e.emoji === "string" ? e.emoji : "•",
          title: e.title,
          detail: typeof e.detail === "string" ? e.detail : undefined,
          actors: Array.isArray(e.actors) ? e.actors.filter((a): a is string => typeof a === "string") : [],
          locationId: typeof e.locationId === "string" ? e.locationId : undefined,
          evidence: typeof e.evidence === "string" ? e.evidence : undefined,
        });
      }
    }
    if (Array.isArray(snap.firsts)) {
      for (const f of snap.firsts) if (typeof f === "string") this._firsts.add(f);
    }
    if (snap.relSign && typeof snap.relSign === "object") {
      for (const [k, v] of Object.entries(snap.relSign)) {
        if (typeof v === "number") this._relSign.set(k, v);
      }
    }
  }
}
