/**
 * Narrative State — 叙事状态命名空间
 *
 * 平行于 character.relationships / impressions / needs 的叙事专属状态层。
 * 由角色工具调用时填的语义标签翻译而来；BeatEngine（N3）将读取这些字段。
 *
 * 设计原则：只存事实字段，不存自然语言剧情。LLM 看自然语言摘要，引擎只读字段。
 */

/**
 * 未解决事件生命周期（B4）：fresh → investigating → confronted → settled，只前向流转。
 * 由 B1 立场落账 / B3 罪行供给 / 工具标签驱动推进；settled 后 suspicion 边随之过期
 * （钩子见 NarrativeState.onEventSettled）。
 */
export type UnresolvedEventStatus = "fresh" | "investigating" | "confronted" | "settled";

export const EVENT_STATUS_ORDER: readonly UnresolvedEventStatus[] = [
  "fresh",
  "investigating",
  "confronted",
  "settled",
];

export interface UnresolvedEvent {
  id: string;
  summary: string;            // 给 LLM 看的一行白描
  involved: string[];          // 角色 id 列表
  visibleTo: string[] | "*";   // 谁知道这事存在
  createdTick: number;
  resolvesWhen?: string;       // 表达式（N3 接入）
  /** 生命周期状态（B4）。缺省视为 fresh（旧档 normalize 回填） */
  status?: UnresolvedEventStatus;
  /** 进入 settled 的 tick（suspicion 过期钩子的数据源） */
  settledTick?: number;
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

/**
 * B2 theft 延迟发现制的待发现记录（随档）：
 * 注入时真金已转移、赃物已入包，但受害者要**到场**才落"铁盒空了"发现记忆；
 * 风声（rumor）必须晚于 ≥1 个发现记忆（discoveredTick + 延迟后才释放）。
 */
export interface PendingDiscovery {
  id: string;
  victimId: string;
  /** 发现地点：受害者走到这里才触发发现 */
  locationId: string;
  /** 发现记忆（受害者视角，一段白描） */
  discoveryMemory: string;
  /** 发现当刻的现场短时氛围（observableState，短时过期） */
  observable?: string;
  /** 发现当刻注入的 recover intent */
  intentSummary?: string;
  /** 发现后延迟释放的风声（无则发现即完结） */
  rumor?: string;
  /** 发现时落账的未解决事件 */
  unresolvedEvent?: { id: string; summary: string; involved: string[]; visibleTo: string[] | "*" };
  createdTick: number;
  /** 发现发生的 tick（未发现时缺省） */
  discoveredTick?: number;
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
  /**
   * B2 导演硬事件配额（随档——导演内存态重启即失控）：
   * usedByWeek key = String(周索引 floor(tick/672))，周池 2 次；
   * lastByType = 冷却水位（inject_world_event 每类 / surface_grudge 每对）。
   */
  worldEventQuota: { usedByWeek: Record<string, number>; lastByType: Record<string, number> };
  /** B2 延迟发现队列（随档，跨日状态） */
  pendingDiscoveries: PendingDiscovery[];
  /**
   * 世界注入的静态 NPC 登记表（B3 crime-supply 的随档载体，B2 先立字段：
   * theft_with_perp 的 npc 真凶资格以此为准）。读档时由 B3 重建 addCharacter。
   */
  npcs: Record<string, { name: string; isStatic?: boolean }>;
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
      worldEventQuota: { usedByWeek: {}, lastByType: {} },
      pendingDiscoveries: [],
      npcs: {},
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
  for (const e of w.unresolvedEvents) {
    if (!e || typeof e !== "object") continue;
    // 旧档无 status → fresh；非法值也回 fresh（不猜半途状态）
    if (!EVENT_STATUS_ORDER.includes(e.status as UnresolvedEventStatus)) e.status = "fresh";
    if (typeof e.settledTick !== "number" || !Number.isFinite(e.settledTick)) delete e.settledTick;
  }
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

  // B2：硬事件配额（旧档缺失回填空计数；脏值清掉——NaN 会让配额判定永假/永真）
  const quota = w.worldEventQuota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    w.worldEventQuota = { usedByWeek: {}, lastByType: {} };
  } else {
    for (const field of ["usedByWeek", "lastByType"] as const) {
      const rec = quota[field];
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
        quota[field] = {};
      } else {
        for (const [k, v] of Object.entries(rec)) {
          if (typeof v !== "number" || !Number.isFinite(v)) delete rec[k];
        }
      }
    }
  }

  // B2：延迟发现队列（结构残缺的条目直接丢——宁可少一条发现也别让 sweep 崩）
  if (!Array.isArray(w.pendingDiscoveries)) {
    w.pendingDiscoveries = [];
  } else {
    w.pendingDiscoveries = w.pendingDiscoveries.filter(
      (d) =>
        d && typeof d === "object" &&
        typeof d.id === "string" &&
        typeof d.victimId === "string" &&
        typeof d.locationId === "string" &&
        typeof d.discoveryMemory === "string" &&
        typeof d.createdTick === "number" && Number.isFinite(d.createdTick),
    );
    for (const d of w.pendingDiscoveries) {
      if (typeof d.discoveredTick !== "number" || !Number.isFinite(d.discoveredTick)) delete d.discoveredTick;
    }
  }

  // B2/B3：NPC 登记表
  if (!w.npcs || typeof w.npcs !== "object" || Array.isArray(w.npcs)) {
    w.npcs = {};
  } else {
    for (const [id, npc] of Object.entries(w.npcs)) {
      if (!npc || typeof npc !== "object" || typeof npc.name !== "string") delete w.npcs[id];
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
    this.snapshot.world.unresolvedEvents.push({ status: "fresh", ...event });
  }

  /**
   * 推进事件生命周期（B4）：只允许前向流转（fresh→investigating→confronted→settled）。
   * 后退/原地/未知事件返回 false 不生效。进入 settled 时记 settledTick 并触发
   * onEventSettled 钩子（suspicion 边随 settled 过期的挂点，B1/B3 接线）。
   */
  advanceEventStatus(id: string, next: UnresolvedEventStatus, tick: number): boolean {
    const event = this.snapshot.world.unresolvedEvents.find((e) => e.id === id);
    if (!event) return false;
    const cur = EVENT_STATUS_ORDER.indexOf(event.status ?? "fresh");
    const to = EVENT_STATUS_ORDER.indexOf(next);
    if (to < 0 || to <= cur) return false;
    event.status = next;
    if (next === "settled") {
      event.settledTick = tick;
      for (const hook of this._eventSettledHooks) {
        try { hook(event); } catch (e) { console.warn("[narrative] onEventSettled 钩子失败:", e); }
      }
    }
    return true;
  }

  /** settled 钩子位：事件了结时回调（suspicion 过期等下游账目在此挂载）。运行期接线，不随档。 */
  private _eventSettledHooks: Array<(event: UnresolvedEvent) => void> = [];

  onEventSettled(hook: (event: UnresolvedEvent) => void): () => void {
    this._eventSettledHooks.push(hook);
    return () => {
      const i = this._eventSettledHooks.indexOf(hook);
      if (i >= 0) this._eventSettledHooks.splice(i, 1);
    };
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

  /** B2：硬事件配额计数（随档）。缺失时就地补默认（构造器传入的旧快照没走 normalize）。 */
  getWorldEventQuota(): { usedByWeek: Record<string, number>; lastByType: Record<string, number> } {
    const w = this.snapshot.world;
    if (!w.worldEventQuota || typeof w.worldEventQuota !== "object") {
      w.worldEventQuota = { usedByWeek: {}, lastByType: {} };
    }
    w.worldEventQuota.usedByWeek = w.worldEventQuota.usedByWeek ?? {};
    w.worldEventQuota.lastByType = w.worldEventQuota.lastByType ?? {};
    return w.worldEventQuota;
  }

  /** B2：延迟发现队列（随档，返回可变引用——sweep 就地增删）。 */
  getPendingDiscoveries(): PendingDiscovery[] {
    const w = this.snapshot.world;
    if (!Array.isArray(w.pendingDiscoveries)) w.pendingDiscoveries = [];
    return w.pendingDiscoveries;
  }

  addPendingDiscovery(d: PendingDiscovery): void {
    this.getPendingDiscoveries().push(d);
  }

  // ── NPC 登记（B2 立字段，B3 crime-supply 填充+读档重建）──

  registerNpc(id: string, name: string, isStatic = true): void {
    const w = this.snapshot.world;
    if (!w.npcs || typeof w.npcs !== "object") w.npcs = {};
    w.npcs[id] = { name, isStatic };
  }

  isNpc(id: string): boolean {
    return Boolean(this.snapshot.world.npcs?.[id]);
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
