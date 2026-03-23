import { describe, it, expect, beforeEach } from "vitest";
import { runConversation, type ConversationResult } from "./conversation.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { World } from "../world/world.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const aliceCard: CharacterCard = {
  id: "alice",
  name: "Alice Chen",
  age: 28,
  occupation: "花店老板",
  home: "home_alice",
  personality: { traits: ["温柔"], interests: ["园艺"], dislikes: ["噪音"], speechStyle: "轻声细语" },
  background: "花店老板",
  dailyRoutine: {},
  relationships: { bob: { level: 5, type: "friend" } },
};

const bobCard: CharacterCard = {
  id: "bob",
  name: "Bob Wang",
  age: 35,
  occupation: "渔夫",
  home: "home_bob",
  personality: { traits: ["豪爽"], interests: ["钓鱼"], dislikes: ["早起"], speechStyle: "大大咧咧" },
  background: "渔夫",
  dailyRoutine: {},
  relationships: { alice: { level: 5, type: "friend" } },
};

describe("Conversation System", () => {
  let world: World;
  let mockLLM: MockLLMProvider;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("alice", "Alice Chen", "cafe");
    world.addCharacter("bob", "Bob Wang", "cafe");
    mockLLM = new MockLLMProvider();
  });

  it("基本对话流程：开场白 → 回复 → 接话", async () => {
    // Bob 回复 Alice
    mockLLM.enqueueResponse("哈哈，是啊！今天运气不错，钓了条大鱼！");
    // Alice 回复 Bob
    mockLLM.enqueueResponse("真厉害呀，像盛开的向日葵一样让人开心呢。");
    // Bob 再回复
    mockLLM.enqueueResponse("哈哈你总是这么会说话！下次请你吃鱼。[END]");

    const result = await runConversation({
      initiator: aliceCard,
      target: bobCard,
      intent: "打招呼",
      openingLine: "Bob！今天收获怎么样？",
      provider: mockLLM,
      modelId: "test",
      world,
      gameTime: tickToGameTime(48),
      maxTurns: 6,
    });

    expect(result.messages).toHaveLength(4); // 开场白 + 3 轮
    expect(result.messages[0]!.speakerName).toBe("Alice Chen");
    expect(result.messages[0]!.content).toBe("Bob！今天收获怎么样？");
    expect(result.messages[1]!.speakerName).toBe("Bob Wang");
    expect(result.messages[3]!.content).toContain("请你吃鱼");
  });

  it("[END] 标记终止对话", async () => {
    mockLLM.enqueueResponse("我先走了，回头见。[END]");

    const result = await runConversation({
      initiator: aliceCard,
      target: bobCard,
      intent: "告别",
      openingLine: "Bob，我要回去了",
      provider: mockLLM,
      modelId: "test",
      world,
      gameTime: tickToGameTime(72),
    });

    // 开场白 + 1 轮回复就结束了
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]!.content).not.toContain("[END]"); // [END] 应该被移除
  });

  it("更新双方社交需求", async () => {
    mockLLM.enqueueResponse("嗯嗯。[END]");

    const aliceBefore = world.getCharacter("alice")!.needs.social;
    const bobBefore = world.getCharacter("bob")!.needs.social;

    await runConversation({
      initiator: aliceCard,
      target: bobCard,
      intent: "聊天",
      openingLine: "你好",
      provider: mockLLM,
      modelId: "test",
      world,
      gameTime: tickToGameTime(48),
    });

    expect(world.getCharacter("alice")!.needs.social).toBeGreaterThan(aliceBefore);
    expect(world.getCharacter("bob")!.needs.social).toBeGreaterThan(bobBefore);
  });

  it("生成对话摘要", async () => {
    mockLLM.enqueueResponse("好啊！[END]");

    const result = await runConversation({
      initiator: aliceCard,
      target: bobCard,
      intent: "邀请喝咖啡",
      openingLine: "一起喝杯咖啡？",
      provider: mockLLM,
      modelId: "test",
      world,
      gameTime: tickToGameTime(48),
    });

    expect(result.summary).toContain("Alice Chen");
    expect(result.summary).toContain("Bob Wang");
    expect(result.summary).toContain("邀请喝咖啡");
  });
});
