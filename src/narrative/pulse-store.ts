/**
 * Pulse Store — D2
 *
 * 记录 director 每次写工具调用，让 director 在后续 invoke 中能查询
 * "我上次推完之后世界发生了什么"，形成 expected → observed 反馈闭环。
 *
 * 设计原则:
 *   - 短生命周期：pulse 在 OBSERVATION_WINDOW（8 tick）后被 reducer 回填 observed
 *   - In-memory 即可（D2 范围）；SQLite 持久化留 D2.1
 *   - Reducer 不调 LLM，只扫角色 short-term memory 拼摘要
 */

import type { ShortTermMemory } from "../memory/short-term.js";

export const OBSERVATION_WINDOW = 8;

export interface PulseRecord {
  id: string;
  tick: number;
  /** 写工具名 (inject_intent / inject_observation / add_unresolved_event ...) */
  toolName: string;
  /** 目标角色 id（从 args 提取；多角色或全局工具为 undefined） */
  targetChar?: string;
  /** 工具调用参数 */
  args: Record<string, unknown>;
  /** Director 自报的"我期望发生什么"（可选） */
  expected?: string;
  /** Reducer 自动回填的"实际发生了什么"（可选，未到窗口时为空） */
  observed?: string;
  /** observed 回填的 tick */
  observedAtTick?: number;
}

export interface PulseStoreOptions {
  /** 上限：超出后 FIFO 删旧的 */
  maxEntries?: number;
}

export class InMemoryPulseStore {
  private pulses: Map<string, PulseRecord> = new Map();
  private order: string[] = [];
  private maxEntries: number;
  private counter = 0;

  constructor(options?: PulseStoreOptions) {
    this.maxEntries = options?.maxEntries ?? 200;
  }

  /** 生成新 pulse_id（pulse_<tick>_<n>） */
  nextId(tick: number): string {
    return `pulse_${tick}_${++this.counter}`;
  }

  record(pulse: PulseRecord): void {
    this.pulses.set(pulse.id, pulse);
    this.order.push(pulse.id);
    while (this.order.length > this.maxEntries) {
      const old = this.order.shift()!;
      this.pulses.delete(old);
    }
  }

  get(id: string): PulseRecord | undefined {
    return this.pulses.get(id);
  }

  list(opts?: {
    sinceTick?: number;
    targetChar?: string;
    pendingOnly?: boolean;
  }): PulseRecord[] {
    let result = this.order.map((id) => this.pulses.get(id)!).filter(Boolean);
    if (opts?.sinceTick !== undefined) {
      result = result.filter((p) => p.tick >= opts.sinceTick!);
    }
    if (opts?.targetChar) {
      result = result.filter((p) => p.targetChar === opts.targetChar);
    }
    if (opts?.pendingOnly) {
      result = result.filter((p) => p.observed === undefined);
    }
    return result;
  }

  updateObserved(id: string, observed: string, atTick: number): void {
    const p = this.pulses.get(id);
    if (!p) return;
    p.observed = observed;
    p.observedAtTick = atTick;
  }

  size(): number {
    return this.pulses.size;
  }

  clear(): void {
    this.pulses.clear();
    this.order = [];
  }
}

/**
 * Reducer：扫所有 pending pulse，对那些已经过了 OBSERVATION_WINDOW 的，
 * 从目标角色的 short-term memory 中抽取 [pulse.tick, currentTick] 区间内
 * 的 event/conversation，拼成一行 observed 写回。
 *
 * 不调 LLM。
 */
export function observePulses(
  store: InMemoryPulseStore,
  memory: ShortTermMemory,
  currentTick: number,
): number {
  const pending = store.list({ pendingOnly: true });
  let updated = 0;
  for (const p of pending) {
    if (currentTick - p.tick < OBSERVATION_WINDOW) continue;
    if (!p.targetChar) {
      // 全局工具（add_rumor / nudge_weather）：没有 target_char 可观察，标记一下
      store.updateObserved(p.id, "(无目标角色，无法 observe)", currentTick);
      updated++;
      continue;
    }
    const entries = memory.getRecent(p.targetChar, 30);
    const slice = entries.filter(
      (e) => e.tick >= p.tick && e.tick <= currentTick && (e.type === "event" || e.type === "conversation"),
    );
    if (slice.length === 0) {
      store.updateObserved(p.id, "(窗口内无可观察行为)", currentTick);
    } else {
      const summary = slice
        .slice(0, 4)
        .map((e) => `[t${e.tick}] ${truncate(e.content, 100)}`)
        .join(" | ");
      store.updateObserved(p.id, summary, currentTick);
    }
    updated++;
  }
  return updated;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * 从写工具的 args 中尽力提取"目标角色 id"。
 * 不同工具字段名不一致，按优先级查找。
 */
export function extractTargetChar(args: Record<string, unknown>): string | undefined {
  const keys = ["character_id", "observer_id", "target_character_id", "char_id"];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
