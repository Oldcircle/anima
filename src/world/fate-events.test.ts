/**
 * 命运事件层单测：条件过滤 / 加权抽取 / 金币结算 / 调度与后果落地
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FATE_EVENTS, fateEventEligible, pickFateEvent, applyFateGold } from "./fate-events.js";
import { Simulation } from "../agent/simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "./world.js";
import { EventBus } from "../core/event-bus.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { setBreakLevel } from "../agent/break-config.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "./types.js";

const baseCtx = { weather: "sunny" as const, season: "spring" as const, locationType: "public", gold: 100 };

describe("fateEventEligible / pickFateEvent", () => {
  it("条件过滤：着凉只在雨雪天、丢钱要有钱可丢、赔钱只在商铺", () => {
    const cold = FATE_EVENTS.find((e) => e.id === "caught_cold")!;
    expect(fateEventEligible(cold, baseCtx)).toBe(false);
    expect(fateEventEligible(cold, { ...baseCtx, weather: "rainy" })).toBe(true);

    const wallet = FATE_EVENTS.find((e) => e.id === "wallet_hole")!;
    expect(fateEventEligible(wallet, { ...baseCtx, gold: 5 })).toBe(false);
    expect(fateEventEligible(wallet, { ...baseCtx, gold: 20 })).toBe(true);

    const mishap = FATE_EVENTS.find((e) => e.id === "shop_mishap")!;
    expect(fateEventEligible(mishap, baseCtx)).toBe(false);
    expect(fateEventEligible(mishap, { ...baseCtx, locationType: "commercial" })).toBe(true);
  });

  it("加权抽取：rng 可注入、无候选返回 undefined", () => {
    // 晴天+公共地点+穷光蛋：只剩 windfall_purse 符合条件
    const ctx = { ...baseCtx, gold: 0 };
    expect(pickFateEvent(FATE_EVENTS, ctx, () => 0.5)?.id).toBe("windfall_purse");
    // 晴天+住宅+没钱：全部不符合
    expect(pickFateEvent(FATE_EVENTS, { ...ctx, locationType: "residential" }, () => 0.5)).toBeUndefined();
  });
});

describe("applyFateGold", () => {
  const state = (gold: number) => ({ gold }) as CharacterState;

  it("比例损失：按比例取整、至少 min、以身上的钱为限", () => {
    const s = state(50);
    expect(applyFateGold(s, { kind: "fraction", fraction: 0.4, min: 5 })).toBe(-20);
    expect(s.gold).toBe(30);

    const poor = state(3);
    expect(applyFateGold(poor, { kind: "fraction", fraction: 0.4, min: 5 })).toBe(-3); // 只有 3，全丢
    expect(poor.gold).toBe(0);
  });

  it("定额：正数直加，负数以身上的钱为限", () => {
    const s = state(4);
    expect(applyFateGold(s, { kind: "flat", amount: -10 })).toBe(-4);
    expect(s.gold).toBe(0);
    expect(applyFateGold(s, { kind: "flat", amount: 18 })).toBe(18);
    expect(s.gold).toBe(18);
  });
});

describe("命运事件调度（simulation）", () => {
  let world: World;
  let sim: Simulation;

  function makeCard(id: string, name: string): CharacterCard {
    return {
      id, name, age: 19, occupation: "学徒", home: "home_tomori",
      personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
      background: "测试角色", relationships: {},
    };
  }

  beforeEach(() => {
    setBreakLevel("mild");
    world = new World(TEST_LOCATIONS, 40);
    world.addCharacter("tomori", "高松灯", "cafe");
    sim = new Simulation(world, new EventBus(), {
      characters: [makeCard("tomori", "高松灯")],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
  });

  afterEach(() => {
    setBreakLevel(undefined);
    vi.restoreAllMocks();
  });

  it("到期 + 白天 → 事件落地：金币/记忆/moodlet/intent 全链生效", () => {
    const t = world.getCharacter("tomori")!;
    t.gold = 50;
    (sim as any)._nextFateAt = 40;
    vi.spyOn(Math, "random").mockReturnValue(0.0); // 角色选第一个 + 抽第一个符合条件的事件

    const gt = tickToGameTime(40); // day0 10:00（40*15min=600min=10h）
    expect(gt.hour).toBeGreaterThanOrEqual(8);
    const out = (sim as any)._maybeRollFateEvent(gt);

    expect(out).toBeDefined();
    expect(out.affectedCharacters).toContain("tomori");
    // cafe=commercial + gold 50：抽中 wallet_hole（权重序第一个符合条件的）
    expect(t.gold).toBeLessThan(50);
    const mem = sim.memory.getRecent("tomori", 5).map((e) => e.content).join("");
    expect(mem.length).toBeGreaterThan(0);
    expect(t.moodlets.length).toBeGreaterThan(0);
    // 下一次已排到 3-7 天后
    expect((sim as any)._nextFateAt).toBeGreaterThanOrEqual(40 + 3 * 96);
  });

  it("没到期不触发；off 档完全不启用", () => {
    (sim as any)._nextFateAt = 999;
    expect((sim as any)._maybeRollFateEvent(tickToGameTime(40))).toBeUndefined();

    setBreakLevel("off");
    (sim as any)._nextFateAt = 40;
    expect((sim as any)._maybeRollFateEvent(tickToGameTime(40))).toBeUndefined();
  });

  it("夜里顺延：hour<8 不落地、_nextFateAt 不重排", () => {
    (sim as any)._nextFateAt = 8; // 早已到期
    const night = tickToGameTime(8); // day0 02:00
    expect(night.hour).toBeLessThan(8);
    expect((sim as any)._maybeRollFateEvent(night)).toBeUndefined();
    expect((sim as any)._nextFateAt).toBe(8); // 顺延，白天再落
  });
});

/**
 * fate/beat 事件 → 器物 trace 接线（PLAN-grounding）：
 * 事件要在**世界本体**留痕，不能只活在记忆文本里——留下的 trace 由 examine 与
 * 重访 diff 接住，当时不在场的人过后也能看出这里出过事。
 * 接线点 = `_applyFateOutcome`（随机命运层与 beat auto_events 共用的那一处）。
 */
function makeTestCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
    background: "", relationships: {},
  };
}

describe("命运事件 → 器物留痕", () => {
  function setup() {
    setBreakLevel("mild");
    const world = new World(TEST_LOCATIONS, 40);
    world.addCharacter("tomori", "高松灯", "shop");
    world.objects.registerLocation({
      id: "shop",
      objects: [{ id: "shelves", name: "货架", keywords: ["货架", "存货"] }],
    });
    const sim = new Simulation(world, new EventBus(), {
      characters: [makeTestCard("tomori", "高松灯")],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
    return { world, sim };
  }

  it("声明了 objectTrace 的事件在当事人所在地点的器物上留下痕迹", () => {
    const { world, sim } = setup();
    const mishap = FATE_EVENTS.find((e) => e.id === "shop_mishap")!;
    expect(mishap.objectTrace).toBeTruthy();
    (sim as any)._applyFateOutcome(world.getCharacter("tomori")!, mishap, 40);
    const shelves = world.objects.get("shop.shelves")!;
    expect(shelves.traces.some((t) => t.text.includes("碎渣") && t.source === "event")).toBe(true);
  });

  it("候选名逐个解析：地点没有任何一件候选器物 → 静默跳过（增强不是硬依赖）", () => {
    const { world, sim } = setup();
    world.moveCharacter("tomori", "plaza"); // plaza 没注册器物
    const mishap = FATE_EVENTS.find((e) => e.id === "shop_mishap")!;
    expect(() => (sim as any)._applyFateOutcome(world.getCharacter("tomori")!, mishap, 40)).not.toThrow();
    expect(world.objects.get("shop.shelves")!.traces).toHaveLength(0);
  });

  it("私事不留痕：丢钱/着凉不声明 objectTrace，货架干干净净", () => {
    const { world, sim } = setup();
    for (const id of ["wallet_hole", "caught_cold", "windfall_purse"]) {
      const e = FATE_EVENTS.find((x) => x.id === id)!;
      expect(e.objectTrace).toBeUndefined();
      (sim as any)._applyFateOutcome(world.getCharacter("tomori")!, e, 40);
    }
    expect(world.objects.get("shop.shelves")!.traces).toHaveLength(0);
  });
});
