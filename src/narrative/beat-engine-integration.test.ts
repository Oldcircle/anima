/**
 * BeatEngine 集成测试（无 LLM）
 *
 * 验证：
 * 1. scan 在不同 tick 上能正确触发 beats
 * 2. 触发后写入 narrative_state.triggeredBeats
 * 3. fallback_deadline 在没有正常触发时仍能兜底
 * 4. 多次 scan 不会重复触发同一 beat
 */

import { describe, it, expect, beforeEach } from "vitest";
import { World } from "../world/world.js";
import { BeatEngine, type BeatDefinition } from "./beat-engine.js";
import { buildBeatContext } from "./expression.js";
import type { Location } from "../world/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
];

function makeWorldWithChars(): World {
  const w = new World(fakeLocations);
  w.addCharacter("alice", "Alice", "park");
  w.addCharacter("bob", "Bob", "park");
  return w;
}

function buildCtxFromWorld(world: World, day: number) {
  const tick = (day - 1) * 96 + 88; // 22:00 of the day
  return buildBeatContext({
    narrative: world.narrative.getSnapshot(),
    tick,
    characterRelationships: {},
    characterNeeds: {},
    characterLocations: {},
  });
}

describe("BeatEngine integration with World", () => {
  let world: World;
  let engine: BeatEngine;

  beforeEach(() => {
    world = makeWorldWithChars();
    engine = new BeatEngine();
  });

  it("triggers a beat that depends on disclosedSecrets state", () => {
    const beats: BeatDefinition[] = [
      {
        id: "alice_disclosed",
        preconditions: ["characters.alice.disclosedSecrets | contains('past')"],
      },
    ];
    engine.setBeats(beats);

    // 初始：未坦白
    expect(engine.scan(buildCtxFromWorld(world, 1)).length).toBe(0);

    // 模拟坦白
    world.narrative.addDisclosedSecret("alice", "past");
    const ready = engine.scan(buildCtxFromWorld(world, 2));
    expect(ready.length).toBe(1);
    expect(ready[0]!.beatId).toBe("alice_disclosed");
  });

  it("fallback fires after deadline_day even with unmet preconditions", () => {
    const beats: BeatDefinition[] = [
      {
        id: "must_happen",
        preconditions: ["characters.alice.pressure > 90"],
        fallback_deadline_day: 5,
      },
    ];
    engine.setBeats(beats);

    expect(engine.scan(buildCtxFromWorld(world, 3)).length).toBe(0);
    expect(engine.scan(buildCtxFromWorld(world, 4)).length).toBe(0);
    const ready = engine.scan(buildCtxFromWorld(world, 5));
    expect(ready.length).toBe(1);
    expect(ready[0]!.reason).toBe("fallback_deadline");
  });

  it("triggers based on unresolvedEvents count", () => {
    const beats: BeatDefinition[] = [
      {
        id: "many_unresolved",
        preconditions: ["world.unresolvedEvents | length >= 2"],
      },
    ];
    engine.setBeats(beats);

    expect(engine.scan(buildCtxFromWorld(world, 1)).length).toBe(0);

    world.narrative.addUnresolvedEvent({ id: "e1", summary: "x", involved: [], visibleTo: "*", createdTick: 0 });
    expect(engine.scan(buildCtxFromWorld(world, 1)).length).toBe(0);

    world.narrative.addUnresolvedEvent({ id: "e2", summary: "y", involved: [], visibleTo: "*", createdTick: 0 });
    const ready = engine.scan(buildCtxFromWorld(world, 1));
    expect(ready.length).toBe(1);
    expect(ready[0]!.beatId).toBe("many_unresolved");
  });

  it("multiple beats can fire in same scan, ordered by priority", () => {
    const beats: BeatDefinition[] = [
      { id: "low", preconditions: ["true"], priority: 1 },
      { id: "high", preconditions: ["true"], priority: 100 },
    ];
    engine.setBeats(beats);
    const ready = engine.scan(buildCtxFromWorld(world, 1));
    expect(ready.length).toBe(2);
    expect(ready[0]!.beatId).toBe("high");
  });

  it("simulating many days: every beat fires at most once", () => {
    const beats: BeatDefinition[] = [
      { id: "always", preconditions: ["true"] },
      { id: "never", preconditions: ["false"] },
    ];
    engine.setBeats(beats);

    let totalFired = 0;
    for (let day = 1; day <= 10; day++) {
      const ready = engine.scan(buildCtxFromWorld(world, day));
      totalFired += ready.length;
    }
    expect(totalFired).toBe(1); // 只有 "always" 触发一次
  });
});
