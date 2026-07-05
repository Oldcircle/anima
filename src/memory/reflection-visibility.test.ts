/**
 * 反思可见性回归测试（活人感体检 P2）
 *
 * 回归锁：反思曾存成 type:"thought"，被 formatForPrompt 的 thought 过滤器排除——
 * importance 9 的昨晚反思对检索重排不可见，几个决策 tick 后就从 prompt 消失。
 */

import { describe, it, expect } from "vitest";
import { ShortTermMemory } from "./short-term.js";

describe("反思在 prompt 记忆流中可见", () => {
  it("reflection 类型进入 formatForPrompt（thought 仍被过滤）", () => {
    const mem = new ShortTermMemory();
    mem.add("a", { tick: 92, type: "reflection", content: "[反思] 今天和B吵了架，心里不痛快", importance: 9 });
    mem.add("a", { tick: 93, type: "thought", content: "现在该干嘛呢", importance: 3 });
    for (let t = 94; t < 100; t++) {
      mem.add("a", { tick: t, type: "event", content: `做了琐事${t}`, importance: 3 });
    }

    const text = mem.formatForPrompt("a", 8, 100);
    expect(text).toContain("[反思]");
    expect(text).not.toContain("现在该干嘛呢");
  });

  it("重要性重排下反思挤掉琐事（大量琐事也冲不走）", () => {
    const mem = new ShortTermMemory();
    mem.add("a", { tick: 92, type: "reflection", content: "[反思] 关键的觉悟", importance: 9 });
    for (let t = 93; t < 120; t++) {
      mem.add("a", { tick: t, type: "event", content: `路过琐事第${t}号`, importance: 3 });
    }
    const text = mem.formatForPrompt("a", 6, 120);
    expect(text).toContain("关键的觉悟");
  });
});
