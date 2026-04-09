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
    },
    characters: {},
    locations: {},
  };
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

  /** 整体替换（用于读档） */
  replaceSnapshot(snapshot: NarrativeStateSnapshot): void {
    this.snapshot = snapshot;
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
