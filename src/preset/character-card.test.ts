import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  loadCharacterCard,
  parseCharacterCard,
  cardToMarkers,
} from "./character-card.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERAPHINA = resolve(here, "../../reference/tavern-cards/Seraphina.png");

describe("角色卡兼容层（S2）", () => {
  it("读真实 ST PNG 角色卡（Seraphina，V3）", () => {
    const card = loadCharacterCard(SERAPHINA);
    expect(card.spec).toBe("chara_card_v3");
    expect(card.name).toBe("Seraphina");
    expect(card.description.length).toBeGreaterThan(1000);
    expect(card.description).toContain("caring");
    expect(card.first_mes.length).toBeGreaterThan(100);
  });

  it("兼容 V1 扁平卡", () => {
    const card = parseCharacterCard(
      JSON.stringify({
        name: "旧卡",
        description: "V1 描述",
        personality: "冷淡",
        scenario: "海边",
        first_mes: "……",
        mes_example: "<START>",
        creatorcomment: "备注",
      }),
    );
    expect(card.spec).toBe("v1");
    expect(card.description).toBe("V1 描述");
    expect(card.personality).toBe("冷淡");
    expect(card.creator_notes).toBe("备注");
  });

  it("兼容 V2 卡（data 块）", () => {
    const card = parseCharacterCard(
      JSON.stringify({
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "L",
          description: "侦探",
          post_history_instructions: "保持神秘",
          system_prompt: "你是侦探",
        },
      }),
    );
    expect(card.spec).toBe("chara_card_v2");
    expect(card.name).toBe("L");
    expect(card.description).toBe("侦探");
    expect(card.post_history_instructions).toBe("保持神秘");
    expect(card.system_prompt).toBe("你是侦探");
  });

  it("cardToMarkers 抽 marker 并替换 {{char}}", () => {
    const card = parseCharacterCard(
      JSON.stringify({ name: "L", description: "{{char}} 是个侦探", personality: "多疑" }),
    );
    const m = cardToMarkers(card);
    expect(m.charDescription).toBe("L 是个侦探");
    expect(m.charPersonality).toBe("多疑");
  });
});
