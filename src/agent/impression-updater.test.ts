import { describe, expect, it } from "vitest";
import { generateImpression } from "./impression-updater.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { CharacterCard } from "../character/types.js";
import type { ConversationExchange } from "./conversation-mode.js";
import type { LLMProvider } from "../providers/types.js";

const mutsumi: CharacterCard = {
  id: "mutsumi",
  name: "要乐奏",
  age: 19,
  occupation: "杂货店帮工",
  personality: {
    traits: ["温和"],
    interests: ["吉他"],
    dislikes: ["争吵"],
    speechStyle: "温柔平稳",
  },
  background: "乐器店老板的女儿",
  relationships: {},
};

const sakiko: CharacterCard = {
  id: "sakiko",
  name: "丰川祥子",
  age: 19,
  occupation: "咖啡馆店员",
  personality: {
    traits: ["克制"],
    interests: ["音乐"],
    dislikes: ["失礼"],
    speechStyle: "克制礼貌",
  },
  background: "在咖啡馆兼职",
  relationships: {},
};

const exchanges: ConversationExchange[] = [
  { speakerId: "mutsumi", speakerName: "要乐奏", message: "你好呀！", tick: 10 },
  { speakerId: "sakiko", speakerName: "丰川祥子", message: "请多关照。", tick: 10 },
  { speakerId: "mutsumi", speakerName: "要乐奏", message: "你看起来有点紧张？", tick: 11 },
  { speakerId: "sakiko", speakerName: "丰川祥子", message: "...只是还不太习惯这里。", tick: 11 },
];

describe("impression-updater", () => {
  it("模型不按格式输出时会回退到启发式印象，避免丢失结果", async () => {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("她礼貌而克制，说话一直留着分寸。", []);

    const impression = await generateImpression({
      observerCard: mutsumi,
      targetCard: sakiko,
      exchanges,
      provider,
      modelId: "mock",
      tick: 12,
    });

    expect(impression).not.toBeNull();
    expect(impression!.impression.summary.length).toBeGreaterThan(0);
    expect(impression!.impression.mentalLabel.length).toBeGreaterThan(0);
    expect(impression!.valence).toBe(0);
  });

  it("模型调用失败时也会保留最低限度的印象连续性", async () => {
    const provider: LLMProvider = {
      id: "broken",
      async chat() {
        throw new Error("network");
      },
    };

    const impression = await generateImpression({
      observerCard: sakiko,
      targetCard: mutsumi,
      exchanges,
      provider,
      modelId: "broken",
      tick: 15,
    });

    expect(impression).not.toBeNull();
    expect(impression!.impression.summary).toContain("要乐奏");
  });
});
