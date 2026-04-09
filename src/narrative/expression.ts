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
import type { NarrativeStateSnapshot } from "./narrative-state.js";

/**
 * Context 是表达式可见的整个根对象。
 * 每次 evaluate 调用前由 BeatEngine 构造。
 */
export interface BeatContext {
  /** 世界级状态（来自 narrative_state.world）+ 便捷字段 */
  world: {
    day: number;            // 当前 game day（由 tick 派生）
    tick: number;
    activePhase?: string;
    tensionIndex: number;
    unresolvedEvents: Array<{ id: string; involved: string[] }>;
    triggeredBeats: string[];
  };
  /** 角色级状态。键是角色 id。访问不存在的角色会返回 undefined（jexl 容错） */
  characters: Record<string, BeatCharacterContext>;
  /** 自由形式扩展（N4+ Director 可能注入更多） */
  extras?: Record<string, unknown>;
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
}): BeatContext {
  const { narrative, tick } = params;
  const day = Math.floor(tick / 96) + 1; // 1 game day = 96 ticks (15 min/tick)

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
      tick,
      activePhase: narrative.world.activePhase,
      tensionIndex: narrative.world.tensionIndex,
      unresolvedEvents: narrative.world.unresolvedEvents.map((e) => ({
        id: e.id,
        involved: e.involved,
      })),
      triggeredBeats: narrative.world.triggeredBeats,
    },
    characters,
  };
}
