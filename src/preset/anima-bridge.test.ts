import { describe, it, expect } from "vitest";
import { buildTavernRequest } from "./anima-bridge.js";
import type { ToolDefinition } from "../providers/types.js";

const tools: ToolDefinition[] = [
  { name: "talk", description: "说话", parameters: { type: "object", properties: {} } },
];

describe("Anima ↔ 酒馆桥接（S2）", () => {
  const req = buildTavernRequest({
    characterName: "L",
    characterDefinition: "你是 L，一个多疑的侦探。<<角色定义标记>>",
    worldSnapshot: "【此刻】咖啡馆，14:00，你有点饿。<<世界快照标记>>",
    tools,
    maxTokensCap: 512,
    prefill: "让我以L的视角思考：\n",
    kind: "decision",
    tag: "L",
  });

  it("system 留空，消息内联，用真实 TGbreak 预设做外壳", () => {
    expect(req.system).toBe("");
    expect(req.messages.length).toBeGreaterThanOrEqual(2);
    expect(req.messages.some((m) => m.content.includes("虚构文学"))).toBe(true);
  });

  it("角色定义在消息中、世界快照+输出契约殿后、prefill 收尾", () => {
    const joined = req.messages.map((m) => m.content).join("\n");
    expect(joined).toContain("<<角色定义标记>>");
    expect(joined).toContain("<<世界快照标记>>");
    expect(joined).toContain("输出契约"); // 契约重申已注入
    // merge 后处理下最后一条是 assistant prefill
    const last = req.messages[req.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("视角思考");
  });

  it("采样参数来自预设，maxTokens 被 cap 收住，工具透传", () => {
    expect(req.temperature).toBe(1); // TGbreak temperature
    expect(req.maxTokens).toBe(512); // min(65535, 512)
    expect(req.tools).toBe(tools);
    expect(req.kind).toBe("decision");
    expect(req.tag).toBe("L");
  });

  it("{{char}} 宏被替换（不残留）", () => {
    const joined = req.messages.map((m) => m.content).join("\n");
    expect(joined).not.toContain("{{char}}");
    expect(joined).not.toContain("{{user}}");
  });
});
