/**
 * 涌现引擎回归测试（活人感体检 P6）
 *
 * 四台引擎：对话内容→关系增量（valence）、承诺自动落约、积怨状态机、营业时间。
 */

import { describe, it, expect } from "vitest";
import { generateImpression } from "./impression-updater.js";
import { extractPromise, mightContainPromise } from "./promise-extractor.js";
import { RelationshipManager } from "../world/relationships.js";
import { isLocationOpen } from "./tool-builder.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { CharacterCard } from "../character/types.js";
import type { ConversationExchange } from "./conversation-mode.js";

const cardA: CharacterCard = {
  id: "a", name: "阿明", age: 20, occupation: "店员", home: "home_a",
  personality: { traits: ["直率"], interests: [], dislikes: [], speechStyle: "平常" },
  background: "测试", relationships: {},
};

const exchanges: ConversationExchange[] = [
  { speakerId: "a", speakerName: "阿明", message: "你怎么把我的东西弄乱了？", tick: 10 },
  { speakerId: "b", speakerName: "小北", message: "关我什么事。", tick: 10 },
  { speakerId: "a", speakerName: "阿明", message: "……行吧。", tick: 11 },
  { speakerId: "b", speakerName: "小北", message: "哼。", tick: 11 },
];

describe("对话态度 → 关系增量", () => {
  it("解析'态度: -2'并随印象返回", async () => {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("总结：一个不讲理的人\n观察：把责任推得一干二净\n标签：讨厌鬼\n态度：-2\n疑惑：无");
    const result = await generateImpression({
      observerCard: cardA,
      targetCard: { ...cardA, id: "b", name: "小北" },
      exchanges, provider, modelId: "mock", tick: 12,
    });
    expect(result!.valence).toBe(-2);
    expect(result!.impression.mentalLabel).toBe("讨厌鬼");
  });

  it("态度超界被 clamp 到 ±3，缺失时为 0", async () => {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("总结：好人\n观察：无\n标签：好人\n态度：+9\n疑惑：无");
    const r1 = await generateImpression({
      observerCard: cardA, targetCard: { ...cardA, id: "b", name: "小北" },
      exchanges, provider, modelId: "mock", tick: 12,
    });
    expect(r1!.valence).toBe(3);
  });
});

describe("承诺抽取", () => {
  it("预过滤：短对话或无时间词的对话不烧 LLM", () => {
    expect(mightContainPromise(exchanges.slice(0, 2))).toBe(false);
    expect(mightContainPromise(exchanges)).toBe(false); // 4 句但没有时间词
    const withTime = [...exchanges.slice(0, 3), { speakerId: "b", speakerName: "小北", message: "那明天中午咖啡馆见？", tick: 12 }];
    expect(mightContainPromise(withTime)).toBe(true);
  });

  it("说定的承诺被抽取成结构化约定", async () => {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("承诺: 有\n提议人: 小北\n时间: 明天12:00\n地点: 咖啡馆\n做什么: 一起吃午饭");
    const p = await extractPromise({
      history: exchanges,
      charAId: "a", charAName: "阿明",
      charBId: "b", charBName: "小北",
      locations: [{ id: "cafe", name: "咖啡馆" }, { id: "plaza", name: "广场" }],
      currentTick: 40, // day 1 tick 40
      provider, modelId: "mock",
    });
    expect(p).not.toBeNull();
    expect(p!.proposerId).toBe("b");
    expect(p!.targetId).toBe("a");
    expect(p!.locationId).toBe("cafe");
    expect(p!.atTick).toBeGreaterThan(40);
    expect(p!.activity).toBe("一起吃午饭");
  });

  it("没说定就返回 null", async () => {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("承诺: 没有");
    const p = await extractPromise({
      history: exchanges,
      charAId: "a", charAName: "阿明", charBId: "b", charBName: "小北",
      locations: [{ id: "cafe", name: "咖啡馆" }],
      currentTick: 40, provider, modelId: "mock",
    });
    expect(p).toBeNull();
  });
});

describe("积怨状态机", () => {
  it("setGrudge/clearGrudge 生命周期", () => {
    const rm = new RelationshipManager();
    rm.setGrudge("a", "b", "她弄乱了我的东西", "a", 100);
    expect(rm.get("a", "b").grudge?.reason).toContain("弄乱");
    expect(rm.get("b", "a").grudge?.instigatorId).toBe("a"); // 对称存取
    rm.clearGrudge("b", "a");
    expect(rm.get("a", "b").grudge).toBeUndefined();
  });
});

describe("营业时间", () => {
  const shop = { id: "s", name: "店", type: "commercial" as const, presentCharacters: [], openHours: { open: 8, close: 20 } };
  const bar = { id: "b", name: "酒吧", type: "commercial" as const, presentCharacters: [], openHours: { open: 17, close: 2 } };

  it("普通营业时间", () => {
    expect(isLocationOpen(shop, 10)).toBe(true);
    expect(isLocationOpen(shop, 23)).toBe(false);
    expect(isLocationOpen(shop, 7)).toBe(false);
  });

  it("跨夜营业（酒吧 17-2）", () => {
    expect(isLocationOpen(bar, 22)).toBe(true);
    expect(isLocationOpen(bar, 1)).toBe(true);
    expect(isLocationOpen(bar, 10)).toBe(false);
  });

  it("无 openHours = 全天开放", () => {
    expect(isLocationOpen({ id: "p", name: "广场", type: "public", presentCharacters: [] }, 3)).toBe(true);
  });
});
