/**
 * 反馈回路回归测试（活人感体检 P1）
 *
 * 锁住三条曾被剪断的因果线：
 * 1. relationship_change 效果真实生效（argue 伤关系、comfort 增关系）
 * 2. argue/comfort 的对象能感知（inbox 送达 + moodlet 落地）
 * 3. steal 是真实转移（受害者掉钱；被抓有后果而非静默失败）
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runAgentTick } from "./agent-loop.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { createTestWorld } from "../../test/helpers/test-world.js";
import { EventBus } from "../core/event-bus.js";
import { RelationshipManager } from "../world/relationships.js";
import { tickToGameTime } from "../core/tick-engine.js";
import type { CharacterCard } from "../character/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id,
    name,
    age: 19,
    occupation: "学徒",
    home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色",
    relationships: {},
  };
}

function setup() {
  const world = createTestWorld({ tick: 40 });
  world.addCharacter("tomori", "高松灯", "cafe");
  world.addCharacter("anon", "千早爱音", "cafe");
  const eventBus = new EventBus();
  const relationships = new RelationshipManager();
  const gameTime = tickToGameTime(40);
  return { world, eventBus, relationships, gameTime };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("反馈回路：argue", () => {
  it("argue 伤关系 + 对方收到 inbox + 双方 angry moodlet", async () => {
    const { world, eventBus, relationships, gameTime } = setup();
    // 让 argue 工具浮现：fun < 30
    world.getCharacter("tomori")!.needs.fun = 10;

    const provider = new MockLLMProvider();
    provider.enqueueResponse("受不了了", [
      { id: "c1", name: "argue", arguments: { target: "anon", reason: "她把我的东西弄乱了", words: "你到底有没有把别人的东西当回事？" } },
    ]);

    const result = await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus, gameTime, relationships,
    });

    expect(result.result?.success).not.toBe(false);
    // 关系真实下跌（不再是被丢弃的哑弹）
    expect(relationships.get("tomori", "anon").level).toBe(-15);
    // 对方收到了吵架的话（能进反应轮还嘴）
    const anon = world.getCharacter("anon")!;
    expect(anon.inbox.length).toBe(1);
    expect(anon.inbox[0]!.content).toContain("你到底有没有把别人的东西当回事");
    // 双方情绪落地
    expect(anon.moodlets.some((m) => m.emotion === "angry")).toBe(true);
    expect(world.getCharacter("tomori")!.moodlets.some((m) => m.emotion === "angry")).toBe(true);
  });
});

describe("反馈回路：comfort", () => {
  it("comfort 对方听到安慰的话 + 关系微升 + grateful moodlet", async () => {
    const { world, eventBus, relationships, gameTime } = setup();

    const provider = new MockLLMProvider();
    provider.enqueueResponse("她看起来很难过", [
      { id: "c1", name: "comfort", arguments: { target: "anon", words: "没事的，我陪着你" } },
    ]);

    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus, gameTime, relationships,
    });

    expect(relationships.get("tomori", "anon").level).toBe(3);
    const anon = world.getCharacter("anon")!;
    expect(anon.inbox.length).toBe(1);
    expect(anon.inbox[0]!.content).toContain("没事的，我陪着你");
    expect(anon.moodlets.some((m) => m.emotion === "grateful")).toBe(true);
  });
});

describe("反馈回路：steal", () => {
  it("偷成功 = 真实转移：受害者掉钱，小偷得钱", async () => {
    const { world, eventBus, relationships, gameTime } = setup();
    const tomori = world.getCharacter("tomori")!;
    const anon = world.getCharacter("anon")!;
    tomori.gold = 0;
    tomori.needs.hunger = 10; // steal 浮现条件
    anon.gold = 50;

    // Math.random 调用顺序：amount → caught → victim 选择
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.5)  // amount = 20 + floor(0.5*21) = 30
      .mockReturnValueOnce(0.9)  // caught = false
      .mockReturnValue(0.0);     // victim = 第一个

    const provider = new MockLLMProvider();
    provider.enqueueResponse("饿得不行了", [
      { id: "c1", name: "steal", arguments: {} },
    ]);

    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus, gameTime, relationships,
    });

    expect(tomori.gold).toBe(30);
    expect(anon.gold).toBe(20); // 50 - 30，钱守恒不再凭空铸造
  });

  it("偷被抓 = 有后果的事件：关系 -20 + 受害者 angry + 自己 embarrassed", async () => {
    const { world, eventBus, relationships, gameTime } = setup();
    const tomori = world.getCharacter("tomori")!;
    const anon = world.getCharacter("anon")!;
    tomori.gold = 0;
    tomori.needs.hunger = 10;
    anon.gold = 50;

    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.5)  // amount
      .mockReturnValueOnce(0.1)  // caught = true
      .mockReturnValue(0.0);     // victim

    const provider = new MockLLMProvider();
    provider.enqueueResponse("饿得不行了", [
      { id: "c1", name: "steal", arguments: {} },
    ]);

    const result = await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus, gameTime, relationships,
    });

    // 被抓不是约束失败，是发生了的事——后果必须落地
    expect(result.result?.success).not.toBe(false);
    expect(relationships.get("tomori", "anon").level).toBe(-20);
    expect(anon.gold).toBe(50); // 没偷到
    expect(anon.inbox.length).toBe(1);
    expect(anon.moodlets.some((m) => m.emotion === "angry" && m.intensity === 5)).toBe(true);
    expect(tomori.moodlets.some((m) => m.emotion === "embarrassed")).toBe(true);
  });
});
