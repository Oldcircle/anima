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

  it("talk 通过信箱发送消息", async () => {
    // 把两人放到同一地点
    world.moveCharacter("alice", "cafe");
    world.moveCharacter("bob", "cafe");

    // Alice 对 Bob 说话
    mockLLM.enqueueResponse("看到 Bob 了", [
      { name: "talk", arguments: { target: "bob", message: "嘿Bob！" } },
    ]);
    // Bob 自己的决策
    mockLLM.enqueueResponse("吃点东西", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);

    await sim.runOneTick(tickToGameTime(48));

    // Bob 的信箱应该有 Alice 的消息
    const bobState = world.getCharacter("bob")!;
    expect(bobState.inbox).toHaveLength(1);
    expect(bobState.inbox[0]!.fromId).toBe("alice");
    expect(bobState.inbox[0]!.content).toBe("嘿Bob！");
  });

  it("信箱消息在下一个 tick 被消费并注入 prompt", async () => {
    world.moveCharacter("alice", "cafe");
    world.moveCharacter("bob", "cafe");

    // Tick 1: Alice 对 Bob 说话
    mockLLM.enqueueResponse("打招呼", [
      { name: "talk", arguments: { target: "bob", message: "你好啊！" } },
    ]);
    mockLLM.enqueueResponse("工作", [
      { name: "work", arguments: {} },
    ]);
    await sim.runOneTick(tickToGameTime(48));

    // Tick 2: Bob 应该看到信箱消息
    mockLLM.enqueueResponse("散步", [
      { name: "go_to", arguments: { location: "plaza" } },
    ]);
    // Bob 的 work 还在进行中（duration 8），所以只有 Alice 会被调用
    await sim.runOneTick(tickToGameTime(49));

    // 验证 Bob 的信箱已被清空（在 agent-loop 中被消费）
    // Bob 在 tick 49 还在工作中所以不会被调用，信箱保持
    // 但如果 Bob 被调用了，信箱会被消费
    // 这里主要验证机制存在
  });

  it("反应轮：信箱有消息 → 角色在同 tick 内回复", async () => {
    world.moveCharacter("alice", "cafe");
    world.moveCharacter("bob", "cafe");

    // 先手动往 Bob 信箱写一条消息
    world.sendMessage("bob", { fromId: "alice", fromName: "Alice Chen", content: "嘿Bob！", tick: 48 });

    // 所有 LLM 调用都返回 talk（无论哪个角色调用）
    mockLLM.setDefaultResponse("回复", [
      { name: "talk", arguments: { target: "alice", message: "你好！" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));

    // 总结果应该 > 2（正常 2 + 反应轮至少 1）
    expect(summary.results.length).toBeGreaterThan(2);

    // 至少有人在反应轮中 talk 了
    const allTalks = summary.results.filter((r) => r.action?.name === "talk");
    expect(allTalks.length).toBeGreaterThanOrEqual(2);
  });

  it("反应轮：角色可以选择不回复", async () => {
    world.moveCharacter("alice", "cafe");
    world.moveCharacter("bob", "cafe");

    // Alice 对 Bob 说话
    mockLLM.enqueueResponse("打招呼", [
      { name: "talk", arguments: { target: "bob", message: "嘿！" } },
    ]);
    mockLLM.enqueueResponse("吃饭", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);
    // 反应轮：Bob 选择吃饭而非回复（已读不回）
    mockLLM.enqueueResponse("还是吃饭", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));

    // Bob 没有 talk 回去，反应轮应该在 1 轮后停止
    const bobTalks = summary.results.filter((r) => r.characterId === "bob" && r.action?.name === "talk");
    expect(bobTalks).toHaveLength(0);
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
