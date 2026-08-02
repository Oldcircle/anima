import { describe, it, expect } from "vitest";
import { ImpressionStore, filterMatureUnresolved, type CharacterImpression } from "./impressions.js";

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
    store.set("mutsumi", imp);

    expect(store.get("mutsumi", "sakiko")).toEqual(imp);
    expect(store.get("sakiko", "mutsumi")).toBeUndefined();
  });

  it("limits observations to 5", () => {
    const store = new ImpressionStore();
    const imp = makeImpression({
      observations: ["a", "b", "c", "d", "e", "f", "g"],
    });
    store.set("mutsumi", imp);

    expect(store.get("mutsumi", "sakiko")!.observations).toHaveLength(5);
    expect(store.get("mutsumi", "sakiko")!.observations[0]).toBe("c"); // kept last 5
  });

  it("limits unresolved to 3", () => {
    const store = new ImpressionStore();
    const imp = makeImpression({
      unresolved: ["q1", "q2", "q3", "q4"],
    });
    store.set("mutsumi", imp);

    expect(store.get("mutsumi", "sakiko")!.unresolved).toHaveLength(3);
  });

  it("merges new observations into existing", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression({ observations: ["old obs"] }));

    store.merge("mutsumi", makeImpression({
      summary: "更新后的总结",
      observations: ["new obs"],
      mentalLabel: "新标签",
      lastUpdated: 200,
    }));

    const result = store.get("mutsumi", "sakiko")!;
    expect(result.summary).toBe("更新后的总结");
    expect(result.mentalLabel).toBe("新标签");
    expect(result.observations).toContain("old obs");
    expect(result.observations).toContain("new obs");
    expect(result.lastUpdated).toBe(200);
  });

  it("merge creates new if not exists", () => {
    const store = new ImpressionStore();
    store.merge("mutsumi", makeImpression());

    expect(store.get("mutsumi", "sakiko")).toBeDefined();
  });

  it("deduplicates observations on merge", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression({ observations: ["same obs"] }));
    store.merge("mutsumi", makeImpression({ observations: ["same obs", "new obs"] }));

    const obs = store.get("mutsumi", "sakiko")!.observations;
    expect(obs.filter((o) => o === "same obs")).toHaveLength(1);
  });

  it("getAllFor returns all impressions for an observer", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression({ characterId: "sakiko" }));
    store.set("mutsumi", makeImpression({ characterId: "tomori", summary: "花店老板" }));
    store.set("tomori", makeImpression({ characterId: "mutsumi" }));

    const mariaImps = store.getAllFor("mutsumi");
    expect(mariaImps).toHaveLength(2);
  });

  it("formatForPrompt returns formatted text", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression());

    const text = store.formatForPrompt("mutsumi", "sakiko")!;
    expect(text).toContain("咖啡馆工作的女孩");
    expect(text).toContain("请容我");
    expect(text).toContain("有秘密的人");
    expect(text).toContain("她为什么来这个小镇");
  });

  it("formatForPrompt returns undefined if no impression", () => {
    const store = new ImpressionStore();
    expect(store.formatForPrompt("mutsumi", "sakiko")).toBeUndefined();
  });

  it("size tracks entries correctly", () => {
    const store = new ImpressionStore();
    expect(store.size).toBe(0);
    store.set("mutsumi", makeImpression());
    expect(store.size).toBe(1);
    store.set("tomori", makeImpression({ characterId: "anon" }));
    expect(store.size).toBe(2);
  });
});

// ── C4 疑惑槽节流（DESIGN-revival §3 C4）──

describe("C4 疑惑槽节流", () => {
  it("新疑惑首登记不注回（minCount=2），挺过一次印象更新仍未解才注回", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression()); // unresolved 首登记 → 计数 1
    let text = store.formatForPrompt("mutsumi", "sakiko", { unresolvedMinCount: 2 })!;
    expect(text).not.toContain("她为什么来这个小镇");

    // 又一次印象更新（疑惑没被新提出但也没解开）→ 计数 2 → 注回
    store.merge("mutsumi", makeImpression({ unresolved: [], lastUpdated: 200 }));
    text = store.formatForPrompt("mutsumi", "sakiko", { unresolvedMinCount: 2 })!;
    expect(text).toContain("她为什么来这个小镇");
  });

  it("默认不传 minCount = 不节流（off 档治愈系基线行为不变）", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression());
    expect(store.formatForPrompt("mutsumi", "sakiko")).toContain("她为什么来这个小镇");
  });

  it("filterMatureUnresolved：缺计数的条目视为已成熟（旧档兼容）", () => {
    const imp: CharacterImpression = {
      characterId: "sakiko", summary: "旧档印象", observations: [], mentalLabel: "旧",
      unresolved: ["旧疑惑"], lastUpdated: 10, // 无 unresolvedCounts（旧档直灌）
    };
    expect(filterMatureUnresolved(imp, 2)).toEqual(["旧疑惑"]);
  });

  it("疑惑被 FIFO 挤出时计数一并清掉（Record 不泄漏）", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression({ unresolved: ["q1", "q2", "q3"] }));
    store.merge("mutsumi", makeImpression({ unresolved: ["q4", "q5"], lastUpdated: 200 }));

    const imp = store.get("mutsumi", "sakiko")!;
    expect(imp.unresolved).toEqual(["q3", "q4", "q5"]);
    expect(Object.keys(imp.unresolvedCounts!).sort()).toEqual(["q3", "q4", "q5"]);
    // 存量 q3 挺过一次更新 = 2；新登记 q4/q5 = 1
    expect(imp.unresolvedCounts!["q3"]).toBe(2);
    expect(imp.unresolvedCounts!["q4"]).toBe(1);
    expect(imp.unresolvedCounts!["q5"]).toBe(1);
  });

  it("计数随多次 merge 单调递增（长期未解的疑惑保持成熟）", () => {
    const store = new ImpressionStore();
    store.set("mutsumi", makeImpression());
    store.merge("mutsumi", makeImpression({ unresolved: [], lastUpdated: 200 }));
    store.merge("mutsumi", makeImpression({ unresolved: [], lastUpdated: 300 }));
    const imp = store.get("mutsumi", "sakiko")!;
    expect(imp.unresolvedCounts!["她为什么来这个小镇？"]).toBe(3);
  });
});
