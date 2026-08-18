/**
 * Prompt Trace 形状单测。
 *
 * 锁三件最容易悄悄坏掉的事：
 * ①**前缀断点按字节**（中文一字 3 字节，按字符报位置会和缓存实际偏移对不上）
 * ②同 (kind,角色,模型) 才比前缀——不同角色的 prompt 本就该不同，混比会满屏假断点
 * ③观察层不弄坏被观察的东西：容量上限、长文本截断、坏输入不抛
 */

import { describe, it, expect } from "vitest";
import { PromptTraceStore, firstDivergence, MAX_TEXT_BYTES } from "./prompt-trace.js";
import type { LLMRequest, LLMResponse } from "./types.js";

function req(over: Partial<LLMRequest> = {}): LLMRequest {
  return {
    system: "你是一个镇民。",
    messages: [{ role: "user", content: "现在几点了" }],
    tools: [{ name: "go_to", description: "去别的地方", parameters: {} }],
    kind: "decision",
    tag: "asuka",
    ...over,
  };
}

function res(over: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "我想去咖啡馆。",
    toolCalls: [{ name: "go_to", arguments: { target: "cafe" } }],
    usage: { inputTokens: 1000, outputTokens: 50, cacheHitTokens: 700, cacheMissTokens: 300 },
    finishReason: "stop",
    ...over,
  };
}

describe("firstDivergence（按字节，不是按字符）", () => {
  it("完全相同 → -1；纯 ASCII 差异定位到位", () => {
    expect(firstDivergence("abc", "abc")).toBe(-1);
    expect(firstDivergence("abc", "abd")).toBe(2);
  });

  it("中文按字节报位置（同 UTF-8 前导字节还会再往后挪一格）", () => {
    // 甲/乙 首字节就不同 → 2 个汉字 × 3 字节 = 6
    expect(firstDivergence("镇民甲", "镇民乙")).toBe(6);
    // 好(E5 A5 BD)/坏(E5 9D 8F) 共享前导字节 E5 → 分歧在第 4 字节而非第 3
    expect(firstDivergence("你好", "你坏")).toBe(4);
  });

  it("前缀相同但一方更长 → 分歧在较短者末尾", () => {
    expect(firstDivergence("abc", "abcd")).toBe(3);
  });
});

describe("PromptTraceStore 记录与前缀断点", () => {
  it("记一次成功调用：usage/命中率/工具名/耗时都在", () => {
    const store = new PromptTraceStore(10);
    const rec = store.record({ request: req(), model: "deepseek-chat", durationMs: 1234.6, response: res() })!;
    expect(rec.kind).toBe("decision");
    expect(rec.tag).toBe("asuka");
    expect(rec.toolNames).toEqual(["go_to"]);
    expect(rec.durationMs).toBe(1235);
    expect(rec.cacheHitRate).toBeCloseTo(0.7);
    expect(rec.toolCalls[0]!.name).toBe("go_to");
  });

  it("首次调用不算断点；前缀逐字节一致 → identical", () => {
    const store = new PromptTraceStore(10);
    const first = store.record({ request: req(), model: "m", durationMs: 1, response: res() })!;
    expect(first.prefixBreak.comparedToId).toBeUndefined(); // 无前驱可比
    const second = store.record({
      request: req({ messages: [{ role: "user", content: "换个问题" }] }), // 只动 user，前缀不变
      model: "m", durationMs: 1, response: res(),
    })!;
    expect(second.prefixBreak.comparedToId).toBe(first.id);
    expect(second.prefixBreak.identical).toBe(true);
    expect(second.prefixBreak.atByte).toBe(-1);
    expect(store.stats().total.prefixBreaks).toBe(0);
  });

  it("动态内容回流进 system → 报出断点位置与所在段落", () => {
    const store = new PromptTraceStore(10);
    store.record({ request: req(), model: "m", durationMs: 1, response: res() });
    const broken = store.record({
      request: req({ system: "你是一个镇民。现在 08:15。" }), // 时间行回流前缀 = 典型事故
      model: "m", durationMs: 1, response: res(),
    })!;
    expect(broken.prefixBreak.identical).toBe(false);
    expect(broken.prefixBreak.section).toBe("system");
    expect(broken.prefixBreak.nextSnippet).toContain("08:15");
    expect(store.stats().total.prefixBreaks).toBe(1);
  });

  it("工具表抖动 → 断点落在 tools 段", () => {
    const store = new PromptTraceStore(10);
    store.record({ request: req(), model: "m", durationMs: 1, response: res() });
    const broken = store.record({
      request: req({ tools: [{ name: "go_to", description: "去别的地方（L 在图书馆）", parameters: {} }] }),
      model: "m", durationMs: 1, response: res(),
    })!;
    expect(broken.prefixBreak.section).toBe("tools");
  });

  it("只和同 (kind,角色,模型) 的上一条比——换角色不算断点", () => {
    const store = new PromptTraceStore(10);
    store.record({ request: req({ tag: "asuka" }), model: "m", durationMs: 1, response: res() });
    const other = store.record({
      request: req({ tag: "shinji", system: "你是碇真嗣。" }),
      model: "m", durationMs: 1, response: res(),
    })!;
    expect(other.prefixBreak.comparedToId).toBeUndefined();
    expect(store.stats().total.prefixBreaks).toBe(0);
  });

  it("失败调用也记（白丢的调用最需要被看见）", () => {
    const store = new PromptTraceStore(10);
    const rec = store.record({ request: req(), model: "m", durationMs: 30, error: "fetch failed" })!;
    expect(rec.error).toBe("fetch failed");
    expect(rec.usage).toBeUndefined();
    expect(store.list()[0]!.preview).toContain("fetch failed");
    expect(store.stats().total.errors).toBe(1);
  });
});

describe("PromptTraceStore 纪律", () => {
  it("环形缓冲不超容量，最旧先淘汰", () => {
    const store = new PromptTraceStore(3);
    for (let i = 0; i < 6; i++) {
      store.record({ request: req({ messages: [{ role: "user", content: `q${i}` }] }), model: "m", durationMs: 1, response: res() });
    }
    expect(store.size).toBe(3);
    expect(store.list().map((r) => r.seq)).toEqual([6, 5, 4]);
  });

  it("keep=0 整层关闭（长跑不想吃内存时）", () => {
    const store = new PromptTraceStore(0);
    expect(store.enabled).toBe(false);
    expect(store.record({ request: req(), model: "m", durationMs: 1, response: res() })).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("超长文本截断并标记（单条不吃穿内存）", () => {
    const store = new PromptTraceStore(5);
    const huge = "字".repeat(MAX_TEXT_BYTES); // 中文 3 字节/字，远超上限
    const rec = store.record({ request: req({ system: huge }), model: "m", durationMs: 1, response: res() })!;
    expect(rec.systemTruncated).toBe(true);
    expect(Buffer.byteLength(rec.system, "utf8")).toBeLessThan(MAX_TEXT_BYTES + 100);
  });

  it("坏输入不抛（观察层绝不弄坏被观察的东西）", () => {
    const store = new PromptTraceStore(5);
    expect(() =>
      store.record({ request: { system: "s", messages: null as never }, model: "m", durationMs: 1, response: res() }),
    ).not.toThrow();
  });

  it("stats 按 kind 分桶，命中率/错误/断点各自归位", () => {
    const store = new PromptTraceStore(20);
    store.record({ request: req({ kind: "decision" }), model: "m", durationMs: 10, response: res() });
    store.record({ request: req({ kind: "decision" }), model: "m", durationMs: 20, response: res() });
    store.record({
      request: req({ kind: "conversation", tag: "l" }), model: "m", durationMs: 30,
      response: res({ usage: { inputTokens: 500, outputTokens: 10, cacheHitTokens: 0 } }),
    });
    const { byKind, total, kinds, tags } = store.stats();
    expect(kinds).toEqual(["conversation", "decision"]);
    expect(tags).toEqual(["asuka", "l"]);
    const decision = byKind.find((b) => b.kind === "decision")!;
    expect(decision.calls).toBe(2);
    expect(decision.cacheHitRate).toBeCloseTo(0.7);
    expect(decision.avgDurationMs).toBe(15);
    expect(byKind.find((b) => b.kind === "conversation")!.cacheHitRate).toBe(0);
    expect(total.calls).toBe(3);
  });

  it("list 支持按 kind/角色过滤，clear 清空", () => {
    const store = new PromptTraceStore(20);
    store.record({ request: req({ kind: "decision", tag: "asuka" }), model: "m", durationMs: 1, response: res() });
    store.record({ request: req({ kind: "reflection", tag: "shinji" }), model: "m", durationMs: 1, response: res() });
    expect(store.list({ kind: "reflection" })).toHaveLength(1);
    expect(store.list({ tag: "asuka" })).toHaveLength(1);
    store.clear();
    expect(store.size).toBe(0);
  });
});
