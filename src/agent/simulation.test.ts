import { describe, it, expect, beforeEach } from "vitest";
import { Simulation, type SimulationConfig, type TickSummary } from "./simulation.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
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
  dailyRoutine: { "08:00": "营业", "12:00": "午餐" },
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
  dailyRoutine: { "05:00": "钓鱼", "12:00": "午餐" },
  relationships: { alice: { level: 5, type: "friend" } },
};

describe("Simulation", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let sim: Simulation;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("alice", "Alice Chen", "home_alice");
    world.addCharacter("bob", "Bob Wang", "home_bob");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();

    sim = new Simulation(world, eventBus, {
      characters: [aliceCard, bobCard],
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test",
    });
  });

  it("单 tick 运行两个角色", async () => {
    // Alice: 去咖啡馆
    mockLLM.enqueueResponse("去咖啡馆吧", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);
    // Bob: 去钓鱼
    mockLLM.enqueueResponse("去钓鱼", [
      { name: "go_to", arguments: { location: "beach" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(32));

    expect(summary.results).toHaveLength(2);
    expect(world.getCharacter("alice")!.locationId).toBe("cafe");
    expect(world.getCharacter("bob")!.locationId).toBe("beach");
  });

  it("需求衰减在每 tick 执行", async () => {
    mockLLM.setDefaultResponse("", []);

    const aliceBefore = { ...world.getCharacter("alice")!.needs };
    await sim.runOneTick(tickToGameTime(1));

    expect(world.getCharacter("alice")!.needs.hunger).toBe(aliceBefore.hunger - 2);
  });

  it("talk 触发对话系统", async () => {
    // 把两人放到同一地点
    world.moveCharacter("alice", "cafe");
    world.moveCharacter("bob", "cafe");

    // Alice 发起对话
    mockLLM.enqueueResponse("看到 Bob 了", [
      { name: "talk", arguments: { target: "bob", intent: "打招呼", opening_line: "嘿Bob！" } },
    ]);
    // Bob 自己的决策
    mockLLM.enqueueResponse("等等", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);
    // 对话中 Bob 的回复
    mockLLM.enqueueResponse("哈哈你好！[END]");

    const summary = await sim.runOneTick(tickToGameTime(48));

    expect(summary.conversations).toHaveLength(1);
    expect(summary.conversations[0]!.messages.length).toBeGreaterThanOrEqual(2);
    expect(summary.conversations[0]!.messages[0]!.content).toBe("嘿Bob！");
  });

  it("runTicks 运行多个 tick", async () => {
    mockLLM.setDefaultResponse("想想...", [
      { name: "work", arguments: {} },
    ]);

    const summaries = await sim.runTicks(3, 32);

    expect(summaries).toHaveLength(3);
    // 第一个 tick：两人都 work（8 tick duration）
    // 第二第三个 tick：跳过（还在工作中）
    expect(summaries[1]!.results.every((r) => r.skipped)).toBe(true);
  });

  it("onTick 监听器被调用", async () => {
    mockLLM.setDefaultResponse("", []);

    const ticks: number[] = [];
    sim.onTick((summary) => ticks.push(summary.tick));

    await sim.runTicks(3, 10);

    expect(ticks).toEqual([10, 11, 12]);
  });
});
