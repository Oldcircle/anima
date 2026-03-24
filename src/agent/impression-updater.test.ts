import { describe, expect, it } from "vitest";
import { generateImpression } from "./impression-updater.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { CharacterCard } from "../character/types.js";
import type { ConversationExchange } from "./conversation-mode.js";
import type { LLMProvider } from "../providers/types.js";

const maria: CharacterCard = {
  id: "maria",
  name: "Maria Lopez",
  age: 31,
  occupation: "面包店老板",
  personality: {
    traits: ["热情"],
    interests: ["烘焙"],
    dislikes: ["冷场"],
    speechStyle: "热情洋溢",
  },
  background: "在镇上经营面包店",
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
  { speakerId: "maria", speakerName: "Maria Lopez", message: "你好呀！", tick: 10 },
  { speakerId: "sakiko", speakerName: "丰川祥子", message: "请多关照。", tick: 10 },
  { speakerId: "maria", speakerName: "Maria Lopez", message: "你看起来有点紧张？", tick: 11 },
  { speakerId: "sakiko", speakerName: "丰川祥子", message: "...只是还不太习惯这里。", tick: 11 },
];

describe("impression-updater", () => {
  it("模型不按格式输出时会回退到启发式印象，避免丢失结果", async () => {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("她礼貌而克制，说话一直留着分寸。", []);

    const impression = await generateImpression({
      observerCard: maria,
      targetCard: sakiko,
      exchanges,
      provider,
      modelId: "mock",
      tick: 12,
    });

    expect(impression).not.toBeNull();
    expect(impression!.summary.length).toBeGreaterThan(0);
    expect(impression!.mentalLabel.length).toBeGreaterThan(0);
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
      targetCard: maria,
      exchanges,
      provider,
      modelId: "broken",
      tick: 15,
    });

    expect(impression).not.toBeNull();
    expect(impression!.summary).toContain("Maria");
  });
});
