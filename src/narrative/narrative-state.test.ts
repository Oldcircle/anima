/**
 * NarrativeState + tag-applier + tension 单测
 */

import { describe, it, expect, beforeEach } from "vitest";
import { NarrativeState, emptyNarrativeState } from "./narrative-state.js";
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

describe("tension index", () => {
  it("computeTensionIndex weights unresolved 0.4", () => {
    expect(computeTensionIndex({ unresolvedCount: 0, relationshipVolatility: 0, ticksSinceLastBeat: 0 })).toBe(0);
    // 5 unresolved → a=100, b=0, c=0 → 100*0.4 = 40
    expect(computeTensionIndex({ unresolvedCount: 5, relationshipVolatility: 0, ticksSinceLastBeat: 0 })).toBe(40);
    // 全部最大 → 100
    expect(computeTensionIndex({ unresolvedCount: 10, relationshipVolatility: 1, ticksSinceLastBeat: 100 })).toBe(100);
  });

  it("updateWorldTension reads unresolved from world.narrative", () => {
    const world = new World(fakeLocations);
    world.narrative.addUnresolvedEvent({ id: "e1", summary: "", involved: [], visibleTo: "*", createdTick: 0 });
    world.narrative.addUnresolvedEvent({ id: "e2", summary: "", involved: [], visibleTo: "*", createdTick: 0 });
    const t = updateWorldTension(world);
    // 2 unresolved → a=40, b=0, c=0 → round(40*0.4)=16
    expect(t).toBe(16);
    expect(world.narrative.getWorld().tensionIndex).toBe(16);
  });
});

describe("World.narrative integration", () => {
  it("World exposes narrative field", () => {
    const world = new World(fakeLocations);
    expect(world.narrative).toBeInstanceOf(NarrativeState);
    expect(world.narrative.getWorld().tensionIndex).toBe(0);
  });
});
