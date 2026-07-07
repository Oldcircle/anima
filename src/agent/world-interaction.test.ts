/**
 * 人↔世界交互批次回归测试
 *
 * ① 菜园（世界可改造）：种下→生长（跨日+随档）→照看提前→收获成物品
 * ② 绝境阶梯：财务体感门槛浮现 beg/卖血/借钱/翻垃圾/偷/陪酒，未成年与 off 档硬闸
 * ③ sell：物品↔金币闭环（半价回收、念想不卖）
 * ④ borrow_money：按交情+对方手头结算，欠账进双方 LTM
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgentTick } from "./agent-loop.js";
import { buildToolList, gardenIsMature, CROP_MATURE_TICKS } from "./tool-builder.js";
import { Simulation } from "./simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { RelationshipManager } from "../world/relationships.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { addToInventory, hasItem, getItemCount } from "../world/item-registry.js";
import { saveGame, loadGame } from "../persistence/save-load.js";
import { setBreakLevel } from "./break-config.js";
import type { CharacterCard } from "../character/types.js";
import type { ToolBuildContext } from "./tool-builder.js";

function makeCard(id: string, name: string, age = 19): CharacterCard {
  return {
    id, name, age, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function makeWorld(at = "farm"): World {
  const world = new World(TEST_LOCATIONS, 40);
  world.addCharacter("tomori", "高松灯", at);
  world.addCharacter("anon", "千早爱音", at);
  return world;
}

function ctxFor(world: World, id: string, opts: { age?: number; hour?: number; tick?: number } = {}): ToolBuildContext {
  const state = world.getCharacter(id)!;
  const location = world.getLocation(state.locationId)!;
  return {
    state,
    card: makeCard(id, state.name, opts.age ?? 19),
    location,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId)
      .filter((c) => c !== id).map((c) => ({ id: c, name: world.getCharacter(c)!.name })),
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: opts.hour ?? 12,
    tick: opts.tick ?? 40,
    relationships: new RelationshipManager(),
  };
}

const toolNames = (ctx: ToolBuildContext) => buildToolList(ctx).map((t) => t.tool.name);

describe("菜园：世界可改造", () => {
  it("工具按地块状态浮现：有种子→plant；未熟→tend；熟了→harvest", () => {
    const world = makeWorld("farm");
    const t = world.getCharacter("tomori")!;
    expect(toolNames(ctxFor(world, "tomori"))).not.toContain("plant_crop"); // 没种子

    addToInventory(t.inventory, "vegetable_seeds", 1);
    expect(toolNames(ctxFor(world, "tomori"))).toContain("plant_crop");

    t.garden = { cropId: "fresh_vegetables", plantedTick: 40, matureTicks: CROP_MATURE_TICKS };
    const growing = toolNames(ctxFor(world, "tomori", { tick: 100 }));
    expect(growing).toContain("tend_crop");
    expect(growing).not.toContain("harvest_crop");

    const ripe = toolNames(ctxFor(world, "tomori", { tick: 40 + CROP_MATURE_TICKS }));
    expect(ripe).toContain("harvest_crop");
  });

  it("种下消耗种子；照看提前成熟；收获得 4 份蔬菜并清地", async () => {
    const world = makeWorld("farm");
    const t = world.getCharacter("tomori")!;
    addToInventory(t.inventory, "vegetable_seeds", 1);

    const provider = new MockLLMProvider();
    const run = (tick: number) => runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(tick),
      relationships: new RelationshipManager(),
    });

    provider.enqueueResponse("种点菜，往后不用顿顿买", [{ id: "c1", name: "plant_crop", arguments: {} }]);
    await run(40);
    expect(t.garden?.plantedTick).toBe(40);
    expect(hasItem(t.inventory, "vegetable_seeds")).toBe(false);

    t.currentAction = undefined;
    provider.enqueueResponse("去看看菜", [{ id: "c2", name: "tend_crop", arguments: {} }]);
    await run(60);
    expect(t.garden?.matureTicks).toBe(CROP_MATURE_TICKS - 8);

    t.currentAction = undefined;
    provider.enqueueResponse("收菜", [{ id: "c3", name: "harvest_crop", arguments: {} }]);
    await run(40 + CROP_MATURE_TICKS);
    expect(t.garden).toBeUndefined();
    expect(getItemCount(t.inventory, "fresh_vegetables")).toBe(4);
  });

  it("gardenIsMature 边界：差 1 tick 不熟", () => {
    const g = { plantedTick: 100, matureTicks: 192 };
    expect(gardenIsMature(g, 291)).toBe(false);
    expect(gardenIsMature(g, 292)).toBe(true);
  });
});

const TEST_DB = join(tmpdir(), `anima-garden-${Date.now()}.db`);

describe("菜园随档持久化", () => {
  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = TEST_DB + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("saveGame → loadGame：种下去的东西读档后还长在地里", () => {
    const buildSim = () => {
      const world = makeWorld("farm");
      return new Simulation(world, new EventBus(), {
        characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
        actions: ALL_BASIC_ACTIONS,
        provider: new MockLLMProvider(),
        modelId: "test",
      });
    };
    const sim = buildSim();
    sim.world.getCharacter("tomori")!.garden = { cropId: "fresh_vegetables", plantedTick: 33, matureTicks: 184 };
    saveGame(sim, TEST_DB);

    const restored = buildSim();
    expect(loadGame(restored, TEST_DB)).toBe(true);
    expect(restored.world.getCharacter("tomori")!.garden).toEqual({ cropId: "fresh_vegetables", plantedTick: 33, matureTicks: 184 });
  });
});

describe("绝境阶梯：财务体感门槛", () => {
  beforeEach(() => setBreakLevel("mild"));
  afterEach(() => setBreakLevel(undefined));

  it("走投无路的成年人：beg / sell_blood / borrow_money 浮现；饿了加翻垃圾和偷", () => {
    const world = makeWorld("plaza");
    const t = world.getCharacter("tomori")!;
    t.gold = 3;
    t.needs.hunger = 15;
    const names = toolNames(ctxFor(world, "tomori"));
    expect(names).toEqual(expect.arrayContaining(["beg", "sell_blood", "borrow_money", "scavenge_trash", "steal"]));
  });

  it("手头宽裕：整个阶梯都不浮现", () => {
    const world = makeWorld("plaza");
    const t = world.getCharacter("tomori")!;
    t.gold = 200;
    const names = toolNames(ctxFor(world, "tomori"));
    for (const n of ["beg", "sell_blood", "borrow_money", "scavenge_trash", "steal", "accompany_drinks"]) {
      expect(names).not.toContain(n);
    }
  });

  it("未成年硬闸：14 岁再穷也没有 sell_blood / accompany_drinks", () => {
    const world = makeWorld("bar");
    const t = world.getCharacter("tomori")!;
    t.gold = 0;
    t.needs.hunger = 10;
    const names = toolNames(ctxFor(world, "tomori", { age: 14, hour: 20 }));
    expect(names).not.toContain("sell_blood");
    expect(names).not.toContain("accompany_drinks");
    expect(names).toContain("beg"); // 但乞讨这类还是有的
  });

  it("陪酒：成年+酒吧+晚间+走投无路才浮现；off 档没有这条路", () => {
    const world = makeWorld("bar");
    const t = world.getCharacter("tomori")!;
    t.gold = 0;
    expect(toolNames(ctxFor(world, "tomori", { hour: 20 }))).toContain("accompany_drinks");
    expect(toolNames(ctxFor(world, "tomori", { hour: 14 }))).not.toContain("accompany_drinks"); // 白天没有

    setBreakLevel("off");
    expect(toolNames(ctxFor(world, "tomori", { hour: 20 }))).not.toContain("accompany_drinks");
  });

  it("卖血：虚弱 moodlet 当 3 天冷却；气色太差不收", () => {
    const world = makeWorld("plaza");
    const t = world.getCharacter("tomori")!;
    t.gold = 0;
    const ctx = ctxFor(world, "tomori");
    const sellBlood = buildToolList(ctx).find((a) => a.tool.name === "sell_blood")!;

    const ok = sellBlood.handler({}, { characterId: "tomori" } as any) as any;
    expect(ok._workerIncome).toBe(30);
    expect(ok.effects.some((e: any) => e.type === "moodlet" && e.reason.includes("卖血"))).toBe(true);

    t.moodlets.push({ id: "m1", emotion: "anxious", intensity: 3, reason: "卖血后的虚弱，缓上几天才行", expiresAtTick: 400, source: "need" });
    const blocked = sellBlood.handler({}, { characterId: "tomori" } as any) as any;
    expect(blocked.success).toBe(false);

    t.moodlets = [];
    t.needs.energy = 20;
    const tooWeak = sellBlood.handler({}, { characterId: "tomori" } as any) as any;
    expect(tooWeak.success).toBe(false);
  });
});

describe("sell：物品↔金币闭环", () => {
  it("半价回收进钱包并出背包；念想（keepsake）不收", async () => {
    const world = makeWorld("shop");
    const t = world.getCharacter("tomori")!;
    t.gold = 10;
    addToInventory(t.inventory, "guitar", 1);
    addToInventory(t.inventory, "seashell", 1);

    const provider = new MockLLMProvider();
    provider.enqueueResponse("实在缺钱，吉他先卖了", [{ id: "c1", name: "sell", arguments: { item: "吉他" } }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
      relationships: new RelationshipManager(),
    });
    expect(t.gold).toBe(50); // 10 + 80/2
    expect(hasItem(t.inventory, "guitar")).toBe(false);

    // keepsake 拒收
    const ctx = ctxFor(world, "tomori");
    const sell = buildToolList(ctx).find((a) => a.tool.name === "sell")!;
    const refused = sell.handler({ item: "贝壳" }, { characterId: "tomori" } as any) as any;
    expect(refused.success).toBe(false);
  });
});

describe("borrow_money：交情+对方手头", () => {
  async function runBorrow(relLevel: number, lenderGold: number) {
    const world = makeWorld("plaza");
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    t.gold = 2;
    a.gold = lenderGold;
    const relationships = new RelationshipManager();
    relationships.set("tomori", "anon", relLevel);

    const provider = new MockLLMProvider();
    provider.enqueueResponse("实在没辙了", [{ id: "c1", name: "borrow_money", arguments: { target: "anon", amount: 20 } }]);
    const result = await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40), relationships,
    });
    return { world, t, a, result };
  }

  it("交情够+对方手头宽：借到，双向转账", async () => {
    const { t, a, result } = await runBorrow(40, 100);
    expect(t.gold).toBe(22);
    expect(a.gold).toBe(80);
    expect(result.result?.description).toContain("借了");
  });

  it("交情不够：被拒 + 借钱人难堪 moodlet；对方自己也紧就不借", async () => {
    const { t, a } = await runBorrow(5, 100);
    expect(t.gold).toBe(2);
    expect(a.gold).toBe(100);
    expect(t.moodlets.some((m) => m.reason.includes("借钱被拒"))).toBe(true);

    const tight = await runBorrow(40, 30); // 20*2 > 30，对方手头也紧
    expect(tight.t.gold).toBe(2);
  });

  it("借到的欠账进双方 LTM（活得比 48 小时长）", () => {
    const world = makeWorld("plaza");
    const sim = new Simulation(world, new EventBus(), {
      characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
    (sim as any)._promoteConflictsToLongTerm([{
      characterId: "tomori", thought: "",
      action: { name: "borrow_money", args: { target: "anon" } },
      result: { description: "", effects: [], _borrowOutcome: { lenderId: "anon", amount: 20, granted: true } },
    }], tickToGameTime(40));

    expect(sim.longTerm.getAbout("tomori", "anon").some((e) => e.content.includes("欠着"))).toBe(true);
    expect(sim.longTerm.getAbout("anon", "tomori").some((e) => e.content.includes("欠着"))).toBe(true);
  });
});
