/**
 * 现实闭环批次回归测试
 *
 * ① 债务闭环：借钱落账 → 欠账挂心上（env 快照）→ 债主讨债 → 还钱销账
 * ② 店铺拉黑：偷店被抓 3 天拒绝服务，到期解禁
 * ③ 生病要治：着凉拖着每 tick 掉精力，吃药清病
 * ④ 食物腐坏：鲜货过保质期 06:00 被清 + 留记忆
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAgentTick } from "./agent-loop.js";
import { buildToolList, buildEnvironmentSnapshot } from "./tool-builder.js";
import { Simulation } from "./simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { RelationshipManager } from "../world/relationships.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { addToInventory, hasItem } from "../world/item-registry.js";
import type { CharacterCard } from "../character/types.js";
import type { ToolBuildContext } from "./tool-builder.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 19, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function makeWorld(at = "plaza"): World {
  const world = new World(TEST_LOCATIONS, 40);
  world.addCharacter("tomori", "高松灯", at);
  world.addCharacter("anon", "千早爱音", at);
  return world;
}

function makeSim(world: World): Simulation {
  return new Simulation(world, new EventBus(), {
    characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
    actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(),
    modelId: "test",
  });
}

function ctxFor(world: World, id: string, opts: { hour?: number; tick?: number } = {}): ToolBuildContext {
  const state = world.getCharacter(id)!;
  return {
    state, card: makeCard(id, state.name),
    location: world.getLocation(state.locationId)!,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId)
      .filter((c) => c !== id).map((c) => ({ id: c, name: world.getCharacter(c)!.name })),
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: opts.hour ?? 12,
    tick: opts.tick ?? 40,
    relationships: new RelationshipManager(),
    characterNames: new Map(world.getAllCharacters().map((c) => [c.id, c.name])),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("债务闭环", () => {
  async function borrowThen(world: World, relationships: RelationshipManager) {
    const provider = new MockLLMProvider();
    provider.enqueueResponse("开口借钱", [{ id: "c1", name: "borrow_money", arguments: { target: "anon", amount: 20 } }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40), relationships,
    });
  }

  it("借到钱 → 欠账成世界状态 + 环境快照挂心上", async () => {
    const world = makeWorld();
    const t = world.getCharacter("tomori")!;
    t.gold = 2;
    world.getCharacter("anon")!.gold = 100;
    const relationships = new RelationshipManager();
    relationships.set("tomori", "anon", 40);

    await borrowThen(world, relationships);

    expect(t.debts).toEqual([{ lenderId: "anon", amount: 20, borrowedTick: 40 }]);
    const snapshot = buildEnvironmentSnapshot(ctxFor(world, "tomori"));
    expect(snapshot).toContain("千早爱音的20金币");
    expect(snapshot).toContain("压在心上");
  });

  it("债主在场且钱够 → repay_debt 浮现；还钱销账+转账", async () => {
    const world = makeWorld();
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    t.gold = 50;
    a.gold = 30;
    t.debts = [{ lenderId: "anon", amount: 20, borrowedTick: 10 }];

    expect(buildToolList(ctxFor(world, "tomori")).map((x) => x.tool.name)).toContain("repay_debt");

    const provider = new MockLLMProvider();
    provider.enqueueResponse("把钱还上", [{ id: "c1", name: "repay_debt", arguments: { target: "anon" } }]);
    const result = await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
      relationships: new RelationshipManager(),
    });

    expect(t.gold).toBe(30);
    expect(a.gold).toBe(50);
    expect(t.debts).toEqual([]);
    expect(result.result?.description).toContain("石头落了地");
  });

  it("钱不够时 repay_debt 不浮现", () => {
    const world = makeWorld();
    const t = world.getCharacter("tomori")!;
    t.gold = 5;
    t.debts = [{ lenderId: "anon", amount: 20, borrowedTick: 10 }];
    expect(buildToolList(ctxFor(world, "tomori")).map((x) => x.tool.name)).not.toContain("repay_debt");
  });

  it("欠满 2 天撞见欠债人 → 债主起讨债念头（每天最多催一次）", () => {
    const world = makeWorld();
    const sim = makeSim(world);
    world.getCharacter("tomori")!.debts = [{ lenderId: "anon", amount: 20, borrowedTick: 40 }];

    (sim as any)._applyDebtCollection(tickToGameTime(100)); // 欠了不到 2 天
    expect(world.getCurrentIntent("anon", 100)).toBeUndefined();

    (sim as any)._applyDebtCollection(tickToGameTime(40 + 200));
    const intent = world.getCurrentIntent("anon", 240);
    expect(intent?.targetId).toBe("tomori");
    expect(intent?.summary).toContain("还没还");

    // 冷却：intent 过期后一天内不再催
    world.setIntent("anon", undefined);
    (sim as any)._applyDebtCollection(tickToGameTime(40 + 250));
    expect(world.getCurrentIntent("anon", 290)).toBeUndefined();
  });
});

describe("店铺拉黑", () => {
  it("偷店被抓 → 该店 3 天拒绝服务；到期 06:00 解禁", async () => {
    const world = makeWorld("shop");
    world.moveCharacter("anon", "plaza"); // 店里没别人 → 偷的是店
    const t = world.getCharacter("tomori")!;
    t.gold = 0;
    t.needs.hunger = 10;
    vi.spyOn(Math, "random").mockReturnValue(0.1); // caught < 0.4

    const provider = new MockLLMProvider();
    provider.enqueueResponse("饿疯了", [{ id: "c1", name: "steal", arguments: {} }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
      relationships: new RelationshipManager(),
    });

    const shop = world.getLocation("shop")!;
    expect(shop.bans?.tomori).toBe(40 + 288);

    // 拉黑期内 buy 被拒
    t.gold = 50;
    t.currentAction = undefined;
    const buy = buildToolList(ctxFor(world, "tomori", { tick: 100 })).find((x) => x.tool.name === "buy")!;
    const refused = buy.handler({ item: "便当" }, { characterId: "tomori", tick: 100, nearbyCharacters: [], gold: 50 } as any) as any;
    expect(refused.success).toBe(false);
    expect(refused.description).toContain("店主");

    // 到期后 06:00 清扫解禁
    const sim = makeSim(world);
    (sim as any)._applyDailyEnvironment(tickToGameTime(4 * 96 + 24)); // 解禁（328）之后的第一个 06:00
    expect(shop.bans?.tomori).toBeUndefined();
  });
});

describe("生病要治", () => {
  it("着凉拖着：比健康的同伴每 tick 多掉 1 精力", () => {
    const world = makeWorld("cafe"); // 室内，无露天气候扣减差异
    const sim = makeSim(world);
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    t.needs.energy = 80;
    a.needs.energy = 80;
    t.moodlets.push({ id: "m1", emotion: "sad", intensity: 4, reason: "着凉了，浑身发冷没劲", expiresAtTick: 999, source: "event" });

    (sim as any)._applyClimateAndMoodlets(tickToGameTime(48));

    expect(a.needs.energy! - t.needs.energy!).toBe(1);
  });

  it("有药且病着 → take_medicine 浮现；吃药清病耗药", async () => {
    const world = makeWorld();
    const t = world.getCharacter("tomori")!;
    t.moodlets.push({ id: "m1", emotion: "sad", intensity: 4, reason: "着凉了，浑身发冷没劲", expiresAtTick: 999, source: "event" });
    expect(buildToolList(ctxFor(world, "tomori")).map((x) => x.tool.name)).not.toContain("take_medicine"); // 没药

    addToInventory(t.inventory, "medicine", 1);
    expect(buildToolList(ctxFor(world, "tomori")).map((x) => x.tool.name)).toContain("take_medicine");

    const provider = new MockLLMProvider();
    provider.enqueueResponse("先把药吃了", [{ id: "c1", name: "take_medicine", arguments: {} }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
      relationships: new RelationshipManager(),
    });

    expect(t.moodlets.some((m) => m.reason.includes("着凉"))).toBe(false);
    expect(hasItem(t.inventory, "medicine")).toBe(false);
  });
});

describe("食物腐坏", () => {
  it("过保质期的鲜货 06:00 被清 + 留记忆；没过期和不腐坏的留着", () => {
    const world = makeWorld();
    const sim = makeSim(world);
    const t = world.getCharacter("tomori")!;
    addToInventory(t.inventory, "fresh_fish", 2, { obtainedTick: 0 });    // 保质 96，早馊了
    addToInventory(t.inventory, "bread_plain", 1, { obtainedTick: 150 }); // 保质 192，还新鲜
    addToInventory(t.inventory, "notebook", 1, { obtainedTick: 0 });      // 不腐坏

    (sim as any)._sweepSpoiledFood(tickToGameTime(200));

    expect(hasItem(t.inventory, "fresh_fish")).toBe(false);
    expect(hasItem(t.inventory, "bread_plain")).toBe(true);
    expect(hasItem(t.inventory, "notebook")).toBe(true);
    const mem = sim.memory.getRecent("tomori", 5).map((e) => e.content).join("");
    expect(mem).toContain("馊了");
    expect(mem).toContain("鲜鱼×2");
  });
});
