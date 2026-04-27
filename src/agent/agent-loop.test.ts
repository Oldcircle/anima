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
    // cook 需要食材
    const { addToInventory } = await import("../world/item-registry.js");
    addToInventory(world.getCharacter("tomori")!.inventory, "ingredients");

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

  it("LLM 调用 go_to 到不存在的地点 → 明确失败且位置不变", async () => {
    mockLLM.enqueueResponse("去厨房看看", [
      { name: "go_to", arguments: { location: "kitchen" } },
    ]);

    const result = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(result.action?.name).toBe("go_to");
    expect(result.result?.success).toBe(false);
    expect(result.result?.description).toContain("并没有这个地方");
    expect(world.getCharacter("tomori")!.locationId).toBe("home_tomori");
  });

  it("LLM 调用 go_to 去当前地点 → 明确提示已经在这里", async () => {
    mockLLM.enqueueResponse("还是去家里吧", [
      { name: "go_to", arguments: { location: "home_tomori" } },
    ]);

    const result = await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(result.action?.name).toBe("go_to");
    expect(result.result?.success).toBe(false);
    expect(result.result?.description).toContain("已经在");
    expect(world.getCharacter("tomori")!.locationId).toBe("home_tomori");
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

  it("收到消息但没有回复时，会留下 reply 意图", async () => {
    world.moveCharacter("tomori", "cafe");
    world.sendMessage("tomori", {
      fromId: "anon",
      fromName: "千早爱音",
      content: "等会要不要一起喝咖啡？",
      tick: 48,
    });

    mockLLM.enqueueResponse("我先去洗个手", [
      { name: "use_toilet", arguments: {} },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(world.getCurrentIntent("tomori", 48)?.kind).toBe("reply");
    expect(world.getCurrentIntent("tomori", 48)?.summary).toContain("你还没回应");
  });

  it("成功行动后会留下可观察状态", async () => {
    const { addToInventory } = await import("../world/item-registry.js");
    addToInventory(world.getCharacter("tomori")!.inventory, "ingredients");

    mockLLM.enqueueResponse("在家做饭吧", [
      { name: "cook", arguments: {} },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(world.getObservableState("tomori", 48)?.summary).toContain("做饭");
  });

  it("talk 的可观察状态会保留动作语气和话题片段", async () => {
    world.moveCharacter("tomori", "cafe");
    mockLLM.enqueueResponse("和爱音说两句", [
      { name: "talk", arguments: { target: "anon", message: "你今天看起来很累，要不要先坐一下？", manner: "轻轻拉了下袖口" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    const observable = world.getObservableState("tomori", 48);
    expect(observable?.summary).toContain("轻轻拉了下袖口");
    expect(observable?.summary).toContain("爱音");
    expect(observable?.summary).toContain("你今天看起来");
  });

  it("会把附近角色的细节型可观察状态注入 prompt", async () => {
    world.moveCharacter("tomori", "cafe");
    world.setObservableState("anon", {
      actionName: "rest",
      source: "action",
      summary: "安静地坐在窗边发呆，像是有心事。",
      createdTick: 48,
      expiresAt: 50,
    });

    mockLLM.enqueueResponse("先看看情况", [
      { name: "talk", arguments: { target: "anon", message: "还好吗？" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    expect(req.messages[0]!.content).toContain("安静地坐在窗边发呆");
  });

  it("give 会留下正在递东西的可观察状态", async () => {
    const { addToInventory } = await import("../world/item-registry.js");
    world.moveCharacter("tomori", "cafe");
    addToInventory(world.getCharacter("tomori")!.inventory, "notebook");

    mockLLM.enqueueResponse("把笔记本递过去", [
      { name: "give", arguments: { target: "anon", item: "笔记本" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(world.getObservableState("tomori", 48)?.summary).toContain("递给");
    expect(world.getObservableState("tomori", 48)?.summary).toContain("爱音");
  });

  it("talk cooldown no longer blocks — model decides", async () => {
    world.moveCharacter("tomori", "cafe");

    mockLLM.enqueueResponse("chat with anon", [
      { name: "talk", arguments: { target: "anon", message: "hello" } },
    ]);

    const result = await runAgentTick({
      config,
      world,
      eventBus,
      gameTime: tickToGameTime(48),
      talkCooldownTargets: ["anon"],
    });

    expect(result.action?.name).toBe("talk");
    expect(result.result?.success).not.toBe(false);
  });

  it("prompt 会注入当前短期意图", async () => {
    world.setIntent("tomori", {
      kind: "plan",
      source: "movement",
      summary: "刚到咖啡馆。先看看这里现在适合做什么。",
      createdTick: 48,
      expiresAt: 50,
    });

    mockLLM.enqueueResponse("去洗手间", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    expect(req.messages[0]!.content).toContain("你心里挂着的事");
    expect(req.messages[0]!.content).toContain("刚到咖啡馆");
  });

  it("LLM 收到正确的 prompt 结构", async () => {
    // 用永远可用的 do_nothing 避免触发 retry（旧版用了不存在的 hobby 而能依赖早退）
    mockLLM.enqueueResponse("想想...", [
      { name: "do_nothing", arguments: { thought: "" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(32) });

    // 检查 LLM 收到的请求（成功路径只调一次）
    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    expect(req.system).toContain("高松灯");
    expect(req.system).toContain("面包店学徒");
    expect(req.messages[0]!.content).toContain("你现在看到的");
    expect(req.tools!.length).toBeGreaterThanOrEqual(2); // 至少 go_to + do_nothing
  });

  it("有认识的人在场吃饭 → 社交修正自动生效，社交需求额外增加", async () => {
    const { RelationshipManager } = await import("../world/relationships.js");
    const relationships = new RelationshipManager();
    relationships.set("tomori", "anon", 25); // 认识的朋友

    world.moveCharacter("tomori", "cafe");
    // cafe 有 shop, eat 需要物品，用 addToInventory 给面包
    const { addToInventory } = await import("../world/item-registry.js");
    addToInventory(world.getCharacter("tomori")!.inventory, "sandwich");

    const tomori = world.getCharacter("tomori")!;
    const anon = world.getCharacter("anon")!;
    const tomoriSocialBefore = tomori.needs.social;
    const anonSocialBefore = anon.needs.social;

    mockLLM.enqueueResponse("和爱音一起吃个三明治", [
      { name: "eat", arguments: { item: "三明治" } },
    ]);

    const result = await runAgentTick({
      config, world, eventBus,
      gameTime: tickToGameTime(48),
      relationships,
    });

    expect(result.action?.name).toBe("eat");
    expect(result.result?.success).not.toBe(false);
    // 社交修正：tomori 的 social 应该比 eat 本身的效果更多
    expect(tomori.needs.social).toBeGreaterThan(tomoriSocialBefore);
    // anon 也应该得到社交增益
    expect(anon.needs.social).toBeGreaterThan(anonSocialBefore);
    // observableState 应该提到和爱音一起
    const observable = world.getObservableState("tomori", 48);
    expect(observable?.summary).toContain("爱音");
  });

  it("go_to 工具描述中包含各地点的在场人物", async () => {
    // anon 在 cafe，tomori 在家
    mockLLM.enqueueResponse("去咖啡馆找爱音", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });

    // 检查 LLM 收到的 go_to 工具参数里包含 "千早爱音"
    expect(mockLLM.calls).toHaveLength(1);
    const req = mockLLM.calls[0]!.request;
    const goToTool = req.tools!.find((t: any) => t.name === "go_to");
    expect(goToTool).toBeDefined();
    const locationDesc = goToTool!.parameters?.properties?.location?.description ?? "";
    expect(locationDesc).toContain("千早爱音");
  });
});
