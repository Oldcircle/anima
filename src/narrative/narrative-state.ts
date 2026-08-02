/**
 * Narrative State — 叙事状态命名空间
 *
 * 平行于 character.relationships / impressions / needs 的叙事专属状态层。
 * 由角色工具调用时填的语义标签翻译而来；BeatEngine（N3）将读取这些字段。
 *
 * 设计原则：只存事实字段，不存自然语言剧情。LLM 看自然语言摘要，引擎只读字段。
 */

export interface UnresolvedEvent {
  id: string;
  summary: string;            // 给 LLM 看的一行白描
  involved: string[];          // 角色 id 列表
  visibleTo: string[] | "*";   // 谁知道这事存在
  createdTick: number;
  resolvesWhen?: string;       // 表达式（N3 接入）
}

export interface WitnessedEvent {
  tick: number;
  summary: string;
  actors: string[];
  visibility: "private" | "overheard" | "public";
}

export interface CharacterNarrativeState {
  disclosedSecrets: string[];                       // 已对他人坦白的秘密 id
  knownFacts: string[];                             // 已知的世界事实 id
  unresolvedWith: Record<string, string[]>;         // {otherCharId: [topic ids]}
  pressure: number;                                 // 0-100，叙事压力
  /** 角色卡定义的秘密池快照（只读，由角色 yml 加载时填入） */
  secretsPool: string[];
}

export interface LocationNarrativeState {
  eventsWitnessed: WitnessedEvent[];
  rumorSeeds: string[];
}

export interface WorldNarrativeState {
  unresolvedEvents: UnresolvedEvent[];
  triggeredBeats: string[];
  activePhase?: string;
  tensionIndex: number;     // 0-100，每 tick 末由引擎算
  rumors: Array<{ content: string; sourceCharId?: string; tick: number; reachedChars: string[] }>;
  /**
   * 每条 beat 最近一次触发的 tick（随档计数器，A 件 tension 干旱项数据源；
   * cooldown 型 beat（B4）也读它）。新结构用 Record 不用 Map——JSON 序列化往返安全。
   */
  beatLastTrigger: Record<string, number>;
}

export interface NarrativeStateSnapshot {
  world: WorldNarrativeState;
  characters: Record<string, CharacterNarrativeState>;
  locations: Record<string, LocationNarrativeState>;
}

export function emptyNarrativeState(): NarrativeStateSnapshot {
  return {
    world: {
      unresolvedEvents: [],
      triggeredBeats: [],
      activePhase: undefined,
      tensionIndex: 0,
      rumors: [],
      beatLastTrigger: {},
    },
    characters: {},
    locations: {},
  };
}

/**
 * 读档 normalize（DESIGN-revival A 前置）：旧档缺新字段时逐层回填默认值。
 * 旧档直灌会让下游公式吃到 undefined → NaN（前科：_nextFateAt/_starvingSince）。
 * 采用"填缺不重建"策略：未知的未来字段原样保留，只补/修已知字段。
 */
export function normalizeNarrativeSnapshot(
  raw: Partial<NarrativeStateSnapshot> | null | undefined,
): NarrativeStateSnapshot {
  const snap = (raw ?? {}) as NarrativeStateSnapshot;

  if (!snap.world || typeof snap.world !== "object") {
    snap.world = emptyNarrativeState().world;
  }
  const w = snap.world;
  if (!Array.isArray(w.unresolvedEvents)) w.unresolvedEvents = [];
  if (!Array.isArray(w.triggeredBeats)) w.triggeredBeats = [];
  if (typeof w.activePhase !== "string") w.activePhase = undefined;
  if (typeof w.tensionIndex !== "number" || !Number.isFinite(w.tensionIndex)) {
    w.tensionIndex = 0;
  } else {
    w.tensionIndex = Math.max(0, Math.min(100, w.tensionIndex));
  }
  if (!Array.isArray(w.rumors)) w.rumors = [];
  if (!w.beatLastTrigger || typeof w.beatLastTrigger !== "object" || Array.isArray(w.beatLastTrigger)) {
    w.beatLastTrigger = {};
  } else {
    for (const [k, v] of Object.entries(w.beatLastTrigger)) {
      if (typeof v !== "number" || !Number.isFinite(v)) delete w.beatLastTrigger[k];
    }
  }

  if (!snap.characters || typeof snap.characters !== "object" || Array.isArray(snap.characters)) {
    snap.characters = {};
  }
  for (const [id, c] of Object.entries(snap.characters)) {
    if (!c || typeof c !== "object") {
      delete snap.characters[id];
      continue;
    }
    if (!Array.isArray(c.disclosedSecrets)) c.disclosedSecrets = [];
    if (!Array.isArray(c.knownFacts)) c.knownFacts = [];
    if (!c.unresolvedWith || typeof c.unresolvedWith !== "object" || Array.isArray(c.unresolvedWith)) {
      c.unresolvedWith = {};
    }
    if (typeof c.pressure !== "number" || !Number.isFinite(c.pressure)) {
      c.pressure = 0;
    } else {
      c.pressure = Math.max(0, Math.min(100, c.pressure));
    }
    if (!Array.isArray(c.secretsPool)) c.secretsPool = [];
  }

  if (!snap.locations || typeof snap.locations !== "object" || Array.isArray(snap.locations)) {
    snap.locations = {};
  }
  for (const [id, l] of Object.entries(snap.locations)) {
    if (!l || typeof l !== "object") {
      delete snap.locations[id];
      continue;
    }
    if (!Array.isArray(l.eventsWitnessed)) l.eventsWitnessed = [];
    if (!Array.isArray(l.rumorSeeds)) l.rumorSeeds = [];
  }

  return snap;
}

function ensureCharacter(state: NarrativeStateSnapshot, charId: string): CharacterNarrativeState {
  if (!state.characters[charId]) {
    state.characters[charId] = {
      disclosedSecrets: [],
      knownFacts: [],
      unresolvedWith: {},
      pressure: 0,
      secretsPool: [],
    };
  }
  return state.characters[charId];
}

function ensureLocation(state: NarrativeStateSnapshot, locId: string): LocationNarrativeState {
  if (!state.locations[locId]) {
    state.locations[locId] = { eventsWitnessed: [], rumorSeeds: [] };
  }
  return state.locations[locId];
}

/**
 * NarrativeState — 可变的状态容器（薄包装，便于注入 World 并提供受控写入接口）
 */
export class NarrativeState {
  private snapshot: NarrativeStateSnapshot;

  constructor(snapshot?: NarrativeStateSnapshot) {
    this.snapshot = snapshot ?? emptyNarrativeState();
  }

  /** 取整个快照（只读引用 — 修改请通过本类的方法） */
  getSnapshot(): NarrativeStateSnapshot {
    return this.snapshot;
  }

  /** 整体替换（用于读档）。旧档缺新字段时自动 normalize 回填默认值。 */
  replaceSnapshot(snapshot: NarrativeStateSnapshot): void {
    this.snapshot = normalizeNarrativeSnapshot(snapshot);
  }

  // ── 角色 ──

  getCharacter(charId: string): CharacterNarrativeState {
    return ensureCharacter(this.snapshot, charId);
  }

  addDisclosedSecret(charId: string, secretId: string): boolean {
    const c = ensureCharacter(this.snapshot, charId);
    if (c.disclosedSecrets.includes(secretId)) return false;
    c.disclosedSecrets.push(secretId);
    return true;
  }

  addKnownFact(charId: string, factId: string): boolean {
    const c = ensureCharacter(this.snapshot, charId);
    if (c.knownFacts.includes(factId)) return false;
    c.knownFacts.push(factId);
    return true;
  }

  addUnresolvedWith(charId: string, otherCharId: string, topicId: string): void {
    const c = ensureCharacter(this.snapshot, charId);
    if (!c.unresolvedWith[otherCharId]) c.unresolvedWith[otherCharId] = [];
    if (!c.unresolvedWith[otherCharId].includes(topicId)) {
      c.unresolvedWith[otherCharId].push(topicId);
    }
  }

  setPressure(charId: string, pressure: number): void {
    const c = ensureCharacter(this.snapshot, charId);
    c.pressure = Math.max(0, Math.min(100, pressure));
  }

  setSecretsPool(charId: string, secrets: string[]): void {
    const c = ensureCharacter(this.snapshot, charId);
    c.secretsPool = [...secrets];
  }

  // ── 世界 ──

  getWorld(): WorldNarrativeState {
    return this.snapshot.world;
  }

  addUnresolvedEvent(event: UnresolvedEvent): void {
    if (this.snapshot.world.unresolvedEvents.some((e) => e.id === event.id)) return;
    this.snapshot.world.unresolvedEvents.push(event);
  }

  removeUnresolvedEvent(id: string): boolean {
    const before = this.snapshot.world.unresolvedEvents.length;
    this.snapshot.world.unresolvedEvents = this.snapshot.world.unresolvedEvents.filter(
      (e) => e.id !== id,
    );
    return this.snapshot.world.unresolvedEvents.length < before;
  }

  /** 返回某角色"看得见"的未解决事件（visible_to 包含该角色或为 "*"） */
  getUnresolvedEventsVisibleTo(charId: string): UnresolvedEvent[] {
    return this.snapshot.world.unresolvedEvents.filter(
      (e) => e.visibleTo === "*" || e.visibleTo.includes(charId),
    );
  }

  markBeatTriggered(beatId: string): boolean {
    if (this.snapshot.world.triggeredBeats.includes(beatId)) return false;
    this.snapshot.world.triggeredBeats.push(beatId);
    return true;
  }

  /** 记录某条 beat 的触发 tick（随档；tension 干旱项与 cooldown 型 beat 的数据源） */
  recordBeatTrigger(beatId: string, tick: number): void {
    this.snapshot.world.beatLastTrigger[beatId] = tick;
  }

  /** 距上一次任意 beat 触发过去了多少 tick（无触发史按世界起点 0 算——世界一开始就在"干旱"） */
  getTicksSinceLastBeat(currentTick: number): number {
    const ticks = Object.values(this.snapshot.world.beatLastTrigger);
    const last = ticks.length > 0 ? Math.max(...ticks) : 0;
    return Math.max(0, currentTick - last);
  }

  setActivePhase(phase: string | undefined): void {
    this.snapshot.world.activePhase = phase;
  }

  setTensionIndex(value: number): void {
    this.snapshot.world.tensionIndex = Math.max(0, Math.min(100, value));
  }

  // ── 地点 ──

  recordWitnessedEvent(locId: string, event: WitnessedEvent): void {
    const l = ensureLocation(this.snapshot, locId);
    l.eventsWitnessed.push(event);
    // 简单 cap：保留最近 50 条
    if (l.eventsWitnessed.length > 50) {
      l.eventsWitnessed.splice(0, l.eventsWitnessed.length - 50);
    }
  }
}
