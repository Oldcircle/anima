/**
 * 出货 beat 必触发单测（DESIGN-revival §4 / §8 D 行）：
 * 每条出货 beat 构造"应触发状态" → BeatEngine.scan 必须点火；
 * 关键 beat 附反例（状态不足 → 不触发），杀"表达式写错静默 false"与"首扫即火假绿灯"两类回归。
 * 表达式 lint 由 loadScenario 内置 fail loud（加载即验，另有 beat-b4 全剧本回归兜底）。
 *
 * 附：default 剧本包完整性（manifest 字段 / seeds 信息图可见性 / asuka 被弃真相挪出卡文）
 * 与 default-verify 预热标定（种子压力必须落在阈值 45 下方）。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadScenario, type LoadedScenario } from "./scenario-loader.js";
import { BeatEngine, getBeatCooldownTicks, type BeatDefinition } from "./beat-engine.js";
import { buildSyntheticBeatContext, type BeatContext } from "./expression.js";
import { Simulation } from "../agent/simulation.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

const projectRoot = join(import.meta.dirname, "..", "..");

const defaultScenario = loadScenario("default", { projectRoot });
const verifyScenario = loadScenario("default-verify", { projectRoot });
const kiraScenario = loadScenario("kira-incident", { projectRoot });

function beatById(scenario: LoadedScenario, id: string): BeatDefinition {
  const def = scenario.beats.find((b) => b.id === id);
  expect(def, `beat ${id} 应存在于 ${scenario.manifest.id}`).toBeDefined();
  return def!;
}

/** 构造合成 context（真实 cast id）+ 定点改写；world.day/hour/tick 三者按 day/hour 对齐 */
function ctxFor(
  scenario: LoadedScenario,
  mutate?: (ctx: BeatContext) => void,
  time?: { day: number; hour: number },
): BeatContext {
  const ctx = buildSyntheticBeatContext(scenario.characters.map((c) => c.id));
  if (time) {
    ctx.world.day = time.day;
    ctx.world.hour = time.hour;
    ctx.world.tick = (time.day - 1) * 96 + time.hour * 4;
  }
  mutate?.(ctx);
  return ctx;
}

/** 单条 beat 扫描：应触发 → 返回事件；不触发 → undefined */
function scanOne(def: BeatDefinition, ctx: BeatContext) {
  return new BeatEngine([def]).scan(ctx)[0];
}

// ────────── default 本体 beats ──────────

describe("default 本体 beats：构造应触发状态 → 必触发", () => {
  it("default_hotspot_boils：top 压力对 ≥60 触发；种子水位 40 不触发（cooldown 型）", () => {
    const def = beatById(defaultScenario, "default_hotspot_boils");
    expect(getBeatCooldownTicks(def)).toBe(192);
    const hot = ctxFor(defaultScenario, (c) => {
      c.extras!.pressure.topPairs = [{ a: "asuka", b: "shinji", pressure: 65 }];
    });
    expect(scanOne(def, hot)?.reason).toBe("preconditions_met");
    const cold = ctxFor(defaultScenario, (c) => {
      c.extras!.pressure.topPairs = [{ a: "asuka", b: "shinji", pressure: 40 }];
    });
    expect(scanOne(def, cold)).toBeUndefined();
  });

  it("default_asuka_edge：asuka 压力 ≥55 触发，默认 42 不触发", () => {
    const def = beatById(defaultScenario, "default_asuka_edge");
    expect(getBeatCooldownTicks(def)).toBe(288);
    const hot = ctxFor(defaultScenario, (c) => {
      c.extras!.charPressures.asuka = 58;
    });
    expect(scanOne(def, hot)?.reason).toBe("preconditions_met");
    expect(scanOne(def, ctxFor(defaultScenario))).toBeUndefined();
    expect(def.auto_seeds?.[0]?.char).toBe("asuka");
    expect(def.auto_seeds?.[0]?.urgency).toBe("high");
  });

  it("default_shinji_breaking_point：shinji 压力 ≥55 触发", () => {
    const def = beatById(defaultScenario, "default_shinji_breaking_point");
    const hot = ctxFor(defaultScenario, (c) => {
      c.extras!.charPressures.shinji = 60;
    });
    expect(scanOne(def, hot)?.reason).toBe("preconditions_met");
    expect(scanOne(def, ctxFor(defaultScenario))).toBeUndefined();
  });

  it("default_senjougahara_money_dread：day≥2 且金币 ≤60 触发；金币 100 不触发", () => {
    const def = beatById(defaultScenario, "default_senjougahara_money_dread");
    const broke = ctxFor(defaultScenario, (c) => {
      c.extras!.gold.senjougahara = 45;
    });
    expect(scanOne(def, broke)?.reason).toBe("preconditions_met");
    expect(scanOne(def, ctxFor(defaultScenario))).toBeUndefined(); // 合成默认金币 100
  });

  it("default_lelouch_wire_deadline：day3 08:00 起触发（deadline 保底带 fallback）", () => {
    const def = beatById(defaultScenario, "default_lelouch_wire_deadline");
    expect(def.fallback_deadline_day).toBe(3);
    expect(scanOne(def, ctxFor(defaultScenario, undefined, { day: 3, hour: 9 }))?.reason).toBe("preconditions_met");
    expect(scanOne(def, ctxFor(defaultScenario, undefined, { day: 2, hour: 12 }))).toBeUndefined();
    expect(def.auto_seeds?.[0]?.char).toBe("lelouch");
  });

  it("default_shinji_envelope_surfaces：day4 07:00 起触发", () => {
    const def = beatById(defaultScenario, "default_shinji_envelope_surfaces");
    expect(def.fallback_deadline_day).toBe(4);
    expect(scanOne(def, ctxFor(defaultScenario, undefined, { day: 4, hour: 8 }))?.reason).toBe("preconditions_met");
    expect(scanOne(def, ctxFor(defaultScenario, undefined, { day: 3, hour: 8 }))).toBeUndefined();
    expect(def.auto_seeds?.[0]?.char).toBe("shinji");
  });
});

// ────────── default-verify beats ──────────

describe("default-verify beats：构造应触发状态 → 必触发", () => {
  it("verify_d1_crime：day1 09:00 触发，auto_events 是 fate 机械载荷（不赌导演）", () => {
    const def = beatById(verifyScenario, "verify_d1_crime");
    expect(def.fallback_deadline_day).toBe(1);
    const ev = scanOne(def, ctxFor(verifyScenario, undefined, { day: 1, hour: 9 }));
    expect(ev?.reason).toBe("preconditions_met");
    const autoEvents = ev?.payload?.auto_events as Array<Record<string, unknown>>;
    expect(Array.isArray(autoEvents)).toBe(true);
    expect(autoEvents[0]!.type).toBe("fate");
    expect(autoEvents[0]!.target).toBe("senjougahara");
    const fate = autoEvents[0]!.fate as Record<string, unknown>;
    expect(typeof fate.template).toBe("string");
    expect((fate.goldDelta as Record<string, unknown>).kind).toBe("flat");
    // 08:00 还不到点（fallback 也要等 day1 20:00）
    expect(scanOne(def, ctxFor(verifyScenario, undefined, { day: 1, hour: 8 }))).toBeUndefined();
  });

  it("verify_d1_showdown：day1 10:00 触发，auto_seeds 定向摊牌（asuka→shinji high）", () => {
    const def = beatById(verifyScenario, "verify_d1_showdown");
    const ev = scanOne(def, ctxFor(verifyScenario, undefined, { day: 1, hour: 10 }));
    expect(ev?.reason).toBe("preconditions_met");
    expect(def.auto_seeds).toHaveLength(1);
    expect(def.auto_seeds![0]).toMatchObject({ char: "asuka", target: "shinji", urgency: "high" });
  });

  it("verify_pressure_spike：≥45 触发；种子水位 42 不触发（阈值下方标定回归）", () => {
    const def = beatById(verifyScenario, "verify_pressure_spike");
    expect(getBeatCooldownTicks(def)).toBe(96);
    const hot = ctxFor(verifyScenario, (c) => {
      c.extras!.pressure.topPairs = [{ a: "senjougahara", b: "lelouch", pressure: 46 }];
    });
    expect(scanOne(def, hot)?.reason).toBe("preconditions_met");
    const seeded = ctxFor(verifyScenario, (c) => {
      c.extras!.pressure.topPairs = [{ a: "senjougahara", b: "lelouch", pressure: 42 }];
    });
    expect(scanOne(def, seeded)).toBeUndefined();
  });
});

// ────────── kira 后续幕 beats ──────────

describe("kira 后续幕 beats：状态条件（应验后/第二例后/拆穿后）", () => {
  it("kira_aftermath_first_victim：victimCount ≥1 触发，0 不触发", () => {
    const def = beatById(kiraScenario, "kira_aftermath_first_victim");
    const after = ctxFor(kiraScenario, (c) => {
      c.extras!.kira.victimCount = 1;
    });
    expect(scanOne(def, after)?.reason).toBe("preconditions_met");
    expect(scanOne(def, ctxFor(kiraScenario))).toBeUndefined(); // 合成默认 victimCount 0
  });

  it("kira_aftermath_pattern_talk：victimCount ≥2 触发，1 不触发", () => {
    const def = beatById(kiraScenario, "kira_aftermath_pattern_talk");
    const two = ctxFor(kiraScenario, (c) => {
      c.extras!.kira.victimCount = 2;
    });
    expect(scanOne(def, two)?.reason).toBe("preconditions_met");
    const one = ctxFor(kiraScenario, (c) => {
      c.extras!.kira.victimCount = 1;
    });
    expect(scanOne(def, one)).toBeUndefined();
  });

  it("kira_after_expose_showdown：应验≥1 且 L↔light 有未了结账才触发（任一方向）", () => {
    const def = beatById(kiraScenario, "kira_after_expose_showdown");
    const exposed = ctxFor(kiraScenario, (c) => {
      c.extras!.kira.victimCount = 1;
      c.characters.light!.unresolvedWith = { l_lawliet: ["kira_accusation"] };
    });
    expect(scanOne(def, exposed)?.reason).toBe("preconditions_met");
    // 反向账（L 记着 light）也触发
    const reverse = ctxFor(kiraScenario, (c) => {
      c.extras!.kira.victimCount = 1;
      c.characters.l_lawliet!.unresolvedWith = { light: ["confrontation"] };
    });
    expect(scanOne(def, reverse)?.reason).toBe("preconditions_met");
    // 只有应验没有对峙 → 不触发；只有对峙没有应验 → 不触发
    const onlyVictim = ctxFor(kiraScenario, (c) => {
      c.extras!.kira.victimCount = 1;
    });
    expect(scanOne(def, onlyVictim)).toBeUndefined();
    const onlyStance = ctxFor(kiraScenario, (c) => {
      c.characters.light!.unresolvedWith = { l_lawliet: ["kira_accusation"] };
    });
    expect(scanOne(def, onlyStance)).toBeUndefined();
  });
});

// ────────── default 剧本包完整性 ──────────

describe("default 剧本包（D 件）", () => {
  it("manifest：mild + third + crime_supply=cast（S7 字段先解析存好）", () => {
    expect(defaultScenario.manifest.breakLevel).toBe("mild");
    expect(defaultScenario.manifest.decisionPov).toBe("third");
    expect(defaultScenario.manifest.crimeSupply).toEqual({ mode: "cast" });
  });

  it("seeds 信息图：asuka 被弃真相 visible_to 不含本人；三条私有钩子只对本人可见", () => {
    const byId = Object.fromEntries(defaultScenario.seeds!.unresolvedEvents!.map((e) => [e.id, e]));
    expect(byId.asuka_abandonment_truth!.visibleTo).toEqual(["lelouch"]);
    expect(byId.asuka_abandonment_truth!.visibleTo).not.toContain("asuka");
    expect(byId.senjougahara_collection_deadline!.visibleTo).toEqual(["senjougahara"]);
    expect(byId.lelouch_cipher_silence!.visibleTo).toEqual(["lelouch"]);
    expect(byId.shinji_father_thread!.visibleTo).toEqual(["shinji"]);
  });

  it("asuka.yml 卡文回归：被弃真相已挪出（卡片对本人可见，真相不能写在卡里）", () => {
    const raw = readFileSync(join(projectRoot, "data", "characters", "asuka.yml"), "utf-8");
    expect(raw).not.toContain("父亲的女友");
    expect(raw).not.toContain("嫌她碍事");
    // 主观感受保留（她隐约觉得被抛弃——这是她的真实体感，不是真相本身）
    expect(raw).toContain("被抛弃");
  });
});

// ────────── default-verify 预热标定（seeds ↔ 阈值联动锁） ──────────

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

describe("default-verify 预热标定", () => {
  it("manifest：decision_pov 必须 third（motive 缓冲依赖）+ mild + crime_supply", () => {
    expect(verifyScenario.manifest.decisionPov).toBe("third");
    expect(verifyScenario.manifest.breakLevel).toBe("mild");
    expect(verifyScenario.manifest.crimeSupply).toEqual({ mode: "cast" });
  });

  it("applySeeds 真实落账后：两对种子压力 = 40/42，全部低于阈值 45（防首扫即火假绿灯）", () => {
    const startTick = 24;
    const ids = verifyScenario.characters.map((c) => c.id);
    const world = new World(fakeLocations, startTick);
    for (const id of ids) world.addCharacter(id, id, "park");
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("", []);
    const sim = new Simulation(world, new EventBus(), {
      characters: ids.map((id) => makeCard(id, id)),
      actions: ALL_BASIC_ACTIONS,
      provider: mock,
      modelId: "test",
    });
    sim.applySeeds(verifyScenario.seeds!);

    // 逾期债真实落账（borrowedTick 在过去 4 天）
    const shinjiDebts = world.getCharacter("shinji")!.debts!;
    expect(shinjiDebts[0]).toMatchObject({ lenderId: "asuka", amount: 15 });
    expect(shinjiDebts[0]!.borrowedTick).toBe(startTick - 4 * 96);
    // 立场真实落账且在 3 天活动窗内
    expect(world.narrative.getActiveOpenStances("senjougahara", "lelouch")).toHaveLength(1);

    sim.pressureGraph.update({
      world,
      relationships: sim.relationships,
      impressions: sim.impressions,
      tick: startTick,
    });
    const asukaShinji = sim.pressureGraph.getPairPressure("asuka", "shinji");
    const senLelouch = sim.pressureGraph.getPairPressure("senjougahara", "lelouch");
    expect(asukaShinji?.pressure).toBe(40);
    expect(senLelouch?.pressure).toBe(42);
    for (const p of sim.pressureGraph.getTopPairs(10)) {
      expect(p.pressure, `${p.a}:${p.b} 种子压力必须低于阈值 45`).toBeLessThan(45);
    }

    // 用真实种子压力构造 extras → verify_pressure_spike 首扫必须不点火
    const def = beatById(verifyScenario, "verify_pressure_spike");
    const ctx = ctxFor(verifyScenario, (c) => {
      c.extras!.pressure.topPairs = sim.pressureGraph
        .getTopPairs(3)
        .map((p) => ({ a: p.a, b: p.b, pressure: p.pressure }));
    }, { day: 1, hour: 6 });
    expect(scanOne(def, ctx)).toBeUndefined();
  });
});
