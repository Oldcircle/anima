/**
 * Expression evaluator 单测
 */

import { describe, it, expect } from "vitest";
import { evaluateExpression, evaluateCompiled, buildBeatContext, type BeatContext } from "./expression.js";
import { emptyNarrativeState } from "./narrative-state.js";

const baseCtx = (): BeatContext => ({
  world: {
    day: 1,
    tick: 50,
    activePhase: undefined,
    tensionIndex: 0,
    unresolvedEvents: [],
    triggeredBeats: [],
  },
  characters: {},
});

describe("evaluateExpression", () => {
  it("evaluates simple boolean expressions", () => {
    expect(evaluateExpression("world.day > 0", baseCtx())).toBe(true);
    expect(evaluateExpression("world.day > 5", baseCtx())).toBe(false);
  });

  it("supports contains transform", () => {
    const ctx = baseCtx();
    ctx.characters.alice = {
      disclosedSecrets: ["secret_a", "secret_b"],
      knownFacts: [],
      unresolvedWith: {},
      pressure: 0,
      relationships: {},
    };
    expect(evaluateExpression("characters.alice.disclosedSecrets | contains('secret_a')", ctx)).toBe(true);
    expect(evaluateExpression("characters.alice.disclosedSecrets | contains('secret_x')", ctx)).toBe(false);
  });

  it("supports excludes transform", () => {
    const ctx = baseCtx();
    ctx.characters.alice = {
      disclosedSecrets: ["s1"],
      knownFacts: [],
      unresolvedWith: {},
      pressure: 0,
      relationships: {},
    };
    expect(evaluateExpression("characters.alice.disclosedSecrets | excludes('family')", ctx)).toBe(true);
    expect(evaluateExpression("characters.alice.disclosedSecrets | excludes('s1')", ctx)).toBe(false);
  });

  it("supports length transform on array and object", () => {
    const ctx = baseCtx();
    ctx.world.unresolvedEvents = [
      { id: "e1", involved: [] },
      { id: "e2", involved: [] },
    ];
    expect(evaluateExpression("world.unresolvedEvents | length > 1", ctx)).toBe(true);
    expect(evaluateExpression("world.unresolvedEvents | length == 2", ctx)).toBe(true);
  });

  it("supports nested object access", () => {
    const ctx = baseCtx();
    ctx.characters.alice = {
      disclosedSecrets: [],
      knownFacts: [],
      unresolvedWith: {},
      pressure: 0,
      relationships: { bob: { level: 70, type: "friend", trust: 0.7 } },
    };
    expect(evaluateExpression("characters.alice.relationships.bob.trust > 0.5", ctx)).toBe(true);
    expect(evaluateExpression("characters.alice.relationships.bob.type == 'friend'", ctx)).toBe(true);
  });

  it("returns false on invalid expression", () => {
    expect(evaluateExpression("this is not jexl", baseCtx())).toBe(false);
    expect(evaluateExpression("undefined.prop.access", baseCtx())).toBe(false);
  });

  it("evaluateCompiled caches and is equivalent to evaluateExpression", () => {
    const ctx = baseCtx();
    expect(evaluateCompiled("world.day > 0", ctx)).toBe(true);
    expect(evaluateCompiled("world.day > 0", ctx)).toBe(true); // cache hit
    expect(evaluateCompiled("world.day > 100", ctx)).toBe(false);
  });
});

describe("buildBeatContext", () => {
  it("derives game day from tick", () => {
    const snap = emptyNarrativeState();
    const ctx = buildBeatContext({
      narrative: snap,
      tick: 96 * 2 + 50, // day 3
      characterRelationships: {},
      characterNeeds: {},
      characterLocations: {},
    });
    expect(ctx.world.day).toBe(3);
    expect(ctx.world.tick).toBe(96 * 2 + 50);
  });

  it("merges narrative_state.characters with relationship data", () => {
    const snap = emptyNarrativeState();
    snap.characters["alice"] = {
      disclosedSecrets: ["s1"],
      knownFacts: ["f1"],
      unresolvedWith: { bob: ["topic"] },
      pressure: 30,
      secretsPool: [],
    };
    const ctx = buildBeatContext({
      narrative: snap,
      tick: 0,
      characterRelationships: {
        alice: { bob: { level: 50, type: "friend", trust: 0.5 } },
      },
      characterNeeds: { alice: { social: 70, energy: 80 } },
      characterLocations: { alice: "park" },
    });
    expect(ctx.characters.alice).toBeDefined();
    expect(ctx.characters.alice!.disclosedSecrets).toEqual(["s1"]);
    expect(ctx.characters.alice!.relationships.bob.level).toBe(50);
    expect(ctx.characters.alice!.needs?.social).toBe(70);
    expect(ctx.characters.alice!.locationId).toBe("park");
  });

  it("provides defaults for characters not in narrative_state", () => {
    const snap = emptyNarrativeState();
    const ctx = buildBeatContext({
      narrative: snap,
      tick: 0,
      characterRelationships: { alice: {} },
      characterNeeds: {},
      characterLocations: { alice: "home" },
    });
    expect(ctx.characters.alice!.disclosedSecrets).toEqual([]);
    expect(ctx.characters.alice!.pressure).toBe(0);
  });
});
