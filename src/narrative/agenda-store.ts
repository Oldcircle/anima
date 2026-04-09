/**
 * Director Agenda Store — D4
 *
 * Director 的"工作记忆"。每条 Arc 是一个跨 invoke 的剧情计划，
 * 让 director 不再 cold-start。
 *
 * 设计原则:
 *   - 同时活跃 Arc ≤ 3（强制聚焦）
 *   - Freelance Arc ≤ 1，且 >2 游戏日强制 abandon
 *   - Arc 必须 pin 到一个 beat_id，或显式 'freelance'
 *   - resolved/abandoned 移到 archive，不再注入 prompt
 */

export type ArcStatus = "setup" | "brewing" | "climax_ready" | "resolved" | "abandoned";

export interface Arc {
  id: string;
  /** pin 到的 beat id；'freelance' 表示自由剧情线 */
  beatId: string;
  /** 一句话目标 */
  goal: string;
  /** 想在哪天达成 */
  targetDay: number;
  status: ArcStatus;
  watchChars: string[];
  /** 自由备注，≤200 字（store 层会截断） */
  notes: string;
  createdAtTick: number;
  createdAtDay: number;
  updatedAtTick: number;
}

export const MAX_ACTIVE_ARCS = 3;
export const MAX_FREELANCE_ARCS = 1;
export const FREELANCE_LIFETIME_DAYS = 2;
export const NOTES_MAX_LEN = 200;

export interface CreateArcInput {
  beatId: string;
  goal: string;
  targetDay: number;
  watchChars: string[];
  notes?: string;
}

export interface AgendaPatch {
  status?: ArcStatus;
  notes?: string;
  targetDay?: number;
}

export class InMemoryAgendaStore {
  private arcs: Map<string, Arc> = new Map();
  private archive: Arc[] = [];
  private counter = 0;

  /** 当前所有"活跃" arc（status != resolved && != abandoned） */
  active(): Arc[] {
    return [...this.arcs.values()].filter((a) => a.status !== "resolved" && a.status !== "abandoned");
  }

  /** 仅查 freelance 的活跃 arc */
  activeFreelance(): Arc[] {
    return this.active().filter((a) => a.beatId === "freelance");
  }

  get(id: string): Arc | undefined {
    return this.arcs.get(id) ?? this.archive.find((a) => a.id === id);
  }

  /** 创建一个 arc。会校验上限。返回创建结果或 error。 */
  create(
    input: CreateArcInput,
    currentTick: number,
    currentDay: number,
  ): { ok: true; arc: Arc } | { ok: false; error: string } {
    if (!input.beatId) return { ok: false, error: "beat_id 必填（或写 'freelance'）" };
    if (!input.goal || input.goal.length === 0) return { ok: false, error: "goal 必填" };

    const active = this.active();
    if (active.length >= MAX_ACTIVE_ARCS) {
      return { ok: false, error: `活跃 arc 已达上限 ${MAX_ACTIVE_ARCS}，请先 update_agenda 把某条 resolve 或 abandon` };
    }
    if (input.beatId === "freelance" && this.activeFreelance().length >= MAX_FREELANCE_ARCS) {
      return { ok: false, error: `freelance arc 已达上限 ${MAX_FREELANCE_ARCS}` };
    }

    const id = `arc_${++this.counter}`;
    const arc: Arc = {
      id,
      beatId: input.beatId,
      goal: input.goal.slice(0, 200),
      targetDay: input.targetDay,
      status: "setup",
      watchChars: input.watchChars ?? [],
      notes: (input.notes ?? "").slice(0, NOTES_MAX_LEN),
      createdAtTick: currentTick,
      createdAtDay: currentDay,
      updatedAtTick: currentTick,
    };
    this.arcs.set(id, arc);
    return { ok: true, arc };
  }

  update(
    id: string,
    patch: AgendaPatch,
    currentTick: number,
  ): { ok: true; arc: Arc } | { ok: false; error: string } {
    const arc = this.arcs.get(id);
    if (!arc) return { ok: false, error: `arc ${id} 不存在或已归档` };

    if (patch.status !== undefined) arc.status = patch.status;
    if (patch.notes !== undefined) arc.notes = patch.notes.slice(0, NOTES_MAX_LEN);
    if (patch.targetDay !== undefined) arc.targetDay = patch.targetDay;
    arc.updatedAtTick = currentTick;

    // resolved / abandoned 移到 archive
    if (arc.status === "resolved" || arc.status === "abandoned") {
      this.archive.push(arc);
      this.arcs.delete(id);
      // archive 上限 50
      if (this.archive.length > 50) this.archive.shift();
    }

    return { ok: true, arc };
  }

  /**
   * 维护：扫所有 freelance arc，超过 FREELANCE_LIFETIME_DAYS 的强制 abandon。
   * 应在每个 tick 末或 daily pacing 时调用。
   */
  maintenance(currentDay: number, currentTick: number): number {
    let abandoned = 0;
    for (const arc of [...this.arcs.values()]) {
      if (arc.beatId !== "freelance") continue;
      if (currentDay - arc.createdAtDay > FREELANCE_LIFETIME_DAYS) {
        arc.status = "abandoned";
        arc.notes = `${arc.notes}\n[auto-abandon: freelance > ${FREELANCE_LIFETIME_DAYS} days]`.slice(0, NOTES_MAX_LEN);
        arc.updatedAtTick = currentTick;
        this.archive.push(arc);
        this.arcs.delete(arc.id);
        abandoned++;
      }
    }
    return abandoned;
  }

  /**
   * 渲染当前 active arc 摘要，用于 prompt 自动注入。
   * 一行一条，紧凑。
   */
  renderForPrompt(): string {
    const active = this.active();
    if (active.length === 0) return "(无活跃 arc — 你可以用 create_arc 开一条新的)";
    return active
      .map((a) => {
        const pin = a.beatId === "freelance" ? "[freelance]" : `[beat:${a.beatId}]`;
        const watch = a.watchChars.length > 0 ? ` watch=[${a.watchChars.join(",")}]` : "";
        return `  - ${a.id} ${pin} status=${a.status} target_day=${a.targetDay}${watch}\n    goal: ${a.goal}\n    notes: ${a.notes || "(无)"}`;
      })
      .join("\n");
  }

  /** 测试用：清空 */
  clear(): void {
    this.arcs.clear();
    this.archive = [];
    this.counter = 0;
  }

  size(): number {
    return this.arcs.size;
  }

  archiveSize(): number {
    return this.archive.length;
  }
}
