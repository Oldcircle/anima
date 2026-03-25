import { describe, it, expect, beforeEach } from "vitest";
import { runAgentTick, type AgentConfig } from "./agent-loop.js";
import { TickEngine, tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const tomoriCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: {
    traits: ["内向", "纯真"],
    interests: ["写东西", "捡石头"],
    dislikes: ["人多的场合"],
    speechStyle: "声音微弱，断断续续",
  },
  background: "从城市来的安静女孩，在面包店当学徒。",
  relationships: {},
};

describe("Agent Loop", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let config: AgentConfig;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "cafe");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();
    config = {
      card: tomoriCard,
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
    const tomori = world.getCharacter("tomori")!;
    expect(tomori.needs.hunger).toBeGreaterThan(80); // 初始 80 + 50
  });

  it("LLM 调用 go_to → 移动角色", async () => {
    mockLLM.enqueueResponse("去咖啡馆坐坐", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);

    const result = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(result.action?.name).toBe("go_to");
    expect(world.getCharacter("tomori")!.locationId).toBe("cafe");
  });

  it("多 tick 行为：sleep 持续多个 tick", async () => {
    // 先把精力降到 80 以下，否则 sleep 会被拒绝
    world.modifyNeed("tomori", "energy", -50);

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

  it("LLM 未调用工具时返回 skipped", async () => {
    mockLLM.setDefaultResponse("嗯...", []);

    const result = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("未调用工具");
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
    expect(events[0].description).toContain("高松灯");
  });

  it("talk 工具写入对方信箱并更新社交值", async () => {
    // 先把 tomori 移到 cafe（anon 在那里）
    world.moveCharacter("tomori", "cafe");

    mockLLM.enqueueResponse("看到爱音了，打个招呼", [
      { name: "talk", arguments: { target: "anon", message: "你、你好……" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    // Tomori 社交值增加
    expect(world.getCharacter("tomori")!.needs.social).toBeGreaterThan(60); // 初始 60 + 3
    // Anon 信箱应有消息
    const anon = world.getCharacter("anon")!;
    expect(anon.inbox).toHaveLength(1);
    expect(anon.inbox[0]!.fromId).toBe("tomori");
    expect(anon.inbox[0]!.fromName).toBe("高松灯");
    expect(anon.inbox[0]!.content).toBe("你、你好……");
  });

  it("LLM 收到正确的 prompt 结构", async () => {
    mockLLM.enqueueResponse("想想...", [
      { name: "work", arguments: {} },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(32) });

    // 检查 LLM 收到的请求
    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    expect(req.system).toContain("高松灯");
    expect(req.system).toContain("面包店学徒");
    expect(req.messages[0]!.content).toContain("饥饿");
    expect(req.tools!.length).toBeGreaterThanOrEqual(5);
  });
});
