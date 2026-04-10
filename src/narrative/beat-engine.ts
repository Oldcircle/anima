/**
 * Beat Engine — 规则导演
 *
 * 加载 scenario 的 beats.yml，每天扫一遍，触发条件满足的 beat → emit beat_ready。
 *
 * 完全无 LLM。纯字段比较 + 表达式求值。
 *
 * 设计原则：
 * - 触发是单向的：beat 一旦 triggered 就持久化在 narrative_state.world.triggeredBeats
 * - 支持 fallback deadline：到达 deadline_day 时无论 preconditions 是否满足都强制触发
 * - cooldown 字段为未来 repeatable beat 预留，N3 v1 默认 never（一次性）
 * - 一次 scan 可以触发多个 beat，按 priority 排序
 */

import type { BeatContext } from "./expression.js";
import { evaluateCompiled } from "./expression.js";

/** beats.yml 中每条 beat 的原始结构 */
export interface BeatDefinition {
  id: string;
  description?: string;
  /** preconditions 支持两种写法：
   *  1) 简单数组：等价于 all 列表
   *  2) {all?: [...], any?: [...]} 结构 */
  preconditions?: string[] | { all?: string[]; any?: string[] };
  /** 一次性 (never，默认) | 'realtime' 每 tick | tick 数 (cooldown) */
  cooldown_after_trigger?: "never" | "realtime" | number;
  /** 优先级（同 tick 多 beat ready 时，高优先先 emit）。默认 0 */
  priority?: number;
  /** 兜底强制触发的 game day */
  fallback_deadline_day?: number;
  /** 任意 payload，emit 给监听器使用（N4 director 会读 director_hint） */
  on_trigger?: Record<string, unknown>;
}

export interface BeatReadyEvent {
  beatId: string;
  description?: string;
  /** 是 fallback 强制触发还是正常 precondition 满足？ */
  reason: "preconditions_met" | "fallback_deadline";
  payload?: Record<string, unknown>;
  /** 触发时的世界 day / tick */
  triggeredDay: number;
  triggeredTick: number;
}

export class BeatEngine {
  private beats: BeatDefinition[];
  /** 已触发集合（由调用方从 narrative_state 同步进来） */
  private triggered: Set<string>;

  constructor(beats: BeatDefinition[] = []) {
    this.beats = beats;
    this.triggered = new Set();
  }

  /** 加载/替换 beats（scenario 切换时用） */
  setBeats(beats: BeatDefinition[]): void {
    this.beats = beats;
  }

  setTriggered(triggered: Iterable<string>): void {
    this.triggered = new Set(triggered);
  }

  getBeats(): readonly BeatDefinition[] {
    return this.beats;
  }

  getTriggered(): readonly string[] {
    return Array.from(this.triggered);
  }

  /**
   * 扫一遍所有 beats，返回这次需要 emit 的事件列表。
   * 不直接修改世界 — 由调用方拿到结果后写入 narrative_state.markBeatTriggered + emit event bus。
   */
  scan(context: BeatContext): BeatReadyEvent[] {
    const ready: BeatReadyEvent[] = [];
    for (const beat of this.beats) {
      if (this.triggered.has(beat.id)) continue;

      const reason = this.evaluateBeat(beat, context);
      if (reason) {
        ready.push({
          beatId: beat.id,
          description: beat.description,
          reason,
          payload: beat.on_trigger,
          triggeredDay: context.world.day,
          triggeredTick: context.world.tick,
        });
      }
    }

    // priority 高的先 emit
    ready.sort((a, b) => {
      const pa = this.beats.find((b2) => b2.id === a.beatId)?.priority ?? 0;
      const pb = this.beats.find((b2) => b2.id === b.beatId)?.priority ?? 0;
      return pb - pa;
    });

    // 标记为 triggered（防止下次扫描重复）
    for (const ev of ready) {
      this.triggered.add(ev.beatId);
    }

    return ready;
  }

  /**
   * 单个 beat 的判定。
   * 返回触发原因 或 null（不触发）。
   */
  private evaluateBeat(
    beat: BeatDefinition,
    context: BeatContext,
  ): "preconditions_met" | "fallback_deadline" | null {
    // 1. 正常 precondition 路径
    const preconditionsMet = this.checkPreconditions(beat, context);
    if (preconditionsMet) return "preconditions_met";

    // 2. fallback deadline 路径
    // 当天内只在晚间（tick 换算 hour >= 20）才 fallback，给正常 precondition 足够时间
    // 过了 deadline day 则立即 fallback
    if (beat.fallback_deadline_day !== undefined) {
      const hour = Math.floor((context.world.tick % 96) / 4);
      if (
        context.world.day > beat.fallback_deadline_day ||
        (context.world.day === beat.fallback_deadline_day && hour >= 20)
      ) {
        return "fallback_deadline";
      }
    }

    return null;
  }

  private checkPreconditions(beat: BeatDefinition, context: BeatContext): boolean {
    if (!beat.preconditions) return false;

    if (Array.isArray(beat.preconditions)) {
      // 简单数组 = all
      return beat.preconditions.every((expr) => evaluateCompiled(expr, context));
    }

    const { all, any } = beat.preconditions;
    if (all && all.length > 0) {
      const allOk = all.every((expr) => evaluateCompiled(expr, context));
      if (!allOk) return false;
    }
    if (any && any.length > 0) {
      const anyOk = any.some((expr) => evaluateCompiled(expr, context));
      if (!anyOk) return false;
    }
    // 必须至少声明了 all 或 any 一项；两者都空 → 不触发
    return Boolean((all && all.length > 0) || (any && any.length > 0));
  }
}

/** 解析 beats.yml 的内容（已是 yaml.parse 后的对象）→ BeatDefinition[] */
export function parseBeatsConfig(parsed: unknown): BeatDefinition[] {
  if (!parsed) return [];
  // beats.yml 顶层可以是数组，也可以是 {beats: [...]}
  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (typeof parsed === "object" && parsed !== null && "beats" in parsed) {
    const b = (parsed as { beats: unknown }).beats;
    raw = Array.isArray(b) ? b : [];
  } else {
    return [];
  }

  const out: BeatDefinition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== "string") continue;
    const def: BeatDefinition = { id: obj.id };
    if (typeof obj.description === "string") def.description = obj.description;
    if (obj.preconditions !== undefined) def.preconditions = obj.preconditions as BeatDefinition["preconditions"];
    if (obj.cooldown_after_trigger !== undefined) {
      def.cooldown_after_trigger = obj.cooldown_after_trigger as BeatDefinition["cooldown_after_trigger"];
    }
    if (typeof obj.priority === "number") def.priority = obj.priority;
    if (typeof obj.fallback_deadline_day === "number") def.fallback_deadline_day = obj.fallback_deadline_day;
    if (obj.on_trigger !== undefined) def.on_trigger = obj.on_trigger as Record<string, unknown>;
    out.push(def);
  }
  return out;
}
