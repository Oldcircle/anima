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
  /** B5 多日执念（随档；登记/消费两端见 ObsessionEntry 文档注释） */
  obsessions: ObsessionEntry[];
  /**
   * S3 已被击穿的信念 id（随档，**不可逆**）。
   * 想明白了就是想明白了——可逆的"成长"是均值回归，不是弧。
   */
  brokenBeliefs: string[];
  /**
   * S3 信念击穿判据的机械计数（随档）。
   * 全部来自 S1/S2 已有的落账点，不新开管线：
   * 兑现/爽约在 _sweepDeferrals，碰壁/要到在 _settleConversationOutcomes。
   */
  beliefStats: BeliefCounters;
}

/** S3 机械计数（关系/金币这类能直接从世界读的不入账，避免两份真相） */
export interface BeliefCounters {
  keptPromises: number;
  brokenPromises: number;
  refusedByOthers: number;
  asksLanded: number;
}

export function emptyBeliefCounters(): BeliefCounters {
  return { keptPromises: 0, brokenPromises: 0, refusedByOthers: 0, asksLanded: 0 };
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
  /**
   * M4 案件账本（PLAN-grounding，随档）：caseId → 案件（真凶 ground truth + 指控记录）。
   * theft_with_perp 注册；accuse 工具据此裁决破案/无证/冤案；5 天冷案扫描搁置。
   * fate 类无主之罪不入账（无真凶=天然悬案，accuse 不浮现）。
   */
  cases: Record<string, CaseEntry>;
  /**
   * S1 拒绝账本（随档）：`"<所求方>:<拒绝方>"`（**有向**，不排序）→ 该方向的碰壁记录。
   * 对话结算判「被拒/反将」时累加；「得手」或和解时清账。
   * 存在的意义：此前每一场戏都以平局收场——说完各自离开，世界状态零变化，
   * 于是"再谈一次"永远是最优解，绝境阶梯永远走不到第二级。
   */
  refusals: Record<string, RefusalEntry>;
  /**
   * S2 拖延账（随档）：`"<所求方>:<承诺方>"`（**有向**）→ 一张到期要兑现的欠条。
   *
   * 拖延是结算的**第四格**：既不是得手也不是被拒，而是「答应了，然后到点没做」——
   * 真实冲突里最常见的一格（live 实证：明日香追债十二个来回，真嗣自始至终既没给也没拒，他拖）。
   * 它自带期限，所以天然可结算：到点兑现=得手，到点没兑现=**爽约**（比头一次被拒更重，
   * 因为不是没要到，是被骗了一次）。
   */
  deferrals: Record<string, DeferralEntry>;
}

/** S2 拖延欠条 */
export interface DeferralEntry {
  /** 开口所求的一方 */
  fromId: string;
  /** 答应了要办的一方（拖的人） */
  toId: string;
  /** 所求类型（DesireKind） */
  kind: string;
  /** 逐字原话（他答应的那句） */
  evidence: string;
  createdTick: number;
  /** 到期时刻 */
  dueTick: number;
  /**
   * 立约时的"进度"快照——**只有能机械核验的 kind 才有**（如 debt = 当时还欠多少）。
   * 缺省 = 核验不了，到期静默过期，绝不凭 LLM 自评判兑现（进度绑真实状态是本项目红线）。
   */
  baseline?: number;
}

/** 拖延的宽限：1 游戏天。不解析"打烊前"这类自然语言，机械给窗口——戏要的是"你说了你会做" */
export const DEFERRAL_GRACE_TICKS = 96;

/** S1 拒绝条目：某人朝某人开口要一类东西，碰了几次壁 */
export interface RefusalEntry {
  /** 开口的那一方（被拒的人） */
  fromId: string;
  /** 回绝的那一方 */
  toId: string;
  /** 所求类型（DesireKind）：升档只对同类生效，借钱碰壁不该把闲聊也写硬 */
  kind: string;
  /** 累计碰壁次数 */
  count: number;
  /** 手段档位 0..3（= min(count, 3)，3 = 这条路走到头了） */
  tier: number;
  /** 其中被反将（不但没给，还被将了一军）的次数 */
  counterAttacks: number;
  /** 其中「答应了却到点没做」的次数——爽约比单纯回绝更伤，升档也更快 */
  brokenPromises: number;
  lastTick: number;
}

/**
 * 拒绝账本 TTL：5 游戏天没有新的碰壁 → 整条清掉。
 * 与执念 decayDays=5 对齐——碰壁的记忆和碰壁的执念该一起淡。
 */
export const REFUSAL_TTL_TICKS = 5 * 96;

/** 手段升档封顶（与 conversation-desire.MAX_REFUSAL_TIER 同值，此处为账本侧的钳位） */
export const MAX_REFUSAL_TIER = 3;

/** S1 有向 key：谁被谁拒是有方向的，绝不排序 */
export function refusalKey(fromId: string, toId: string): string {
  return `${fromId}:${toId}`;
}

/** M4 案件条目 */
export interface CaseEntry {
  id: string;
  kind: "theft";
  perpId: string;
  victimId: string;
  amount: number;
  createdTick: number;
  status: "open" | "solved" | "cold";
  /** 每人一发：accuserId → accusedId（当众指控是重棋，不许翻来覆去泼脏水） */
  accusations: Record<string, string>;
  closedTick?: number;
  /**
   * 案件公开时刻（受害者真发现失窃那刻，processPendingDiscoveries 落）。
   * accuse 只对公开案件浮现——否则作案瞬间全镇就冒出"指控悬案"的工具，
   * 等于引擎泄露了一桩没人知道的罪（信息隔离）。
   */
  publicSinceTick?: number;
}

/** 冷案窗：悬 5 游戏天没人破 → 诚实搁置 */
export const COLD_CASE_TICKS = 480;

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
      cases: {},
      refusals: {},
      deferrals: {},
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

  // M4：案件账本（旧档缺失回填空；缺必填字段的条目整条丢弃——半截案件比没案件更毒）
  if (!w.cases || typeof w.cases !== "object" || Array.isArray(w.cases)) {
    w.cases = {};
  } else {
    for (const [k, c] of Object.entries(w.cases)) {
      const bad =
        !c || typeof c !== "object" ||
        typeof c.perpId !== "string" || typeof c.victimId !== "string" ||
        typeof c.amount !== "number" || !Number.isFinite(c.amount) ||
        typeof c.createdTick !== "number" || !Number.isFinite(c.createdTick) ||
        !["open", "solved", "cold"].includes(c.status as string);
      if (bad) {
        delete w.cases[k];
        continue;
      }
      if (!c.accusations || typeof c.accusations !== "object" || Array.isArray(c.accusations)) {
        c.accusations = {};
      }
    }
  }

  // S1：拒绝账本（旧档缺失回填空；缺必填字段或数值脏的条目整条丢弃——
  // 半截的碰壁记录会让 tier 变 NaN，升档判定永假/永真）
  if (!w.refusals || typeof w.refusals !== "object" || Array.isArray(w.refusals)) {
    w.refusals = {};
  } else {
    for (const [k, r] of Object.entries(w.refusals)) {
      const bad =
        !r || typeof r !== "object" ||
        typeof r.fromId !== "string" || typeof r.toId !== "string" ||
        typeof r.kind !== "string" ||
        typeof r.count !== "number" || !Number.isFinite(r.count) ||
        typeof r.lastTick !== "number" || !Number.isFinite(r.lastTick);
      if (bad) {
        delete w.refusals[k];
        continue;
      }
      r.count = Math.max(1, Math.floor(r.count));
      r.tier =
        typeof r.tier === "number" && Number.isFinite(r.tier)
          ? Math.max(0, Math.min(MAX_REFUSAL_TIER, Math.floor(r.tier)))
          : Math.min(MAX_REFUSAL_TIER, r.count);
      r.counterAttacks =
        typeof r.counterAttacks === "number" && Number.isFinite(r.counterAttacks)
          ? Math.max(0, Math.floor(r.counterAttacks))
          : 0;
      r.brokenPromises =
        typeof r.brokenPromises === "number" && Number.isFinite(r.brokenPromises)
          ? Math.max(0, Math.floor(r.brokenPromises))
          : 0;
    }
  }

  // S2：拖延账（旧档缺失回填空；缺必填字段或数值脏的条目整条丢弃——
  // 半截欠条到期会把 undefined 当 baseline 判成"没兑现"，冤枉人）
  if (!w.deferrals || typeof w.deferrals !== "object" || Array.isArray(w.deferrals)) {
    w.deferrals = {};
  } else {
    for (const [k, d] of Object.entries(w.deferrals)) {
      const bad =
        !d || typeof d !== "object" ||
        typeof d.fromId !== "string" || typeof d.toId !== "string" ||
        typeof d.kind !== "string" || typeof d.evidence !== "string" ||
        typeof d.createdTick !== "number" || !Number.isFinite(d.createdTick) ||
        typeof d.dueTick !== "number" || !Number.isFinite(d.dueTick);
      if (bad) {
        delete w.deferrals[k];
        continue;
      }
      if (typeof d.baseline !== "number" || !Number.isFinite(d.baseline)) delete d.baseline;
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
    // S3：信念（旧档缺失回填；非字符串 id 丢弃；计数脏值归零——
    // NaN 会让 >= 阈值判定永假或永真）
    c.brokenBeliefs = Array.isArray(c.brokenBeliefs)
      ? c.brokenBeliefs.filter((b): b is string => typeof b === "string")
      : [];
    const counters = c.beliefStats;
    if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
      c.beliefStats = emptyBeliefCounters();
    } else {
      for (const k of Object.keys(emptyBeliefCounters()) as Array<keyof BeliefCounters>) {
        const v = counters[k];
        counters[k] = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
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
      brokenBeliefs: [],
      beliefStats: emptyBeliefCounters(),
    };
  }
  const c = state.characters[charId];
  // 构造器直灌的旧快照没走 normalize：就地补新字段
  if (!Array.isArray(c.obsessions)) c.obsessions = [];
  if (!Array.isArray(c.brokenBeliefs)) c.brokenBeliefs = [];
  if (!c.beliefStats || typeof c.beliefStats !== "object") c.beliefStats = emptyBeliefCounters();
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

  // ── S3 信念 ──

  getBrokenBeliefs(charId: string): string[] {
    return [...ensureCharacter(this.snapshot, charId).brokenBeliefs];
  }

  /** 击穿一条信念（不可逆）。已击穿返回 false */
  breakBelief(charId: string, beliefId: string): boolean {
    const c = ensureCharacter(this.snapshot, charId);
    if (c.brokenBeliefs.includes(beliefId)) return false;
    c.brokenBeliefs.push(beliefId);
    return true;
  }

  getBeliefCounters(charId: string): BeliefCounters {
    return { ...ensureCharacter(this.snapshot, charId).beliefStats };
  }

  /** 计数 +1。落点只在 S1/S2 既有的结算处，不新开管线 */
  bumpBeliefCounter(charId: string, key: keyof BeliefCounters, by = 1): void {
    const c = ensureCharacter(this.snapshot, charId);
    c.beliefStats[key] = Math.max(0, (c.beliefStats[key] ?? 0) + by);
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
   * S1 执念原地升档：同 id 的执念改写 summary 并把 createdDay 推到今天（重新计时）。
   * **不能用 registerObsession 重登记**——它同 id 直接 return false；
   * 也不能换 id 另开一条：每人上限 6 条 FIFO，同一桩事挂多档会把执念池挤爆，
   * 而 getActiveObsessions 只取最近 2 条，同一桩事会占满两个曝光位。
   * 找不到该 id → false（调用方据此走首次 registerObsession）。
   */
  upgradeObsession(charId: string, id: string, summary: string, day: number): boolean {
    const c = ensureCharacter(this.snapshot, charId);
    const idx = c.obsessions.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    const o = c.obsessions[idx]!;
    o.summary = summary;
    o.createdDay = day;
    // **必须挪到队尾**：getActiveObsessions 的"取最近"是 slice(-limit) 按**数组位置**
    // 而非 createdDay，registerObsession 的 FIFO 淘汰也是 splice(0,…) 从头砍。
    // 只刷新 createdDay 不挪位置，会出现"刚升档的执念反而抢不到那 2 个曝光位、
    // 甚至被当成最旧的第一个删掉"（对抗审查实证）。
    c.obsessions.splice(idx, 1);
    c.obsessions.push(o);
    return true;
  }

  // ── S1 拒绝账本 ──

  getRefusal(fromId: string, toId: string): RefusalEntry | undefined {
    return this.snapshot.world.refusals?.[refusalKey(fromId, toId)];
  }

  /** 全量读口（面板/战报/单测用） */
  getRefusals(): Record<string, RefusalEntry> {
    if (!this.snapshot.world.refusals) this.snapshot.world.refusals = {};
    return this.snapshot.world.refusals;
  }

  /**
   * 记一次碰壁。同方向换了所求类型 → 从头计（借钱被拒和闲聊被拒不是同一桩事）。
   * 返回落账后的条目（tier 已钳在 0..MAX_REFUSAL_TIER）。
   */
  recordRefusal(params: {
    fromId: string;
    toId: string;
    kind: string;
    tick: number;
    counterAttack?: boolean;
    /** S2 爽约：答应了却到点没做。比单纯回绝更伤——升档额外快一档 */
    brokenPromise?: boolean;
  }): RefusalEntry {
    const { fromId, toId, kind, tick } = params;
    if (!this.snapshot.world.refusals) this.snapshot.world.refusals = {};
    const key = refusalKey(fromId, toId);
    const prev = this.snapshot.world.refusals[key];
    const carry = prev && prev.kind === kind ? prev : undefined;
    const count = (carry?.count ?? 0) + 1;
    const brokenPromises = (carry?.brokenPromises ?? 0) + (params.brokenPromise ? 1 : 0);
    const entry: RefusalEntry = {
      fromId,
      toId,
      kind,
      count,
      // 爽约计入档位：被回绝 N 次和"答应了 N 次都没做"不是一回事，后者该更快走到摊牌
      tier: Math.min(MAX_REFUSAL_TIER, count + brokenPromises),
      counterAttacks: (carry?.counterAttacks ?? 0) + (params.counterAttack ? 1 : 0),
      brokenPromises,
      lastTick: tick,
    };
    this.snapshot.world.refusals[key] = entry;
    return entry;
  }

  // ── S2 拖延账 ──

  getDeferral(fromId: string, toId: string): DeferralEntry | undefined {
    return this.snapshot.world.deferrals?.[refusalKey(fromId, toId)];
  }

  getDeferrals(): Record<string, DeferralEntry> {
    if (!this.snapshot.world.deferrals) this.snapshot.world.deferrals = {};
    return this.snapshot.world.deferrals;
  }

  /**
   * 立一张欠条。
   *
   * **同方向已有未到期欠条时，保留原来的 dueTick 与 baseline**，只更新原话——
   * 否则"每次快到期就再答应一次"是一张免罪符：结算每对每天限 1 次、宽限恰好也是 1 天，
   * 刚好够无限续期，而戏里"他一直在拿话搪塞我"本该越滚越重，不是清零重来。
   * 同时刷新拒绝账的 lastTick：欠条还悬着的时候，TTL 日扫不该把攒的阶梯先抹掉。
   */
  recordDeferral(entry: DeferralEntry): void {
    if (!this.snapshot.world.deferrals) this.snapshot.world.deferrals = {};
    const key = refusalKey(entry.fromId, entry.toId);
    const prev = this.snapshot.world.deferrals[key];
    const keepOriginal = prev && entry.createdTick < prev.dueTick;
    this.snapshot.world.deferrals[key] = keepOriginal
      ? { ...prev, evidence: entry.evidence, kind: entry.kind }
      : { ...entry };
    const r = this.snapshot.world.refusals?.[key];
    if (r) r.lastTick = entry.createdTick;
  }

  clearDeferral(fromId: string, toId: string): boolean {
    const d = this.snapshot.world.deferrals;
    const key = refusalKey(fromId, toId);
    if (!d?.[key]) return false;
    delete d[key];
    return true;
  }

  /** 到期的欠条（调用方逐张核验兑现与否） */
  getDueDeferrals(tick: number): DeferralEntry[] {
    return Object.values(this.snapshot.world.deferrals ?? {}).filter((d) => tick >= d.dueTick);
  }

  /**
   * S1 拒绝账本衰减 sweep（06:00 日扫调）：`REFUSAL_TTL_TICKS` 内没有新的碰壁就整条清掉。
   * 没有这条，refusals 会是同批随档态里**唯一无限期**的账——
   * 半年前碰过一次壁的人，所求那一行永远写着硬话。返回清掉的条数。
   */
  sweepRefusals(tick: number): number {
    const refusals = this.snapshot.world.refusals;
    if (!refusals) return 0;
    let n = 0;
    for (const [key, r] of Object.entries(refusals)) {
      if (tick - r.lastTick >= REFUSAL_TTL_TICKS) {
        delete refusals[key];
        n++;
      }
    }
    return n;
  }

  /**
   * S1 得手退档：**降一档而不是一键清空**。
   *
   * 得手是唯一会删持久状态的结果，而判它的是个会出错的分类器——
   * 给分类器一键抹掉几天阶梯的权力，等于把整层的可靠性押在它身上。
   * 退档让一次误判只值一档，而且叙事上更真：这回成了，不等于之前碰的壁一笔勾销。
   * 退到 0 即整条摘掉。返回退档后的条目（已清则 undefined）。
   */
  easeRefusal(fromId: string, toId: string, tick: number): RefusalEntry | undefined {
    const refusals = this.snapshot.world.refusals;
    const key = refusalKey(fromId, toId);
    const prev = refusals?.[key];
    if (!refusals || !prev) return undefined;
    const count = prev.count - 1;
    // **爽约计数也要跟着退**：tier = count + brokenPromises，只减 count 的话
    // 爽约过的对永远退不下来（bp=2 时 count 2→1，tier 仍是 3），
    // "得手退一档"这句话就成了空话
    const brokenPromises = Math.max(0, (prev.brokenPromises ?? 0) - 1);
    if (count <= 0) {
      delete refusals[key];
      return undefined;
    }
    const next: RefusalEntry = {
      ...prev,
      count,
      brokenPromises,
      tier: Math.min(MAX_REFUSAL_TIER, count + brokenPromises),
      lastTick: tick,
    };
    refusals[key] = next;
    return next;
  }

  /** 清账：得手了，或者两人和解了。返回清掉的条数 */
  clearRefusals(fromId: string, toId: string, bothWays = false): number {
    const refusals = this.snapshot.world.refusals;
    if (!refusals) return 0;
    let n = 0;
    for (const key of bothWays
      ? [refusalKey(fromId, toId), refusalKey(toId, fromId)]
      : [refusalKey(fromId, toId)]) {
      if (refusals[key]) {
        delete refusals[key];
        n++;
      }
    }
    return n;
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

  // ── M4 案件账本 ──

  /** 案件账本（懒初始化——构造器传入的旧快照没走 normalize） */
  getCaseLedger(): Record<string, CaseEntry> {
    const w = this.snapshot.world;
    if (!w.cases || typeof w.cases !== "object" || Array.isArray(w.cases)) {
      w.cases = {};
    }
    return w.cases;
  }

  /** 立案（theft_with_perp 注册；已存在同 id 不覆盖——案情不许被重写） */
  registerCase(entry: Omit<CaseEntry, "status" | "accusations">): boolean {
    const ledger = this.getCaseLedger();
    if (ledger[entry.id]) return false;
    ledger[entry.id] = { ...entry, status: "open", accusations: {} };
    return true;
  }

  getCase(id: string): CaseEntry | undefined {
    return this.getCaseLedger()[id];
  }

  getOpenCases(): CaseEntry[] {
    return Object.values(this.getCaseLedger()).filter((c) => c.status === "open");
  }

  /** 公开的未破案件（accuse 浮现判据：没被发现的罪不存在于任何人的世界里） */
  getPublicOpenCases(): CaseEntry[] {
    return this.getOpenCases().filter((c) => c.publicSinceTick !== undefined);
  }

  /** 最新的公开未破案件（accuse 工具 v1 的默认对象） */
  getLatestOpenCase(): CaseEntry | undefined {
    return this.getPublicOpenCases().sort((a, b) => b.createdTick - a.createdTick)[0];
  }

  /** 案件公开（受害者发现失窃那刻由 processPendingDiscoveries 调用） */
  markCasePublic(id: string, tick: number): boolean {
    const c = this.getCaseLedger()[id];
    if (!c || c.publicSinceTick !== undefined) return false;
    c.publicSinceTick = tick;
    return true;
  }

  /** 记一次指控（每人每案一发；已指控过返回 false） */
  recordAccusation(caseId: string, accuserId: string, accusedId: string): boolean {
    const c = this.getCaseLedger()[caseId];
    if (!c || c.status !== "open") return false;
    if (c.accusations[accuserId]) return false;
    c.accusations[accuserId] = accusedId;
    return true;
  }

  closeCase(id: string, status: "solved" | "cold", tick: number): boolean {
    const c = this.getCaseLedger()[id];
    if (!c || c.status !== "open") return false;
    c.status = status;
    c.closedTick = tick;
    return true;
  }

  /** 冷案候选：悬超过 maxAgeTicks 的 open 案件 */
  getStaleCases(tick: number, maxAgeTicks: number): CaseEntry[] {
    return this.getOpenCases().filter((c) => tick - c.createdTick > maxAgeTicks);
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
   * 落一条敌对立场：pair+kind+holder 三键匹配到 active 已存在 → refresh
   * （更新 lastRefreshTick/evidence/summary，**复用既有 stanceId**——unresolvedWith/obsession
   * 的引用保持一致），否则新增。只按 pair+kind 匹配会把 B 反向指控 A 折进 A 持有的旧条，
   * 方向翻转污染账本。返回 { stance, refreshed }。
   */
  addOrRefreshOpenStance(stance: Omit<OpenStance, "status" | "lastRefreshTick"> & { lastRefreshTick?: number }): { stance: OpenStance; refreshed: boolean } {
    const map = this.getOpenStanceMap();
    const key = stancePairKey(stance.holderId, stance.targetId);
    if (!map[key]) map[key] = [];
    const existing = map[key].find(
      (s) => s.status === "active" && s.kind === stance.kind && s.holderId === stance.holderId,
    );
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
