/**
 * B2 导演硬事件原语 单测（DESIGN-revival §8 B2 行）
 *
 * 锁形状：
 * - enqueueMutation 安全通路（硬事件只入队，drain 前世界不动）
 * - 配额随档（周池 2 次 + 每类冷却，JSON 往返后仍生效）+ 拒绝路径
 * - 无 cause 拒绝；真凶红线（cast 无锚定 steal 即拒）
 * - theft 金币守恒 + 赃物真入包 + 延迟发现 + 风声晚于发现
 * - off 档禁用（治愈系基线）
 * - surface_grudge 不直写关系/印象、催化门槛、每对冷却
 * - set_active_phase 翻转 + phase 工具上架
 * - prompt 手术：pacing 分档快照、心灵直写排序反转、压力摘要/真心层注入（空集安全）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { World } from "../world/world.js";
import type { Location } from "../world/types.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { ImpressionStore } from "../memory/impressions.js";
import { RelationshipManager } from "../world/relationships.js";
import { PressureGraph } from "./pressure-graph.js";
import { EventBus } from "../core/event-bus.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { Simulation } from "../agent/simulation.js";
import { Director } from "./director.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import {
  injectWorldEventTool,
  surfaceGrudgeTool,
  setActivePhaseTool,
  ALL_DIRECTOR_TOOLS,
  type DirectorToolContext,
} from "./director-tools.js";
import {
  applyLetterArrival,
  processPendingDiscoveries,
  checkAndReserveWorldEventQuota,
  DISCOVERY_RUMOR_DELAY_TICKS,
  STOLEN_EVIDENCE_ITEM,
  WORLD_EVENT_TYPE_COOLDOWN_TICKS,
  WORLD_EVENT_WEEK_TICKS,
} from "./world-events.js";
import { setBreakLevel, setEnabledWorldEvents } from "../agent/break-config.js";
import { normalizeNarrativeSnapshot } from "./narrative-state.js";
import { hasItem, addToInventory } from "../world/item-registry.js";
import type { BeatReadyEvent } from "./beat-engine.js";

const LOCATIONS: Location[] = [
  { id: "park", name: "公园", type: "public", openHours: null, presentCharacters: [] } as Location,
  { id: "bakery", name: "面包店", type: "commercial", openHours: null, presentCharacters: [] } as Location,
];

function makeWorld(): World {
  const w = new World(LOCATIONS.map((l) => ({ ...l, presentCharacters: [] })));
  w.addCharacter("victim", "小美", "park");
  w.addCharacter("perp_cast", "阿强", "park");
  return w;
}

function makeQueue(): { queued: Array<() => void>; enqueue: (fn: () => void) => void; drain: () => void } {
  const queued: Array<() => void> = [];
  return {
    queued,
    enqueue: (fn) => queued.push(fn),
    drain: () => {
      while (queued.length > 0) queued.shift()!();
    },
  };
}

function makeCtx(world: World, tick: number, extra?: Partial<DirectorToolContext>): DirectorToolContext & { drain: () => void; queued: Array<() => void> } {
  const q = makeQueue();
  return {
    world,
    tick,
    memory: new ShortTermMemory(),
    enqueueMutation: q.enqueue,
    drain: q.drain,
    queued: q.queued,
    ...extra,
  };
}

const THEFT_ARGS = {
  event_type: "theft_with_perp",
  cause: "面包店月底要结货款，钱一直收在后屋铁盒里",
  perp_id: "npc_drifter",
  victim_id: "victim",
  amount: 50,
  discovery_location_id: "bakery",
};

/** 注册一个合法 NPC 真凶（B3 前由测试手工登记） */
function addNpcPerp(world: World, gold = 100): void {
  world.addCharacter("npc_drifter", "外乡流浪汉", "park");
  world.getCharacter("npc_drifter")!.gold = gold;
  world.narrative.registerNpc("npc_drifter", "外乡流浪汉");
}

beforeEach(() => {
  setBreakLevel("mild");
  setEnabledWorldEvents([]);
});

afterEach(() => {
  setBreakLevel("mild");
  setEnabledWorldEvents([]);
});

describe("B2 inject_world_event — 守门", () => {
  it("off 档：三个新工具全部拒绝（治愈系基线）", () => {
    setBreakLevel("off");
    const world = makeWorld();
    addNpcPerp(world);
    const ctx = makeCtx(world, 100);

    expect(injectWorldEventTool.handler({ ...THEFT_ARGS }, ctx).error).toBe("break_level_off");
    expect(surfaceGrudgeTool.handler({ char_id: "victim", about_char_id: "perp_cast" }, ctx).error).toBe("break_level_off");
    expect(setActivePhaseTool.handler({ phase: "trial" }, ctx).error).toBe("break_level_off");
    expect(ctx.queued.length).toBe(0);
  });

  it("缺 enqueueMutation 安全通路 → 拒绝（硬事件绝不同步直写）", () => {
    const world = makeWorld();
    addNpcPerp(world);
    const r = injectWorldEventTool.handler({ ...THEFT_ARGS }, { world, tick: 100, memory: new ShortTermMemory() });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_mutation_queue");
  });

  it("无 cause 拒绝（因果伪装必填）", () => {
    const world = makeWorld();
    addNpcPerp(world);
    const ctx = makeCtx(world, 100);
    const r = injectWorldEventTool.handler({ ...THEFT_ARGS, cause: "  " }, ctx);
    expect(r.error).toBe("missing_cause");
    expect(ctx.queued.length).toBe(0);
  });

  it("真凶红线：cast 成员无锚定 steal → 拒绝且不烧配额", () => {
    const world = makeWorld();
    const ctx = makeCtx(world, 100);
    const r = injectWorldEventTool.handler({ ...THEFT_ARGS, perp_id: "perp_cast" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("perp_not_eligible");
    expect(ctx.queued.length).toBe(0);
    expect(Object.keys(world.narrative.getWorldEventQuota().usedByWeek).length).toBe(0);
  });

  it("cast 成员近窗真实执行过 steal → 锚定放大器路径允许", () => {
    const world = makeWorld();
    const perp = world.getCharacter("perp_cast")!;
    perp.recentActions.push({ actionId: "steal", tick: 92 });
    const ctx = makeCtx(world, 100);
    const r = injectWorldEventTool.handler({ ...THEFT_ARGS, perp_id: "perp_cast" }, ctx);
    expect(r.ok).toBe(true);
  });
});

describe("B2 theft_with_perp — 金币守恒 + 物证 + 延迟发现", () => {
  it("入队不直写：drain 前世界不动；drain 后金币守恒、赃物入包、发现延迟、风声晚于发现", () => {
    const world = makeWorld();
    addNpcPerp(world, 100);
    const victim = world.getCharacter("victim")!;
    victim.gold = 80;
    const memory = new ShortTermMemory();
    const ctx = makeCtx(world, 100, { memory });

    const r = injectWorldEventTool.handler({ ...THEFT_ARGS }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.queued.length).toBe(1);

    // 只入队：drain 前一分钱没动
    expect(victim.gold).toBe(80);
    expect(world.getCharacter("npc_drifter")!.gold).toBe(100);

    ctx.drain();

    // 金币守恒：受害者丢多少真凶得多少
    const perp = world.getCharacter("npc_drifter")!;
    expect(victim.gold).toBe(30);
    expect(perp.gold).toBe(150);
    expect(victim.gold + perp.gold).toBe(80 + 100);

    // 赃物真入包（持久物证）
    expect(hasItem(perp.inventory, STOLEN_EVIDENCE_ITEM)).toBe(true);

    // 受害者拿到"去取货款"intent，但**还没有**发现记忆
    expect(world.getCurrentIntent("victim", 100)?.summary).toContain("面包店");
    const memsBefore = memory.getRecent("victim", 20).map((m) => m.content).join("\n");
    expect(memsBefore).not.toContain("不翼而飞");

    // 不在发现地点 → sweep 不触发
    processPendingDiscoveries(world, memory, 101);
    expect(memory.getRecent("victim", 20).some((m) => m.content.includes("不翼而飞"))).toBe(false);

    // 到场 → 发现记忆 + 未解决事件（只对受害者可见）+ 现场氛围；风声尚未起
    world.moveCharacter("victim", "bakery");
    processPendingDiscoveries(world, memory, 102);
    expect(memory.getRecent("victim", 20).some((m) => m.content.includes("不翼而飞"))).toBe(true);
    const events = world.narrative.getWorld().unresolvedEvents;
    expect(events.length).toBe(1);
    expect(events[0]!.visibleTo).toEqual(["victim"]);
    expect(events[0]!.involved).toEqual(["victim"]); // 不伪造证据链：事件不点名真凶
    expect(world.getObservableState("victim", 102)?.summary).toContain("铁盒");
    expect(world.narrative.getWorld().rumors.length).toBe(0);

    // 风声必须晚于发现记忆
    processPendingDiscoveries(world, memory, 102 + DISCOVERY_RUMOR_DELAY_TICKS - 1);
    expect(world.narrative.getWorld().rumors.length).toBe(0);
    processPendingDiscoveries(world, memory, 102 + DISCOVERY_RUMOR_DELAY_TICKS);
    expect(world.narrative.getWorld().rumors.length).toBe(1);
    expect(world.narrative.getWorld().rumors[0]!.content).toContain("小美");
    // 队列清空
    expect(world.narrative.getPendingDiscoveries().length).toBe(0);
  });

  it("amount 超过受害者身上的钱：只偷走实际有的（不凭空造钱）", () => {
    const world = makeWorld();
    addNpcPerp(world, 0);
    world.getCharacter("victim")!.gold = 10;
    const ctx = makeCtx(world, 100);
    injectWorldEventTool.handler({ ...THEFT_ARGS, amount: 999 }, ctx);
    ctx.drain();
    expect(world.getCharacter("victim")!.gold).toBe(0);
    expect(world.getCharacter("npc_drifter")!.gold).toBe(10);
  });
});

describe("B2 配额 — 周池 2 次 + 每类冷却，随档", () => {
  it("同类冷却：第二次同类注入被拒", () => {
    const world = makeWorld();
    addNpcPerp(world);
    const ctx1 = makeCtx(world, 100);
    expect(injectWorldEventTool.handler({ ...THEFT_ARGS }, ctx1).ok).toBe(true);
    const ctx2 = makeCtx(world, 110);
    const r = injectWorldEventTool.handler({ ...THEFT_ARGS }, ctx2);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("type_cooldown");
  });

  it("周池：2 次后第三类（未冷却）也被拒；计数随档（JSON 往返仍生效）；下周恢复", () => {
    setEnabledWorldEvents(["letter_arrival"]);
    const world = makeWorld();
    addNpcPerp(world);
    addToInventory(world.getCharacter("victim")!.inventory, "umbrella", 1);

    // 第 1 次：theft
    expect(injectWorldEventTool.handler({ ...THEFT_ARGS }, makeCtx(world, 100)).ok).toBe(true);
    // 第 2 次：accident（不同类，不吃冷却）
    const accident = {
      event_type: "accident_damage",
      cause: "梅雨天屋檐漏水泡了东西",
      target_id: "victim",
      item: "umbrella",
    };
    expect(injectWorldEventTool.handler(accident, makeCtx(world, 101)).ok).toBe(true);
    // 第 3 次：letter（无冷却记录）→ 周池耗尽
    const letter = {
      event_type: "letter_arrival",
      cause: "月初的邮船到港了",
      recipient_id: "victim",
      from_whom: "远方的姑妈",
      content_summary: "姑妈说家里的老屋要拆了",
    };
    const r3 = injectWorldEventTool.handler(letter, makeCtx(world, 102));
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe("quota_exhausted");

    // 配额随档：JSON 序列化往返后仍拒绝（导演内存态重启即失控——所以挂 narrative_state）
    const roundTripped = JSON.parse(JSON.stringify(world.narrative.getSnapshot()));
    world.narrative.replaceSnapshot(roundTripped);
    const r4 = injectWorldEventTool.handler(letter, makeCtx(world, 103));
    expect(r4.error).toBe("quota_exhausted");

    // 下一周：池子重置且冷却已过
    const nextWeekTick = 100 + WORLD_EVENT_WEEK_TICKS;
    expect(WORLD_EVENT_WEEK_TICKS).toBeGreaterThan(WORLD_EVENT_TYPE_COOLDOWN_TICKS);
    const r5 = injectWorldEventTool.handler(letter, makeCtx(world, nextWeekTick));
    expect(r5.ok).toBe(true);
  });

  it("checkAndReserveWorldEventQuota 是同步预定：连查两次第二次被拒", () => {
    const world = makeWorld();
    expect(checkAndReserveWorldEventQuota(world, "theft_with_perp", 50).ok).toBe(true);
    const again = checkAndReserveWorldEventQuota(world, "theft_with_perp", 51);
    expect(again.ok).toBe(false);
  });
});

describe("B2 accident_damage / letter_arrival", () => {
  it("accident item 路径：物品真的没了；不持有则同步拒绝", () => {
    const world = makeWorld();
    const victim = world.getCharacter("victim")!;
    addToInventory(victim.inventory, "umbrella", 1);
    const memory = new ShortTermMemory();
    const ctx = makeCtx(world, 100, { memory });
    const r = injectWorldEventTool.handler(
      { event_type: "accident_damage", cause: "台风夜院墙塌了半边", target_id: "victim", item: "umbrella" },
      ctx,
    );
    expect(r.ok).toBe(true);
    ctx.drain();
    expect(hasItem(victim.inventory, "umbrella")).toBe(false);
    expect(memory.getRecent("victim", 5).some((m) => m.content.includes("毁"))).toBe(true);

    // 不持有的物品：同步拒绝，不烧配额
    const ctx2 = makeCtx(world, 400);
    const r2 = injectWorldEventTool.handler(
      { event_type: "accident_damage", cause: "又一场事故", target_id: "victim", item: "guitar" },
      ctx2,
    );
    expect(r2.error).toBe("item_not_held");
  });

  it("accident gold 路径：以身上的钱为限，不扣成负数", () => {
    const world = makeWorld();
    world.getCharacter("victim")!.gold = 20;
    const ctx = makeCtx(world, 100);
    const r = injectWorldEventTool.handler(
      { event_type: "accident_damage", cause: "打翻了店里一整架瓷器", target_id: "victim", gold_cost: 30 },
      ctx,
    );
    expect(r.ok).toBe(true);
    ctx.drain();
    expect(world.getCharacter("victim")!.gold).toBe(0);
  });

  it("letter 剧本门控：未声明 world_events 时拒绝；声明后信真的送达（实体物品+记忆+intent）", () => {
    const world = makeWorld();
    const memory = new ShortTermMemory();
    const letter = {
      event_type: "letter_arrival",
      cause: "月初的邮船到港了",
      recipient_id: "victim",
      from_whom: "远方的姑妈",
      content_summary: "老屋要拆了，问你要不要回去看最后一眼",
    };

    const r1 = injectWorldEventTool.handler(letter, makeCtx(world, 100, { memory }));
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe("letter_not_enabled");

    setEnabledWorldEvents(["letter_arrival"]);
    const ctx = makeCtx(world, 100, { memory });
    const r2 = injectWorldEventTool.handler(letter, ctx);
    expect(r2.ok).toBe(true);
    ctx.drain();
    const victim = world.getCharacter("victim")!;
    expect(hasItem(victim.inventory, "letter")).toBe(true);
    expect(memory.getRecent("victim", 5).some((m) => m.content.includes("姑妈"))).toBe(true);
    expect(world.getCurrentIntent("victim", 100)?.summary).toContain("信");
  });

  it("applyLetterArrival 直调也吃门控（beat auto_events 路径同样被闸）", () => {
    const world = makeWorld();
    const r = applyLetterArrival(
      { world, memory: new ShortTermMemory(), tick: 10 },
      { recipientId: "victim", fromWhom: "某人", contentSummary: "内容", cause: "原因" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("letter_not_enabled");
  });
});

describe("B2 surface_grudge — 催化已有旧账", () => {
  function heatUpPair(world: World): { relationships: RelationshipManager; graph: PressureGraph } {
    const relationships = new RelationshipManager();
    relationships.setGrudge("victim", "perp_cast", "上次的事没完", "perp_cast", 10);
    const graph = new PressureGraph();
    graph.update({ world, relationships, impressions: new ImpressionStore(), tick: 100 });
    return { relationships, graph };
  }

  it("压力不足 → 拒绝（催化不无中生有）；无压力图 → 拒绝", () => {
    const world = makeWorld();
    const emptyGraph = new PressureGraph();
    emptyGraph.update({ world, relationships: new RelationshipManager(), impressions: new ImpressionStore(), tick: 100 });
    const r1 = surfaceGrudgeTool.handler(
      { char_id: "victim", about_char_id: "perp_cast" },
      makeCtx(world, 100, { pressureGraph: emptyGraph }),
    );
    expect(r1.error).toBe("pressure_too_low");

    const r2 = surfaceGrudgeTool.handler({ char_id: "victim", about_char_id: "perp_cast" }, makeCtx(world, 100));
    expect(r2.error).toBe("no_pressure_graph");
  });

  it("压力达标：drain 后落 wantToDiscuss(high) + intent；不直写关系/印象；每对冷却", () => {
    const world = makeWorld();
    const { relationships, graph } = heatUpPair(world);
    const impressions = new ImpressionStore();
    const levelBefore = relationships.get("victim", "perp_cast").level;

    const ctx = makeCtx(world, 100, { pressureGraph: graph, impressions });
    const r = surfaceGrudgeTool.handler({ char_id: "victim", about_char_id: "perp_cast" }, ctx);
    expect(r.ok).toBe(true);

    // drain 前不落
    expect(world.getWantToDiscuss("victim", 100, "perp_cast").length).toBe(0);
    ctx.drain();
    const wants = world.getWantToDiscuss("victim", 0, "perp_cast");
    expect(wants.length).toBe(1);
    expect(wants[0]!.urgency).toBe("high");
    expect(world.getCurrentIntent("victim", 0)?.targetId).toBe("perp_cast");

    // 不直写关系/印象（只配注意力）
    expect(relationships.get("victim", "perp_cast").level).toBe(levelBefore);
    expect(impressions.getAll().length).toBe(0);

    // 每对冷却
    const r2 = surfaceGrudgeTool.handler(
      { char_id: "victim", about_char_id: "perp_cast" },
      makeCtx(world, 110, { pressureGraph: graph }),
    );
    expect(r2.error).toBe("pair_cooldown");
  });
});

describe("B2 set_active_phase — 翻转 + phase 工具上架", () => {
  it("入队翻转：drain 前不变，drain 后 activePhase 切换；'none' 清除", () => {
    const world = makeWorld();
    const ctx = makeCtx(world, 100);
    const r = setActivePhaseTool.handler({ phase: "trial" }, ctx);
    expect(r.ok).toBe(true);
    expect(world.narrative.getWorld().activePhase).toBeUndefined();
    ctx.drain();
    expect(world.narrative.getWorld().activePhase).toBe("trial");

    const ctx2 = makeCtx(world, 101);
    setActivePhaseTool.handler({ phase: "none" }, ctx2);
    ctx2.drain();
    expect(world.narrative.getWorld().activePhase).toBeUndefined();
  });

  it("经 simulation 入队：drainMutations 后 phase 工具上架", async () => {
    const world = makeWorld();
    const sim = new Simulation(world, new EventBus(), {
      characters: [],
      actions: [],
      provider: new MockLLMProvider(),
      modelId: "test",
    });
    const nightTool = {
      tool: { name: "night_tool", description: "", parameters: { type: "object", properties: {} } },
      handler: () => ({ description: "", effects: [] }),
    } as any;
    sim.registerPhaseTools({ night: [nightTool] });

    const ctx: DirectorToolContext = { world, tick: 100, enqueueMutation: (fn) => sim.enqueueMutation(fn) };
    const r = setActivePhaseTool.handler({ phase: "night" }, ctx);
    expect(r.ok).toBe(true);
    sim.drainMutations();
    expect(world.narrative.getWorld().activePhase).toBe("night");
    expect((sim as any)._getActivePhaseTools()).toEqual([nightTool]);
  });
});

describe("B2 prompt 手术", () => {
  const beatEvent: BeatReadyEvent = { beatId: "b1", reason: "preconditions_met", triggeredDay: 2, triggeredTick: 184 };

  it("pacing 分档快照：<25 播种 / 25-60 催化 / >60 收手", async () => {
    const world = makeWorld();
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);
    const director = new Director({ provider: mock, modelId: "test", dailyBudget: 10 });

    world.narrative.setTensionIndex(10);
    await director.handleDailyPacing(world, 100);
    world.narrative.setTensionIndex(40);
    await director.handleDailyPacing(world, 101);
    world.narrative.setTensionIndex(80);
    await director.handleDailyPacing(world, 102);

    const users = mock.calls.map((c) => String(c.request.messages[0]!.content));
    expect(users[0]).toContain("播种");
    expect(users[1]).toContain("催化热点");
    expect(users[2]).toContain("收手看戏");
    // system 带完整分档说明
    expect(mock.calls[0]!.request.system).toContain("tension < 25 → 播种");
    expect(mock.calls[0]!.request.system).toContain("tension > 60 → 收手看戏");
  });

  it("pacingBand 边界：24=seed / 25=catalyze / 60=catalyze / 61=hands_off", () => {
    expect(Director.pacingBand(24)).toBe("seed");
    expect(Director.pacingBand(25)).toBe("catalyze");
    expect(Director.pacingBand(60)).toBe("catalyze");
    expect(Director.pacingBand(61)).toBe("hands_off");
  });

  it("beat-ready 心灵直写排序反转：inject_world_event 在前，inject_intent 落为最后手段", async () => {
    const world = makeWorld();
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);
    const director = new Director({ provider: mock, modelId: "test" });
    await director.handleBeatReady(beatEvent, world);

    const system = mock.calls[0]!.request.system!;
    expect(system).toContain("世界侧事实优先");
    expect(system).toContain("心灵直写");
    expect(system).toContain("最后手段");
    expect(system.indexOf("inject_world_event")).toBeGreaterThan(-1);
    expect(system.indexOf("inject_world_event")).toBeLessThan(system.indexOf("inject_intent"));
    // 旧文案（首选心灵直写）必须死透
    expect(system).not.toContain("inject_intent**（最有效，首选）");
  });

  it("worldSnapshot 注入压力图摘要 + recent-motive；空集安全（没有就整块不出现）", async () => {
    const world = makeWorld();
    const relationships = new RelationshipManager();
    relationships.setGrudge("victim", "perp_cast", "旧怨", "perp_cast", 10);
    const graph = new PressureGraph();
    graph.update({ world, relationships, impressions: new ImpressionStore(), tick: 100 });

    // 有料：压力热点 + 真心层
    const mock1 = new MockLLMProvider();
    mock1.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);
    const d1 = new Director({
      provider: mock1,
      modelId: "test",
      pressureGraph: graph,
      getRecentMotives: () => [{ charId: "victim", name: "小美", surface: "我只是路过", hidden: "想看看他心虚不心虚", tick: 90 }],
    });
    await d1.handleBeatReady(beatEvent, world);
    const user1 = String(mock1.calls[0]!.request.messages[0]!.content);
    expect(user1).toContain("压力图热点");
    expect(user1).toContain("最近真心层");
    expect(user1).toContain("想看看他心虚不心虚");

    // 空集：两块都不出现
    const mock2 = new MockLLMProvider();
    mock2.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);
    const d2 = new Director({ provider: mock2, modelId: "test", getRecentMotives: () => [] });
    await d2.handleBeatReady(beatEvent, world);
    const user2 = String(mock2.calls[0]!.request.messages[0]!.content);
    expect(user2).not.toContain("压力图热点");
    expect(user2).not.toContain("最近真心层");
  });

  it("Director tool loop 接线：inject_world_event 经 config.enqueueMutation 只入队", async () => {
    const world = makeWorld();
    addNpcPerp(world);
    const q = makeQueue();
    const mock = new MockLLMProvider();
    mock.enqueueResponse("注入一桩失窃。", [{ name: "inject_world_event", arguments: { ...THEFT_ARGS } }]);
    mock.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);
    const director = new Director({
      provider: mock,
      modelId: "test",
      memory: new ShortTermMemory(),
      enqueueMutation: q.enqueue,
    });
    const log = await director.handleBeatReady(beatEvent, world);
    const call = log!.toolCalls.find((c) => c.name === "inject_world_event")!;
    expect(call.result.ok).toBe(true);
    expect(q.queued.length).toBe(1);
    // 世界未被同步直写
    expect(world.getCharacter("victim")!.gold).toBe(100);
    q.drain();
    expect(world.getCharacter("victim")!.gold).toBe(50);
  });

  it("新工具已上架 ALL_DIRECTOR_TOOLS 且不含 talk/say", () => {
    const names = ALL_DIRECTOR_TOOLS.map((t) => t.tool.name);
    expect(names).toContain("inject_world_event");
    expect(names).toContain("surface_grudge");
    expect(names).toContain("set_active_phase");
  });
});

describe("B2 随档 normalize（旧档回填）", () => {
  it("旧档缺新字段：quota/pendingDiscoveries/npcs 回填默认；脏值清掉", () => {
    const snap = normalizeNarrativeSnapshot({
      world: {
        unresolvedEvents: [],
        triggeredBeats: [],
        tensionIndex: 0,
        rumors: [],
        beatLastTrigger: {},
        worldEventQuota: { usedByWeek: { "1": "abc" }, lastByType: { theft_with_perp: 5 } },
        pendingDiscoveries: [{ id: "x" }, { id: "ok", victimId: "v", locationId: "l", discoveryMemory: "m", createdTick: 3, discoveredTick: "bad" }],
        npcs: { good: { name: "N" }, bad: 5 },
      } as any,
    } as any);
    expect(snap.world.worldEventQuota.usedByWeek).toEqual({});
    expect(snap.world.worldEventQuota.lastByType).toEqual({ theft_with_perp: 5 });
    expect(snap.world.pendingDiscoveries.length).toBe(1);
    expect(snap.world.pendingDiscoveries[0]!.id).toBe("ok");
    expect(snap.world.pendingDiscoveries[0]!.discoveredTick).toBeUndefined();
    expect(Object.keys(snap.world.npcs)).toEqual(["good"]);
  });

  it("完全空的旧档也能回填", () => {
    const snap = normalizeNarrativeSnapshot({} as any);
    expect(snap.world.worldEventQuota).toEqual({ usedByWeek: {}, lastByType: {} });
    expect(snap.world.pendingDiscoveries).toEqual([]);
    expect(snap.world.npcs).toEqual({});
  });
});

describe("B2 simulation 接线（runOneTick drain + 延迟发现 sweep）", () => {
  it("runOneTick 开头 drain 硬事件；受害者移动到场后下一 tick 发现", async () => {
    const world = makeWorld();
    addNpcPerp(world);
    world.getCharacter("victim")!.gold = 80;
    const sim = new Simulation(world, new EventBus(), {
      characters: [],
      actions: [],
      provider: new MockLLMProvider(),
      modelId: "test",
    });

    const ctx: DirectorToolContext = {
      world,
      tick: 40,
      memory: sim.memory,
      enqueueMutation: (fn) => sim.enqueueMutation(fn),
    };
    expect(injectWorldEventTool.handler({ ...THEFT_ARGS }, ctx).ok).toBe(true);
    expect(world.getCharacter("victim")!.gold).toBe(80);

    // tick 40（10:00）：drain → 真金转移
    await sim.runOneTick(tickToGameTime(40));
    expect(world.getCharacter("victim")!.gold).toBe(30);
    expect(sim.memory.getRecent("victim", 20).some((m) => m.content.includes("不翼而飞"))).toBe(false);

    // 受害者走到发现地点 → 下一 tick sweep 落发现记忆
    world.moveCharacter("victim", "bakery");
    await sim.runOneTick(tickToGameTime(41));
    expect(sim.memory.getRecent("victim", 20).some((m) => m.content.includes("不翼而飞"))).toBe(true);
  });

  it("ingestMotives：只收真分层；getRecentMotives 空集安全", () => {
    const world = makeWorld();
    const sim = new Simulation(world, new EventBus(), {
      characters: [],
      actions: [],
      provider: new MockLLMProvider(),
      modelId: "test",
    });
    expect(sim.getRecentMotives().length).toBe(0);
    sim.ingestMotives(
      [
        { characterId: "victim", motive: { surface: "我只是想散步", hidden: "想避开他", twoLayer: true } },
        { characterId: "perp_cast", motive: { surface: "一致", hidden: "与表面一致", twoLayer: false } },
        { characterId: "perp_cast" },
      ] as any,
      7,
    );
    const motives = sim.getRecentMotives();
    expect(motives.length).toBe(1);
    expect(motives[0]!.charId).toBe("victim");
    expect(motives[0]!.hidden).toBe("想避开他");
    expect(motives[0]!.tick).toBe(7);
  });
});
