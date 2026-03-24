import { describe, it, expect, beforeEach } from "vitest";
import { Simulation } from "./simulation.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const playerCard: CharacterCard = {
  id: "player",
  name: "旅人",
  age: 25,
  occupation: "冒险者",
  home: "home_player",
  personality: { traits: ["好奇"], interests: ["探索"], dislikes: [], speechStyle: "随和" },
  background: "刚来到小镇的旅人",
  relationships: {},
};

const tomoriCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多的场合"], speechStyle: "声音微弱" },
  background: "面包店学徒",
  relationships: {},
};

const LOCATIONS_WITH_PLAYER = [
  ...TEST_LOCATIONS,
  { id: "home_player", name: "旅人的住处", type: "residential" as const, presentCharacters: [] as string[] },
];

describe("Player System", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let sim: Simulation;

  beforeEach(() => {
    world = new World(LOCATIONS_WITH_PLAYER);
    world.addCharacter("player", "旅人", "home_player");
    world.addCharacter("tomori", "高松灯", "home_tomori");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();

    sim = new Simulation(world, eventBus, {
      characters: [playerCard, tomoriCard],
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test",
      playerId: "player",
    });
  });

  it("玩家有 CharacterState（位置、需求、金币）", () => {
    const state = world.getCharacter("player")!;
    expect(state).toBeDefined();
    expect(state.locationId).toBe("home_player");
    expect(state.gold).toBe(100);
    expect(state.needs.hunger).toBe(80);
  });

  it("玩家不调 LLM：tick 中只有 AI 角色决策", async () => {
    mockLLM.enqueueResponse("工作", [{ name: "work", arguments: { activity: "揉面团" } }]);

    const summary = await sim.runOneTick(tickToGameTime(32));
    // 只有 tomori 的结果，没有 player
    const charIds = summary.results.map((r) => r.characterId);
    expect(charIds).toContain("tomori");
    expect(charIds).not.toContain("player");
  });

  it("玩家需求随 tick 衰减", async () => {
    mockLLM.setDefaultResponse("", [{ name: "work", arguments: {} }]);
    const hungerBefore = world.getCharacter("player")!.needs.hunger;
    await sim.runOneTick(tickToGameTime(32));
    const hungerAfter = world.getCharacter("player")!.needs.hunger;
    expect(hungerAfter).toBeLessThan(hungerBefore);
  });

  it("executePlayerAction: go_to 移动玩家", async () => {
    const result = await sim.executePlayerAction("go_to", { location: "cafe" });
    expect(result).not.toBeNull();
    expect(result!.action!.name).toBe("go_to");
    expect(world.getCharacter("player")!.locationId).toBe("cafe");
  });

  it("executePlayerAction: eat 在家免费", async () => {
    const result = await sim.executePlayerAction("eat", { location: "home_player" });
    expect(result).not.toBeNull();
    expect(result!.result!.success).not.toBe(false);
    expect(world.getCharacter("player")!.needs.hunger).toBeGreaterThan(80);
  });

  it("executePlayerAction: talk 写入对方信箱", async () => {
    // 先把玩家和 tomori 移到同一地点
    world.moveCharacter("player", "cafe");
    world.moveCharacter("tomori", "cafe");

    const result = await sim.executePlayerAction("talk", { target: "tomori", message: "你好，灯！" });
    expect(result).not.toBeNull();
    expect(result!.action!.name).toBe("talk");

    // tomori 的信箱应该有玩家的消息
    const tomoriState = world.getCharacter("tomori")!;
    expect(tomoriState.inbox).toHaveLength(1);
    expect(tomoriState.inbox[0]!.content).toBe("你好，灯！");
    expect(tomoriState.inbox[0]!.fromId).toBe("player");
  });

  it("executePlayerAction: talk 产生关系变化", async () => {
    world.moveCharacter("player", "cafe");
    world.moveCharacter("tomori", "cafe");

    await sim.executePlayerAction("talk", { target: "tomori", message: "你好！" });

    const rels = sim.relationships.getRelationshipsOf("player");
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0]!.otherId).toBe("tomori");
  });

  it("executePlayerAction: sleep 约束（必须在家）", async () => {
    world.moveCharacter("player", "cafe");
    const result = await sim.executePlayerAction("sleep", {});
    expect(result!.result!.success).toBe(false);
  });

  it("executePlayerAction: 未知行为返回 null", async () => {
    const result = await sim.executePlayerAction("fly", {});
    expect(result).toBeNull();
  });

  it("AI 角色能看到玩家并反应", async () => {
    // 把两人放在同一地点
    world.moveCharacter("player", "cafe");
    world.moveCharacter("tomori", "cafe");

    // 玩家先说话
    await sim.executePlayerAction("talk", { target: "tomori", message: "你好！" });

    // 运行 tick，tomori 应该能看到玩家的信箱消息
    mockLLM.enqueueResponse("有人跟我打招呼", [{ name: "talk", arguments: { target: "player", message: "你、你好……旅人先生。" } }]);
    const summary = await sim.runOneTick(tickToGameTime(48));

    // tomori 应该回复了
    const tomoriResult = summary.results.find((r) => r.characterId === "tomori" && r.action?.name === "talk");
    expect(tomoriResult).toBeDefined();

    // 玩家信箱应该有 tomori 的回复
    const playerState = world.getCharacter("player")!;
    expect(playerState.inbox).toHaveLength(1);
    expect(playerState.inbox[0]!.fromId).toBe("tomori");
  });

  it("getPlayerActions 返回所有可用行为", () => {
    const actions = sim.getPlayerActions();
    expect(actions.length).toBeGreaterThan(5);
    expect(actions.find((a) => a.name === "go_to")).toBeDefined();
    expect(actions.find((a) => a.name === "talk")).toBeDefined();
    expect(actions.find((a) => a.name === "eat")).toBeDefined();
  });
});
