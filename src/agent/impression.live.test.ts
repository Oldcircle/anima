/**
 * 印象系统 Live 测试
 *
 * 用真实 LLM 验证：
 * 1. generateImpression 能正确生成印象
 * 2. updateImpressionsBidirectional 双方印象都能生成
 * 3. ImpressionStore.formatForPrompt 输出可注入 prompt
 */

import { describe, it, expect } from "vitest";
import { config as loadEnv } from "dotenv";
loadEnv();

import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { ImpressionStore } from "../memory/impressions.js";
import { generateImpression, updateImpressionsBidirectional } from "./impression-updater.js";
import { loadCharacterFromYAML } from "../character/loader.js";
import { join } from "node:path";
import type { ConversationExchange } from "./conversation-mode.js";

const DATA_DIR = join(import.meta.dirname, "..", "..", "data", "characters");

// 跳过条件：没有 API key
const hasKey = !!process.env.DEEPSEEK_API_KEY;
const describeIf = hasKey ? describe : describe.skip;

const provider = new OpenAICompatibleProvider({
  id: "deepseek",
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  defaultModel: "deepseek-chat",
});

// 模拟一段 Mutsumi ↔ Sakiko 的对话
const testExchanges: ConversationExchange[] = [
  { speakerId: "mutsumi", speakerName: "要乐奏", message: "你好呀！你是新来的吗？我是奏，在杂货店帮忙的！", tick: 10 },
  { speakerId: "sakiko", speakerName: "丰川祥子", message: "日安。我是祥子，在咖啡馆兼职。请多关照。", tick: 10 },
  { speakerId: "mutsumi", speakerName: "要乐奏", message: "别这么客气嘛！你平时有什么爱好？", tick: 11 },
  { speakerId: "sakiko", speakerName: "丰川祥子", message: "...没什么特别的。只是做些普通的事。请容我先去工作了。", tick: 11 },
];

describeIf("印象系统 Live 测试", () => {
  it("generateImpression: Mutsumi 对 Sakiko 生成印象", async () => {
    const maria = loadCharacterFromYAML(join(DATA_DIR, "mutsumi.yml"));
    const sakiko = loadCharacterFromYAML(join(DATA_DIR, "sakiko.yml"));

    const impression = await generateImpression({
      observerCard: maria,
      targetCard: sakiko,
      exchanges: testExchanges,
      provider,
      modelId: "deepseek-chat",
      tick: 12,
    });

    console.log("Mutsumi 对 Sakiko 的印象:", JSON.stringify(impression, null, 2));

    expect(impression).not.toBeNull();
    expect(impression!.characterId).toBe("sakiko");
    expect(impression!.summary.length).toBeGreaterThan(0);
    expect(impression!.mentalLabel.length).toBeGreaterThan(0);
    expect(impression!.lastUpdated).toBe(12);
  }, 30_000);

  it("updateImpressionsBidirectional: 双方印象都写入 store", async () => {
    const maria = loadCharacterFromYAML(join(DATA_DIR, "mutsumi.yml"));
    const sakiko = loadCharacterFromYAML(join(DATA_DIR, "sakiko.yml"));
    const store = new ImpressionStore();

    await updateImpressionsBidirectional({
      cardA: maria,
      cardB: sakiko,
      exchanges: testExchanges,
      impressions: store,
      provider,
      modelId: "deepseek-chat",
      tick: 15,
    });

    // Mutsumi 对 Sakiko 的印象
    const mToS = store.get("mutsumi", "sakiko");
    console.log("\nMutsumi→Sakiko:", JSON.stringify(mToS, null, 2));
    expect(mToS).toBeDefined();
    expect(mToS!.summary.length).toBeGreaterThan(0);

    // Sakiko 对 Mutsumi 的印象
    const sToM = store.get("sakiko", "mutsumi");
    console.log("\nSakiko→Mutsumi:", JSON.stringify(sToM, null, 2));
    expect(sToM).toBeDefined();
    expect(sToM!.summary.length).toBeGreaterThan(0);

    // formatForPrompt 输出
    const promptText = store.formatForPrompt("mutsumi", "sakiko");
    console.log("\nPrompt 注入文本:\n", promptText);
    expect(promptText).toBeDefined();
    expect(promptText!).toContain("你");
  }, 30_000);
});
