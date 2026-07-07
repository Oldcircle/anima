/**
 * argue 机械兜底回归测试（下行通路最后一环）
 *
 * 7 天基线：argue=0、grudge=0——门开着（P4）、许可给了（破线），模型仍不走。
 * 兜底：疙瘩落账 + 撞见对方 → 注入"把话挑明"intent。只配时机与注意力，不写结果。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Simulation } from "./simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { setBreakLevel } from "./break-config.js";
import type { CharacterCard } from "../character/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 19, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function setFrictions(sim: Simulation, observer: string, target: string, frictions: string[]): void {
  sim.impressions.set(observer, {
    characterId: target, summary: "总踩我雷的人", observations: [], mentalLabel: "让人来气",
    unresolved: [], frictions, lastUpdated: 40,
  });
}

describe("argue 机械兜底", () => {
  let world: World;
  let sim: Simulation;

  beforeEach(() => {
    setBreakLevel("mild");
    world = new World(TEST_LOCATIONS, 40);
    world.addCharacter("tomori", "高松灯", "cafe");
    world.addCharacter("anon", "千早爱音", "cafe");
    sim = new Simulation(world, new EventBus(), {
      characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
  });

  afterEach(() => setBreakLevel(undefined));

  it("疙瘩攒满 3 条 + 同地点 → 注入挑明 intent", () => {
    setFrictions(sim, "tomori", "anon", ["第一次放我鸽子", "又抢我话头", "第三次说话夹枪带棒"]);

    (sim as any)._applyConfrontationFallback(tickToGameTime(40));

    const intent = world.getCurrentIntent("tomori", 40);
    expect(intent?.targetId).toBe("anon");
    expect(intent?.summary).toContain("挑明");
    expect(intent?.summary).toContain("夹枪带棒"); // 引用最新一条疙瘩
  });

  it("疙瘩 2 条 + 关系已跌负（≤-10）→ 也触发", () => {
    setFrictions(sim, "tomori", "anon", ["说好的事没做到", "背后说我闲话"]);
    sim.relationships.set("tomori", "anon", -15);

    (sim as any)._applyConfrontationFallback(tickToGameTime(40));

    expect(world.getCurrentIntent("tomori", 40)?.targetId).toBe("anon");
  });

  it("疙瘩 2 条但关系没负 → 还没到火候，不触发", () => {
    setFrictions(sim, "tomori", "anon", ["说好的事没做到", "背后说我闲话"]);
    sim.relationships.set("tomori", "anon", 20);

    (sim as any)._applyConfrontationFallback(tickToGameTime(40));

    expect(world.getCurrentIntent("tomori", 40)).toBeUndefined();
  });

  it("off 档完全不启用（A/B 基线）", () => {
    setBreakLevel("off");
    setFrictions(sim, "tomori", "anon", ["一", "二", "三"]);

    (sim as any)._applyConfrontationFallback(tickToGameTime(40));

    expect(world.getCurrentIntent("tomori", 40)).toBeUndefined();
  });

  it("不同地点不触发；已有 grudge 交给积怨状态机不重复驱动", () => {
    setFrictions(sim, "tomori", "anon", ["一", "二", "三"]);
    world.moveCharacter("anon", "beach");
    (sim as any)._applyConfrontationFallback(tickToGameTime(40));
    expect(world.getCurrentIntent("tomori", 40)).toBeUndefined();

    world.moveCharacter("anon", "cafe");
    const rel = sim.relationships.get("tomori", "anon");
    rel.grudge = { reason: "上次吵的", instigatorId: "anon", sinceTick: 30 };
    (sim as any)._applyConfrontationFallback(tickToGameTime(40));
    expect(world.getCurrentIntent("tomori", 40)).toBeUndefined();
  });

  it("挑明 intent 生效期间 argue 上菜单（7 天实测：21 次 nudge 时 argue 全不在菜单）", async () => {
    const { buildToolList } = await import("./tool-builder.js");
    setFrictions(sim, "tomori", "anon", ["一", "二", "三"]);
    (sim as any)._applyConfrontationFallback(tickToGameTime(40)); // 注入挑明 intent

    const state = world.getCharacter("tomori")!;
    const tools = buildToolList({
      state, card: makeCard("tomori", "高松灯"),
      location: world.getLocation("cafe")!,
      nearbyCharacters: [{ id: "anon", name: "千早爱音" }],
      allLocations: world.getAllLocations(),
      gold: state.gold, tick: 40,
      relationships: sim.relationships, // level=0 非负、无 grudge——旧摩擦门全不认
    });
    expect(tools.map((t) => t.tool.name)).toContain("argue");

    // intent 过期后不再因此浮现
    const toolsLater = buildToolList({
      state, card: makeCard("tomori", "高松灯"),
      location: world.getLocation("cafe")!,
      nearbyCharacters: [{ id: "anon", name: "千早爱音" }],
      allLocations: world.getAllLocations(),
      gold: state.gold, tick: 60,
      relationships: sim.relationships,
    });
    expect(toolsLater.map((t) => t.tool.name)).not.toContain("argue");
  });

  it("冷却：同一对半个游戏天内不重复催", () => {
    setFrictions(sim, "tomori", "anon", ["一", "二", "三"]);

    (sim as any)._applyConfrontationFallback(tickToGameTime(40));
    expect(world.getCurrentIntent("tomori", 40)).toBeDefined();

    // intent 过期后（expiresAt +6）、冷却窗（48）内再遇 → 不再注入
    world.setIntent("tomori", undefined);
    (sim as any)._applyConfrontationFallback(tickToGameTime(60));
    expect(world.getCurrentIntent("tomori", 60)).toBeUndefined();

    // 冷却窗过后可以再催
    (sim as any)._applyConfrontationFallback(tickToGameTime(90));
    expect(world.getCurrentIntent("tomori", 90)).toBeDefined();
  });
});
