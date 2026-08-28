/**
 * B1 + B1.5 形状单测（DESIGN-revival §8 B1/B1.5 行）：
 *
 * B1：
 * - witnesses 机械化（talk 结算写 witnesses + locationId 进 exchange）
 * - <4 句 / off 档 / 预过滤 AND（摊牌词 且 近窗负 valence≤-2）不调用
 * - 坏 JSON 不落账不崩；SmartMock 默认 no_stance 不落账
 * - evidence substring 校验丢弃路径
 * - 落账形状：openStance + unresolvedWith 双向 + 双方 LTM imp8 + 有 witnesses 才流言 + 疙瘩 + obsession 登记
 * - 每对每天 ≤1；严重度阶梯（break/threaten 无明示原话降档）；双边印象佐证
 * - 和解清账（openStance 归档 + grudge 清 + unresolvedWith 摘除）
 * - TTL 7 天降档归档；压力图只计近 3 天有活动的
 * - 旧档 normalize + JSON 往返存活
 *
 * B1.5：
 * - openStance/未 settled 事件的对：不清 grudge、不 idleDecay（off 档豁免集恒空）
 * - break/threaten 取消疙瘩期负向减半（dampNegativeDelta + hasActiveStanceOfKind）
 * - 摊牌场景闸：8→16 轮 + 重复拦截豁免目标 + 场景结束/TTL 恢复
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Simulation } from "./simulation.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { SmartMockLLM } from "../../test/helpers/smart-mock-llm.js";
import { setBreakLevel } from "./break-config.js";
import { dampNegativeDelta } from "./agent-loop.js";
import {
  extractStances,
  mightContainShowdown,
  applySeverityLadder,
  computeConversationWitnesses,
  stanceVisibility,
} from "./stance-extractor.js";
import {
  normalizeNarrativeSnapshot,
  stancePairKey,
  type NarrativeStateSnapshot,
} from "../narrative/narrative-state.js";
import { PressureGraph } from "../narrative/pressure-graph.js";
import { RelationshipManager } from "../world/relationships.js";
import type { ConversationExchange } from "./conversation-mode.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "公园", type: "public", openHours: null, presentCharacters: [] } as Location,
  { id: "cafe", name: "咖啡馆", type: "commercial", openHours: null, presentCharacters: [] } as Location,
];

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, gender: "female", occupation: "tester", home: "park",
    personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
    background: "", relationships: {},
  } as unknown as CharacterCard;
}

function makeSim(): { world: World; sim: Simulation; mock: SmartMockLLM } {
  const world = new World(fakeLocations);
  world.addCharacter("alice", "爱丽丝", "park");
  world.addCharacter("bob", "鲍勃", "park");
  world.addCharacter("carol", "卡罗尔", "park");
  const mock = new SmartMockLLM();
  const sim = new Simulation(world, new EventBus(), {
    characters: [makeCard("alice", "爱丽丝"), makeCard("bob", "鲍勃"), makeCard("carol", "卡罗尔")],
    actions: ALL_BASIC_ACTIONS,
    provider: mock,
    modelId: "test",
  });
  return { world, sim, mock };
}

/** 造一段含摊牌词的 4 句对话（tick 递增；witnesses 可配） */
function showdownHistory(baseTick: number, witnesses: string[] = ["carol"]): ConversationExchange[] {
  return [
    { speakerId: "alice", speakerName: "爱丽丝", message: "你最近很奇怪。", tick: baseTick, witnesses, locationId: "park" },
    { speakerId: "bob", speakerName: "鲍勃", message: "什么意思？", tick: baseTick + 1, witnesses, locationId: "park" },
    { speakerId: "alice", speakerName: "爱丽丝", message: "你偷了我的钱，别装了。", tick: baseTick + 2, witnesses, locationId: "park" },
    { speakerId: "bob", speakerName: "鲍勃", message: "……你凭什么这么说。", tick: baseTick + 3, witnesses, locationId: "park" },
  ];
}

function conv(history: ConversationExchange[]): { charA: string; charB: string; history: ConversationExchange[] } {
  return { charA: "alice", charB: "bob", history };
}

/** 一条合法的敌对立场抽取响应 */
function accuseJson(evidence = "你偷了我的钱，别装了。"): string {
  return JSON.stringify({ stances: [{ kind: "accuse", holder: "爱丽丝", target: "鲍勃", summary: "指控鲍勃偷钱", evidence }] });
}

beforeEach(() => setBreakLevel("mild"));
afterEach(() => setBreakLevel("mild"));

// ────────── witnesses 机械化 ──────────

describe("B1 witnesses 机械化", () => {
  it("talk 结算把当刻同地点在场者（不含双方）+ locationId 写进 exchange", () => {
    const { sim } = makeSim();
    const gt = tickToGameTime(100);
    (sim as any)._applyTalkEffects([
      {
        characterId: "alice", thought: "",
        action: { name: "talk", args: { target: "bob", message: "你好" } },
        result: { success: true, description: "" },
      },
    ], gt);
    const history = sim.conversations.getHistory("alice", "bob");
    expect(history).toHaveLength(1);
    expect(history[0]!.witnesses).toEqual(["carol"]);
    expect(history[0]!.locationId).toBe("park");
  });

  it("computeConversationWitnesses 取并集且排除双方；stanceVisibility 分档", () => {
    const history = showdownHistory(100, ["carol", "bob"]);
    expect(computeConversationWitnesses(history, "alice", "bob")).toEqual(["carol"]);
    expect(stanceVisibility(0)).toBe("private");
    expect(stanceVisibility(2)).toBe("overheard");
    expect(stanceVisibility(3)).toBe("public");
  });
});

// ────────── 预过滤 / 不调用路径 ──────────

describe("B1 预过滤（防线①）", () => {
  it("off 档不调用（红线②治愈系基线）", async () => {
    const { sim, mock } = makeSim();
    setBreakLevel("off");
    sim.pressureGraph.recordValence("alice", "bob", -3, 108);
    (sim as any)._scheduleStanceExtraction(conv(showdownHistory(100)), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBeUndefined();
  });

  it("<4 句不调用", async () => {
    const { sim, mock } = makeSim();
    sim.pressureGraph.recordValence("alice", "bob", -3, 108);
    (sim as any)._scheduleStanceExtraction(conv(showdownHistory(100).slice(0, 3)), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBeUndefined();
  });

  it("AND 双臂：有摊牌词但近窗 valence 不够负 → 不调用", async () => {
    const { sim, mock } = makeSim();
    sim.pressureGraph.recordValence("alice", "bob", -1, 108);
    (sim as any)._scheduleStanceExtraction(conv(showdownHistory(100)), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBeUndefined();
  });

  it("AND 双臂：valence 够负但无摊牌词 → 不调用", async () => {
    const { sim, mock } = makeSim();
    sim.pressureGraph.recordValence("alice", "bob", -5, 108);
    const bland: ConversationExchange[] = [
      { speakerId: "alice", speakerName: "爱丽丝", message: "今天天气一般。", tick: 100 },
      { speakerId: "bob", speakerName: "鲍勃", message: "是啊。", tick: 101 },
      { speakerId: "alice", speakerName: "爱丽丝", message: "嗯。", tick: 102 },
      { speakerId: "bob", speakerName: "鲍勃", message: "回见。", tick: 103 },
    ];
    (sim as any)._scheduleStanceExtraction(conv(bland), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBeUndefined();
    expect(mightContainShowdown(bland)).toBe(false);
  });

  it("两臂都满足 → 调用（默认 no_stance 不落账）", async () => {
    const { sim, mock } = makeSim();
    sim.pressureGraph.recordValence("alice", "bob", -3, 108);
    (sim as any)._scheduleStanceExtraction(conv(showdownHistory(100)), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBe(1);
    expect(sim.world.narrative.getOpenStances("alice", "bob")).toHaveLength(0);
  });

  it("和解分叉：摊牌次日的道歉对话（valence 窗口空）触发抽取并清账", async () => {
    const { sim, mock } = makeSim();
    const ns = sim.world.narrative;
    // 昨日摊牌已落账：active 立场 + 疙瘩
    (sim as any)._settleExtractedStances(conv(showdownHistory(100)), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "指控鲍勃偷钱", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(112));
    expect(ns.getActiveOpenStances("alice", "bob")).toHaveLength(1);
    expect(sim.relationships.get("alice", "bob").grudge).toBeDefined();

    // 次日道歉对话：valence 环形缓冲为空——旧 AND 门会把和解通路闸死
    const t = 100 + 96;
    const apology: ConversationExchange[] = [
      { speakerId: "bob", speakerName: "鲍勃", message: "昨天的事……我想跟你说说。", tick: t, witnesses: [], locationId: "park" },
      { speakerId: "alice", speakerName: "爱丽丝", message: "说吧。", tick: t + 1, witnesses: [], locationId: "park" },
      { speakerId: "bob", speakerName: "鲍勃", message: "对不起，是我不对，钱的事是个误会。", tick: t + 2, witnesses: [], locationId: "park" },
      { speakerId: "alice", speakerName: "爱丽丝", message: "……知道了。", tick: t + 3, witnesses: [], locationId: "park" },
    ];
    mock.enqueueKindResponse("stance-extract", JSON.stringify({
      stances: [{ kind: "apologize", holder: "鲍勃", target: "爱丽丝", summary: "为指控的事道歉和好", evidence: "对不起，是我不对" }],
    }));
    (sim as any)._scheduleStanceExtraction(conv(apology), tickToGameTime(t + 12));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBe(1);
    expect(ns.getActiveOpenStances("alice", "bob")).toHaveLength(0);
    expect(ns.getOpenStances("alice", "bob")[0]!.archiveReason).toBe("reconciled");
    expect(sim.relationships.get("alice", "bob").grudge).toBeUndefined();
  });

  it("和解分叉不放行敌对面：无 activeOpenStance 时含和解词也过不了 valence 门", async () => {
    const { sim, mock } = makeSim();
    const history: ConversationExchange[] = [
      ...showdownHistory(100),
      { speakerId: "bob", speakerName: "鲍勃", message: "对不起嘛，别误会。", tick: 104, witnesses: [], locationId: "park" },
    ];
    (sim as any)._scheduleStanceExtraction(conv(history), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBeUndefined();
  });
});

// ────────── 抽取器解析 ──────────

describe("B1 抽取器（防线②③）", () => {
  it("坏 JSON 不落账不崩", async () => {
    const { sim, mock } = makeSim();
    mock.enqueueKindResponse("stance-extract", "这不是 JSON {{{");
    sim.pressureGraph.recordValence("alice", "bob", -3, 108);
    (sim as any)._scheduleStanceExtraction(conv(showdownHistory(100)), tickToGameTime(112));
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBe(1);
    expect(sim.world.narrative.getOpenStances("alice", "bob")).toHaveLength(0);
  });

  it("evidence 不逐字命中转录 → 丢弃", async () => {
    const mock = new SmartMockLLM();
    mock.enqueueKindResponse("stance-extract", accuseJson("你就是个骗子我看透你了"));
    const out = await extractStances({
      history: showdownHistory(100),
      charAId: "alice", charAName: "爱丽丝", charBId: "bob", charBName: "鲍勃",
      provider: mock, modelId: "test",
    });
    expect(out).toHaveLength(0);
  });

  it("归属校验：evidence 是对方台词（holder 没说过这句）→ 丢弃不落账", async () => {
    const mock = new SmartMockLLM();
    // evidence "……你凭什么这么说。" 是鲍勃的台词，holder 却报了爱丽丝 → 归错方即丢
    mock.enqueueKindResponse("stance-extract", accuseJson("……你凭什么这么说。"));
    const out = await extractStances({
      history: showdownHistory(100),
      charAId: "alice", charAName: "爱丽丝", charBId: "bob", charBName: "鲍勃",
      provider: mock, modelId: "test",
    });
    expect(out).toHaveLength(0);
  });

  it("evidence 逐字命中 → 通过，holder 名字解析成 id", async () => {
    const mock = new SmartMockLLM();
    mock.enqueueKindResponse("stance-extract", accuseJson());
    const out = await extractStances({
      history: showdownHistory(100),
      charAId: "alice", charAName: "爱丽丝", charBId: "bob", charBName: "鲍勃",
      provider: mock, modelId: "test",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("accuse");
    expect(out[0]!.holderId).toBe("alice");
    expect(out[0]!.targetId).toBe("bob");
  });

  it("no_stance / 未知 kind 被过滤", async () => {
    const mock = new SmartMockLLM();
    mock.enqueueKindResponse("stance-extract", JSON.stringify({ stances: [{ kind: "no_stance" }, { kind: "banish", holder: "爱丽丝", evidence: "你偷了我的钱，别装了。" }] }));
    const out = await extractStances({
      history: showdownHistory(100),
      charAId: "alice", charAName: "爱丽丝", charBId: "bob", charBName: "鲍勃",
      provider: mock, modelId: "test",
    });
    expect(out).toHaveLength(0);
  });

  it("严重度阶梯：break/threaten 无明示原话降档 accuse，有原话保级", () => {
    expect(applySeverityLadder("break", "你偷了我的钱，别装了。")).toBe("accuse");
    expect(applySeverityLadder("break", "我们绝交，从此别再来找我。")).toBe("break");
    expect(applySeverityLadder("threaten", "你很过分。")).toBe("accuse");
    expect(applySeverityLadder("threaten", "你等着，我会让你付出代价。")).toBe("threaten");
    expect(applySeverityLadder("accuse", "随便什么")).toBe("accuse");
  });
});

// ────────── 落账形状 ──────────

describe("B1 落账形状", () => {
  it("openStance + unresolvedWith 双向 + 双方 LTM imp8 + 有 witnesses 才流言 + 疙瘩 + obsession", () => {
    const { sim } = makeSim();
    const history = showdownHistory(100, ["carol"]);
    (sim as any)._settleExtractedStances(conv(history), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "指控鲍勃偷钱", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(112));

    const ns = sim.world.narrative;
    const active = ns.getActiveOpenStances("alice", "bob");
    expect(active).toHaveLength(1);
    const st = active[0]!;
    expect(st.kind).toBe("accuse");
    expect(st.witnesses).toEqual(["carol"]);
    expect(st.locationId).toBe("park");

    // unresolvedWith 双向
    expect(ns.getCharacter("alice").unresolvedWith["bob"]).toContain(st.id);
    expect(ns.getCharacter("bob").unresolvedWith["alice"]).toContain(st.id);

    // 双方 LTM imp8
    const aLtm = sim.longTerm.getAbout("alice", "bob");
    const bLtm = sim.longTerm.getAbout("bob", "alice");
    expect(aLtm.some((e) => e.importance === 8 && e.content.includes("当面指控"))).toBe(true);
    expect(bLtm.some((e) => e.importance === 8 && e.content.includes("当面指控"))).toBe(true);

    // 有 witnesses → 流言
    const rumors = ns.getWorld().rumors;
    expect(rumors).toHaveLength(1);
    expect(rumors[0]!.reachedChars).toEqual(["carol"]);

    // 疙瘩
    expect(sim.relationships.get("alice", "bob").grudge).toBeDefined();

    // obsession 登记（B5 桩）
    expect(ns.getCharacter("alice").obsessions).toHaveLength(1);
    expect(ns.getCharacter("bob").obsessions).toHaveLength(1);

    // 每对每天水位
    expect(ns.getStanceDayLog()[stancePairKey("alice", "bob")]).toBe(Math.floor(103 / 96));
  });

  it("无 witnesses 不进流言（私下摊牌不外泄）", () => {
    const { sim } = makeSim();
    (sim as any)._settleExtractedStances(conv(showdownHistory(100, [])), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "指控", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(112));
    expect(sim.world.narrative.getWorld().rumors).toHaveLength(0);
    expect(sim.world.narrative.getActiveOpenStances("alice", "bob")).toHaveLength(1);
  });

  it("每对每天 ≤1：同日第二条敌对立场被拒", () => {
    const { sim } = makeSim();
    const gt = tickToGameTime(112);
    (sim as any)._settleExtractedStances(conv(showdownHistory(100)), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "第一条", evidence: "你偷了我的钱，别装了。" },
    ], gt);
    (sim as any)._settleExtractedStances(conv(showdownHistory(104)), [
      { kind: "expose", holderId: "bob", targetId: "alice", summary: "第二条", evidence: "……你凭什么这么说。" },
    ], gt);
    const all = sim.world.narrative.getOpenStances("alice", "bob");
    expect(all).toHaveLength(1);
    expect(all[0]!.summary).toBe("第一条");
  });

  it("break 缺双边印象佐证 → 降档 accuse；有佐证 → 保级 break", () => {
    const { sim } = makeSim();
    const evidence = "我们绝交，从此别再来找我。";
    const history: ConversationExchange[] = [
      ...showdownHistory(100, []),
      { speakerId: "alice", speakerName: "爱丽丝", message: evidence, tick: 104, witnesses: [], locationId: "park" },
    ];
    (sim as any)._settleExtractedStances(conv(history), [
      { kind: "break", holderId: "alice", targetId: "bob", summary: "宣告绝交", evidence },
    ], tickToGameTime(112));
    expect(sim.world.narrative.getActiveOpenStances("alice", "bob")[0]!.kind).toBe("accuse");

    // 有双边佐证（换一对角色避开每日水位）
    sim.impressions.set("alice", { characterId: "carol", summary: "s", observations: [], mentalLabel: "", unresolved: [], frictions: ["旧怨"], lastUpdated: 0 });
    sim.impressions.set("carol", { characterId: "alice", summary: "s", observations: [], mentalLabel: "", unresolved: [], frictions: ["旧怨"], lastUpdated: 0 });
    const history2: ConversationExchange[] = history.map((e) => ({ ...e, speakerId: e.speakerId === "bob" ? "carol" : e.speakerId, speakerName: e.speakerName === "鲍勃" ? "卡罗尔" : e.speakerName }));
    (sim as any)._settleExtractedStances({ charA: "alice", charB: "carol", history: history2 }, [
      { kind: "break", holderId: "alice", targetId: "carol", summary: "宣告绝交", evidence },
    ], tickToGameTime(112));
    expect(sim.world.narrative.getActiveOpenStances("alice", "carol")[0]!.kind).toBe("break");
  });

  it("和解清账：openStance 归档（reconciled）+ grudge 清 + unresolvedWith 摘除", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    (sim as any)._settleExtractedStances(conv(showdownHistory(100)), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "指控", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(112));
    const stanceId = ns.getActiveOpenStances("alice", "bob")[0]!.id;
    expect(sim.relationships.get("alice", "bob").grudge).toBeDefined();

    (sim as any)._settleExtractedStances(conv([
      ...showdownHistory(200, []),
      { speakerId: "bob", speakerName: "鲍勃", message: "对不起，是我不对。", tick: 204, witnesses: [], locationId: "park" },
    ]), [
      { kind: "apologize", holderId: "bob", targetId: "alice", summary: "道歉和好", evidence: "对不起，是我不对。" },
    ], tickToGameTime(212));

    expect(ns.getActiveOpenStances("alice", "bob")).toHaveLength(0);
    const archived = ns.getOpenStances("alice", "bob")[0]!;
    expect(archived.status).toBe("archived");
    expect(archived.archiveReason).toBe("reconciled");
    expect(sim.relationships.get("alice", "bob").grudge).toBeUndefined();
    expect(ns.getCharacter("alice").unresolvedWith["bob"] ?? []).not.toContain(stanceId);
    expect(ns.getCharacter("bob").unresolvedWith["alice"] ?? []).not.toContain(stanceId);
  });

  it("方向翻转：次日 B 反向指控 A → 新账条；同 holder 再指控 → refresh 复用旧 stanceId", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    // day1：alice 指控 bob
    (sim as any)._settleExtractedStances(conv(showdownHistory(100)), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "第一天", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(112));
    const firstId = ns.getActiveOpenStances("alice", "bob")[0]!.id;

    // day2：bob 反向指控 alice——必须是新账条，不污染 alice 持有的旧条
    (sim as any)._settleExtractedStances(conv(showdownHistory(196)), [
      { kind: "accuse", holderId: "bob", targetId: "alice", summary: "反向指控", evidence: "……你凭什么这么说。" },
    ], tickToGameTime(208));
    const active = ns.getActiveOpenStances("alice", "bob");
    expect(active).toHaveLength(2);
    const bobStance = active.find((s) => s.holderId === "bob")!;
    expect(bobStance.id).not.toBe(firstId);
    expect(bobStance.summary).toBe("反向指控");
    expect(active.find((s) => s.holderId === "alice")!.summary).toBe("第一天"); // 旧条没被覆盖
    expect(ns.getCharacter("bob").unresolvedWith["alice"]).toContain(bobStance.id);

    // day3：alice 再次同类指控 → refresh，复用旧 stanceId（unresolvedWith 不长悬空引用）
    (sim as any)._settleExtractedStances(conv(showdownHistory(292)), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "第三天又提", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(304));
    const aliceStance = ns.getActiveOpenStances("alice", "bob").find((s) => s.holderId === "alice")!;
    expect(aliceStance.id).toBe(firstId);
    expect(aliceStance.summary).toBe("第三天又提");
    const aliceUnresolved = ns.getCharacter("alice").unresolvedWith["bob"]!;
    expect(aliceUnresolved).toHaveLength(2); // firstId + bobStance.id，没有第三个悬空 id
    expect(aliceUnresolved).toContain(firstId);
    expect(aliceUnresolved).toContain(bobStance.id);
  });

  it("和解不清债（live2「嘴上还钱」）：欠款没动 → 债主向拒绝账+执念留着，立场/疙瘩/欠债人向照清", () => {
    const { sim, world } = makeSim();
    const ns = sim.world.narrative;
    // bob 欠 alice 15 金未还；alice 朝 bob 的 debt 所求被爽约过（tier 2 = 摊牌门开着）
    world.getCharacter("bob")!.debts = [{ lenderId: "alice", amount: 15, borrowedTick: 0 }];
    ns.recordRefusal({ fromId: "alice", toId: "bob", kind: "debt", tick: 100, brokenPromise: true });
    ns.registerObsession("alice", {
      id: "obs_refusal_alice_bob", summary: "他答应过的到点没做",
      createdDay: 1, decayDays: 5, source: "broken-promise", relatedId: "refusal_alice_bob",
    });
    // 欠债人向（bob 求宽限碰壁）不可核验 → 和解应照清（方向纪律与 S2 一致）
    ns.recordRefusal({ fromId: "bob", toId: "alice", kind: "debt", tick: 100 });
    // 场上再挂一条立场 + 疙瘩（好话**该**清的部分）
    (sim as any)._settleExtractedStances(conv(showdownHistory(100)), [
      { kind: "accuse", holderId: "alice", targetId: "bob", summary: "指控", evidence: "你偷了我的钱，别装了。" },
    ], tickToGameTime(112));
    expect(sim.relationships.get("alice", "bob").grudge).toBeDefined();

    (sim as any)._settleExtractedStances(conv([
      ...showdownHistory(200, []),
      { speakerId: "bob", speakerName: "鲍勃", message: "钱我已经还了，咱们两清了吧。", tick: 204, witnesses: [], locationId: "park" },
    ]), [
      { kind: "reconcile", holderId: "bob", targetId: "alice", summary: "嘴上两清", evidence: "钱我已经还了，咱们两清了吧。" },
    ], tickToGameTime(212));

    // 好话说得开的：立场归档、疙瘩清、欠债人向拒绝账清
    expect(ns.getActiveOpenStances("alice", "bob")).toHaveLength(0);
    expect(sim.relationships.get("alice", "bob").grudge).toBeUndefined();
    expect(ns.getRefusal("bob", "alice")).toBeUndefined();
    // 好话说不掉的：钱没动，债主向拒绝账（档位 2）与执念原地留着
    const r = ns.getRefusal("alice", "bob");
    expect(r).toMatchObject({ kind: "debt", tier: 2, brokenPromises: 1 });
    expect(
      ns.getCharacter("alice").obsessions.some((o) => o.id === "obs_refusal_alice_bob"),
    ).toBe(true);
  });

  it("和解清债的解锁条件：钱真还清了（债记录已销）→ 债主向拒绝账随和解一起清", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    // 无在账欠款（还清即整条删除）→ _verifiableProgress = 0 → 闸放行
    ns.recordRefusal({ fromId: "alice", toId: "bob", kind: "debt", tick: 100, brokenPromise: true });
    (sim as any)._settleExtractedStances(conv([
      ...showdownHistory(200, []),
      { speakerId: "bob", speakerName: "鲍勃", message: "对不起，是我不对。", tick: 204, witnesses: [], locationId: "park" },
    ]), [
      { kind: "apologize", holderId: "bob", targetId: "alice", summary: "道歉和好", evidence: "对不起，是我不对。" },
    ], tickToGameTime(212));
    expect(ns.getRefusal("alice", "bob")).toBeUndefined();
  });

  it("核验不了的 kind（hostile）维持原行为：和解照清拒绝账", () => {
    const { sim, world } = makeSim();
    const ns = sim.world.narrative;
    // 就算两人之间还有欠款，hostile 类拒绝账也不受债务闸保护（闸只按该条账的 kind 核验）
    world.getCharacter("bob")!.debts = [{ lenderId: "alice", amount: 15, borrowedTick: 0 }];
    ns.recordRefusal({ fromId: "alice", toId: "bob", kind: "hostile", tick: 100 });
    (sim as any)._settleExtractedStances(conv([
      ...showdownHistory(200, []),
      { speakerId: "bob", speakerName: "鲍勃", message: "对不起，是我不对。", tick: 204, witnesses: [], locationId: "park" },
    ]), [
      { kind: "apologize", holderId: "bob", targetId: "alice", summary: "道歉和好", evidence: "对不起，是我不对。" },
    ], tickToGameTime(212));
    expect(ns.getRefusal("alice", "bob")).toBeUndefined();
  });

  it("和解不无中生有：没账可清时 apologize 不产生任何写入", () => {
    const { sim } = makeSim();
    (sim as any)._settleExtractedStances(conv(showdownHistory(100)), [
      { kind: "apologize", holderId: "bob", targetId: "alice", summary: "道歉", evidence: "……你凭什么这么说。" },
    ], tickToGameTime(112));
    expect(sim.longTerm.getAbout("bob", "alice")).toHaveLength(0);
    expect(sim.world.narrative.getOpenStances("alice", "bob")).toHaveLength(0);
  });

  it("对话结束管线接线（第三兄弟）：经 _schedulePromiseExtraction 全链路落账", async () => {
    const { sim, mock } = makeSim();
    mock.enqueueKindResponse("stance-extract", accuseJson());
    sim.pressureGraph.recordValence("alice", "bob", -3, 103);
    for (const e of showdownHistory(100)) {
      sim.conversations.recordTalk(e.speakerId, e.speakerName, e.speakerId === "alice" ? "bob" : "alice", e.message, e.tick, undefined, { witnesses: e.witnesses, locationId: e.locationId });
    }
    (sim as any)._schedulePromiseExtraction(tickToGameTime(112)); // 103+9 → 对话结束
    await sim.waitForBackgroundTasks();
    expect(mock.callsByKind.get("stance-extract")).toBe(1);
    expect(sim.world.narrative.getActiveOpenStances("alice", "bob")).toHaveLength(1);
  });
});

// ────────── TTL / 压力图 ──────────

describe("B1 TTL 与压力图", () => {
  it("TTL 7 游戏天无 refresh 自动降档归档", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    ns.addOrRefreshOpenStance({
      id: "s1", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "s", evidence: "e", createdTick: 0, witnesses: [],
    });
    expect(ns.sweepStanceTTL(672)).toBe(0); // 恰好 7 天不过期
    expect(ns.sweepStanceTTL(673)).toBe(1);
    const st = ns.getOpenStances("alice", "bob")[0]!;
    expect(st.status).toBe("archived");
    expect(st.archiveReason).toBe("ttl");
  });

  it("压力图 stance 边：近 3 天有活动的 active 计 18/条；过窗/归档不计", () => {
    const { sim, world } = makeSim();
    const ns = world.narrative;
    ns.addOrRefreshOpenStance({
      id: "s1", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "s", evidence: "e", createdTick: 1000, lastRefreshTick: 1000, witnesses: [],
    });
    world.setTick(1010);
    let res = sim.pressureGraph.update({ world, relationships: sim.relationships, impressions: sim.impressions, tick: 1010 });
    let pair = res.pairs.find((p) => p.a === "alice" && p.b === "bob");
    expect(pair?.inputs.activeOpenStances).toBe(1);
    expect(pair!.pressure).toBeGreaterThanOrEqual(18);

    // 过 3 天活动窗（288 tick）→ 不计
    res = sim.pressureGraph.update({ world, relationships: sim.relationships, impressions: sim.impressions, tick: 1000 + 289 });
    pair = res.pairs.find((p) => p.a === "alice" && p.b === "bob");
    expect(pair?.inputs.activeOpenStances ?? 0).toBe(0);

    // 归档 → 不计（回到窗内也一样）
    ns.resolveOpenStances("alice", "bob", 1020);
    res = sim.pressureGraph.update({ world, relationships: sim.relationships, impressions: sim.impressions, tick: 1010 });
    pair = res.pairs.find((p) => p.a === "alice" && p.b === "bob");
    expect(pair?.inputs.activeOpenStances ?? 0).toBe(0);
  });
});

// ────────── B1.5 阻尼豁免 ──────────

describe("B1.5 阻尼豁免", () => {
  it("openStance 对暂停 grudge 3 天自动清；归档后恢复自动清", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    const tick = 96 * 4 + 24; // 某天 06:00
    sim.relationships.setGrudge("alice", "bob", "旧账", "alice", 10); // > 288 tick 前
    ns.addOrRefreshOpenStance({
      id: "s1", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "s", evidence: "e", createdTick: tick - 10, witnesses: [],
    });
    (sim as any)._applyDailyEnvironment(tickToGameTime(tick));
    expect(sim.relationships.get("alice", "bob").grudge).toBeDefined(); // 豁免生效

    ns.resolveOpenStances("alice", "bob", tick);
    (sim as any)._applyDailyEnvironment(tickToGameTime(tick + 96));
    expect(sim.relationships.get("alice", "bob").grudge).toBeUndefined(); // 恢复自动清
  });

  it("未 settled 事件的对同样豁免；off 档豁免集恒空", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    ns.addUnresolvedEvent({ id: "ev1", summary: "s", involved: ["alice", "carol"], visibleTo: "*", createdTick: 0 });
    const exempt = (sim as any)._stanceDamperExemptPairs() as Set<string>;
    expect(exempt.has(stancePairKey("alice", "carol"))).toBe(true);
    // settled 后不再豁免
    ns.advanceEventStatus("ev1", "settled", 10);
    expect(((sim as any)._stanceDamperExemptPairs() as Set<string>).has(stancePairKey("alice", "carol"))).toBe(false);

    ns.addOrRefreshOpenStance({
      id: "s1", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "s", evidence: "e", createdTick: 0, witnesses: [],
    });
    setBreakLevel("off");
    expect(((sim as any)._stanceDamperExemptPairs() as Set<string>).size).toBe(0);
  });

  it("openStance 对不 idleDecay（豁免集直传 applyIdleDecay）", () => {
    const rels = new RelationshipManager();
    rels.set("alice", "bob", 50);
    rels.set("alice", "carol", 50);
    const exempt = new Set([stancePairKey("alice", "bob")]);
    rels.applyIdleDecay(1000, 96, 1.5, exempt);
    expect(rels.get("alice", "bob").level).toBe(50);      // 豁免不衰减
    expect(rels.get("alice", "carol").level).toBe(48.5);  // 非豁免正常衰减
  });

  it("break/threaten 取消疙瘩期负向减半", () => {
    expect(dampNegativeDelta(-10, true, false)).toBe(-5);  // 疙瘩期减半
    expect(dampNegativeDelta(-10, true, true)).toBe(-10);  // 立场在账全额
    expect(dampNegativeDelta(-10, false, false)).toBe(-10);
    expect(dampNegativeDelta(6, true, false)).toBe(6);

    const { sim } = makeSim();
    const ns = sim.world.narrative;
    ns.addOrRefreshOpenStance({
      id: "s1", kind: "threaten", holderId: "alice", targetId: "bob",
      summary: "s", evidence: "e", createdTick: 0, witnesses: [],
    });
    expect(ns.hasActiveStanceOfKind("alice", "bob", ["break", "threaten"])).toBe(true);
    expect(ns.hasActiveStanceOfKind("alice", "bob", ["break"])).toBe(false);
    expect(ns.hasActiveStanceOfKind("alice", "carol", ["break", "threaten"])).toBe(false);
  });
});

// ────────── B1.5 摊牌场景闸 ──────────

describe("B1.5 摊牌场景闸", () => {
  function fillTurns(sim: Simulation, n: number, startTick: number): void {
    for (let i = 0; i < n; i++) {
      const speaker = i % 2 === 0 ? "alice" : "bob";
      sim.conversations.recordTalk(speaker, speaker, speaker === "alice" ? "bob" : "alice", `第${i}句`, startTick + i);
    }
  }

  it("场景内对话闸 8→16 轮，场景外 8 轮即拦", () => {
    const { sim } = makeSim();
    fillTurns(sim, 9, 95);
    // 无场景：9 轮 ≥ 8 → bob 进冷却
    expect((sim as any)._getTalkCooldownTargets("alice", 104)).toContain("bob");
    // 场景抬闸：9 轮 < 16 → 放行
    sim.raiseConfrontationScene("alice", "bob", 104);
    expect((sim as any)._getTalkCooldownTargets("alice", 104)).not.toContain("bob");
  });

  it("16 轮后即使在场景内也拦（闸是抬升不是取消）", () => {
    const { sim } = makeSim();
    fillTurns(sim, 16, 95);
    sim.raiseConfrontationScene("alice", "bob", 104);
    expect((sim as any)._getTalkCooldownTargets("alice", 104)).toContain("bob");
  });

  it("TTL 到期自动恢复；对话结束（管线清扫）恢复", () => {
    const { sim } = makeSim();
    sim.raiseConfrontationScene("alice", "bob", 100);
    expect(sim.isConfrontationSceneActive("alice", "bob", 124)).toBe(true);
    expect(sim.isConfrontationSceneActive("alice", "bob", 125)).toBe(false); // TTL 24

    sim.raiseConfrontationScene("alice", "bob", 200);
    sim.conversations.recordTalk("alice", "爱丽丝", "bob", "说完了。", 200);
    (sim as any)._schedulePromiseExtraction(tickToGameTime(209)); // 对话结束 → 清场景
    expect(sim.isConfrontationSceneActive("alice", "bob", 201)).toBe(false);
  });

  it("beat auto_seeds：只有 confront: true 才抬场景闸；high+target 仍照常注入 intent", () => {
    const { sim } = makeSim();
    sim.loadBeats([
      {
        id: "b_plain",
        preconditions: ["true"],
        auto_seeds: [{ char: "alice", target: "bob", topic: "得找他谈谈", urgency: "high" as const }],
      },
      {
        id: "b_confront",
        preconditions: ["true"],
        auto_seeds: [{ char: "carol", target: "bob", topic: "当面摊牌", urgency: "high" as const, confront: true }],
      },
    ]);
    sim.runBeatScan(tickToGameTime(100));
    // 未标 confront 的 high+target 种子不再抬 16 轮闸（触发面收窄）
    expect(sim.isConfrontationSceneActive("alice", "bob", 100)).toBe(false);
    // 标了 confront 的照常抬闸
    expect(sim.isConfrontationSceneActive("carol", "bob", 100)).toBe(true);
    // intent 注入不依赖 confront：定向种子照常配注意力
    expect(sim.world.getCurrentIntent("alice", 100)?.targetId).toBe("bob");
  });

  it("重复拦截豁免目标：场景内互为豁免；off 档抬闸无效", () => {
    const { sim } = makeSim();
    sim.raiseConfrontationScene("alice", "bob", 100);
    expect((sim as any)._confrontExemptTargets("alice", 100)).toEqual(["bob"]);
    expect((sim as any)._confrontExemptTargets("bob", 100)).toEqual(["alice"]);
    expect((sim as any)._confrontExemptTargets("carol", 100)).toEqual([]);

    setBreakLevel("off");
    const { sim: sim2 } = makeSim();
    sim2.raiseConfrontationScene("alice", "bob", 100);
    expect(sim2.isConfrontationSceneActive("alice", "bob", 100)).toBe(false);
  });
});

// ────────── 随档 / normalize ──────────

describe("B1 随档 normalize", () => {
  it("旧档缺 openStances/stanceDayLog/obsessions → 回填默认", () => {
    const snap = normalizeNarrativeSnapshot({
      world: { unresolvedEvents: [], triggeredBeats: [], tensionIndex: 0, rumors: [] },
      characters: { alice: { disclosedSecrets: [], knownFacts: [], unresolvedWith: {}, pressure: 0, secretsPool: [] } },
      locations: {},
    } as unknown as NarrativeStateSnapshot);
    expect(snap.world.openStances).toEqual({});
    expect(snap.world.stanceDayLog).toEqual({});
    expect(snap.characters.alice!.obsessions).toEqual([]);
  });

  it("残缺立场条目丢弃；lastRefreshTick 回填 createdTick；非法 status 回 active", () => {
    const snap = normalizeNarrativeSnapshot({
      world: {
        ...({} as any),
        unresolvedEvents: [], triggeredBeats: [], tensionIndex: 0, rumors: [],
        openStances: {
          "alice:bob": [
            { id: "ok", kind: "accuse", holderId: "alice", targetId: "bob", summary: "s", evidence: "e", createdTick: 5, status: "weird" },
            { id: "bad-kind", kind: "banish", holderId: "alice", targetId: "bob", summary: "s", evidence: "e", createdTick: 5 },
            { notEven: "an object shape" },
          ],
          "x:y": "not-an-array",
        },
        stanceDayLog: { "alice:bob": 3, "x:y": NaN },
      },
      characters: {}, locations: {},
    } as unknown as NarrativeStateSnapshot);
    const list = snap.world.openStances["alice:bob"]!;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("ok");
    expect(list[0]!.status).toBe("active");
    expect(list[0]!.lastRefreshTick).toBe(5);
    expect(list[0]!.witnesses).toEqual([]);
    expect(snap.world.openStances["x:y"]).toBeUndefined();
    expect(snap.world.stanceDayLog).toEqual({ "alice:bob": 3 });
  });

  it("JSON 序列化往返（save/load 路径）后立场账存活", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    ns.addOrRefreshOpenStance({
      id: "s1", kind: "expose", holderId: "alice", targetId: "bob",
      summary: "s", evidence: "e", createdTick: 10, witnesses: ["carol"], locationId: "park",
    });
    ns.recordStanceDay(stancePairKey("alice", "bob"), 2);
    ns.registerObsession("alice", { id: "o1", summary: "念着", createdDay: 1, decayDays: 5, source: "stance" });

    const revived = JSON.parse(JSON.stringify(ns.getSnapshot()));
    const { sim: sim2 } = makeSim();
    sim2.world.narrative.replaceSnapshot(revived);
    const ns2 = sim2.world.narrative;
    expect(ns2.getActiveOpenStances("alice", "bob")).toHaveLength(1);
    expect(ns2.getActiveOpenStances("alice", "bob")[0]!.witnesses).toEqual(["carol"]);
    expect(ns2.getStanceDayLog()[stancePairKey("alice", "bob")]).toBe(2);
    expect(ns2.getCharacter("alice").obsessions).toHaveLength(1);
  });

  it("addOrRefreshOpenStance：同对同类同 holder active → refresh 不重复，复用既有 stanceId", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    const first = ns.addOrRefreshOpenStance({
      id: "s1", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "旧", evidence: "e1", createdTick: 10, witnesses: [],
    });
    expect(first.refreshed).toBe(false);
    const second = ns.addOrRefreshOpenStance({
      id: "s2", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "新", evidence: "e2", createdTick: 50, lastRefreshTick: 50, witnesses: ["carol"],
    });
    expect(second.refreshed).toBe(true);
    expect(second.stance.id).toBe("s1"); // 复用既有 stanceId——unresolvedWith 引用一致
    const all = ns.getOpenStances("alice", "bob");
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("s1");
    expect(all[0]!.summary).toBe("新");
    expect(all[0]!.lastRefreshTick).toBe(50);
    expect(all[0]!.witnesses).toEqual(["carol"]);
  });

  it("addOrRefreshOpenStance 三键匹配：B 反向同类指控 → 新条不折进 A 的旧条", () => {
    const { sim } = makeSim();
    const ns = sim.world.narrative;
    ns.addOrRefreshOpenStance({
      id: "s_ab", kind: "accuse", holderId: "alice", targetId: "bob",
      summary: "A 指控 B", evidence: "e1", createdTick: 10, witnesses: [],
    });
    const reverse = ns.addOrRefreshOpenStance({
      id: "s_ba", kind: "accuse", holderId: "bob", targetId: "alice",
      summary: "B 反向指控 A", evidence: "e2", createdTick: 50, lastRefreshTick: 50, witnesses: [],
    });
    expect(reverse.refreshed).toBe(false);
    expect(reverse.stance.id).toBe("s_ba");
    const all = ns.getOpenStances("alice", "bob");
    expect(all).toHaveLength(2);
    const holderA = all.find((s) => s.holderId === "alice")!;
    expect(holderA.summary).toBe("A 指控 B");
    expect(holderA.lastRefreshTick).toBe(10); // 旧条完全没被 refresh 污染
  });
});
