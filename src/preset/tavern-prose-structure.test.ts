import { describe, it, expect } from "vitest";
import { buildTavernRequest, generateTavernProse } from "./anima-bridge.js";

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

  it("无工具（纯正文）：场景在 chatHistory 位，预设殿后块压轴（ST 消息顺序对齐）", () => {
    const req = buildTavernRequest({ ...base, tools: [], prefill: undefined });
    const idxScene = req.messages.findIndex((m) => m.role === "user" && String(m.content).includes("继续写这场亲密"));
    expect(idxScene).toBeGreaterThanOrEqual(0);
    // TGbreak 的 668##### 收口块（"故事继续"）必须在场景之后——预设的催写机关压轴
    const after = req.messages.slice(idxScene + 1).map((m) => String(m.content ?? "")).join("\n");
    expect(after).toContain("故事继续");
  });

  it("无工具 + prefill：prefill 仍是最后一条 assistant 消息", () => {
    const req = buildTavernRequest({ ...base, tools: [] });
    const last = req.messages[req.messages.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(String(last.content)).toContain("好：");
  });

  it("有工具（决策）：保留原行为——注入'内心独白+调用工具、禁叙事正文'契约", () => {
    const tool = { name: "talk", description: "说话", parameters: { type: "object", properties: {} } };
    const req = buildTavernRequest({ ...base, tools: [tool as any] });
    const blob = JSON.stringify(req.messages);
    expect(blob).toContain("禁止输出任何叙事正文");
  });
});

describe("generateTavernProse 清洗后空重试", () => {
  it("首跑纯应答（清洗后空）→ 自动重试拿到正文，attempts=2", async () => {
    const replies = [
      "好的，作为苏苓，我会按照你的要求，以第一人称继续写下去。\n\n---\n\n<details><summary>摘要</summary>\n温存。\n</details>",
      "他掌心贴上来的时候，我吸了口气。",
    ];
    let call = 0;
    const chat = async () => ({ content: replies[call++], finishReason: "stop" });
    const r = await generateTavernProse(chat, { ...base, tools: [] });
    expect(r.attempts).toBe(2);
    expect(r.prose).toBe("他掌心贴上来的时候，我吸了口气。");
  });
  it("重试耗尽仍空 → prose 为空串诚实返回", async () => {
    const chat = async () => ({ content: "好的，作为苏苓，我会按照你的要求继续写。", finishReason: "stop" });
    const r = await generateTavernProse(chat, { ...base, tools: [] }, { retries: 1 });
    expect(r.attempts).toBe(2);
    expect(r.prose).toBe("");
  });
});
