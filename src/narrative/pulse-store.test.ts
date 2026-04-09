/**
 * D2 — pulse-store 单测
 */

import { describe, it, expect } from "vitest";
import { ShortTermMemory } from "../memory/short-term.js";
import {
  InMemoryPulseStore,
  observePulses,
  extractTargetChar,
  OBSERVATION_WINDOW,
  type PulseRecord,
} from "./pulse-store.js";

function makePulse(overrides: Partial<PulseRecord>): PulseRecord {
  return {
    id: "p_test",
    tick: 100,
    toolName: "inject_intent",
    targetChar: "alice",
    args: {},
    ...overrides,
  };
}

describe("InMemoryPulseStore", () => {
  it("records and retrieves pulses", () => {
    const store = new InMemoryPulseStore();
    const id = store.nextId(100);
    store.record(makePulse({ id }));
    expect(store.get(id)).toBeDefined();
    expect(store.size()).toBe(1);
  });

  it("nextId生成唯一 id", () => {
    const store = new InMemoryPulseStore();
    const a = store.nextId(100);
    const b = store.nextId(100);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pulse_100_/);
  });

  it("FIFO 移除超过 maxEntries 的旧 pulse", () => {
    const store = new InMemoryPulseStore({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      const id = store.nextId(100 + i);
      store.record(makePulse({ id, tick: 100 + i }));
    }
    expect(store.size()).toBe(3);
    expect(store.list()[0]!.tick).toBe(102);
  });

  it("list 支持 sinceTick / targetChar / pendingOnly 过滤", () => {
    const store = new InMemoryPulseStore();
    store.record(makePulse({ id: "p1", tick: 90, targetChar: "alice" }));
    store.record(makePulse({ id: "p2", tick: 100, targetChar: "bob" }));
    store.record(makePulse({ id: "p3", tick: 110, targetChar: "alice", observed: "x", observedAtTick: 118 }));

    expect(store.list({ sinceTick: 100 }).length).toBe(2);
    expect(store.list({ targetChar: "alice" }).length).toBe(2);
    expect(store.list({ pendingOnly: true }).length).toBe(2);
  });

  it("updateObserved 写入 observed + observedAtTick", () => {
    const store = new InMemoryPulseStore();
    store.record(makePulse({ id: "p1" }));
    store.updateObserved("p1", "alice 之后去找了 bob 谈话", 110);
    const p = store.get("p1");
    expect(p?.observed).toContain("bob");
    expect(p?.observedAtTick).toBe(110);
  });
});

describe("observePulses reducer", () => {
  it("跳过尚在观察窗口内的 pulse", () => {
    const store = new InMemoryPulseStore();
    const memory = new ShortTermMemory();
    store.record(makePulse({ id: "p1", tick: 100 }));
    const updated = observePulses(store, memory, 105); // 距 pulse 5 tick < 8
    expect(updated).toBe(0);
    expect(store.get("p1")?.observed).toBeUndefined();
  });

  it("过窗口后扫 memory 拼 observed 摘要", () => {
    const store = new InMemoryPulseStore();
    const memory = new ShortTermMemory();
    memory.add("alice", { tick: 102, type: "event", content: "去了广场", importance: 5 });
    memory.add("alice", { tick: 105, type: "conversation", content: "对 bob 说：你好", importance: 6 });
    store.record(makePulse({ id: "p1", tick: 100, targetChar: "alice" }));

    const updated = observePulses(store, memory, 109); // 距 100 已 9 tick > 8
    expect(updated).toBe(1);
    const p = store.get("p1");
    expect(p?.observed).toContain("去了广场");
    expect(p?.observed).toContain("对 bob 说");
    expect(p?.observedAtTick).toBe(109);
  });

  it("窗口内无可观察行为时填占位", () => {
    const store = new InMemoryPulseStore();
    const memory = new ShortTermMemory();
    store.record(makePulse({ id: "p1", tick: 100, targetChar: "alice" }));
    observePulses(store, memory, 110);
    expect(store.get("p1")?.observed).toContain("无可观察行为");
  });

  it("无 targetChar 的全局 pulse 标记为 not-observable", () => {
    const store = new InMemoryPulseStore();
    const memory = new ShortTermMemory();
    store.record(makePulse({ id: "p1", tick: 100, targetChar: undefined, toolName: "add_rumor" }));
    observePulses(store, memory, 110);
    expect(store.get("p1")?.observed).toContain("无目标角色");
  });

  it("已 observed 的 pulse 不会被重复处理", () => {
    const store = new InMemoryPulseStore();
    const memory = new ShortTermMemory();
    store.record(makePulse({ id: "p1", tick: 100, targetChar: "alice", observed: "已经填过", observedAtTick: 109 }));
    const updated = observePulses(store, memory, 120);
    expect(updated).toBe(0);
    expect(store.get("p1")?.observed).toBe("已经填过");
  });
});

describe("extractTargetChar", () => {
  it("从 character_id 提取", () => {
    expect(extractTargetChar({ character_id: "alice" })).toBe("alice");
  });
  it("从 observer_id 提取", () => {
    expect(extractTargetChar({ observer_id: "bob" })).toBe("bob");
  });
  it("从 target_character_id 提取", () => {
    expect(extractTargetChar({ target_character_id: "rei" })).toBe("rei");
  });
  it("没有匹配字段返回 undefined", () => {
    expect(extractTargetChar({ event_id: "x" })).toBeUndefined();
  });
});

describe("OBSERVATION_WINDOW 常量", () => {
  it("是 8", () => expect(OBSERVATION_WINDOW).toBe(8));
});
