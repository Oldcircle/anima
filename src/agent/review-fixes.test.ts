/**
 * 审查修复回归测试（活人感体检 · 对抗审查轮）
 *
 * 锁住 27 条审查发现里修掉的关键路径：
 * 力竭昏睡不乒乓、steal 严格守恒、库存全链、积怨冻结/和解/淡化、argue 边际递减。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runAgentTick } from "./agent-loop.js";
import { Simulation } from "./simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { createTestWorld, TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { RelationshipManager } from "../world/relationships.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import type { CharacterCard } from "../character/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 19, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function buildSim(tick = 40): { sim: Simulation; world: World } {
  const world = new World(TEST_LOCATIONS, tick);
  world.addCharacter("tomori", "高松灯", "cafe");
  world.addCharacter("anon", "千早爱音", "cafe");
  const sim = new Simulation(world, new EventBus(), {
    characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
    actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(),
    modelId: "test",
  });
  return { sim, world };
}

afterEach(() => vi.restoreAllMocks());

describe("力竭昏睡：不乒乓", () => {
  it("energy≤3 触发昏睡；昏睡中每 tick 回能量；不重复触发", () => {
    const { sim, world } = buildSim();
    const t = world.getCharacter("tomori")!;
    t.needs.energy = 2;
    const gt = tickToGameTime(40);

    (sim as any)._applyExhaustionCollapse(gt);
    expect(t.currentAction?.name).toBe("collapse_asleep");
    const memCount = sim.memory.getRecent("tomori", 20).length;

    // 下一 tick：还在昏睡 → 回能量，不再写第二份昏倒记忆
    (sim as any)._applyExhaustionCollapse(tickToGameTime(41));
    expect(t.needs.energy).toBeGreaterThan(2);
    expect(sim.memory.getRecent("tomori", 20).length).toBe(memCount);
  });

  it("昏睡叫不醒：inbox 消息不打断 collapse_asleep", async () => {
    const { world } = buildSim();
    const t = world.getCharacter("tomori")!;
    t.currentAction = { name: "collapse_asleep", remainingTicks: 5 };
    world.sendMessage("tomori", { fromId: "anon", fromName: "千早爱音", content: "喂，你还好吗？", tick: 40 });

    const provider = new MockLLMProvider();
    const result = await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("昏睡");
    expect(t.currentAction?.name).toBe("collapse_asleep"); // 没被清掉
    expect(t.inbox.length).toBe(1); // 消息留着，醒来再看
  });
});

describe("steal：严格守恒", () => {
  it("受害者掏不出全额时，小偷只进账掏得出的部分", async () => {
    const { world } = buildSim();
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    t.gold = 0; t.needs.hunger = 10;
    a.gold = 10; // 掏不出 30

    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.5)  // amount = 30
      .mockReturnValueOnce(0.9)  // 不被抓
      .mockReturnValue(0.0);

    const provider = new MockLLMProvider();
    provider.enqueueResponse("饿疯了", [{ id: "c1", name: "steal", arguments: {} }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
      relationships: new RelationshipManager(),
    });

    expect(t.gold).toBe(10); // 不是 30——严禁铸币
    expect(a.gold).toBe(0);
  });
});

describe("库存全链", () => {
  it("06:00 补货：有员工的店补足到 2；已追踪库存的店（被 prepare 过的杂货店）也补", () => {
    const { sim, world } = buildSim();
    const cafe = world.getLocation("cafe")!;
    const shop = world.getLocation("shop")!;
    cafe.workerTools = [{ name: "make_coffee", description: "做咖啡", effects: {}, income: 3 }];
    shop.stock = { ingredients: 0 }; // 无 workerTools 但已被追踪（曾被 prepare 毒化的场景）

    (sim as any)._applyDailyEnvironment(tickToGameTime(96 + 24)); // day2 06:00

    expect(cafe.stock!.coffee_latte).toBe(2);
    expect(shop.stock!.ingredients).toBe(2); // 不再永久缺货
  });

  it("补足到 2 而非覆盖：员工备到 5 的货不隔夜蒸发", () => {
    const { sim, world } = buildSim();
    const cafe = world.getLocation("cafe")!;
    cafe.workerTools = [{ name: "make_coffee", description: "做咖啡", effects: {}, income: 3 }];
    cafe.stock = { coffee_latte: 5 };
    (sim as any)._applyDailyEnvironment(tickToGameTime(96 + 24));
    expect(cafe.stock!.coffee_latte).toBe(5);
  });

  it("买到最后一件后库存为 0，执行时复检拦截超卖", async () => {
    const { world } = buildSim();
    const cafe = world.getLocation("cafe")!;
    cafe.stock = { sandwich: 1, coffee_latte: 2 };

    const provider = new MockLLMProvider();
    provider.enqueueResponse("买个三明治", [{ id: "c1", name: "buy", arguments: { item: "三明治" } }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(44), // 11:00 营业中
    });
    expect(cafe.stock!.sandwich).toBe(0);

    // 第二个人再买：执行时复检 → 失败而非复制售出
    const provider2 = new MockLLMProvider();
    provider2.enqueueResponse("我也买", [{ id: "c2", name: "buy", arguments: { item: "三明治" } }]);
    provider2.setDefaultResponse("算了", []);
    const r2 = await runAgentTick({
      config: { card: makeCard("anon", "千早爱音"), actions: [], provider: provider2, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(44),
    });
    // 卖完的物品不在工具表里 → 要么选不到（工具过滤），要么复检失败；两条路都不允许成交
    expect(cafe.stock!.sandwich).toBe(0);
    if (r2.action?.name === "buy" && (r2.action.args.item as string)?.includes("三明治")) {
      expect(r2.result?.success).toBe(false);
    }
  });
});

describe("积怨状态机运行时路径", () => {
  it("疙瘩期间 talk 的 flat+1 被冻结（主轮路径）", () => {
    const { sim } = buildSim();
    sim.relationships.setGrudge("tomori", "anon", "吵过架", "tomori", 30);
    const before = sim.relationships.get("tomori", "anon").level;
    (sim as any)._applyTalkEffects([
      { characterId: "tomori", action: { name: "talk", args: { target: "anon", message: "今天天气不错" } }, result: { success: true, description: "对anon说话", effects: [] }, thought: "" },
    ], tickToGameTime(40));
    expect(sim.relationships.get("tomori", "anon").level).toBe(before); // 没涨
  });

  it("肇事方道歉性 talk 解开疙瘩并 +3；受害者的'对不起'不解", () => {
    const { sim } = buildSim();
    sim.relationships.setGrudge("tomori", "anon", "吵过架", "tomori", 30);

    // 受害者 anon 习惯性道歉：不解
    (sim as any)._promoteConflictsToLongTerm([
      { characterId: "anon", action: { name: "talk", args: { target: "tomori", message: "对不起，我先走了" } }, result: { success: true, description: "", effects: [] }, thought: "" },
    ], tickToGameTime(40));
    expect(sim.relationships.get("tomori", "anon").grudge).toBeDefined();

    // 肇事方 tomori 道歉：解开
    (sim as any)._promoteConflictsToLongTerm([
      { characterId: "tomori", action: { name: "talk", args: { target: "anon", message: "那天是我不对，别生气了" } }, result: { success: true, description: "", effects: [] }, thought: "" },
    ], tickToGameTime(41));
    expect(sim.relationships.get("tomori", "anon").grudge).toBeUndefined();
    expect(sim.relationships.get("tomori", "anon").level).toBe(3);
  });

  it("结怨 2 tick 内不能秒解（同 tick 自吵自解拦截）", () => {
    const { sim } = buildSim();
    sim.relationships.setGrudge("tomori", "anon", "刚吵的", "tomori", 40);
    (sim as any)._promoteConflictsToLongTerm([
      { characterId: "tomori", action: { name: "talk", args: { target: "anon", message: "抱歉抱歉" } }, result: { success: true, description: "", effects: [] }, thought: "" },
    ], tickToGameTime(40));
    expect(sim.relationships.get("tomori", "anon").grudge).toBeDefined();
  });

  it("3 游戏天未解自然淡化", () => {
    const { sim } = buildSim();
    sim.relationships.setGrudge("tomori", "anon", "旧怨", "tomori", 40);
    (sim as any)._applyDailyEnvironment(tickToGameTime(4 * 96 + 24)); // day5 06:00，距结怨 368 tick > 288
    expect(sim.relationships.get("tomori", "anon").grudge).toBeUndefined();
  });

  it("疙瘩没解开时再次冲突，关系伤害减半（argue 边际递减）", async () => {
    const { world } = buildSim();
    const relationships = new RelationshipManager();
    relationships.setGrudge("tomori", "anon", "上次吵的", "tomori", 30);
    world.getCharacter("tomori")!.needs.fun = 10; // argue 浮现

    const provider = new MockLLMProvider();
    provider.enqueueResponse("又来了", [{ id: "c1", name: "argue", arguments: { target: "anon", reason: "旧事重提" } }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40), relationships,
    });
    expect(relationships.get("tomori", "anon").level).toBe(-7); // ceil(-15/2)，不是 -15
  });
});
