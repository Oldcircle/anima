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

// ── B1 立场账（DESIGN-revival §2 B1）──

/** 敌对立场类型（和解类 apologize/reconcile/clarify 不落账——命中即清对应 openStance） */
export type OpenStanceKind = "expose" | "accuse" | "threaten" | "vow" | "break" | "side_with";

export const OPEN_STANCE_KINDS: readonly OpenStanceKind[] = [
  "expose", "accuse", "threaten", "vow", "break", "side_with",
];

/**
 * 未了结立场（随档）：交锋之后的账。active 期间参与压力图 + B1.5 阻尼豁免；
 * TTL 7 游戏天无 refresh 自动降档归档（archiveReason=ttl），和解命中即清（reconciled）。
 */
export interface OpenStance {
  id: string;
  kind: OpenStanceKind;
  /** 亮立场的一方 */
  holderId: string;
  targetId: string;
  summary: string;
  /** 逐字命中转录的原话（抽取时已经 substring 校验） */
  evidence: string;
  createdTick: number;
  /** 最近一次活动（同类立场再次落账即 refresh）；压力图只计近 3 天有活动的 */
  lastRefreshTick: number;
  /** 交锋当场的在场者（不含双方）——公开性引擎机械判定的依据 */
  witnesses: string[];
  locationId?: string;
  status: "active" | "archived";
  archiveReason?: "reconciled" | "ttl";
  archivedTick?: number;
}

/** pairKey（排序后 "a:b"）——openStances / stanceDayLog / 阻尼豁免共用 */
export function stancePairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * B5 多日执念载体（DESIGN-revival §2 B5）：只配注意力不写结果。
 * 登记点：kira 应验 / B1 立场双方 / 罪案受害·嫌疑 / 同对爽约≥2 派生。
 * 消费点：晨间打算输入 + 决策 prompt 此刻区 ≤2 条 + 反思回顾。
 * 5 天衰减（sweepObsessions）、关联事件 settled 即清（clearObsessionsRelatedTo）。
 */
export interface ObsessionEntry {
  id: string;
  summary: string;
  createdDay: number;
  decayDays: number;
  source: string;
  /** 关联的 unresolvedEvent / openStance id——settled/和解时按它清账（可缺省） */
  relatedId?: string;
}

export interface CharacterNarrativeState {
  disclosedSecrets: string[];                       // 已对他人坦白的秘密 id
  knownFacts: string[];                             // 已知的世界事实 id
  unresolvedWith: Record<string, string[]>;         // {otherCharId: [topic ids]}
  pressure: number;                                 // 0-100，叙事压力
  /** 角色卡定义的秘密池快照（只读，由角色 yml 加载时填入） */
  secretsPool: string[];
  /** B5 多日执念（随档；本阶段只登记不消费，见 ObsessionEntry TODO） */
  obsessions: ObsessionEntry[];
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
  /** B1 立场账：pairKey(排序 "a:b") → 该对的立场列表（active + 归档，随档） */
  openStances: Record<string, OpenStance[]>;
  /** B1 假阳性防线④：每对每天 ≤1 条敌对立场——pairKey → 最近落账的 game day（随档） */
  stanceDayLog: Record<string, number>;
  /**
   * B3 罪行供给器账本（随档）：已处理的 crime key → 处理 tick。
   * cast 放大器靠它保证同一桩灰行为只补一次被发现链；npc 模式的投放冷却水位
   * （key "npc_last_crime" / "npc_seeded_at"）也记在这里。Record 不用 Map（JSON 往返安全）。
   */
  crimeSupplyLedger: Record<string, number>;
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
      openStances: {},
      stanceDayLog: {},
      crimeSupplyLedger: {},
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

  // B1：立场账（结构残缺的条目直接丢；lastRefreshTick 缺失回填 createdTick）
  if (!w.openStances || typeof w.openStances !== "object" || Array.isArray(w.openStances)) {
    w.openStances = {};
  } else {
    for (const [key, list] of Object.entries(w.openStances)) {
      if (!Array.isArray(list)) {
        delete w.openStances[key];
        continue;
      }
      w.openStances[key] = list.filter(
        (s) =>
          s && typeof s === "object" &&
          typeof s.id === "string" &&
          OPEN_STANCE_KINDS.includes(s.kind as OpenStanceKind) &&
          typeof s.holderId === "string" &&
          typeof s.targetId === "string" &&
          typeof s.summary === "string" &&
          typeof s.evidence === "string" &&
          typeof s.createdTick === "number" && Number.isFinite(s.createdTick),
      );
      for (const s of w.openStances[key]!) {
        if (typeof s.lastRefreshTick !== "number" || !Number.isFinite(s.lastRefreshTick)) {
          s.lastRefreshTick = s.createdTick;
        }
        if (!Array.isArray(s.witnesses)) s.witnesses = [];
        if (s.status !== "active" && s.status !== "archived") s.status = "active";
        if (typeof s.archivedTick !== "number" || !Number.isFinite(s.archivedTick)) delete s.archivedTick;
        if (s.archiveReason !== "reconciled" && s.archiveReason !== "ttl") delete s.archiveReason;
      }
      if (w.openStances[key]!.length === 0) delete w.openStances[key];
    }
  }
  if (!w.stanceDayLog || typeof w.stanceDayLog !== "object" || Array.isArray(w.stanceDayLog)) {
    w.stanceDayLog = {};
  } else {
    for (const [k, v] of Object.entries(w.stanceDayLog)) {
      if (typeof v !== "number" || !Number.isFinite(v)) delete w.stanceDayLog[k];
    }
  }

  // B3：罪行供给器账本（旧档缺失回填空；脏值清掉——NaN 会让冷却判定永假/永真）
  if (!w.crimeSupplyLedger || typeof w.crimeSupplyLedger !== "object" || Array.isArray(w.crimeSupplyLedger)) {
    w.crimeSupplyLedger = {};
  } else {
    for (const [k, v] of Object.entries(w.crimeSupplyLedger)) {
      if (typeof v !== "number" || !Number.isFinite(v)) delete w.crimeSupplyLedger[k];
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
    // B5：执念（旧档缺失回填空；结构残缺条目丢弃）
    if (!Array.isArray(c.obsessions)) {
      c.obsessions = [];
    } else {
      c.obsessions = c.obsessions.filter(
        (o) => o && typeof o === "object" && typeof o.id === "string" && typeof o.summary === "string" &&
          typeof o.createdDay === "number" && Number.isFinite(o.createdDay),
      );
      for (const o of c.obsessions) {
        if (typeof o.decayDays !== "number" || !Number.isFinite(o.decayDays)) o.decayDays = 5;
        if (typeof o.source !== "string") o.source = "unknown";
        if (typeof o.relatedId !== "string") delete o.relatedId;
      }
    }
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
      obsessions: [],
    };
  }
  const c = state.characters[charId];
  // 构造器直灌的旧快照没走 normalize：就地补新字段
  if (!Array.isArray(c.obsessions)) c.obsessions = [];
  return c;
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

  /** 和解清账用：摘掉某个 topic id（清空后删 key） */
  removeUnresolvedWith(charId: string, otherCharId: string, topicId: string): boolean {
    const c = ensureCharacter(this.snapshot, charId);
    const list = c.unresolvedWith[otherCharId];
    if (!list) return false;
    const idx = list.indexOf(topicId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length === 0) delete c.unresolvedWith[otherCharId];
    return true;
  }

  /**
   * B5 执念登记：同 id 去重、每人上限 6 条（FIFO 挤出最旧）。
   * 只配注意力不写结果——summary 是"压在心里的事"，不是行动指令。
   */
  registerObsession(charId: string, entry: ObsessionEntry): boolean {
    const c = ensureCharacter(this.snapshot, charId);
    if (c.obsessions.some((o) => o.id === entry.id)) return false;
    c.obsessions.push({ ...entry });
    if (c.obsessions.length > 6) c.obsessions.splice(0, c.obsessions.length - 6);
    return true;
  }

  /**
   * B5 消费读取口：未衰减（day - createdDay < decayDays）的执念，取最近登记的 limit 条。
   * 决策 prompt 此刻区 ≤2 条 / 晨间打算 / 反思回顾都走这里。
   */
  getActiveObsessions(charId: string, day: number, limit = 2): ObsessionEntry[] {
    const c = ensureCharacter(this.snapshot, charId);
    return c.obsessions
      .filter((o) => day - o.createdDay < o.decayDays)
      .slice(-Math.max(0, limit));
  }

  /** B5 每日衰减 sweep（06:00 调）：清掉已过 decayDays 的执念。返回清掉的条数。 */
  sweepObsessions(day: number): number {
    let n = 0;
    for (const c of Object.values(this.snapshot.characters)) {
      if (!Array.isArray(c.obsessions)) continue;
      const before = c.obsessions.length;
      c.obsessions = c.obsessions.filter((o) => day - o.createdDay < o.decayDays);
      n += before - c.obsessions.length;
    }
    return n;
  }

  /**
   * B5 settled 即清：按关联事件/立场 id 清所有角色的执念。
   * 兼容两种关联方式：显式 relatedId 字段，或 id 内含关联 id（S4 立场执念的 obs_<stanceId>_* 约定）。
   */
  clearObsessionsRelatedTo(relatedId: string): number {
    if (!relatedId) return 0;
    let n = 0;
    for (const c of Object.values(this.snapshot.characters)) {
      if (!Array.isArray(c.obsessions)) continue;
      const before = c.obsessions.length;
      c.obsessions = c.obsessions.filter(
        (o) => o.relatedId !== relatedId && !o.id.includes(relatedId),
      );
      n += before - c.obsessions.length;
    }
    return n;
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

  /** B3/§4.5：该角色是否为世界注入的静态 NPC（生存循环豁免的判定口） */
  isStaticNpc(id: string): boolean {
    return Boolean(this.snapshot.world.npcs?.[id]?.isStatic);
  }

  /** B3：罪行供给器账本（随档，懒初始化——构造器传入的旧快照没走 normalize） */
  getCrimeSupplyLedger(): Record<string, number> {
    const w = this.snapshot.world;
    if (!w.crimeSupplyLedger || typeof w.crimeSupplyLedger !== "object" || Array.isArray(w.crimeSupplyLedger)) {
      w.crimeSupplyLedger = {};
    }
    return w.crimeSupplyLedger;
  }

  // ── B1 立场账 ──

  /** 立场账全表（懒初始化——构造器传入的旧快照没走 normalize） */
  getOpenStanceMap(): Record<string, OpenStance[]> {
    const w = this.snapshot.world;
    if (!w.openStances || typeof w.openStances !== "object" || Array.isArray(w.openStances)) {
      w.openStances = {};
    }
    return w.openStances;
  }

  getOpenStances(a: string, b: string): OpenStance[] {
    return this.getOpenStanceMap()[stancePairKey(a, b)] ?? [];
  }

  getActiveOpenStances(a: string, b: string): OpenStance[] {
    return this.getOpenStances(a, b).filter((s) => s.status === "active");
  }

  /** B1.5：break/threaten 立场在账时取消疙瘩期负向减半的判定口 */
  hasActiveStanceOfKind(a: string, b: string, kinds: readonly OpenStanceKind[]): boolean {
    return this.getActiveOpenStances(a, b).some((s) => kinds.includes(s.kind));
  }

  /**
   * 落一条敌对立场：同对同类 active 已存在 → refresh（更新 lastRefreshTick/evidence/summary），
   * 否则新增。返回 { stance, refreshed }。
   */
  addOrRefreshOpenStance(stance: Omit<OpenStance, "status" | "lastRefreshTick"> & { lastRefreshTick?: number }): { stance: OpenStance; refreshed: boolean } {
    const map = this.getOpenStanceMap();
    const key = stancePairKey(stance.holderId, stance.targetId);
    if (!map[key]) map[key] = [];
    const existing = map[key].find((s) => s.status === "active" && s.kind === stance.kind);
    const tick = stance.lastRefreshTick ?? stance.createdTick;
    if (existing) {
      existing.lastRefreshTick = tick;
      existing.summary = stance.summary;
      existing.evidence = stance.evidence;
      for (const w of stance.witnesses) {
        if (!existing.witnesses.includes(w)) existing.witnesses.push(w);
      }
      return { stance: existing, refreshed: true };
    }
    const created: OpenStance = { ...stance, lastRefreshTick: tick, status: "active" };
    map[key].push(created);
    return { stance: created, refreshed: false };
  }

  /** 和解清账：把该对所有 active 立场归档（reconciled），返回被归档的条目 */
  resolveOpenStances(a: string, b: string, tick: number): OpenStance[] {
    const archived: OpenStance[] = [];
    for (const s of this.getOpenStances(a, b)) {
      if (s.status !== "active") continue;
      s.status = "archived";
      s.archiveReason = "reconciled";
      s.archivedTick = tick;
      archived.push(s);
    }
    return archived;
  }

  /** TTL 7 游戏天无 refresh 自动降档归档（§2 B1）。返回归档条数。 */
  sweepStanceTTL(tick: number, ttlTicks = 7 * 96): number {
    let n = 0;
    for (const list of Object.values(this.getOpenStanceMap())) {
      for (const s of list) {
        if (s.status !== "active") continue;
        if (tick - s.lastRefreshTick > ttlTicks) {
          s.status = "archived";
          s.archiveReason = "ttl";
          s.archivedTick = tick;
          n++;
        }
      }
    }
    return n;
  }

  /** 有 active 立场的 pairKey 集合（B1.5 阻尼豁免数据源） */
  pairsWithActiveStances(): string[] {
    const out: string[] = [];
    for (const [key, list] of Object.entries(this.getOpenStanceMap())) {
      if (list.some((s) => s.status === "active")) out.push(key);
    }
    return out;
  }

  /** 未 settled 事件牵涉的 pairKey 集合（involved 两两成对；B1.5 阻尼豁免数据源） */
  unsettledEventPairKeys(): Set<string> {
    const out = new Set<string>();
    for (const e of this.snapshot.world.unresolvedEvents) {
      if ((e.status ?? "fresh") === "settled") continue;
      for (let i = 0; i < e.involved.length; i++) {
        for (let j = i + 1; j < e.involved.length; j++) {
          out.add(stancePairKey(e.involved[i]!, e.involved[j]!));
        }
      }
    }
    return out;
  }

  /** 每对每天 ≤1 的水位表（懒初始化） */
  getStanceDayLog(): Record<string, number> {
    const w = this.snapshot.world;
    if (!w.stanceDayLog || typeof w.stanceDayLog !== "object" || Array.isArray(w.stanceDayLog)) {
      w.stanceDayLog = {};
    }
    return w.stanceDayLog;
  }

  recordStanceDay(pairKey: string, day: number): void {
    this.getStanceDayLog()[pairKey] = day;
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
