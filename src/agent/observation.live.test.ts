/**
 * 观察推理 Live 测试
 *
 * 用真实 LLM 验证：角色能观察并推理同地点其他人的行为。
 */

import { describe, it, expect } from "vitest";
import { config as loadEnv } from "dotenv";
loadEnv();

import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { generateObservation } from "./observation-reasoning.js";
import { ImpressionStore } from "../memory/impressions.js";
import { loadCharacterFromYAML } from "../character/loader.js";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "..", "..", "data", "characters");
const hasKey = !!process.env.DEEPSEEK_API_KEY;
const describeIf = hasKey ? describe : describe.skip;

const provider = new OpenAICompatibleProvider({
  id: "deepseek",
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  defaultModel: "deepseek-chat",
});

describeIf("观察推理 Live 测试", () => {
  it("Sakiko 观察 Emily 在咖啡馆看书", async () => {
    const sakiko = loadCharacterFromYAML(join(DATA_DIR, "sakiko.yml"));

    const result = await generateObservation(
      {
        observerCard: sakiko,
        observerState: {
          id: "sakiko", name: "丰川祥子", locationId: "cafe",
          needs: { hunger: 60, energy: 50, social: 40, happiness: 55, hygiene: 70 },
          gold: 80, inbox: [],
        },
        visibleCharacters: [
          { id: "emily", name: "Emily Liu", action: "在角落安静地看书，咖啡已经凉了", stayDuration: 8 },
        ],
        locationName: "咖啡馆",
        tick: 48,
      },
      provider,
      "deepseek-chat",
    );

    console.log("Sakiko 的观察推理:", result);

    expect(result).not.toBeNull();
    expect(result!.observerId).toBe("sakiko");
    expect(result!.targetId).toBe("emily");
    expect(result!.reasoning.length).toBeGreaterThan(4);
    console.log(`  推理: "${result!.reasoning}"`);
  }, 30_000);

  it("Maria 观察 Alice（有已有印象时推理更深入）", async () => {
    const maria = loadCharacterFromYAML(join(DATA_DIR, "maria.yml"));
    const impressions = new ImpressionStore();

    // 预设 Maria 对 Alice 的印象
    impressions.set("maria", {
      characterId: "alice",
      summary: "花店的温柔女孩，总是笑着但好像有点心事",
      observations: ["她有时候会发呆", "手指上经常有泥土"],
      mentalLabel: "让人心疼的邻居",
      unresolved: ["她为什么从城市搬来？"],
      lastUpdated: 30,
    });

    const result = await generateObservation(
      {
        observerCard: maria,
        observerState: {
          id: "maria", name: "Maria Lopez", locationId: "plaza",
          needs: { hunger: 70, energy: 60, social: 30, happiness: 55, hygiene: 65 },
          gold: 120, inbox: [],
        },
        visibleCharacters: [
          { id: "alice", name: "Alice Chen", action: "一个人坐在长椅上，手里攥着一封信发呆", stayDuration: 6 },
        ],
        locationName: "广场",
        tick: 52,
      },
      provider,
      "deepseek-chat",
      impressions,
    );

    console.log("Maria 的观察推理（有印象时）:", result);

    expect(result).not.toBeNull();
    expect(result!.reasoning.length).toBeGreaterThan(4);
    console.log(`  推理: "${result!.reasoning}"`);
  }, 30_000);
});
