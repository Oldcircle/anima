/**
 * BeatEngine 单测
 */

import { describe, it, expect } from "vitest";
import { BeatEngine, parseBeatsConfig, type BeatDefinition } from "./beat-engine.js";
import type { BeatContext } from "./expression.js";

const ctx = (overrides: Partial<BeatContext["world"]> = {}): BeatContext => ({
  world: {
    day: 1,
    tick: 0,
    activePhase: undefined,
    tensionIndex: 0,
    unresolvedEvents: [],
    triggeredBeats: [],
    ...overrides,
  },
  characters: {},
});

describe("BeatEngine", () => {
  it("triggers a beat whose preconditions are met", () => {
    const engine = new BeatEngine([
      {
        id: "day_check",
        preconditions: ["world.day >= 2"],
      },
    ]);
    const ready = engine.scan(ctx({ day: 3 }));
    expect(ready.length).toBe(1);
    expect(ready[0]!.beatId).toBe("day_check");
    expect(ready[0]!.reason).toBe("preconditions_met");
  });

  it("does not re-trigger an already-triggered beat", () => {
    const engine = new BeatEngine([
      { id: "x", preconditions: ["world.day >= 1"] },
    ]);
    expect(engine.scan(ctx()).length).toBe(1);
    expect(engine.scan(ctx()).length).toBe(0);
  });

  it("supports {all, any} structure", () => {
    const engine = new BeatEngine([
      {
        id: "complex",
        preconditions: {
          all: ["world.day >= 2"],
          any: ["world.tensionIndex > 50", "world.day > 10"],
        },
      },
    ]);
    // all 满足，any 不满足 → 不触发
    expect(engine.scan(ctx({ day: 3, tensionIndex: 10 })).length).toBe(0);
    // all 满足，any 满足 → 触发
    const ready = engine.scan(ctx({ day: 3, tensionIndex: 60 }));
    expect(ready.length).toBe(1);
  });

  it("triggers via fallback_deadline_day even when preconditions never match", () => {
    const engine = new BeatEngine([
      {
        id: "deadline",
        preconditions: ["false"],
        fallback_deadline_day: 3,
      },
    ]);
    // day 2: 没到 deadline，不触发
    expect(engine.scan(ctx({ day: 2 })).length).toBe(0);
    // day 3 早晨 (hour < 20): deadline 当天但还没到晚间，不触发
    expect(engine.scan(ctx({ day: 3, tick: 96 * 2 })).length).toBe(0); // tick=192 → hour=0
    // day 3 晚间 (hour >= 20): deadline 当天晚间，触发
    const ready = engine.scan(ctx({ day: 3, tick: 96 * 2 + 80 })); // tick=272 → hour=20
    expect(ready.length).toBe(1);
    expect(ready[0]!.reason).toBe("fallback_deadline");
  });

  it("fallback fires immediately when past deadline day", () => {
    const engine = new BeatEngine([
      { id: "overdue", preconditions: ["false"], fallback_deadline_day: 2 },
    ]);
    // day 3 任何时间（超过 deadline day 2）都触发
    const ready = engine.scan(ctx({ day: 3, tick: 96 * 2 }));
    expect(ready.length).toBe(1);
    expect(ready[0]!.reason).toBe("fallback_deadline");
  });

  it("respects priority order in scan output", () => {
    const engine = new BeatEngine([
      { id: "low", preconditions: ["true"], priority: 1 },
      { id: "high", preconditions: ["true"], priority: 10 },
      { id: "mid", preconditions: ["true"], priority: 5 },
    ]);
    const ready = engine.scan(ctx());
    expect(ready.map((r) => r.beatId)).toEqual(["high", "mid", "low"]);
  });

  it("propagates on_trigger payload", () => {
    const engine = new BeatEngine([
      {
        id: "with_payload",
        preconditions: ["true"],
        on_trigger: { kind: "test", hint: "do something" },
      },
    ]);
    const ready = engine.scan(ctx());
    expect(ready[0]!.payload).toEqual({ kind: "test", hint: "do something" });
  });

  it("setTriggered restores already-triggered set (for read-from-save)", () => {
    const engine = new BeatEngine([{ id: "x", preconditions: ["true"] }]);
    engine.setTriggered(["x"]);
    expect(engine.scan(ctx()).length).toBe(0);
  });

  it("empty preconditions does not trigger", () => {
    const engine = new BeatEngine([{ id: "noop" }]);
    expect(engine.scan(ctx()).length).toBe(0);
  });

  it("a beat with empty all+any does not trigger", () => {
    const engine = new BeatEngine([{ id: "noop", preconditions: { all: [], any: [] } }]);
    expect(engine.scan(ctx()).length).toBe(0);
  });
});

describe("parseBeatsConfig", () => {
  it("accepts top-level array", () => {
    const beats = parseBeatsConfig([
      { id: "a", description: "A", preconditions: ["true"] },
      { id: "b" },
    ]);
    expect(beats.length).toBe(2);
    expect(beats[0]!.description).toBe("A");
  });

  it("accepts {beats: [...]} wrapping", () => {
    const beats = parseBeatsConfig({
      beats: [
        { id: "x", priority: 5 },
        { id: "y", fallback_deadline_day: 10 },
      ],
    });
    expect(beats.length).toBe(2);
    expect(beats[0]!.priority).toBe(5);
    expect(beats[1]!.fallback_deadline_day).toBe(10);
  });

  it("filters out items without id", () => {
    const beats = parseBeatsConfig([
      { id: "ok" },
      { description: "no id" },
      "not an object",
      null,
    ]);
    expect(beats.length).toBe(1);
    expect(beats[0]!.id).toBe("ok");
  });

  it("returns empty array on invalid input", () => {
    expect(parseBeatsConfig(undefined)).toEqual([]);
    expect(parseBeatsConfig(null)).toEqual([]);
    expect(parseBeatsConfig("not yaml")).toEqual([]);
    expect(parseBeatsConfig({ no_beats: 123 })).toEqual([]);
  });
});
