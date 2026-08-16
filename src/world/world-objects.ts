/**
 * World Objects — 器物层（PLAN-grounding M0/M1）
 *
 * 世界与模型叙事之间差两个数量级的颗粒度（地点级 vs 页码级）。器物层给每个地点
 * 一副「招牌器物骨架」：模型看得见（骨架行）、查得着（examine 返回 ground truth）、
 * 世界改得动（事件/交互在器物上留 trace）、回头认得出（重访 diff）。
 *
 * 设计原则（PLAN-grounding §1）：
 * - 器物集合与名字只随地点静态存在——骨架行/工具描述进缓存稳定区（角色×地点键不变）
 * - 动态（trace/flags/diff）一律走 user prompt 末尾此刻区（buildEnvironmentSnapshot）
 * - 意图触发只给指路（"你惦记的东西就在这儿"），真相必须用 examine 换——保住
 *   「看见→行动→反馈」的玩家回路，不白送
 * - canonFacts（永久正史：预埋钩子/懒实体化）与 traces（当下物理痕迹：可被清理篡改）分开
 * - `ANIMA_GROUNDING=0` 整层退场，逐字节回归旧 prompt（A/B 基线）
 */

/** YAML 声明（location yml `objects:`），加载期逐字段显式映射（seeds visible_to 教训） */
export interface WorldObjectDef {
  /** 地点内唯一；store 全局 key = `${locationId}.${id}` */
  id: string;
  name: string;
  /** 一句话骨架描述（静态，examine 的第一行） */
  summary?: string;
  /** 意图触发的词面匹配关键词（"借阅记录"→台账） */
  keywords?: string[];
  /** 预埋正典钩子（环境叙事：把历史埋进场景，M2 懒实体化的史料锚点） */
  canon?: string[];
  /** M3 tamper 灰工具的资格闸（本期只随档不消费） */
  tamperable?: boolean;
}

export interface WorldObjectTrace {
  /** 去重 id（同一事件反复注入只落一条） */
  id: string;
  text: string;
  addedTick: number;
  source: "event" | "interaction";
}

export interface WorldObjectCanonFact {
  text: string;
  addedTick: number;
  /** authored=YAML 预埋（每次启动以 YAML 为准）；event/canonized=运行期追加（随档） */
  source: "authored" | "event" | "canonized";
}

export interface WorldObjectState {
  key: string;
  locationId: string;
  defId: string;
  name: string;
  summary?: string;
  keywords: string[];
  tamperable: boolean;
  canonFacts: WorldObjectCanonFact[];
  traces: WorldObjectTrace[];
  /** 机器判定用标志位（pried=true 等），不直接进 prompt */
  flags: Record<string, string | number | boolean>;
  /** characterId → 上次 examine 时的 {tick, digest}（重访 diff 判据） */
  lastSeen: Record<string, { tick: number; digest: string }>;
}

/** 每对象动态正典条数上限（防膨胀，对齐记忆淘汰纪律） */
export const MAX_DYNAMIC_CANON_FACTS = 6;
/** 每对象 trace 上限（最旧先淘汰） */
export const MAX_TRACES = 8;
/** 意图触发指路行上限（宁漏勿噪） */
export const INTENT_MATCH_CAP = 2;

/** 器物层总开关：`ANIMA_GROUNDING=0` 逐字节回归旧行为 */
export function groundingEnabled(): boolean {
  return process.env.ANIMA_GROUNDING !== "0";
}

/** 从 YAML 原始数据解析 objects 声明（location-loader 与 scenario-loader 显式列表路径共用） */
export function normalizeObjectDefs(v: unknown): WorldObjectDef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WorldObjectDef[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length === 0) continue;
    if (typeof o.name !== "string" || o.name.length === 0) continue;
    out.push({
      id: o.id,
      name: o.name,
      summary: typeof o.summary === "string" ? o.summary : undefined,
      keywords: Array.isArray(o.keywords)
        ? (o.keywords as unknown[]).filter((k): k is string => typeof k === "string" && k.length >= 2)
        : undefined,
      canon: Array.isArray(o.canon)
        ? (o.canon as unknown[]).filter((c): c is string => typeof c === "string" && c.length > 0)
        : undefined,
      tamperable: o.tamperable === true,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** 随档快照（只存动态：authored 正典每次启动以 YAML 为准） */
export interface WorldObjectsSnapshot {
  version: 1;
  objects: Record<
    string,
    {
      canonFacts?: WorldObjectCanonFact[];
      traces?: WorldObjectTrace[];
      flags?: Record<string, string | number | boolean>;
      lastSeen?: Record<string, { tick: number; digest: string }>;
    }
  >;
}

export class WorldObjectStore {
  private byKey = new Map<string, WorldObjectState>();
  private byLocation = new Map<string, string[]>();

  /**
   * 登记一个地点的器物声明。幂等：重复登记（读档后 upsertLocation、剧本重载）
   * 保留已有动态状态（traces/flags/lastSeen/非 authored 正典），authored 字段以 YAML 为准。
   */
  registerLocation(loc: { id: string; objects?: WorldObjectDef[] }): void {
    const defs = loc.objects ?? [];
    const keys: string[] = [];
    for (const def of defs) {
      const key = `${loc.id}.${def.id}`;
      keys.push(key);
      const existing = this.byKey.get(key);
      const authoredFacts: WorldObjectCanonFact[] = (def.canon ?? []).map((text) => ({
        text,
        addedTick: 0,
        source: "authored" as const,
      }));
      if (existing) {
        existing.name = def.name;
        existing.summary = def.summary;
        existing.keywords = def.keywords ?? [];
        existing.tamperable = def.tamperable === true;
        existing.canonFacts = [
          ...authoredFacts,
          ...existing.canonFacts.filter((f) => f.source !== "authored"),
        ];
      } else {
        this.byKey.set(key, {
          key,
          locationId: loc.id,
          defId: def.id,
          name: def.name,
          summary: def.summary,
          keywords: def.keywords ?? [],
          tamperable: def.tamperable === true,
          canonFacts: authoredFacts,
          traces: [],
          flags: {},
          lastSeen: {},
        });
      }
    }
    this.byLocation.set(loc.id, keys);
  }

  get(key: string): WorldObjectState | undefined {
    return this.byKey.get(key);
  }

  getAtLocation(locationId: string): WorldObjectState[] {
    return (this.byLocation.get(locationId) ?? [])
      .map((k) => this.byKey.get(k))
      .filter((o): o is WorldObjectState => o !== undefined);
  }

  /** 名字/关键词模糊解析（examine 的 target 参数是模型写的自由文本） */
  resolveByName(locationId: string, query: string): WorldObjectState | undefined {
    const q = query.trim();
    if (!q) return undefined;
    const objs = this.getAtLocation(locationId);
    return (
      objs.find((o) => o.name === q) ??
      objs.find((o) => o.name.includes(q) || q.includes(o.name)) ??
      objs.find((o) => o.keywords.some((k) => q.includes(k)))
    );
  }

  /** 事件/交互在器物上留物理痕迹（同 id 去重；超上限淘汰最旧） */
  addTrace(key: string, trace: WorldObjectTrace): boolean {
    const obj = this.byKey.get(key);
    if (!obj) return false;
    if (obj.traces.some((t) => t.id === trace.id)) return false;
    obj.traces.push(trace);
    if (obj.traces.length > MAX_TRACES) obj.traces.splice(0, obj.traces.length - MAX_TRACES);
    return true;
  }

  /**
   * 按地点+词面提示找器物落痕迹（world-events/beats 的接线入口：
   * "钱盒"命中 shop.till 就落，命不中静默跳过——器物层是增强不是硬依赖）。
   */
  addTraceAt(
    locationId: string,
    objectHint: string,
    trace: { id: string; text: string; addedTick: number; source: "event" | "interaction" },
  ): boolean {
    const obj = this.resolveByName(locationId, objectHint);
    if (!obj) return false;
    return this.addTrace(obj.key, trace);
  }

  setFlag(key: string, flag: string, value: string | number | boolean): boolean {
    const obj = this.byKey.get(key);
    if (!obj) return false;
    obj.flags[flag] = value;
    return true;
  }

  /** 运行期追加正典（M2 懒实体化的落点；本期供事件用）。超预算淘汰最旧动态条。 */
  addCanonFact(key: string, text: string, addedTick: number, source: "event" | "canonized"): boolean {
    const obj = this.byKey.get(key);
    if (!obj) return false;
    if (obj.canonFacts.some((f) => f.text === text)) return false;
    obj.canonFacts.push({ text, addedTick, source });
    const dynamic = obj.canonFacts.filter((f) => f.source !== "authored");
    if (dynamic.length > MAX_DYNAMIC_CANON_FACTS) {
      const oldest = dynamic[0]!;
      obj.canonFacts = obj.canonFacts.filter((f) => f !== oldest);
    }
    return true;
  }

  /** 器物当前状态指纹（重访 diff 判据）：traces + flags 变了就变 */
  digest(obj: WorldObjectState): string {
    const flagPart = Object.keys(obj.flags)
      .sort()
      .map((k) => `${k}=${String(obj.flags[k])}`)
      .join(",");
    const tracePart = obj.traces.map((t) => t.id).join(",");
    const canonPart = obj.canonFacts.filter((f) => f.source !== "authored").length;
    return `${flagPart}|${tracePart}|${canonPart}`;
  }

  /**
   * 骨架行（进「你现在看到的」块）：只有名字，零状态——静态per地点，缓存安全。
   * 没器物返回 undefined（未迁移地点逐字节零变化）。
   */
  describeSkeleton(locationId: string): string | undefined {
    const objs = this.getAtLocation(locationId);
    if (objs.length === 0) return undefined;
    return `这里值得留意的有：${objs.map((o) => o.name).join("、")}。`;
  }

  /**
   * examine 的 ground truth：骨架描述 + 正典 + 当下痕迹。记录 lastSeen（重访 diff 基线）。
   *
   * 重复衰减（halfday live r1 教训：examine 占决策 31%、六成是对未变化器物的复读）：
   * 同一角色对**没有变化**的器物再查，只给一句"没什么新东西"的短反馈——不复读全文、
   * 不刷记忆、不喂奖励回路；器物一旦有变化（trace/flags/正典），全文恢复。
   */
  examine(key: string, characterId: string, tick: number): string | undefined {
    const obj = this.byKey.get(key);
    if (!obj) return undefined;
    const digest = this.digest(obj);
    const seen = obj.lastSeen[characterId];
    obj.lastSeen[characterId] = { tick, digest };
    if (seen && seen.digest === digest) {
      return `和你上次看到的没什么两样，没什么新东西`;
    }
    const parts: string[] = [];
    if (obj.summary) parts.push(obj.summary);
    for (const f of obj.canonFacts) parts.push(f.text);
    for (const t of obj.traces) parts.push(t.text);
    if (parts.length === 0) parts.push(`${obj.name}没什么特别的，就是寻常的${obj.name}`);
    return parts.join("；");
  }

  /**
   * 意图触发（触发通道②）：打算/在身意图/执念的词面命中本地点器物 → 指路行。
   * 只指路不给真相（真相用 examine 换）。上限 INTENT_MATCH_CAP。
   */
  matchIntents(locationId: string, intentTexts: string[], characterId: string): string[] {
    const texts = intentTexts.filter((t) => t && t.length > 0);
    if (texts.length === 0) return [];
    const lines: string[] = [];
    for (const obj of this.getAtLocation(locationId)) {
      if (lines.length >= INTENT_MATCH_CAP) break;
      const needles = [obj.name, ...obj.keywords];
      const hit = texts.some((t) => needles.some((n) => n.length >= 2 && t.includes(n)));
      if (!hit) continue;
      // 已经看过且没变化的不再指路（记忆里已有，别刷屏）
      const seen = obj.lastSeen[characterId];
      if (seen && seen.digest === this.digest(obj)) continue;
      lines.push(`你心里惦记的${obj.name}就在这儿，可以凑近仔细看看。`);
    }
    return lines;
  }

  /**
   * 重访 diff（触发通道④）：看过的器物状态变了 → "和你记忆里不一样"。
   * 只提醒有变化，具体变了什么用 examine 换。
   */
  diffForCharacter(locationId: string, characterId: string): string[] {
    const lines: string[] = [];
    for (const obj of this.getAtLocation(locationId)) {
      const seen = obj.lastSeen[characterId];
      if (!seen) continue;
      if (seen.digest !== this.digest(obj)) {
        lines.push(`${obj.name}好像和你记忆里不太一样了，值得再看一眼。`);
      }
    }
    return lines;
  }

  // ── 随档（对齐 narrative-state 模式：只存动态，读档逐字段规范化） ──

  getSnapshot(): WorldObjectsSnapshot {
    const objects: WorldObjectsSnapshot["objects"] = {};
    for (const [key, obj] of this.byKey) {
      const dynamicFacts = obj.canonFacts.filter((f) => f.source !== "authored");
      if (
        dynamicFacts.length === 0 &&
        obj.traces.length === 0 &&
        Object.keys(obj.flags).length === 0 &&
        Object.keys(obj.lastSeen).length === 0
      ) {
        continue; // 纯 YAML 态不入档
      }
      objects[key] = {
        canonFacts: dynamicFacts.length > 0 ? dynamicFacts : undefined,
        traces: obj.traces.length > 0 ? obj.traces : undefined,
        flags: Object.keys(obj.flags).length > 0 ? obj.flags : undefined,
        lastSeen: Object.keys(obj.lastSeen).length > 0 ? obj.lastSeen : undefined,
      };
    }
    return { version: 1, objects };
  }

  /** 读档：动态状态覆盖到已登记器物上；YAML 里已删除的器物动态直接丢弃（宁缺毋乱） */
  replaceSnapshot(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") return;
    const snap = snapshot as Partial<WorldObjectsSnapshot>;
    if (!snap.objects || typeof snap.objects !== "object") return;
    for (const [key, raw] of Object.entries(snap.objects)) {
      const obj = this.byKey.get(key);
      if (!obj || !raw || typeof raw !== "object") continue;
      if (Array.isArray(raw.canonFacts)) {
        const restored = raw.canonFacts.filter(
          (f): f is WorldObjectCanonFact =>
            !!f && typeof f.text === "string" &&
            typeof f.addedTick === "number" && Number.isFinite(f.addedTick) &&
            (f.source === "event" || f.source === "canonized"),
        );
        obj.canonFacts = [...obj.canonFacts.filter((f) => f.source === "authored"), ...restored];
      }
      if (Array.isArray(raw.traces)) {
        obj.traces = raw.traces.filter(
          (t): t is WorldObjectTrace =>
            !!t && typeof t.id === "string" && typeof t.text === "string" &&
            typeof t.addedTick === "number" && Number.isFinite(t.addedTick) &&
            (t.source === "event" || t.source === "interaction"),
        );
      }
      if (raw.flags && typeof raw.flags === "object" && !Array.isArray(raw.flags)) {
        obj.flags = {};
        for (const [k, v] of Object.entries(raw.flags)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            obj.flags[k] = v;
          }
        }
      }
      if (raw.lastSeen && typeof raw.lastSeen === "object" && !Array.isArray(raw.lastSeen)) {
        obj.lastSeen = {};
        for (const [cid, seen] of Object.entries(raw.lastSeen)) {
          if (
            seen && typeof seen === "object" &&
            typeof (seen as { tick?: unknown }).tick === "number" &&
            typeof (seen as { digest?: unknown }).digest === "string"
          ) {
            obj.lastSeen[cid] = { tick: (seen as { tick: number }).tick, digest: (seen as { digest: string }).digest };
          }
        }
      }
    }
  }
}
