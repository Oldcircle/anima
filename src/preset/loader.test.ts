import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadTavernPreset, orderForCharacter } from "./loader.js";
import { TAVERN_MARKERS } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const PRESET = resolve(here, "../../reference/tavern-presets/TGbreak-v3.1.1.json");

describe("酒馆预设加载器（S0）", () => {
  const preset = loadTavernPreset(PRESET);

  it("吃真实 TGbreak 预设，结构完整", () => {
    expect(preset.name).toBe("TGbreak-v3.1.1");
    expect(preset.prompts.length).toBe(122);
    expect(preset.prompt_order.length).toBeGreaterThan(0);
  });

  it("采样参数照抄正确", () => {
    expect(preset.sampling.temperature).toBe(1);
    expect(preset.sampling.top_p).toBe(0.99);
    expect(preset.sampling.max_tokens).toBe(65535);
  });

  it("8 个 marker 占位符都在 prompts 里", () => {
    const ids = new Set(preset.prompts.filter((p) => p.marker).map((p) => p.identifier));
    for (const m of TAVERN_MARKERS) expect(ids.has(m)).toBe(true);
  });

  it("默认角色开关状态可取，且有启用项", () => {
    const order = orderForCharacter(preset);
    expect(order.order.length).toBe(113);
    expect(order.order.filter((e) => e.enabled).length).toBe(54);
  });

  it("main block 是有内容的 system 指令", () => {
    const main = preset.prompts.find((p) => p.identifier === "main");
    expect(main?.marker).toBe(false);
    expect(main?.role).toBe("system");
    expect(main?.content).toContain("虚构文学");
  });
});
