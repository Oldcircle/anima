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

  it("LLM 调用 cook 工具 → 更新饥饿值（在家做饭）", async () => {
    mockLLM.enqueueResponse("肚子饿了，在家做饭吧", [
      { name: "cook", arguments: {} },
    ]);

    const gameTime = tickToGameTime(48); // 中午 12:00
    const result = await runAgentTick({ config, world, eventBus, gameTime });

    expect(result.skipped).toBeFalsy();
    expect(result.action?.name).toBe("cook");
    expect(result.thought).toContain("肚子饿了");

    // 饥饿值应该增加了
    const tomori = world.getCharacter("tomori")!;
    expect(tomori.needs.hunger).toBeGreaterThan(80); // 初始 80 + cook效果
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
    mockLLM.enqueueResponse("去散个步", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);

    const events: any[] = [];
    eventBus.on((e) => events.push(e));

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(32) });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("action.go_to");
    expect(events[0].description).toContain("高松灯");
  });

  it("talk 工具写入对方信箱并更新社交值", async () => {
    // 把两人都移到 cafe
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

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
      { name: "hobby", arguments: {} },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(32) });

    // 检查 LLM 收到的请求
    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    expect(req.system).toContain("高松灯");
    expect(req.system).toContain("面包店学徒");
    expect(req.messages[0]!.content).toContain("你现在看到的");
    expect(req.tools!.length).toBeGreaterThanOrEqual(2); // 至少 go_to + hobby
  });
});
