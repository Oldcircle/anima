/**
 * NarrativeState + tag-applier + tension 单测
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NarrativeState, emptyNarrativeState, normalizeNarrativeSnapshot } from "./narrative-state.js";
import type { NarrativeStateSnapshot } from "./narrative-state.js";
import { World } from "../world/world.js";
import { applyNarrativeTags, extractTagsFromArgs, hasAnyTags } from "./tag-applier.js";
import { computeTensionIndex, updateWorldTension } from "./tension.js";
import type { Location } from "../world/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
];

describe("NarrativeState", () => {
  let ns: NarrativeState;

  beforeEach(() => {
    ns = new NarrativeState();
  });

  it("starts empty", () => {
    const snap = ns.getSnapshot();
    expect(snap.world.unresolvedEvents).toEqual([]);
    expect(snap.world.tensionIndex).toBe(0);
    expect(snap.characters).toEqual({});
  });

  it("addDisclosedSecret is idempotent", () => {
    expect(ns.addDisclosedSecret("alice", "secret_x")).toBe(true);
    expect(ns.addDisclosedSecret("alice", "secret_x")).toBe(false);
    expect(ns.getCharacter("alice").disclosedSecrets).toEqual(["secret_x"]);
  });

  it("addUnresolvedEvent dedupes by id", () => {
    ns.addUnresolvedEvent({ id: "e1", summary: "x", involved: ["a"], visibleTo: "*", createdTick: 0 });
    ns.addUnresolvedEvent({ id: "e1", summary: "different", involved: ["b"], visibleTo: "*", createdTick: 5 });
    expect(ns.getWorld().unresolvedEvents.length).toBe(1);
    expect(ns.getWorld().unresolvedEvents[0]!.summary).toBe("x");
  });

  it("getUnresolvedEventsVisibleTo filters by visibleTo", () => {
    ns.addUnresolvedEvent({ id: "e1", summary: "all", involved: [], visibleTo: "*", createdTick: 0 });
    ns.addUnresolvedEvent({ id: "e2", summary: "alice only", involved: [], visibleTo: ["alice"], createdTick: 0 });
    ns.addUnresolvedEvent({ id: "e3", summary: "bob only", involved: [], visibleTo: ["bob"], createdTick: 0 });
    const ev = ns.getUnresolvedEventsVisibleTo("alice").map((e) => e.id);
    expect(ev.sort()).toEqual(["e1", "e2"]);
  });

  it("markBeatTriggered is idempotent", () => {
    expect(ns.markBeatTriggered("beat_a")).toBe(true);
    expect(ns.markBeatTriggered("beat_a")).toBe(false);
    expect(ns.getWorld().triggeredBeats).toEqual(["beat_a"]);
  });

  it("setTensionIndex clamps 0..100", () => {
    ns.setTensionIndex(-10);
    expect(ns.getWorld().tensionIndex).toBe(0);
    ns.setTensionIndex(150);
    expect(ns.getWorld().tensionIndex).toBe(100);
  });

  it("replaceSnapshot restores from saved state", () => {
    const fresh = emptyNarrativeState();
    fresh.world.tensionIndex = 42;
    fresh.world.triggeredBeats = ["b1"];
    fresh.characters["alice"] = {
      disclosedSecrets: ["s1"],
      knownFacts: [],
      unresolvedWith: {},
      pressure: 50,
      secretsPool: ["s1", "s2"],
    };
    const ns2 = new NarrativeState();
    ns2.replaceSnapshot(fresh);
    expect(ns2.getWorld().tensionIndex).toBe(42);
    expect(ns2.getCharacter("alice").pressure).toBe(50);
  });
});

describe("tag-applier", () => {
  let world: World;

  beforeEach(() => {
    world = new World(fakeLocations);
    world.addCharacter("alice", "Alice", "park");
    world.addCharacter("bob", "Bob", "park");
  });

  it("extractTagsFromArgs handles all fields", () => {
    const tags = extractTagsFromArgs({
      target: "bob",
      message: "...",
      topic_tags: ["family", "past"],
      intent: "disclose",
      reveals: ["s1"],
      references_event: "e1",
    });
    expect(tags.topic_tags).toEqual(["family", "past"]);
    expect(tags.intent).toBe("disclose");
    expect(tags.reveals).toEqual(["s1"]);
    expect(tags.references_event).toBe("e1");
    expect(hasAnyTags(tags)).toBe(true);
  });

  it("extractTagsFromArgs handles empty args", () => {
    const tags = extractTagsFromArgs({ target: "bob", message: "hi" });
    expect(hasAnyTags(tags)).toBe(false);
  });

  it("reveals writes disclosedSecrets to actor and knownFacts to target", () => {
    const log = applyNarrativeTags(world, "alice", "bob", {
      reveals: ["family_background"],
    });
    expect(log.disclosedSecrets).toEqual(["family_background"]);
    expect(log.knownFactsAdded).toEqual(["alice_family_background"]);
    expect(world.narrative.getCharacter("alice").disclosedSecrets).toContain("family_background");
    expect(world.narrative.getCharacter("bob").knownFacts).toContain("alice_family_background");
  });

  it("reveals is idempotent (second call doesn't double-write)", () => {
    applyNarrativeTags(world, "alice", "bob", { reveals: ["s1"] });
    const log = applyNarrativeTags(world, "alice", "bob", { reveals: ["s1"] });
    expect(log.disclosedSecrets).toEqual([]);
    expect(world.narrative.getCharacter("alice").disclosedSecrets).toEqual(["s1"]);
  });

  it("references_event records unresolvedWith", () => {
    applyNarrativeTags(world, "alice", "bob", { references_event: "e_argument" });
    expect(world.narrative.getCharacter("alice").unresolvedWith.bob).toEqual(["e_argument"]);
  });

  it("no-op when tags are empty", () => {
    const log = applyNarrativeTags(world, "alice", "bob", {});
    expect(log.disclosedSecrets).toEqual([]);
    expect(log.knownFactsAdded).toEqual([]);
    expect(world.narrative.getSnapshot().characters).toEqual({});
  });

  it("reveals without target only updates actor", () => {
    const log = applyNarrativeTags(world, "alice", undefined, { reveals: ["s1"] });
    expect(log.disclosedSecrets).toEqual(["s1"]);
    expect(log.knownFactsAdded).toEqual([]);
  });
});

describe("tension index (公式 v1：锁形状不锁数值)", () => {
  it("零输入 → 0；单项注入 → 单调上升", () => {
    expect(computeTensionIndex({ unresolvedCount: 0, pairPressureTop3Avg: 0, ticksSinceLastBeat: 0 })).toBe(0);
    const onlyUnresolved = computeTensionIndex({ unresolvedCount: 5, pairPressureTop3Avg: 0, ticksSinceLastBeat: 0 });
    expect(onlyUnresolved).toBeGreaterThan(0);
    const withPairs = computeTensionIndex({ unresolvedCount: 5, pairPressureTop3Avg: 60, ticksSinceLastBeat: 0 });
    expect(withPairs).toBeGreaterThan(onlyUnresolved);
    const withDrought = computeTensionIndex({ unresolvedCount: 5, pairPressureTop3Avg: 60, ticksSinceLastBeat: 96 });
    expect(withDrought).toBeGreaterThan(withPairs);
  });

  it("全项拉满 → 100（上限回 100，杀 tension>40 永假）", () => {
    expect(computeTensionIndex({ unresolvedCount: 10, pairPressureTop3Avg: 100, ticksSinceLastBeat: 96 })).toBe(100);
  });

  it("压力对插座接了真数据后 tension 可达 >40", () => {
    // 旧公式两插座恒 0 → 封顶 40（director pacing 'tension > 40' 判据永假）
    const t = computeTensionIndex({ unresolvedCount: 3, pairPressureTop3Avg: 70, ticksSinceLastBeat: 48 });
    expect(t).toBeGreaterThan(40);
  });

  it("updateWorldTension reads unresolved + 干旱项 from world.narrative", () => {
    const world = new World(fakeLocations);
    world.narrative.addUnresolvedEvent({ id: "e1", summary: "", involved: [], visibleTo: "*", createdTick: 0 });
    world.narrative.addUnresolvedEvent({ id: "e2", summary: "", involved: [], visibleTo: "*", createdTick: 0 });
    const t = updateWorldTension(world);
    expect(t).toBeGreaterThan(0);
    expect(world.narrative.getWorld().tensionIndex).toBe(t);
    // 压力对均值传入后 tension 上升
    const t2 = updateWorldTension(world, { pairPressureTop3Avg: 80 });
    expect(t2).toBeGreaterThan(t);
  });

  it("beat 触发会压低干旱项", () => {
    const world = new World(fakeLocations, 96 * 3); // day 4
    const droughtHigh = updateWorldTension(world);
    world.narrative.recordBeatTrigger("b1", 96 * 3 - 4); // 1 小时前刚触发过 beat
    const droughtLow = updateWorldTension(world);
    expect(droughtLow).toBeLessThan(droughtHigh);
  });
});

describe("normalizeNarrativeSnapshot（旧档读档回填）", () => {
  it("旧档缺 beatLastTrigger/pressure 等新字段 → 补默认值，无 NaN", () => {
    // 模拟 N2 时代的旧档：world 缺 beatLastTrigger，角色缺 pressure/secretsPool
    const legacy = {
      world: {
        unresolvedEvents: [{ id: "e1", summary: "x", involved: ["alice"], visibleTo: "*", createdTick: 0 }],
        triggeredBeats: ["b1"],
        tensionIndex: 30,
        rumors: [],
      },
      characters: {
        alice: { disclosedSecrets: ["s1"], knownFacts: [], unresolvedWith: {} },
      },
      locations: {
        cafe: { eventsWitnessed: [] },
      },
    } as unknown as NarrativeStateSnapshot;

    const ns = new NarrativeState();
    ns.replaceSnapshot(legacy);

    const w = ns.getWorld();
    expect(w.beatLastTrigger).toEqual({});
    expect(ns.getTicksSinceLastBeat(100)).toBe(100); // 不是 NaN
    const alice = ns.getCharacter("alice");
    expect(alice.pressure).toBe(0);
    expect(Number.isFinite(alice.pressure)).toBe(true);
    expect(alice.secretsPool).toEqual([]);
    expect(alice.disclosedSecrets).toEqual(["s1"]); // 已有数据不动
    expect(ns.getSnapshot().locations.cafe!.rumorSeeds).toEqual([]);
  });

  it("完全空对象/坏 tensionIndex 也能 normalize", () => {
    const snap = normalizeNarrativeSnapshot({} as NarrativeStateSnapshot);
    expect(snap.world.unresolvedEvents).toEqual([]);
    expect(snap.world.tensionIndex).toBe(0);
    expect(snap.world.beatLastTrigger).toEqual({});
    const bad = normalizeNarrativeSnapshot({
      world: { tensionIndex: Number.NaN, beatLastTrigger: { b1: Number.NaN, b2: 42 } },
    } as unknown as NarrativeStateSnapshot);
    expect(bad.world.tensionIndex).toBe(0);
    expect(bad.world.beatLastTrigger).toEqual({ b2: 42 });
  });

  it("beatLastTrigger JSON 序列化 round-trip 存活（随档计数器）", () => {
    const ns = new NarrativeState();
    ns.recordBeatTrigger("beat_x", 120);
    ns.recordBeatTrigger("beat_y", 200);
    const json = JSON.stringify(ns.getSnapshot());
    const ns2 = new NarrativeState();
    ns2.replaceSnapshot(JSON.parse(json));
    expect(ns2.getWorld().beatLastTrigger).toEqual({ beat_x: 120, beat_y: 200 });
    expect(ns2.getTicksSinceLastBeat(230)).toBe(30);
  });
});

describe("World.narrative integration", () => {
  it("World exposes narrative field", () => {
    const world = new World(fakeLocations);
    expect(world.narrative).toBeInstanceOf(NarrativeState);
    expect(world.narrative.getWorld().tensionIndex).toBe(0);
  });
});
