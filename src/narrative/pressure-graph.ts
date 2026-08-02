/**
 * Pressure Graph — 戏剧压力图谱（DESIGN-revival A 件）
 *
 * 确定性、零 LLM、每 tick 重算（幂等：同一世界状态算出同一结果）。
 *
 * 边与来源：
 * - friction：印象疙瘩（impressions.frictions，双向累计）
 * - grudge：relationships.grudge
 * - debt：欠账逾期天数（borrowedTick 起算，宽限 2 游戏天与讨债 OVERDUE_TICKS 对齐）
 * - promise：爽约累计（从 _appointments 派生：status==='missed' 且有 missedBy；
 *   双爽约不计入——§4.5 不加新计数器）
 * - bond：负关系 level 敌意
 * - stance：B1 立场账（narrative openStances；只计近 3 天有活动的 active 条目）
 *
 * 三路输出：
 * 1. per-char pressure → narrative_state.setPressure（beat 表达式 jexl 可读）
 * 2. computeTensionIndex 两插座真数据（top3 压力对均值 + beat 干旱项）
 * 3. 压力对热点摘要 API（导演 worldSnapshot / BeatContext.extras，后续阶段接线）
 *
 * 附：valence 环形缓冲（§4.5 二轮补丁）——impression-updater 关系落地处回调写入，
 * 内存态短窗信号（重启归零可容忍），是 B1 预过滤与热点摘要的数据源。
 */

import type { World } from "../world/world.js";
import type { RelationshipManager } from "../world/relationships.js";
import type { ImpressionStore } from "../memory/impressions.js";
import type { Appointment } from "../world/types.js";
import { updateWorldTension } from "./tension.js";

const TICKS_PER_DAY = 96;
/** 欠账宽限天数：与 simulation 讨债 OVERDUE_TICKS(192) 对齐——欠满 2 天才算逾期 */
const DEBT_GRACE_DAYS = 2;
/** stance 项只计近 3 天内有活动的（§1：防饱和失真） */
const STANCE_ACTIVITY_WINDOW_TICKS = 3 * TICKS_PER_DAY;
/** valence 环形缓冲容量 */
const VALENCE_BUFFER_CAP = 256;
/** 近窗默认窗口：1 游戏天 */
const VALENCE_WINDOW_TICKS = 96;

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// ── 公式 v1（单测锁形状不锁数值）──

export interface PairPressureInputs {
  /** 双向疙瘩条数合计 */
  frictions: number;
  /** 是否存在未解开的 grudge */
  grudge: boolean;
  /** 欠账逾期天数合计（过了宽限期的部分） */
  debtOverdueDays: number;
  /** 单方爽约累计次数（双爽约不计） */
  missedAppointments: number;
  /** 关系 level（只有负值贡献压力） */
  level: number;
  /** 活跃未了结立场数（B1 接入前恒 0；只计近 3 天有活动的） */
  activeOpenStances: number;
}

/** pair = 8*frictions + 25*grudge + 6*debtOverdueDays + 12*missedAppointments + 4*max(0,-level) + 18*activeOpenStances */
export function computePairPressure(i: PairPressureInputs): number {
  const raw =
    8 * Math.max(0, i.frictions) +
    (i.grudge ? 25 : 0) +
    6 * Math.max(0, i.debtOverdueDays) +
    12 * Math.max(0, i.missedAppointments) +
    4 * Math.max(0, -i.level) +
    18 * Math.max(0, i.activeOpenStances);
  return clamp100(raw);
}

/** char = max(pairs)*0.7 + avg(top3 pairs)*0.3 + personal，clamp 0-100 */
export function computeCharPressure(pairPressures: number[], personal: number): number {
  if (pairPressures.length === 0) return clamp100(Math.max(0, personal));
  const max = Math.max(...pairPressures);
  const top3 = [...pairPressures].sort((a, b) => b - a).slice(0, 3);
  const avgTop3 = top3.reduce((s, v) => s + v, 0) / top3.length;
  return clamp100(max * 0.7 + avgTop3 * 0.3 + Math.max(0, personal));
}

/**
 * 爽约计数派生查询（§4.5：不加新计数器，直接 filter _appointments）。
 * 只计 status==='missed' 且记录了缺席者（missedBy）的——双爽约/角色缺失不计。
 * 返回 pairKey(sorted) → 次数。
 */
export function countMissedAppointmentsByPair(
  appointments: ReadonlyArray<Appointment>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of appointments) {
    if (a.status !== "missed" || !a.missedBy) continue;
    const key = pairKeyOf(a.proposerId, a.targetId);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export interface PairPressure {
  /** 排序后的两个角色 id（a < b） */
  a: string;
  b: string;
  pressure: number;
  inputs: PairPressureInputs;
}

export interface PressureUpdateResult {
  pairs: PairPressure[];
  charPressures: Record<string, number>;
  tension: number;
}

interface ValenceEntry {
  a: string;
  b: string;
  valence: number;
  tick: number;
}

export class PressureGraph {
  /** valence 环形缓冲：内存态短窗信号，重启归零可容忍（§4.5） */
  private _valences: ValenceEntry[] = [];
  /** 上次 update 的结果（热点摘要/读 API 用） */
  private _lastPairs: PairPressure[] = [];

  // ── valence 环形缓冲 ──

  /** impression-updater 关系落地处回调写入 (pair, valence, tick) */
  recordValence(charA: string, charB: string, valence: number, tick: number): void {
    const [a, b] = charA < charB ? [charA, charB] : [charB, charA];
    this._valences.push({ a, b, valence, tick });
    if (this._valences.length > VALENCE_BUFFER_CAP) {
      this._valences.splice(0, this._valences.length - VALENCE_BUFFER_CAP);
    }
  }

  /** 近窗某对的累计 valence（B1 预过滤"本窗口负 valence≤-2"的数据源） */
  windowValence(charA: string, charB: string, nowTick: number, windowTicks = VALENCE_WINDOW_TICKS): number {
    const key = pairKeyOf(charA, charB);
    return this._valences
      .filter((e) => pairKeyOf(e.a, e.b) === key && nowTick - e.tick <= windowTicks)
      .reduce((s, e) => s + e.valence, 0);
  }

  /** 近窗关系波动 0..1（|valence| 均值 / 3；无样本 = 0） */
  computeVolatility(nowTick: number, windowTicks = VALENCE_WINDOW_TICKS): number {
    const recent = this._valences.filter((e) => nowTick - e.tick <= windowTicks);
    if (recent.length === 0) return 0;
    const avgAbs = recent.reduce((s, e) => s + Math.abs(e.valence), 0) / recent.length;
    return Math.max(0, Math.min(1, avgAbs / 3));
  }

  /** 缓冲区快照（测试/调试用） */
  getValenceBuffer(): ReadonlyArray<{ a: string; b: string; valence: number; tick: number }> {
    return this._valences;
  }

  // ── 每 tick 重算 ──

  /**
   * 收边 → pair 压力 → per-char 压力回写 setPressure → tension 更新。
   * 纯重算无累加，天然幂等：同一 tick 调两次结果一致。
   */
  update(params: {
    world: World;
    relationships: RelationshipManager;
    impressions: ImpressionStore;
    tick: number;
  }): PressureUpdateResult {
    const { world, relationships, impressions, tick } = params;
    const ns = world.narrative;

    // 1. 收边：pairKey → inputs
    const edges = new Map<string, PairPressureInputs>();
    const ensure = (x: string, y: string): PairPressureInputs => {
      const key = pairKeyOf(x, y);
      let e = edges.get(key);
      if (!e) {
        e = { frictions: 0, grudge: false, debtOverdueDays: 0, missedAppointments: 0, level: 0, activeOpenStances: 0 };
        edges.set(key, e);
      }
      return e;
    };

    // friction：印象疙瘩，双向累计
    for (const { observerId, impression } of impressions.getAll()) {
      const n = impression.frictions?.length ?? 0;
      if (n > 0) ensure(observerId, impression.characterId).frictions += n;
    }

    // grudge + 负 level：只读已存在的关系（不经 get() 触发惰性创建）
    for (const rel of relationships.getAll()) {
      const e = ensure(rel.characterA, rel.characterB);
      e.grudge = e.grudge || Boolean(rel.grudge);
      e.level = rel.level;
    }

    // debt：逾期天数（过宽限期的部分）
    for (const c of world.getAllCharacters()) {
      for (const debt of c.debts ?? []) {
        const daysHeld = Math.floor(Math.max(0, tick - debt.borrowedTick) / TICKS_PER_DAY);
        const overdue = Math.max(0, daysHeld - DEBT_GRACE_DAYS);
        if (overdue > 0) ensure(c.id, debt.lenderId).debtOverdueDays += overdue;
      }
    }

    // promise：爽约派生计数
    for (const [key, count] of Object.entries(countMissedAppointmentsByPair(world.getAllAppointments()))) {
      const [x, y] = key.split(":") as [string, string];
      ensure(x, y).missedAppointments += count;
    }

    // stance：B1 立场账——只计近 3 天内有活动的 active openStance（§1 防饱和失真）
    const stanceMap = ns.getWorld().openStances ?? {};
    for (const [key, list] of Object.entries(stanceMap)) {
      if (!Array.isArray(list)) continue;
      const active = list.filter(
        (s) => s?.status === "active" && tick - (s.lastRefreshTick ?? s.createdTick) <= STANCE_ACTIVITY_WINDOW_TICKS,
      ).length;
      if (active > 0) {
        const [x, y] = key.split(":") as [string, string];
        ensure(x, y).activeOpenStances += active;
      }
    }

    // 2. pair 压力
    const pairs: PairPressure[] = [];
    for (const [key, inputs] of edges) {
      const pressure = computePairPressure(inputs);
      if (pressure <= 0) continue;
      const [a, b] = key.split(":") as [string, string];
      pairs.push({ a, b, pressure, inputs });
    }
    pairs.sort((x, y) => y.pressure - x.pressure);
    this._lastPairs = pairs;

    // 3. per-char 压力回写（所有在世角色都写——边消失时压力要能回落）
    const unresolved = ns.getWorld().unresolvedEvents;
    const charPressures: Record<string, number> = {};
    for (const c of world.getAllCharacters()) {
      const myPairs = pairs.filter((p) => p.a === c.id || p.b === c.id).map((p) => p.pressure);
      const personal = 6 * unresolved.filter((e) => e.involved.includes(c.id)).length;
      const pressure = computeCharPressure(myPairs, personal);
      ns.setPressure(c.id, pressure);
      charPressures[c.id] = pressure;
    }

    // 4. tension：top3 压力对均值 + 干旱项（updateWorldTension 内部读）
    const top3 = pairs.slice(0, 3).map((p) => p.pressure);
    const top3Avg = top3.length > 0 ? top3.reduce((s, v) => s + v, 0) / top3.length : 0;
    const tension = updateWorldTension(world, { pairPressureTop3Avg: top3Avg });

    return { pairs, charPressures, tension };
  }

  /** 上次 update 的压力对（降序） */
  getTopPairs(n = 3): PairPressure[] {
    return this._lastPairs.slice(0, n);
  }

  /** 某一对的最新压力（B2 surface_grudge 门槛判定用）。无边 = undefined。 */
  getPairPressure(charA: string, charB: string): PairPressure | undefined {
    const key = pairKeyOf(charA, charB);
    return this._lastPairs.find((p) => pairKeyOf(p.a, p.b) === key);
  }

  /**
   * 压力对热点摘要（三路输出之三）：给导演 worldSnapshot / BeatContext.extras 的
   * 一段人可读白描。无热点时返回空串。
   */
  formatHotspotSummary(world: World, n = 3): string {
    const top = this.getTopPairs(n);
    if (top.length === 0) return "";
    const nameOf = (id: string): string => world.getCharacter(id)?.name ?? id;
    const lines = top.map((p) => {
      const parts: string[] = [];
      if (p.inputs.frictions > 0) parts.push(`疙瘩×${p.inputs.frictions}`);
      if (p.inputs.grudge) parts.push("有积怨");
      if (p.inputs.debtOverdueDays > 0) parts.push(`欠账逾期${p.inputs.debtOverdueDays}天`);
      if (p.inputs.missedAppointments > 0) parts.push(`爽约×${p.inputs.missedAppointments}`);
      if (p.inputs.level < 0) parts.push(`关系${Math.round(p.inputs.level)}`);
      if (p.inputs.activeOpenStances > 0) parts.push(`未了结立场×${p.inputs.activeOpenStances}`);
      return `- ${nameOf(p.a)} ↔ ${nameOf(p.b)}：压力 ${Math.round(p.pressure)}（${parts.join("、") || "累积摩擦"}）`;
    });
    return lines.join("\n");
  }
}
