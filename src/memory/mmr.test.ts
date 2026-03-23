import { describe, it, expect } from "vitest";
import { tokenize, jaccardSimilarity, mmrRerank, textSimilarity } from "./mmr.js";

describe("tokenize", () => {
  it("提取小写 token", () => {
    const tokens = tokenize("Hello World 123");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("123");
  });

  it("支持中文", () => {
    const tokens = tokenize("Alice 在咖啡馆聊天");
    expect(tokens.size).toBeGreaterThan(0);
    expect(tokens).toContain("alice");
  });
});

describe("jaccardSimilarity", () => {
  it("相同集合 → 1", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("无交集 → 0", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("部分重叠", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  it("两个空集 → 1", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });
});

describe("mmrRerank", () => {
  it("disabled 时返回原序", () => {
    const items = [
      { id: "a", score: 0.9, content: "hello world" },
      { id: "b", score: 0.8, content: "hello there" },
    ];
    const result = mmrRerank(items, { enabled: false });
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("enabled 时平衡相关性和多样性", () => {
    const items = [
      { id: "a", score: 0.95, content: "alice went to the cafe" },
      { id: "b", score: 0.90, content: "alice went to the cafe for coffee" },
      { id: "c", score: 0.85, content: "bob was fishing at the beach" },
    ];
    const result = mmrRerank(items, { enabled: true, lambda: 0.5 });

    // a 和 b 高度相似，c 很不同
    // 第一个应该是 a（最高分），第二个应该是 c（多样性）
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("c");
  });

  it("lambda=1 时按分数排序", () => {
    const items = [
      { id: "c", score: 0.7, content: "x" },
      { id: "a", score: 0.9, content: "y" },
      { id: "b", score: 0.8, content: "z" },
    ];
    const result = mmrRerank(items, { enabled: true, lambda: 1 });
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
