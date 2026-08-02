/**
 * Pressure Graph 单测（DESIGN-revival §8 A 行：锁形状不锁数值）
 *
 * - 单边注入 → pair 单调不减
 * - clamp 0-100
 * - char 公式形状（max*0.7 + avg(top3)*0.3 + personal）
 * - update 幂等
 * - pressure 落 narrative_state 且 jexl 可读
 * - tension 可达 >40（杀 director pacing "tension > 40" 永假回归）
 * - 爽约派生计数（双爽约不计入）
 * - valence 环形缓冲（impression-updater 落地处回调）
 */

import { describe, it, expect } from "vitest";
import {
  PressureGraph,
  computePairPressure,
  computeCharPressure,
  countMissedAppointmentsByPair,
} from "./pressure-graph.js";
import { buildBeatContext, evaluateExpression } from "./expression.js";
import { World } from "../world/world.js";
import { RelationshipManager } from "../world/relationships.js";
import { ImpressionStore } from "../memory/impressions.js";
import { updateImpressionsBidirectional } from "../agent/impression-updater.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { Appointment } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

function makeWorld(tick = 0): World {
  const world = new World(TEST_LOCATIONS, tick);
  world.addCharacter("tomori", "高松灯", "cafe");
  world.addCharacter("anon", "千早爱音", "cafe");
  world.addCharacter("soyo", "长崎素世", "plaza");
  return world;
}

function friction(impressions: ImpressionStore, observer: string, target: string, frictions: string[]): void {
  impressions.set(observer, {
    characterId: target,
    summary: "有点疙瘩",
    observations: [],
    mentalLabel: "难说",
    unresolved: [],
    frictions,
    lastUpdated: 0,
  });
}

function appointment(id: string, a: string, b: string, over: Partial<Appointment> = {}): Appointment {
  return {
    id, proposerId: a, targetId: b, locationId: "cafe",
    atTick: 10, status: "pending", createdTick: 0, ...over,
  };
}

describe("computePairPressure（公式 v1 形状）", () => {
  const zero = { frictions: 0, grudge: false, debtOverdueDays: 0, missedAppointments: 0, level: 0, activeOpenStances: 0 };

  it("零输入 → 0", () => {
    expect(computePairPressure(zero)).toBe(0);
  });

  it("每个来源单独注入都抬压力", () => {
    expect(computePairPressure({ ...zero, frictions: 1 })).toBeGreaterThan(0);
    expect(computePairPressure({ ...zero, grudge: true })).toBeGreaterThan(0);
    expect(computePairPressure({ ...zero, debtOverdueDays: 1 })).toBeGreaterThan(0);
    expect(computePairPressure({ ...zero, missedAppointments: 1 })).toBeGreaterThan(0);
    expect(computePairPressure({ ...zero, level: -10 })).toBeGreaterThan(0);
    expect(computePairPressure({ ...zero, activeOpenStances: 1 })).toBeGreaterThan(0);
  });

  it("正 level 不贡献压力（只有敌意计入）", () => {
    expect(computePairPressure({ ...zero, level: 80 })).toBe(0);
  });

  it("clamp 0-100", () => {
    expect(computePairPressure({ ...zero, frictions: 50 })).toBe(100);
    expect(computePairPressure({ ...zero, debtOverdueDays: -5 })).toBe(0);
  });

  it("注入单调不减", () => {
    const p1 = computePairPressure({ ...zero, frictions: 1 });
    const p2 = computePairPressure({ ...zero, frictions: 2 });
    const p3 = computePairPressure({ ...zero, frictions: 2, grudge: true });
    expect(p2).toBeGreaterThanOrEqual(p1);
    expect(p3).toBeGreaterThanOrEqual(p2);
  });
});

describe("computeCharPressure（char 公式形状）", () => {
  it("无 pair 时只剩 personal，clamp 0-100", () => {
    expect(computeCharPressure([], 0)).toBe(0);
    expect(computeCharPressure([], 12)).toBe(12);
    expect(computeCharPressure([], 500)).toBe(100);
  });

  it("char = max*0.7 + avg(top3)*0.3 + personal", () => {
    // 单 pair：max=avg → 等于 pair 值
    expect(computeCharPressure([50], 0)).toBe(50);
    // 多 pair 只取 top3 进 avg
    const v = computeCharPressure([60, 40, 20, 5], 0);
    expect(v).toBeCloseTo(60 * 0.7 + ((60 + 40 + 20) / 3) * 0.3, 5);
  });

  it("加 pair 单调不减", () => {
    const base = computeCharPressure([30], 0);
    const more = computeCharPressure([30, 30], 0);
    expect(more).toBeGreaterThanOrEqual(base);
  });
});

describe("爽约派生计数（§4.5 不加新计数器）", () => {
  it("单方爽约计入、双爽约/pending/kept 不计入", () => {
    const appts: Appointment[] = [
      appointment("a1", "tomori", "anon", { status: "missed", missedBy: "anon" }),
      appointment("a2", "tomori", "anon", { status: "missed", missedBy: "tomori" }),
      appointment("a3", "tomori", "anon", { status: "missed" }),            // 双爽约：无 missedBy
      appointment("a4", "tomori", "anon", { status: "kept" }),
      appointment("a5", "tomori", "soyo", { status: "pending" }),
    ];
    const counts = countMissedAppointmentsByPair(appts);
    expect(counts["anon:tomori"]).toBe(2);
    expect(counts["soyo:tomori"]).toBeUndefined();
  });

  it("markAppointment 单方爽约记 missedBy、双爽约不记", () => {
    const world = makeWorld();
    world.addAppointment(appointment("x1", "tomori", "anon"));
    world.markAppointment("x1", "missed", "anon");
    expect(world.getAllAppointments().find((a) => a.id === "x1")!.missedBy).toBe("anon");
    world.addAppointment(appointment("x2", "tomori", "anon", { atTick: 20 }));
    world.markAppointment("x2", "missed");
    expect(world.getAllAppointments().find((a) => a.id === "x2")!.missedBy).toBeUndefined();
  });
});

describe("PressureGraph.update（三路输出）", () => {
  it("单边注入疙瘩 → pair 出现且单调不减", () => {
    const world = makeWorld();
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();

    friction(impressions, "tomori", "anon", ["上次被放了鸽子"]);
    const r1 = graph.update({ world, relationships, impressions, tick: 0 });
    const p1 = r1.pairs.find((p) => p.a === "anon" && p.b === "tomori");
    expect(p1).toBeDefined();
    expect(p1!.pressure).toBeGreaterThan(0);

    friction(impressions, "tomori", "anon", ["上次被放了鸽子", "又阴阳怪气"]);
    const r2 = graph.update({ world, relationships, impressions, tick: 0 });
    const p2 = r2.pairs.find((p) => p.a === "anon" && p.b === "tomori");
    expect(p2!.pressure).toBeGreaterThanOrEqual(p1!.pressure);
  });

  it("update 幂等：同一世界状态重算结果一致", () => {
    const world = makeWorld();
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();
    friction(impressions, "tomori", "anon", ["疙瘩1", "疙瘩2"]);
    relationships.setGrudge("tomori", "anon", "吵翻了", "anon", 0);

    const r1 = graph.update({ world, relationships, impressions, tick: 100 });
    const r2 = graph.update({ world, relationships, impressions, tick: 100 });
    expect(r2.charPressures).toEqual(r1.charPressures);
    expect(r2.tension).toBe(r1.tension);
    expect(r2.pairs).toEqual(r1.pairs);
  });

  it("pressure 回写 narrative_state 且 jexl 可读", () => {
    const world = makeWorld();
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();
    friction(impressions, "tomori", "anon", ["a", "b", "c"]);
    relationships.setGrudge("tomori", "anon", "积怨", "anon", 0);

    graph.update({ world, relationships, impressions, tick: 0 });

    expect(world.narrative.getCharacter("tomori").pressure).toBeGreaterThan(0);
    const ctx = buildBeatContext({
      narrative: world.narrative.getSnapshot(),
      tick: 0,
      characterRelationships: {},
      characterNeeds: {},
      characterLocations: {},
    });
    expect(evaluateExpression("characters.tomori.pressure > 20", ctx)).toBe(true);
  });

  it("债务过宽限期才计入", () => {
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();

    // 宽限期内（欠 1 天）：无压力边
    const early = makeWorld(96);
    early.getCharacter("tomori")!.debts = [{ lenderId: "anon", amount: 30, borrowedTick: 0 }];
    expect(graph.update({ world: early, relationships, impressions, tick: 96 }).pairs.length).toBe(0);

    // 逾期（欠 5 天，宽限 2 天）：出边
    const late = makeWorld(96 * 5);
    late.getCharacter("tomori")!.debts = [{ lenderId: "anon", amount: 30, borrowedTick: 0 }];
    const r = graph.update({ world: late, relationships, impressions, tick: 96 * 5 });
    const pair = r.pairs.find((p) => p.a === "anon" && p.b === "tomori");
    expect(pair).toBeDefined();
    expect(pair!.inputs.debtOverdueDays).toBeGreaterThan(0);
  });

  it("tension 可达 >40（integration：unresolved+压力对+干旱）", () => {
    const world = makeWorld(96 * 2); // day 3，从无 beat 触发 → 干旱拉满
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();

    for (let i = 0; i < 3; i++) {
      world.narrative.addUnresolvedEvent({ id: `e${i}`, summary: "未解决", involved: ["tomori", "anon"], visibleTo: "*", createdTick: 0 });
    }
    friction(impressions, "tomori", "anon", ["a", "b", "c"]);
    friction(impressions, "anon", "tomori", ["x", "y"]);
    relationships.setGrudge("tomori", "anon", "积怨", "anon", 0);
    relationships.set("tomori", "soyo", -30, "rival");
    world.addAppointment(appointment("m1", "tomori", "anon"));
    world.markAppointment("m1", "missed", "anon");

    const r = graph.update({ world, relationships, impressions, tick: 96 * 2 });
    expect(r.tension).toBeGreaterThan(40);
    expect(world.narrative.getWorld().tensionIndex).toBe(r.tension);
  });

  it("边消失后压力回落（重算不是累加器）", () => {
    const world = makeWorld();
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();
    relationships.setGrudge("tomori", "anon", "吵架", "anon", 0);
    const withGrudge = graph.update({ world, relationships, impressions, tick: 0 });
    expect(withGrudge.charPressures.tomori).toBeGreaterThan(0);

    relationships.clearGrudge("tomori", "anon");
    const after = graph.update({ world, relationships, impressions, tick: 0 });
    expect(after.charPressures.tomori).toBe(0);
    expect(world.narrative.getCharacter("tomori").pressure).toBe(0);
  });

  it("热点摘要：有热点出白描、无热点空串", () => {
    const world = makeWorld();
    const relationships = new RelationshipManager();
    const impressions = new ImpressionStore();
    const graph = new PressureGraph();

    expect(graph.formatHotspotSummary(world)).toBe("");
    friction(impressions, "tomori", "anon", ["疙瘩"]);
    relationships.setGrudge("tomori", "anon", "积怨", "anon", 0);
    graph.update({ world, relationships, impressions, tick: 0 });
    const summary = graph.formatHotspotSummary(world);
    expect(summary).toContain("高松灯");
    expect(summary).toContain("千早爱音");
    expect(summary).toContain("压力");
  });
});

describe("valence 环形缓冲（§4.5 内存态近窗信号）", () => {
  it("recordValence 记入、windowValence 按对/按窗聚合", () => {
    const graph = new PressureGraph();
    graph.recordValence("tomori", "anon", -2, 100);
    graph.recordValence("anon", "tomori", -1, 104); // 顺序无关，同一对
    graph.recordValence("tomori", "soyo", 3, 104);
    expect(graph.windowValence("tomori", "anon", 110)).toBe(-3);
    expect(graph.windowValence("soyo", "tomori", 110)).toBe(3);
    // 窗口外的不算（now=106、窗 4 tick：tick=100 的被排除，tick=104 的保留）
    expect(graph.windowValence("tomori", "anon", 106, 4)).toBe(-1);
  });

  it("volatility 0..1，无样本为 0", () => {
    const graph = new PressureGraph();
    expect(graph.computeVolatility(100)).toBe(0);
    graph.recordValence("a", "b", 3, 100);
    graph.recordValence("a", "b", -3, 100);
    const v = graph.computeVolatility(100);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("环形缓冲有容量上限", () => {
    const graph = new PressureGraph();
    for (let i = 0; i < 500; i++) {
      graph.recordValence("a", "b", 1, i);
    }
    expect(graph.getValenceBuffer().length).toBeLessThanOrEqual(256);
    // 留下的是最新的
    const last = graph.getValenceBuffer()[graph.getValenceBuffer().length - 1]!;
    expect(last.tick).toBe(499);
  });

  it("impression-updater 关系落地处回调把 valence 写入缓冲", async () => {
    const provider = new MockLLMProvider();
    const impResponse = "总结：他今天很冲\n观察：说话夹枪带棒\n标签：难缠\n态度：-3";
    provider.enqueueResponse(impResponse);
    provider.enqueueResponse(impResponse);

    const card = (id: string, name: string): CharacterCard => ({
      id, name, age: 19, occupation: "学徒",
      personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
      background: "测试", relationships: {},
    });

    const graph = new PressureGraph();
    const impressions = new ImpressionStore();
    await updateImpressionsBidirectional({
      cardA: card("tomori", "高松灯"),
      cardB: card("anon", "千早爱音"),
      exchanges: [
        { speakerId: "tomori", speakerName: "高松灯", message: "你怎么又迟到", tick: 10 },
        { speakerId: "anon", speakerName: "千早爱音", message: "关你什么事", tick: 10 },
      ],
      impressions,
      provider,
      modelId: "mock",
      tick: 12,
      onValence: (a, b, valence, tick) => graph.recordValence(a, b, valence, tick),
    });

    const buffer = graph.getValenceBuffer();
    expect(buffer.length).toBe(1);
    expect(buffer[0]!.valence).toBe(-6); // 双方各 -3 求和
    expect(buffer[0]!.tick).toBe(12);
    expect(graph.windowValence("tomori", "anon", 12)).toBe(-6);
  });
});
