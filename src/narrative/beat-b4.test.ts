/**
 * B4 形状单测（DESIGN-revival §8 B4 行）：
 * - cooldown 二次触发（cooldown 型不进 triggeredBeats 一次性集合；触发史随档 beatLastTrigger）
 * - BeatContext.extras 形状（压力/kira/金币/约定/事件状态/beat 触发史，jexl 可读）
 * - unresolvedEvent status 只前向流转 + settled 钩子位 + 旧档 normalize
 * - on_trigger.new_phase 应用
 * - on_trigger.auto_events 走 fate 包装 + enqueueMutation（下一 tick 落账；未知 type 不崩）
 * - 旧 beat 语义回归（无 cooldown = 一次性）
 * - beat 表达式加载期 lint fail loud + 全剧本回归
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Simulation } from "../agent/simulation.js";
import { EventBus, type WorldEvent } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { BeatEngine, getBeatCooldownTicks, lintBeats, type BeatDefinition } from "./beat-engine.js";
import {
  buildBeatContext,
  buildSyntheticBeatContext,
  evaluateCompiled,
  lintExpression,
} from "./expression.js";
import { NarrativeState, normalizeNarrativeSnapshot, emptyNarrativeState } from "./narrative-state.js";
import { loadScenario } from "./scenario-loader.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "public", openHours: null, presentCharacters: [] } as Location,
];

function makeCard(id: string, name: string): CharacterCard {
  return {
    id,
    name,
    age: 20,
    gender: "female",
    occupation: "tester",
    home: "park",
    personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
    background: "",
    relationships: {},
  };
}

function makeSim(): { world: World; eventBus: EventBus; sim: Simulation; beatEvents: WorldEvent[] } {
  const world = new World(fakeLocations);
  world.addCharacter("alice", "Alice", "park");
  world.addCharacter("bob", "Bob", "park");
  const eventBus = new EventBus();
  const mock = new MockLLMProvider();
  mock.setDefaultResponse("", []);
  const sim = new Simulation(world, eventBus, {
    characters: [makeCard("alice", "Alice"), makeCard("bob", "Bob")],
    actions: ALL_BASIC_ACTIONS,
    provider: mock,
    modelId: "test",
  });
  const beatEvents: WorldEvent[] = [];
  eventBus.on((e) => {
    if (e.type === "beat.ready") beatEvents.push(e);
  });
  return { world, eventBus, sim, beatEvents };
}

// ────────── cooldown_after_trigger ──────────

describe("B4 cooldown_after_trigger", () => {
  it("getBeatCooldownTicks: never/缺省 = null；realtime = 0；数字原样", () => {
    expect(getBeatCooldownTicks({ id: "a" })).toBeNull();
    expect(getBeatCooldownTicks({ id: "a", cooldown_after_trigger: "never" })).toBeNull();
    expect(getBeatCooldownTicks({ id: "a", cooldown_after_trigger: "realtime" })).toBe(0);
    expect(getBeatCooldownTicks({ id: "a", cooldown_after_trigger: 8 })).toBe(8);
  });

  it("引擎层：cooldown 型冷却期内不触发、冷却过后二次触发，且不进 triggered 集合", () => {
    const engine = new BeatEngine([
      { id: "pulse", preconditions: ["true"], cooldown_after_trigger: 8 },
    ]);
    const ctxAt = (tick: number) =>
      buildBeatContext({
        narrative: emptyNarrativeState(),
        tick,
        characterRelationships: {},
        characterNeeds: {},
        characterLocations: {},
      });

    expect(engine.scan(ctxAt(40)).length).toBe(1);   // 首次
    expect(engine.scan(ctxAt(44)).length).toBe(0);   // 冷却中（4 < 8）
    expect(engine.scan(ctxAt(48)).length).toBe(1);   // 二次触发
    expect(engine.getTriggered()).not.toContain("pulse");
    expect(engine.getBeatLastTrigger()["pulse"]).toBe(48);
  });

  it("realtime 型每次扫描都可触发", () => {
    const engine = new BeatEngine([
      { id: "rt", preconditions: ["true"], cooldown_after_trigger: "realtime" },
    ]);
    const ctxAt = (tick: number) =>
      buildBeatContext({
        narrative: emptyNarrativeState(),
        tick,
        characterRelationships: {},
        characterNeeds: {},
        characterLocations: {},
      });
    expect(engine.scan(ctxAt(4)).length).toBe(1);
    expect(engine.scan(ctxAt(8)).length).toBe(1);
  });

  it("sim 层：cooldown beat 二次点火，triggeredBeats 不收录、beatLastTrigger 随档更新", async () => {
    const { world, sim, beatEvents } = makeSim();
    sim.loadBeats([{ id: "pulse", preconditions: ["true"], cooldown_after_trigger: 8 }]);

    await sim.runOneTick(tickToGameTime(40));
    await sim.runOneTick(tickToGameTime(44)); // 冷却中
    await sim.runOneTick(tickToGameTime(48)); // 二次点火

    expect(beatEvents.length).toBe(2);
    expect(world.narrative.getWorld().triggeredBeats).not.toContain("pulse");
    expect(world.narrative.getWorld().beatLastTrigger["pulse"]).toBe(48);
  });

  it("旧档 migrate：cooldown 型 id 从 triggeredBeats 一次性集合里放出来（loadBeats + loadGame 同路径）", async () => {
    const { world, sim, beatEvents } = makeSim();
    // 模拟旧档：旧语义下 cooldown beat 曾被 markBeatTriggered
    world.narrative.markBeatTriggered("pulse");
    sim.loadBeats([{ id: "pulse", preconditions: ["true"], cooldown_after_trigger: 8 }]);

    expect(sim.beatEngine.getTriggered()).not.toContain("pulse");
    await sim.runOneTick(tickToGameTime(40));
    expect(beatEvents.length).toBe(1); // 能再触发
  });

  it("旧 beat 语义回归：无 cooldown 的 beat 仍是一次性，进 triggeredBeats 且不复发", async () => {
    const { world, sim, beatEvents } = makeSim();
    sim.loadBeats([{ id: "once", preconditions: ["true"] }]);
    await sim.runOneTick(tickToGameTime(40));
    await sim.runOneTick(tickToGameTime(48));
    expect(beatEvents.length).toBe(1);
    expect(world.narrative.getWorld().triggeredBeats).toContain("once");
    expect(world.narrative.getWorld().beatLastTrigger["once"]).toBe(40);
  });
});

// ────────── BeatContext.extras ──────────

describe("B4 BeatContext.extras", () => {
  it("runBeatScan 注入 extras：金币/事件状态/kira/约定 对 jexl 表达式可读", async () => {
    const { world, sim, beatEvents } = makeSim();
    world.narrative.addUnresolvedEvent({
      id: "e1", summary: "test", involved: ["alice"], visibleTo: "*", createdTick: 0,
    });
    world.narrative.advanceEventStatus("e1", "investigating", 10);

    sim.loadBeats([
      {
        id: "extras_read",
        preconditions: [
          "extras.gold.alice >= 100",
          "extras.charPressures.alice >= 0",
          "extras.events.e1 == 'investigating'",
          "extras.kira.total == 0",
          "extras.appointments.pendingCount == 0",
          "extras.pressure.topPairs | length >= 0",
        ],
      },
    ]);
    await sim.runOneTick(tickToGameTime(40));
    expect(beatEvents.length).toBe(1);
    expect(beatEvents[0]!.description).toContain("extras_read");
  });

  it("extras.beatLastTrigger 可作为触发史读入表达式（跨 beat 依赖）", async () => {
    const { sim, beatEvents } = makeSim();
    sim.loadBeats([
      { id: "first", preconditions: ["true"] },
      { id: "second", preconditions: ["extras.beatLastTrigger.first >= 0"] },
    ]);
    await sim.runOneTick(tickToGameTime(40)); // first 点火（second 在同一 scan 内读不到）
    await sim.runOneTick(tickToGameTime(44)); // second 读到触发史点火
    expect(beatEvents.map((e) => e.description).join("|")).toContain("second");
  });

  it("合成 context 覆盖 extras 全形状（lint dry-run 的地基）", () => {
    const ctx = buildSyntheticBeatContext(["alice", "bob"]);
    expect(ctx.extras).toBeDefined();
    expect(typeof ctx.extras!.pressure.summary).toBe("string");
    expect(ctx.extras!.kira).toMatchObject({ total: 0, victimCount: 0, pendingCount: 0 });
    expect(ctx.extras!.gold.alice).toBeTypeOf("number");
    expect(ctx.extras!.charPressures.alice).toBeTypeOf("number");
    expect(ctx.extras!.appointments.missedByPair).toBeTypeOf("object");
    // 表达式真能读
    expect(evaluateCompiled("extras.gold | length >= 1", ctx)).toBe(true);
  });
});

// ────────── unresolvedEvent status ──────────

describe("B4 unresolvedEvent status 生命周期", () => {
  let ns: NarrativeState;

  beforeEach(() => {
    ns = new NarrativeState();
    ns.addUnresolvedEvent({ id: "theft", summary: "x", involved: [], visibleTo: "*", createdTick: 0 });
  });

  it("新事件默认 fresh", () => {
    expect(ns.getWorld().unresolvedEvents[0]!.status).toBe("fresh");
  });

  it("只前向流转：可跳档前进，禁止后退与原地", () => {
    expect(ns.advanceEventStatus("theft", "confronted", 10)).toBe(true);   // 跳过 investigating 允许
    expect(ns.advanceEventStatus("theft", "investigating", 11)).toBe(false); // 后退拒绝
    expect(ns.advanceEventStatus("theft", "confronted", 12)).toBe(false);    // 原地拒绝
    expect(ns.advanceEventStatus("theft", "settled", 13)).toBe(true);
    expect(ns.advanceEventStatus("theft", "fresh", 14)).toBe(false);
    expect(ns.getWorld().unresolvedEvents[0]!.status).toBe("settled");
  });

  it("未知事件 / 未知状态返回 false 不生效", () => {
    expect(ns.advanceEventStatus("nope", "settled", 1)).toBe(false);
    expect(ns.advanceEventStatus("theft", "weird" as never, 1)).toBe(false);
    expect(ns.getWorld().unresolvedEvents[0]!.status).toBe("fresh");
  });

  it("settled 记 settledTick 并触发钩子（suspicion 过期挂点）；退订生效", () => {
    const settled: string[] = [];
    const off = ns.onEventSettled((e) => settled.push(e.id));
    ns.advanceEventStatus("theft", "settled", 42);
    expect(settled).toEqual(["theft"]);
    expect(ns.getWorld().unresolvedEvents[0]!.settledTick).toBe(42);

    off();
    ns.addUnresolvedEvent({ id: "e2", summary: "y", involved: [], visibleTo: "*", createdTick: 0 });
    ns.advanceEventStatus("e2", "settled", 50);
    expect(settled).toEqual(["theft"]); // 退订后不再回调
  });

  it("旧档 normalize：缺 status 补 fresh、非法值回 fresh、坏 settledTick 删除", () => {
    const snap = emptyNarrativeState();
    snap.world.unresolvedEvents = [
      { id: "a", summary: "", involved: [], visibleTo: "*", createdTick: 0 } as never,
      { id: "b", summary: "", involved: [], visibleTo: "*", createdTick: 0, status: "banana", settledTick: "x" } as never,
      { id: "c", summary: "", involved: [], visibleTo: "*", createdTick: 0, status: "settled", settledTick: 99 } as never,
    ];
    const out = normalizeNarrativeSnapshot(snap);
    expect(out.world.unresolvedEvents[0]!.status).toBe("fresh");
    expect(out.world.unresolvedEvents[1]!.status).toBe("fresh");
    expect((out.world.unresolvedEvents[1] as { settledTick?: number }).settledTick).toBeUndefined();
    expect(out.world.unresolvedEvents[2]!.status).toBe("settled");
    expect(out.world.unresolvedEvents[2]!.settledTick).toBe(99);
  });
});

// ────────── on_trigger 机械载荷 ──────────

describe("B4 on_trigger 机械载荷", () => {
  it("new_phase 应用：beat 点火即翻转 active_phase（koukou 审判线复活路径）", async () => {
    const { world, sim } = makeSim();
    sim.loadBeats([
      { id: "to_trial", preconditions: ["true"], on_trigger: { new_phase: "trial" } },
    ]);
    expect(world.narrative.getWorld().activePhase).toBeUndefined();
    await sim.runOneTick(tickToGameTime(40));
    expect(world.narrative.getWorld().activePhase).toBe("trial");
  });

  it("auto_events 走 fate 包装 + enqueueMutation：本 tick 只入队，下一 tick 落账（金币/记忆/intent/目击）", async () => {
    const { world, sim } = makeSim();
    sim.loadBeats([
      {
        id: "theft_seed",
        preconditions: ["true"],
        on_trigger: {
          auto_events: [
            {
              type: "fate",
              target: "alice",
              fate: {
                id: "wallet_gone",
                name: "钱包被顺走",
                template: "{character}发现钱包不见了",
                importance: 8,
                goldDelta: { kind: "flat", amount: -15 },
                intentSummary: "钱包不见了，得想想是在哪儿丢的。",
                witnessTemplate: "{character}翻遍口袋脸色发白",
              },
            },
          ],
        },
      },
    ]);

    const goldBefore = world.getCharacter("alice")!.gold;
    await sim.runOneTick(tickToGameTime(40));
    // 本 tick 只入队（enqueueMutation），未落账
    expect(world.getCharacter("alice")!.gold).toBe(goldBefore);

    await sim.runOneTick(tickToGameTime(41));
    // 下一 tick 开头 drainMutations 落账
    expect(world.getCharacter("alice")!.gold).toBe(goldBefore - 15);
    // 受害者记忆 + intent（fate 包装的完整结算）
    const aliceMems = sim.memory.getRecent("alice", 10).map((m) => m.content).join("|");
    expect(aliceMems).toContain("钱包不见了");
    expect(world.getCharacter("alice")!.currentIntent?.summary).toContain("钱包");
    // 同地点目击
    const bobMems = sim.memory.getRecent("bob", 10).map((m) => m.content).join("|");
    expect(bobMems).toContain("翻遍口袋");
  });

  it("未知 auto_events type 只告警跳过，不崩、不影响其他载荷（S3 注册后自动可用）", async () => {
    const { world, sim } = makeSim();
    sim.loadBeats([
      {
        id: "future_crime",
        preconditions: ["true"],
        on_trigger: {
          new_phase: "investigation",
          auto_events: [
            { type: "theft_with_perp", perp: "npc_x" },  // S3 才注册
            {
              type: "fate",
              target: "alice",
              fate: { template: "{character}听到了风声", importance: 8 },
            },
          ],
        },
      },
    ]);
    await sim.runOneTick(tickToGameTime(40));
    await sim.runOneTick(tickToGameTime(41));
    // 未知类型被跳过；同批的 fate 与 new_phase 正常生效
    expect(world.narrative.getWorld().activePhase).toBe("investigation");
    const aliceMems = sim.memory.getRecent("alice", 10).map((m) => m.content).join("|");
    expect(aliceMems).toContain("风声");
  });

  it("registerAutoEventHandler：外部注册的类型（S3 接入点）能被派发", async () => {
    const { sim } = makeSim();
    const seen: Array<{ type: string; beatId: string }> = [];
    sim.registerAutoEventHandler("theft_with_perp", (payload, ctx) => {
      seen.push({ type: payload.type as string, beatId: ctx.beatId });
    });
    sim.loadBeats([
      {
        id: "crime_day1",
        preconditions: ["true"],
        on_trigger: { auto_events: [{ type: "theft_with_perp", perp: "npc_x" }] },
      },
    ]);
    await sim.runOneTick(tickToGameTime(40));
    await sim.runOneTick(tickToGameTime(41));
    expect(seen).toEqual([{ type: "theft_with_perp", beatId: "crime_day1" }]);
  });
});

// ────────── beat 表达式加载期 lint ──────────

describe("B4 beat lint（fail loud）", () => {
  it("compile 失败的表达式在加载期抛错", () => {
    expect(() =>
      lintBeats([{ id: "bad", preconditions: ["world.day >>>> 1"] }]),
    ).toThrow(/bad/);
  });

  it("未知 transform 在 dry-run 阶段炸出来（而非运行期静默 false）", () => {
    expect(() =>
      lintBeats([{ id: "bad2", preconditions: ["world.day | noSuchTransform"] }]),
    ).toThrow(/bad2/);
  });

  it("lintExpression 对合法表达式返回 null（含 extras 访问）", () => {
    const ctx = buildSyntheticBeatContext(["alice"]);
    expect(lintExpression("world.day >= 2", ctx)).toBeNull();
    expect(lintExpression("extras.gold | length >= 0", ctx)).toBeNull();
    expect(lintExpression("characters.alice.pressure > 40", ctx)).toBeNull();
  });

  it("cooldown/new_phase/auto_events 载荷形状不合法时报错", () => {
    expect(() =>
      lintBeats([{ id: "c1", preconditions: ["true"], cooldown_after_trigger: -2 }]),
    ).toThrow(/cooldown_after_trigger/);
    expect(() =>
      lintBeats([{ id: "c2", preconditions: ["true"], on_trigger: { new_phase: 42 } }]),
    ).toThrow(/new_phase/);
    expect(() =>
      lintBeats([{ id: "c3", preconditions: ["true"], on_trigger: { auto_events: [{ no_type: true }] } }]),
    ).toThrow(/auto_events/);
  });

  it("合法 beat 通过；聚合错误一次性列出全部问题", () => {
    expect(() =>
      lintBeats([
        { id: "ok", preconditions: ["world.day >= 1"], cooldown_after_trigger: 8 },
      ]),
    ).not.toThrow();
    try {
      lintBeats([
        { id: "b1", preconditions: ["world.day >>>> 1"] },
        { id: "b2", preconditions: ["world.day | nope"] },
      ]);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as Error).message).toContain("b1");
      expect((e as Error).message).toContain("b2");
    }
  });

  it("全剧本回归：data/scenarios 下所有剧本的 beats 全部过 lint（loadScenario 内置 fail loud）", () => {
    const projectRoot = join(import.meta.dirname, "..", "..");
    const scenariosRoot = join(projectRoot, "data", "scenarios");
    const ids = readdirSync(scenariosRoot).filter((d) => {
      const dir = join(scenariosRoot, d);
      return statSync(dir).isDirectory() && existsSync(join(dir, "manifest.yml"));
    });
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) {
      expect(() => loadScenario(id, { projectRoot }), `scenario ${id}`).not.toThrow();
    }
  });
});
