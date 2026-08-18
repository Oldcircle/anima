/**
 * Prompt Routes 端到端 HTTP 测试：列表/统计/详情/清空。
 * 数据源是进程级单例 promptTrace，每个用例先 clear 保证互不串味。
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { registerPromptRoutes } from "./prompt-routes.js";
import { promptTrace } from "../providers/prompt-trace.js";
import type { LLMRequest, LLMResponse } from "../providers/types.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  registerPromptRoutes(app);
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const req = (over: Partial<LLMRequest> = {}): LLMRequest => ({
  system: "你是一个镇民。",
  messages: [{ role: "user", content: "现在几点" }],
  tools: [{ name: "go_to", description: "去别处", parameters: {} }],
  kind: "decision",
  tag: "asuka",
  ...over,
});

const res = (): LLMResponse => ({
  content: "去咖啡馆吧。",
  toolCalls: [{ name: "go_to", arguments: {} }],
  usage: { inputTokens: 800, outputTokens: 40, cacheHitTokens: 600 },
  finishReason: "stop",
});

beforeEach(() => {
  promptTrace.clear();
});

describe("prompt routes", () => {
  it("空缓冲：结构齐全、列表为空", async () => {
    await withServer(makeApp(), async (base) => {
      const body = await (await fetch(`${base}/api/prompts`)).json();
      expect(body.enabled).toBe(true);
      expect(body.items).toEqual([]);
      const stats = await (await fetch(`${base}/api/prompts/stats`)).json();
      expect(stats.total.calls).toBe(0);
      expect(stats.byKind).toEqual([]);
    });
  });

  it("列表按 kind/角色过滤；摘要不带长文本", async () => {
    promptTrace.record({ request: req(), model: "m", durationMs: 10, response: res() });
    promptTrace.record({ request: req({ kind: "reflection", tag: "shinji" }), model: "m", durationMs: 20, response: res() });

    await withServer(makeApp(), async (base) => {
      const all = await (await fetch(`${base}/api/prompts`)).json();
      expect(all.items).toHaveLength(2);
      expect(all.items[0].system).toBeUndefined(); // 摘要里没有 prompt 正文
      expect(all.items[0].preview).toContain("go_to");

      const filtered = await (await fetch(`${base}/api/prompts?kind=reflection`)).json();
      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0].tag).toBe("shinji");

      const byTag = await (await fetch(`${base}/api/prompts?tag=asuka`)).json();
      expect(byTag.items).toHaveLength(1);
    });
  });

  it("详情给完整请求体与前缀断点；未知 id → 404", async () => {
    promptTrace.record({ request: req(), model: "m", durationMs: 10, response: res() });
    // 时间行回流进 system = 典型缓存事故，详情里要能指出断在哪
    const broken = promptTrace.record({
      request: req({ system: "你是一个镇民。现在 08:15。" }), model: "m", durationMs: 10, response: res(),
    })!;

    await withServer(makeApp(), async (base) => {
      const detail = await (await fetch(`${base}/api/prompts/${broken.id}`)).json();
      expect(detail.system).toContain("08:15");
      expect(detail.toolsJson).toContain("go_to");
      expect(detail.messages[0].content).toBe("现在几点");
      expect(detail.prefixBreak.identical).toBe(false);
      expect(detail.prefixBreak.section).toBe("system");
      expect(detail.prefixBreak.atByte).toBeGreaterThan(0);

      const missing = await fetch(`${base}/api/prompts/p9999`);
      expect(missing.status).toBe(404);
    });
  });

  it("统计分桶 + DELETE 清空", async () => {
    promptTrace.record({ request: req(), model: "m", durationMs: 10, response: res() });
    promptTrace.record({ request: req({ kind: "conversation" }), model: "m", durationMs: 30, response: res() });

    await withServer(makeApp(), async (base) => {
      const stats = await (await fetch(`${base}/api/prompts/stats`)).json();
      expect(stats.total.calls).toBe(2);
      expect(stats.total.cacheHitRate).toBeCloseTo(0.75);
      expect(stats.kinds).toEqual(["conversation", "decision"]);

      const del = await (await fetch(`${base}/api/prompts`, { method: "DELETE" })).json();
      expect(del.ok).toBe(true);
      const after = await (await fetch(`${base}/api/prompts`)).json();
      expect(after.items).toEqual([]);
    });
  });
});
