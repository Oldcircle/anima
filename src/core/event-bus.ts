/**
 * Event Bus — 世界事件系统
 *
 * 所有角色行为产生事件，事件驱动世界变化。
 * 支持事件监听、过滤、持久化。
 */

export interface WorldEvent {
  id: string;
  tick: number;
  type: string;
  actorId: string;
  targetId?: string;
  locationId: string;
  description: string;
  effects: Effect[];
  witnesses: string[];
}

export interface Effect {
  type: "need_change" | "relationship_change" | "inventory_change" | "location_change" | "mood_change";
  targetId: string;
  field?: string;
  delta?: number;
  value?: string;
}

export type EventListener = (event: WorldEvent) => void | Promise<void>;

export type EventFilter = {
  type?: string | RegExp;
  actorId?: string;
  locationId?: string;
};

function matchesFilter(event: WorldEvent, filter: EventFilter): boolean {
  if (filter.type) {
    if (typeof filter.type === "string") {
      if (!event.type.startsWith(filter.type)) return false;
    } else {
      if (!filter.type.test(event.type)) return false;
    }
  }
  if (filter.actorId && event.actorId !== filter.actorId) return false;
  if (filter.locationId && event.locationId !== filter.locationId) return false;
  return true;
}

export class EventBus {
  private _listeners: Array<{ filter: EventFilter | null; listener: EventListener }> = [];
  private _history: WorldEvent[] = [];
  private _maxHistory: number;

  constructor(options?: { maxHistory?: number }) {
    this._maxHistory = options?.maxHistory ?? 10_000;
  }

  /** 注册监听器，可选过滤条件 */
  on(listener: EventListener, filter?: EventFilter): () => void {
    const entry = { filter: filter ?? null, listener };
    this._listeners.push(entry);
    return () => {
      const idx = this._listeners.indexOf(entry);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /** 发布事件 */
  async emit(event: WorldEvent): Promise<void> {
    // 存入历史
    this._history.push(event);
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    // 通知匹配的监听器
    const promises: Promise<void>[] = [];
    for (const { filter, listener } of this._listeners) {
      if (!filter || matchesFilter(event, filter)) {
        const result = listener(event);
        if (result instanceof Promise) {
          promises.push(result);
        }
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /** 查询历史事件 */
  query(filter: EventFilter & { afterTick?: number; limit?: number }): WorldEvent[] {
    let results = this._history;

    if (filter.afterTick !== undefined) {
      results = results.filter((e) => e.tick > filter.afterTick!);
    }
    if (filter.type || filter.actorId || filter.locationId) {
      results = results.filter((e) => matchesFilter(e, filter));
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  /** 获取全部历史 */
  get history(): ReadonlyArray<WorldEvent> {
    return this._history;
  }

  /** 清空历史 */
  clear(): void {
    this._history = [];
  }
}
