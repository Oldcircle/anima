/**
 * Expression — Beat precondition 表达式求值器（基于 jexl）
 *
 * 设计原则：
 * - 同步求值（BeatEngine 每天扫一遍，无需异步）
 * - 输入是 narrative_state + 一些便捷辅助字段，输出 boolean
 * - 失败不抛错而是返回 false（避免一个坏 beat 拖崩整个 scan）
 * - 提供少量自定义 transform，让 yaml 写起来更接近自然语言
 *
 * 示例表达式：
 *   "world.day > 14"
 *   "characters.alice.disclosedSecrets | contains('family_background')"
 *   "characters.alice.disclosedSecrets | excludes('family_background')"
 *   "world.unresolvedEvents | length > 0"
 *   "characters.alice.relationships.bob.trust > 0.7"
 */

import jexl from "jexl";
import type { NarrativeStateSnapshot, UnresolvedEventStatus } from "./narrative-state.js";

/**
 * Context 是表达式可见的整个根对象。
 * 每次 evaluate 调用前由 BeatEngine 构造。
 */
export interface BeatContext {
  /** 世界级状态（来自 narrative_state.world）+ 便捷字段 */
  world: {
    day: number;            // 当前 game day（由 tick 派生）
    hour: number;           // 当前游戏内小时 0-23
    tick: number;
    activePhase?: string;
    tensionIndex: number;
    unresolvedEvents: Array<{ id: string; involved: string[]; status: UnresolvedEventStatus }>;
    triggeredBeats: string[];
  };
  /** 角色级状态。键是角色 id。访问不存在的角色会返回 undefined（jexl 容错） */
  characters: Record<string, BeatCharacterContext>;
  /** 结构化扩展（B4）：压力图摘要 / kira 计数 / 金币 / 约定 / 事件状态 / beat 触发史 */
  extras?: BeatContextExtras;
}

/**
 * BeatContext.extras 形状（B4）。全部用 Record 不用 Map（JSON 序列化安全）。
 * 所有字段由 simulation.runBeatScan 每次扫描时现算注入；单测锁形状不锁数值。
 */
export interface BeatContextExtras {
  /** 压力图三路输出之三：热点摘要 + top 压力对（pressure-graph 上次 update 的结果） */
  pressure: {
    /** 人可读白描（导演 worldSnapshot 同源），无热点为空串 */
    summary: string;
    topPairs: Array<{ a: string; b: string; pressure: number }>;
  };
  /**
   * kira 计数器快照。⚠️ 声明：world.kira 是瞬态不入档（DESIGN-revival §4.5），
   * 这些计数**仅在单次连续 sim 内有效**——读档后归零，跨档表达式别依赖它。
   */
  kira: {
    total: number;
    victimCount: number;
    pendingCount: number;
    lastStrikeDay: number;
  };
  /** 各角色叙事压力快照（与 characters.<id>.pressure 同源，extras 里给一份平铺 Record 便于聚合表达式） */
  charPressures: Record<string, number>;
  /** 各角色金币快照 */
  gold: Record<string, number>;
  /** 约定账目：pending 数 + 按 pair（id 排序 "a:b"）的单方爽约累计（派生自 _appointments） */
  appointments: {
    pendingCount: number;
    missedByPair: Record<string, number>;
  };
  /** 事件状态速查：eventId → status（与 world.unresolvedEvents[].status 同源） */
  events: Record<string, UnresolvedEventStatus>;
  /** 每条 beat 最近触发 tick（随档 Record；cooldown 型 beat 的触发史也在这里） */
  beatLastTrigger: Record<string, number>;
}

export interface BeatCharacterContext {
  /** narrative_state.characters[id] 的字段直拷贝 */
  disclosedSecrets: string[];
  knownFacts: string[];
  unresolvedWith: Record<string, string[]>;
  pressure: number;
  /** 来自 RelationshipManager 的快照：{otherId: {level, type, bond}} */
  relationships: Record<string, { level: number; type: string; bond?: string; trust: number }>;
  /** 来自 needs 的快照 */
  needs?: Record<string, number>;
  /** 当前所在地点 id */
  locationId?: string;
}

// ── 自定义 transform ──
// jexl 用法：value | transformName(arg1, arg2)

jexl.addTransform("contains", (arr: unknown, item: unknown): boolean => {
  return Array.isArray(arr) && arr.includes(item);
});

jexl.addTransform("excludes", (arr: unknown, item: unknown): boolean => {
  return Array.isArray(arr) && !arr.includes(item);
});

jexl.addTransform("length", (v: unknown): number => {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  if (typeof v === "string") return v.length;
  return 0;
});

jexl.addTransform("isEmpty", (v: unknown): boolean => {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  if (typeof v === "string") return v === "";
  return false;
});

jexl.addTransform("keys", (v: unknown): string[] => {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];
});

// 数学便捷
jexl.addTransform("min", (a: number, b: number) => Math.min(a, b));
jexl.addTransform("max", (a: number, b: number) => Math.max(a, b));

/**
 * 求值。失败时打印警告并返回 false，不抛错。
 */
export function evaluateExpression(
  expression: string,
  context: BeatContext,
): boolean {
  try {
    const result = jexl.evalSync(expression, context as unknown as Record<string, unknown>);
    return Boolean(result);
  } catch (err) {
    console.warn(`⚠️  beat expression failed: ${expression}\n   ${(err as Error).message}`);
    return false;
  }
}

/**
 * 编译并缓存表达式（同一表达式可能每天扫一次，避免重复 parse）
 */
const cache = new Map<string, ReturnType<typeof jexl.compile>>();

export function evaluateCompiled(
  expression: string,
  context: BeatContext,
): boolean {
  let compiled = cache.get(expression);
  if (!compiled) {
    try {
      compiled = jexl.compile(expression);
      cache.set(expression, compiled);
    } catch (err) {
      console.warn(`⚠️  beat expression compile failed: ${expression}\n   ${(err as Error).message}`);
      return false;
    }
  }
  try {
    return Boolean(compiled.evalSync(context as unknown as Record<string, unknown>));
  } catch (err) {
    console.warn(`⚠️  beat expression eval failed: ${expression}\n   ${(err as Error).message}`);
    return false;
  }
}

/**
 * 给 BeatEngine 用：根据 NarrativeStateSnapshot 构建 BeatContext。
 * 关系/needs/locationId 由调用方注入。
 */
export function buildBeatContext(params: {
  narrative: NarrativeStateSnapshot;
  tick: number;
  characterRelationships: Record<string, BeatCharacterContext["relationships"]>;
  characterNeeds: Record<string, Record<string, number>>;
  characterLocations: Record<string, string>;
  /** B4：simulation.runBeatScan 现算注入（压力/kira/金币/约定/事件状态/beat 触发史） */
  extras?: BeatContextExtras;
}): BeatContext {
  const { narrative, tick } = params;
  const day = Math.floor(tick / 96) + 1; // 1 game day = 96 ticks (15 min/tick)
  const hour = Math.floor((tick % 96) / 4); // 0-23

  const characters: Record<string, BeatCharacterContext> = {};
  const allCharIds = new Set<string>([
    ...Object.keys(narrative.characters),
    ...Object.keys(params.characterRelationships),
    ...Object.keys(params.characterLocations),
  ]);
  for (const id of allCharIds) {
    const ns = narrative.characters[id];
    characters[id] = {
      disclosedSecrets: ns?.disclosedSecrets ?? [],
      knownFacts: ns?.knownFacts ?? [],
      unresolvedWith: ns?.unresolvedWith ?? {},
      pressure: ns?.pressure ?? 0,
      relationships: params.characterRelationships[id] ?? {},
      needs: params.characterNeeds[id],
      locationId: params.characterLocations[id],
    };
  }

  return {
    world: {
      day,
      hour,
      tick,
      activePhase: narrative.world.activePhase,
      tensionIndex: narrative.world.tensionIndex,
      unresolvedEvents: narrative.world.unresolvedEvents.map((e) => ({
        id: e.id,
        involved: e.involved,
        status: e.status ?? "fresh",
      })),
      triggeredBeats: narrative.world.triggeredBeats,
    },
    characters,
    extras: params.extras,
  };
}

/**
 * 合成 dry-run 上下文（B4 beat 表达式 lint 用）：
 * 用真实字段形状 + 占位数值搭一个"世界的样子"，让表达式在加载期跑一遍求值。
 * 目的只有一个：把写错的表达式在启动时炸出来，而不是 live 跑到那天才静默 false。
 */
export function buildSyntheticBeatContext(characterIds: string[] = []): BeatContext {
  const ids = characterIds.length > 0 ? characterIds : ["__probe__"];
  const characters: Record<string, BeatCharacterContext> = {};
  for (const id of ids) {
    const otherId = ids.find((x) => x !== id) ?? "__other__";
    characters[id] = {
      disclosedSecrets: ["__secret__"],
      knownFacts: ["__fact__"],
      unresolvedWith: { [otherId]: ["__topic__"] },
      pressure: 42,
      relationships: {
        [otherId]: { level: 10, type: "acquaintance", bond: "friend", trust: 0.5 },
      },
      needs: { hunger: 60, energy: 60, social: 60, fun: 60, hygiene: 60, bladder: 60 },
      locationId: "plaza",
    };
  }
  const pairKey = ids.length >= 2 ? [...ids].sort().slice(0, 2).join(":") : "__a__:__b__";
  return {
    world: {
      day: 2,
      hour: 12,
      tick: 96 + 48,
      activePhase: "peaceful",
      tensionIndex: 30,
      unresolvedEvents: [{ id: "__event__", involved: ids.slice(0, 2), status: "fresh" }],
      triggeredBeats: ["__beat_done__"],
    },
    characters,
    extras: {
      pressure: { summary: "", topPairs: [{ a: ids[0]!, b: ids[1] ?? "__other__", pressure: 40 }] },
      kira: { total: 0, victimCount: 0, pendingCount: 0, lastStrikeDay: -1 },
      charPressures: Object.fromEntries(ids.map((id) => [id, 42])),
      gold: Object.fromEntries(ids.map((id) => [id, 100])),
      appointments: { pendingCount: 0, missedByPair: { [pairKey]: 1 } },
      events: { __event__: "fresh" },
      beatLastTrigger: { __beat_done__: 96 },
    },
  };
}

/**
 * 表达式 lint（fail loud 路径）：compile + 对合成 context dry-run。
 * 与 evaluateCompiled 不同——这里**不吞错**，任何 compile/eval 异常都返回错误消息。
 * 返回 null = 通过。
 */
export function lintExpression(expression: string, context: BeatContext): string | null {
  let compiled: ReturnType<typeof jexl.compile>;
  try {
    compiled = jexl.compile(expression);
  } catch (err) {
    return `compile 失败: ${(err as Error).message}`;
  }
  try {
    compiled.evalSync(context as unknown as Record<string, unknown>);
  } catch (err) {
    return `dry-run 求值失败: ${(err as Error).message}`;
  }
  return null;
}
