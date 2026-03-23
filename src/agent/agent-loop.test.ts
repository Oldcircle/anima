import { describe, it, expect, beforeEach } from "vitest";
import { runAgentTick, type AgentConfig } from "./agent-loop.js";
import { TickEngine, tickToGameTime } from "../core/tick-engine.js";
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
  personality: {
    traits: ["温柔", "内向"],
    interests: ["园艺", "阅读"],
    dislikes: ["噪音"],
    speechStyle: "轻声细语",
  },
  background: "开了镇上唯一的花店",
  dailyRoutine: { "08:00": "开门营业", "12:00": "午餐", "18:00": "散步" },
  relationships: { bob: { level: 5, type: "friend" } },
};

describe("Agent Loop", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let config: AgentConfig;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("alice", "Alice Chen", "home_alice");
    world.addCharacter("bob", "Bob Wang", "cafe");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();
    config = {
      card: aliceCard,
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test-model",
    };
  });

  it("LLM 调用 eat 工具 → 更新饥饿值", async () => {
    mockLLM.enqueueResponse("肚子饿了，去咖啡馆吃午饭吧", [
      { name: "eat", arguments: { location: "cafe", food: "三明治" } },
    ]);

    const gameTime = tickToGameTime(48); // 中午 12:00
    const result = await runAgentTick({ config, world, eventBus, gameTime });

    expect(result.skipped).toBeFalsy();
    expect(result.action?.name).toBe("eat");
    expect(result.thought).toContain("肚子饿了");

    // 饥饿值应该增加了
    const alice = world.getCharacter("alice")!;
    expect(alice.needs.hunger).toBeGreaterThan(80); // 初始 80 + 50
  });

  it("LLM 调用 go_to → 移动角色", async () => {
    mockLLM.enqueueResponse("去咖啡馆坐坐", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);

    const result = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(result.action?.name).toBe("go_to");
    expect(world.getCharacter("alice")!.locationId).toBe("cafe");
  });

  it("多 tick 行为：sleep 持续多个 tick", async () => {
    mockLLM.enqueueResponse("太累了，该睡觉了", [
      { name: "sleep", arguments: {} },
    ]);

    // 第一个 tick：执行 sleep
    const r1 = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(92) });
    expect(r1.action?.name).toBe("sleep");
    expect(r1.result?.duration).toBe(32);

    // 第二个 tick：应该跳过（还在睡觉）
    const r2 = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(93) });
    expect(r2.skipped).toBe(true);
    expect(r2.skipReason).toContain("执行中");
  });

  it("LLM 失败时回退到日程兜底", async () => {
    // 不设置任何响应，让 mock 返回空 toolCalls
    mockLLM.setDefaultResponse("嗯...", []);

    const result = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });
    expect(result.skipped).toBe(true);
  });

  it("事件被广播到 EventBus", async () => {
    mockLLM.enqueueResponse("工作时间到了", [
      { name: "work", arguments: { activity: "整理花束" } },
    ]);

    const events: any[] = [];
    eventBus.on((e) => events.push(e));

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(32) });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("action.work");
    expect(events[0].description).toContain("Alice Chen");
  });

  it("talk 工具写入对方信箱并更新社交值", async () => {
    // 先把 alice 移到 cafe（bob 在那里）
    world.moveCharacter("alice", "cafe");

    mockLLM.enqueueResponse("看到 Bob 了，打个招呼", [
      { name: "talk", arguments: { target: "bob", message: "嘿 Bob！" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    // Alice 社交值增加
    expect(world.getCharacter("alice")!.needs.social).toBeGreaterThan(60); // 初始 60 + 5
    // Bob 信箱应有消息
    const bob = world.getCharacter("bob")!;
    expect(bob.inbox).toHaveLength(1);
    expect(bob.inbox[0]!.fromId).toBe("alice");
    expect(bob.inbox[0]!.fromName).toBe("Alice Chen");
    expect(bob.inbox[0]!.content).toBe("嘿 Bob！");
  });

  it("LLM 收到正确的 prompt 结构", async () => {
    mockLLM.enqueueResponse("想想...", [
      { name: "work", arguments: {} },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(32) });

    // 检查 LLM 收到的请求
    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    expect(req.system).toContain("Alice Chen");
    expect(req.system).toContain("花店老板");
    expect(req.messages[0]!.content).toContain("饥饿");
    expect(req.tools!.length).toBeGreaterThanOrEqual(5);
  });
});
