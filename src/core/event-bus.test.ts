import { describe, it, expect, vi } from "vitest";
import { EventBus, type WorldEvent } from "./event-bus.js";

function makeEvent(overrides: Partial<WorldEvent> = {}): WorldEvent {
  return {
    id: "evt-1",
    tick: 1,
    type: "social.chat",
    actorId: "alice",
    locationId: "cafe",
    description: "Alice 和 Bob 聊天",
    effects: [],
    witnesses: ["bob"],
    ...overrides,
  };
}

describe("EventBus", () => {
  it("emit 触发监听器", async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on(listener);

    const event = makeEvent();
    await bus.emit(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it("按类型过滤事件", async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on(listener, { type: "work" });

    await bus.emit(makeEvent({ type: "social.chat" }));
    await bus.emit(makeEvent({ type: "work.harvest", id: "evt-2" }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].type).toBe("work.harvest");
  });

  it("按 actorId 过滤", async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on(listener, { actorId: "bob" });

    await bus.emit(makeEvent({ actorId: "alice" }));
    await bus.emit(makeEvent({ actorId: "bob", id: "evt-2" }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("取消订阅", async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsub = bus.on(listener);

    await bus.emit(makeEvent());
    unsub();
    await bus.emit(makeEvent({ id: "evt-2" }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("记录事件历史", async () => {
    const bus = new EventBus();
    await bus.emit(makeEvent({ id: "evt-1", tick: 1 }));
    await bus.emit(makeEvent({ id: "evt-2", tick: 2 }));
    await bus.emit(makeEvent({ id: "evt-3", tick: 3 }));

    expect(bus.history).toHaveLength(3);
  });

  it("query 按 tick 过滤", async () => {
    const bus = new EventBus();
    await bus.emit(makeEvent({ id: "evt-1", tick: 1 }));
    await bus.emit(makeEvent({ id: "evt-2", tick: 5 }));
    await bus.emit(makeEvent({ id: "evt-3", tick: 10 }));

    const results = bus.query({ afterTick: 3 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("evt-2");
  });

  it("query 支持 limit", async () => {
    const bus = new EventBus();
    for (let i = 0; i < 10; i++) {
      await bus.emit(makeEvent({ id: `evt-${i}`, tick: i }));
    }

    const results = bus.query({ limit: 3 });
    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("evt-7");
  });

  it("正则过滤类型", async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on(listener, { type: /^social\./ });

    await bus.emit(makeEvent({ type: "social.chat" }));
    await bus.emit(makeEvent({ type: "social.gift", id: "evt-2" }));
    await bus.emit(makeEvent({ type: "work.harvest", id: "evt-3" }));

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("maxHistory 限制历史长度", async () => {
    const bus = new EventBus({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) {
      await bus.emit(makeEvent({ id: `evt-${i}`, tick: i }));
    }

    expect(bus.history).toHaveLength(5);
    expect(bus.history[0].id).toBe("evt-5");
  });
});
