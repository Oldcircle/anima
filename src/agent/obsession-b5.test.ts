/**
 * B5 多日执念载体形状单测（DESIGN-revival §2 B5 / §4.5）：
 *
 * 载体：
 * - registerObsession 去重 + 上限；getActiveObsessions 按 decayDays 过滤 + 取最近 limit 条
 * - sweepObsessions 5 天衰减；clearObsessionsRelatedTo（relatedId 字段 + id 子串双通道）
 * - 旧档 normalize（relatedId 非法清除；JSON 往返存活）
 *
 * 登记点：
 * - kira 应验（受害者 + 写名者）；off 档不登记
 * - 同对爽约≥2 派生（§4.5：从 _appointments filter 派生，不加新计数器）；首次爽约不登记
 * - B1 立场双方（stance-b1.test.ts 已覆盖）；罪案受害/嫌疑（crime-supply.test.ts 已覆盖）
 *
 * 消费点：
 * - 决策 prompt 此刻区 ≤2 条（时间行之后——缓存纪律）；off 档不注入
 * - 晨间打算输入；反思回顾
 * - settled 即清（onEventSettled 钩子经 Simulation 构造器接线）
 * - 06:00 sweep 接线（_applyDailyEnvironment）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Simulation } from "./simulation.js";
import { runAgentTick, type AgentConfig } from "./agent-loop.js";
import { generateMorningPlan } from "./morning-plan.js";
import { runReflection } from "./reflection.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { setBreakLevel } from "./break-config.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { RelationshipManager } from "../world/relationships.js";
import {
  NarrativeState,
  normalizeNarrativeSnapshot,
  type NarrativeStateSnapshot,
} from "../narrative/narrative-state.js";
import type { CharacterCard } from "../character/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function makeSim(tick = 100): { world: World; sim: Simulation; mock: MockLLMProvider } {
  const world = new World(TEST_LOCATIONS, tick);
  world.addCharacter("alice", "爱丽丝", "cafe");
  world.addCharacter("bob", "鲍勃", "plaza");
  world.addCharacter("carol", "卡罗尔", "plaza");
  const mock = new MockLLMProvider();
  const sim = new Simulation(world, new EventBus(), {
    characters: [makeCard("alice", "爱丽丝"), makeCard("bob", "鲍勃"), makeCard("carol", "卡罗尔")],
    actions: ALL_BASIC_ACTIONS,
    provider: mock,
    modelId: "test",
  });
  return { world, sim, mock };
}

function ob(id: string, summary: string, createdDay: number, opts?: { decayDays?: number; relatedId?: string }) {
  return { id, summary, createdDay, decayDays: opts?.decayDays ?? 5, source: "test", relatedId: opts?.relatedId };
}

beforeEach(() => setBreakLevel("mild"));
afterEach(() => setBreakLevel("mild"));

describe("B5 载体（narrative-state）", () => {
  it("getActiveObsessions：decayDays 过滤 + 取最近 limit 条；registerObsession 同 id 去重", () => {
    const ns = new NarrativeState();
    expect(ns.registerObsession("a", ob("o1", "第一件", 0))).toBe(true);
    expect(ns.registerObsession("a", ob("o1", "第一件重复", 0))).toBe(false);
    ns.registerObsession("a", ob("o2", "第二件", 3));
    ns.registerObsession("a", ob("o3", "第三件", 4));
    // day 5：o1 已衰减（5-0 >= 5），o2/o3 存活
    const active = ns.getActiveObsessions("a", 5, 2);
    expect(active.map((o) => o.id)).toEqual(["o2", "o3"]);
    // limit=1 取最近登记的
    expect(ns.getActiveObsessions("a", 5, 1).map((o) => o.id)).toEqual(["o3"]);
  });

  it("sweepObsessions 清过期；clearObsessionsRelatedTo 走 relatedId 与 id 子串双通道", () => {
    const ns = new NarrativeState();
    ns.registerObsession("a", ob("old", "旧事", 0));
    ns.registerObsession("a", ob("obs_stance_x_holder", "立场事", 4));
    ns.registerObsession("b", ob("linked", "关联事", 4, { relatedId: "evt9" }));
    expect(ns.sweepObsessions(5)).toBe(1); // 只清 old
    expect(ns.getCharacter("a").obsessions.map((o) => o.id)).toEqual(["obs_stance_x_holder"]);
    // relatedId 通道
    expect(ns.clearObsessionsRelatedTo("evt9")).toBe(1);
    expect(ns.getCharacter("b").obsessions).toHaveLength(0);
    // id 子串通道（S4 立场执念的 obs_<stanceId>_* 约定）
    expect(ns.clearObsessionsRelatedTo("stance_x")).toBe(1);
    expect(ns.getCharacter("a").obsessions).toHaveLength(0);
  });

  it("旧档 normalize：relatedId 非法清除；JSON 往返存活", () => {
    const snap = normalizeNarrativeSnapshot({
      world: {},
      characters: {
        a: {
          obsessions: [
            { id: "x", summary: "s", createdDay: 1, decayDays: 5, source: "t", relatedId: 42 },
            { id: "y", summary: "s2", createdDay: 1, decayDays: 5, source: "t", relatedId: "evt" },
          ],
        },
      },
      locations: {},
    } as unknown as NarrativeStateSnapshot);
    expect(snap.characters.a!.obsessions[0]!.relatedId).toBeUndefined();
    expect(snap.characters.a!.obsessions[1]!.relatedId).toBe("evt");
    const roundTrip = normalizeNarrativeSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(roundTrip.characters.a!.obsessions).toHaveLength(2);
  });
});

describe("B5 登记点", () => {
  it("kira 应验：受害者 + 写名者各登记一条；off 档不登记", () => {
    const { world, sim } = makeSim(24);
    world.moveCharacter("bob", "cafe"); // light=alice 写 bob；bob 在 cafe 倒下
    world.kira.pending.push({ by: "alice", target: "bob", judgment: "试验", writtenDay: 0 });
    (sim as any)._resolveKiraStrikes(tickToGameTime(24));
    const victimObs = world.narrative.getActiveObsessions("bob", 0, 6);
    const writerObs = world.narrative.getActiveObsessions("alice", 0, 6);
    expect(victimObs.some((o) => o.source === "kira")).toBe(true);
    expect(writerObs.some((o) => o.source === "kira" && o.summary.includes("应验"))).toBe(true);

    // off 档：应验照常发生但不登记执念
    setBreakLevel("off");
    const off = makeSim(24);
    off.world.kira.pending.push({ by: "alice", target: "bob", judgment: "", writtenDay: 0 });
    (off.sim as any)._resolveKiraStrikes(tickToGameTime(24));
    expect(off.world.getCharacter("bob")!.currentAction?.name).toBe("collapse_cursed");
    expect(off.world.narrative.getActiveObsessions("bob", 0, 6)).toHaveLength(0);
  });

  it("同对爽约≥2 派生：首次不登记，第二次双方各登记（计数派生自 _appointments）", () => {
    const { world, sim } = makeSim(100);
    // alice 在 cafe 等，bob 在 plaza 爽约
    world.addAppointment({
      id: "ap1", proposerId: "alice", targetId: "bob", locationId: "cafe",
      atTick: 100, status: "pending", createdTick: 90,
    });
    (sim as any).resolveAppointments(tickToGameTime(103)); // 过宽限窗 → missed(bob)
    expect(world.getAllAppointments().filter((a) => a.status === "missed")).toHaveLength(1);
    expect(world.narrative.getActiveObsessions("alice", 1, 6)).toHaveLength(0); // 第一次不登记

    world.addAppointment({
      id: "ap2", proposerId: "alice", targetId: "bob", locationId: "cafe",
      atTick: 110, status: "pending", createdTick: 105,
    });
    (sim as any).resolveAppointments(tickToGameTime(113));
    const waiterObs = world.narrative.getActiveObsessions("alice", 1, 6);
    const absenteeObs = world.narrative.getActiveObsessions("bob", 1, 6);
    expect(waiterObs.some((o) => o.source === "promise" && o.summary.includes("第 2 次"))).toBe(true);
    expect(absenteeObs.some((o) => o.source === "promise")).toBe(true);
  });
});

describe("B5 消费点", () => {
  it("决策 prompt 此刻区 ≤2 条（最近的 2 条，位于时间行之后）；off 档不注入", async () => {
    const { world, sim, mock } = makeSim(100);
    void sim;
    const ns = world.narrative;
    ns.registerObsession("alice", ob("o1", "最旧的一件事", 1));
    ns.registerObsession("carol", ob("other", "别人的心事", 1)); // 无关角色不串台
    ns.registerObsession("alice", ob("o2", "鲍勃爽约的事", 1));
    ns.registerObsession("alice", ob("o3", "被指控的事", 1));

    const config: AgentConfig = {
      card: makeCard("alice", "爱丽丝"),
      actions: ALL_BASIC_ACTIONS,
      provider: mock,
      modelId: "test",
    };
    mock.enqueueResponse("待着", [{ name: "do_nothing", arguments: {} }]);
    await runAgentTick({ config, world, eventBus: new EventBus(), gameTime: tickToGameTime(101) });
    const prompt = mock.calls[0]!.request.messages[0]!.content as string;
    expect(prompt).toContain("这几天一直压在你心里的：鲍勃爽约的事");
    expect(prompt).toContain("这几天一直压在你心里的：被指控的事");
    expect(prompt).not.toContain("最旧的一件事"); // ≤2 条，只取最近
    expect(prompt).not.toContain("别人的心事"); // 不串台
    // 缓存纪律：执念行位于此刻区（时间行之后）
    expect(prompt.indexOf("\n时间: ")).toBeLessThan(prompt.indexOf("这几天一直压在你心里的"));

    // off 档不注入
    setBreakLevel("off");
    mock.enqueueResponse("待着", [{ name: "do_nothing", arguments: {} }]);
    await runAgentTick({ config, world, eventBus: new EventBus(), gameTime: tickToGameTime(102) });
    const offPrompt = mock.calls[1]!.request.messages[0]!.content as string;
    expect(offPrompt).not.toContain("这几天一直压在你心里的");
  });

  it("晨间打算输入：obsessions 进 user prompt（只摆事实不派任务）", async () => {
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("- 去海边走走");
    const world = new World(TEST_LOCATIONS, 24);
    world.addCharacter("alice", "爱丽丝", "cafe");
    await generateMorningPlan({
      card: makeCard("alice", "爱丽丝"),
      state: world.getCharacter("alice")!,
      provider: mock,
      modelId: "test",
      obsessions: ["鲍勃爽约的事", "那笔被偷的钱"],
    });
    const user = mock.calls[0]!.request.messages[0]!.content as string;
    expect(user).toContain("这几天你心里一直压着：鲍勃爽约的事；那笔被偷的钱");
    expect(user).toContain("你自己定");
  });

  it("反思回顾：obsessions 段进 user prompt", async () => {
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("心情: 平静");
    const memory = new ShortTermMemory();
    memory.add("alice", { tick: 10, type: "event", content: "今天干了活", importance: 5 });
    await runReflection({
      card: makeCard("alice", "爱丽丝"),
      memory,
      relationships: new RelationshipManager(),
      provider: mock,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 92,
      obsessions: ["那事还没完"],
    });
    const user = mock.calls[0]!.request.messages[0]!.content as string;
    expect(user).toContain("## 这几天一直压在你心里的");
    expect(user).toContain("- 那事还没完");
    expect(user).toContain("还压着的");
  });

  it("settled 即清：关联事件 settled → 双方执念被钩子清掉（Simulation 构造器接线）", () => {
    const { world } = makeSim(100);
    const ns = world.narrative;
    ns.addUnresolvedEvent({ id: "evt1", summary: "失窃", involved: ["alice", "bob"], visibleTo: "*", createdTick: 100 });
    ns.registerObsession("alice", ob("obs_evt1_victim", "钱被偷了", 1, { relatedId: "evt1" }));
    ns.registerObsession("bob", ob("obs_evt1_perp", "风声悬着", 1, { relatedId: "evt1" }));
    expect(ns.advanceEventStatus("evt1", "settled", 150)).toBe(true);
    expect(ns.getActiveObsessions("alice", 1, 6)).toHaveLength(0);
    expect(ns.getActiveObsessions("bob", 1, 6)).toHaveLength(0);
  });

  it("06:00 sweep 接线：过期执念在晨间被清（_applyDailyEnvironment）", () => {
    const { world, sim } = makeSim(0);
    world.narrative.registerObsession("alice", ob("old", "五天前的事", 0));
    world.narrative.registerObsession("alice", ob("fresh", "昨天的事", 4));
    (sim as any)._applyDailyEnvironment(tickToGameTime(5 * 96 + 24)); // D6 06:00, day=5
    const left = world.narrative.getCharacter("alice").obsessions.map((o) => o.id);
    expect(left).toEqual(["fresh"]);
  });
});
