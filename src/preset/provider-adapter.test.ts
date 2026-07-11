import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadTavernPreset } from "./loader.js";
import { assembleMessages } from "./assembler.js";
import { toRequestParts } from "./provider-adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const preset = loadTavernPreset(resolve(here, "../../reference/tavern-presets/TGbreak-v3.1.1.json"));

describe("provider 适配器（S2）", () => {
  const msgs = assembleMessages(preset, {
    markers: { charDescription: "L", chatHistory: [{ role: "user", content: "门开了" }] },
    macros: { user: "观察者" },
    postHistory: [{ role: "system", content: "请以工具调用决策" }],
  });

  it("system 留空，消息内联，顺序/角色保持", () => {
    const parts = toRequestParts(msgs, preset);
    expect(parts.system).toBe("");
    expect(parts.messages.length).toBe(msgs.length);
    expect(parts.messages[0].role).toBe("system");
    expect(parts.messages[parts.messages.length - 1]).toEqual({
      role: "system",
      content: "请以工具调用决策",
    });
  });

  it("采样参数从预设照抄", () => {
    const parts = toRequestParts(msgs, preset);
    expect(parts.temperature).toBe(1);
    expect(parts.topP).toBe(0.99);
    expect(parts.frequencyPenalty).toBe(0);
    expect(parts.presencePenalty).toBe(0);
    expect(parts.maxTokens).toBe(65535);
  });

  it("maxTokensCap 生效", () => {
    expect(toRequestParts(msgs, preset, { maxTokensCap: 4096 }).maxTokens).toBe(4096);
  });
});
