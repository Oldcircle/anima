import { describe, it, expect } from "vitest";
import { buildTavernRequest } from "./anima-bridge.js";

const base = { characterName: "苏苓", characterDefinition: "你叫苏苓。", worldSnapshot: "此刻：卧室，继续写这场亲密。", prefill: "好：\n" };

describe("buildTavernRequest 纯正文 vs 决策 结构分叉", () => {
  it("无工具（纯正文）：场景走 user turn，且不注入决策契约（禁叙事正文）", () => {
    const req = buildTavernRequest({ ...base, tools: [] });
    const blob = JSON.stringify(req.messages);
    // 场景作为 user 请求出现
    const hasUserScene = req.messages.some((m) => m.role === "user" && String(m.content).includes("继续写这场亲密"));
    expect(hasUserScene).toBe(true);
    // 不含决策契约那条会掐死正文的指令
    expect(blob).not.toContain("禁止输出任何叙事正文");
    expect(blob).not.toContain("调用恰好一个工具");
  });

  it("有工具（决策）：保留原行为——注入'内心独白+调用工具、禁叙事正文'契约", () => {
    const tool = { name: "talk", description: "说话", parameters: { type: "object", properties: {} } };
    const req = buildTavernRequest({ ...base, tools: [tool as any] });
    const blob = JSON.stringify(req.messages);
    expect(blob).toContain("禁止输出任何叙事正文");
  });
});
