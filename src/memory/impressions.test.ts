import { describe, it, expect } from "vitest";
import { ImpressionStore, type CharacterImpression } from "./impressions.js";

function makeImpression(overrides?: Partial<CharacterImpression>): CharacterImpression {
  return {
    characterId: "sakiko",
    summary: "咖啡馆工作的女孩，礼貌但有距离感",
    observations: ["说话总先说'请容我'"],
    mentalLabel: "有秘密的人",
    unresolved: ["她为什么来这个小镇？"],
    lastUpdated: 100,
    ...overrides,
  };
}

describe("ImpressionStore", () => {
  it("stores and retrieves impressions", () => {
    const store = new ImpressionStore();
    const imp = makeImpression();
    store.set("maria", imp);

    expect(store.get("maria", "sakiko")).toEqual(imp);
    expect(store.get("sakiko", "maria")).toBeUndefined();
  });

  it("limits observations to 5", () => {
    const store = new ImpressionStore();
    const imp = makeImpression({
      observations: ["a", "b", "c", "d", "e", "f", "g"],
    });
    store.set("maria", imp);

    expect(store.get("maria", "sakiko")!.observations).toHaveLength(5);
    expect(store.get("maria", "sakiko")!.observations[0]).toBe("c"); // kept last 5
  });

  it("limits unresolved to 3", () => {
    const store = new ImpressionStore();
    const imp = makeImpression({
      unresolved: ["q1", "q2", "q3", "q4"],
    });
    store.set("maria", imp);

    expect(store.get("maria", "sakiko")!.unresolved).toHaveLength(3);
  });

  it("merges new observations into existing", () => {
    const store = new ImpressionStore();
    store.set("maria", makeImpression({ observations: ["old obs"] }));

    store.merge("maria", makeImpression({
      summary: "更新后的总结",
      observations: ["new obs"],
      mentalLabel: "新标签",
      lastUpdated: 200,
    }));

    const result = store.get("maria", "sakiko")!;
    expect(result.summary).toBe("更新后的总结");
    expect(result.mentalLabel).toBe("新标签");
    expect(result.observations).toContain("old obs");
    expect(result.observations).toContain("new obs");
    expect(result.lastUpdated).toBe(200);
  });

  it("merge creates new if not exists", () => {
    const store = new ImpressionStore();
    store.merge("maria", makeImpression());

    expect(store.get("maria", "sakiko")).toBeDefined();
  });

  it("deduplicates observations on merge", () => {
    const store = new ImpressionStore();
    store.set("maria", makeImpression({ observations: ["same obs"] }));
    store.merge("maria", makeImpression({ observations: ["same obs", "new obs"] }));

    const obs = store.get("maria", "sakiko")!.observations;
    expect(obs.filter((o) => o === "same obs")).toHaveLength(1);
  });

  it("getAllFor returns all impressions for an observer", () => {
    const store = new ImpressionStore();
    store.set("maria", makeImpression({ characterId: "sakiko" }));
    store.set("maria", makeImpression({ characterId: "alice", summary: "花店老板" }));
    store.set("alice", makeImpression({ characterId: "maria" }));

    const mariaImps = store.getAllFor("maria");
    expect(mariaImps).toHaveLength(2);
  });

  it("formatForPrompt returns formatted text", () => {
    const store = new ImpressionStore();
    store.set("maria", makeImpression());

    const text = store.formatForPrompt("maria", "sakiko")!;
    expect(text).toContain("咖啡馆工作的女孩");
    expect(text).toContain("请容我");
    expect(text).toContain("有秘密的人");
    expect(text).toContain("她为什么来这个小镇");
  });

  it("formatForPrompt returns undefined if no impression", () => {
    const store = new ImpressionStore();
    expect(store.formatForPrompt("maria", "sakiko")).toBeUndefined();
  });

  it("size tracks entries correctly", () => {
    const store = new ImpressionStore();
    expect(store.size).toBe(0);
    store.set("maria", makeImpression());
    expect(store.size).toBe(1);
    store.set("alice", makeImpression({ characterId: "bob" }));
    expect(store.size).toBe(2);
  });
});
