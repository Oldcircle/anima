/**
 * default-verify 离线彩排（DESIGN-revival §7 —— 烧钱前的必备闸）
 *
 * 用 scenario-sim harness + SmartMockLLM 走与 live 验收完全相同的装配路径
 * （scenario-loader → seeds → beats → director(mock) → crime_supply），
 * 剧本化台词跑 day1 上午 → day2 中午（120 tick），断言验收信号的机制链全部点火：
 *
 * ① verify_d1_crime 的 auto_events 罪案投放落账（受害者真掉钱 + 发现记忆/LTM + 事件总线）
 * ② 定向摊牌 beat 触发且 raiseConfrontationScene 生效（confront: true 标记路径）
 * ③ stance-extract 的 mock 响应被抽取管线消费 → openStance 落账（含 obsession 登记）
 * ④ 压力对数值高于种子初值（run 内增量存在）→ verify_pressure_spike 涌现点火
 * ⑤ day2 06:00 后 obsession 进晨间打算输入（prompt 可见"心里一直压着"）
 *
 * 文件名故意用 .sim-mock.test.ts：跑默认 vitest config（离线、无 API key），
 * 不落进 *.sim.test.ts 的真 API sim config 排除面。
 *
 * 测试注入的两处"外部信号"（各有独立单测覆盖其真实链路，彩排不重复验证）：
 * - pressureGraph.recordValence(-3)：近窗负 valence 是 impression-updater 的落地回调，
 *   SmartMock 印象恒中性（态度：0），不注入则 B1 预过滤 AND 门永远不开；
 * - stance-extract 的 kind 覆盖响应：与真实 stance-extractor 解析器同格式的 JSON
 *   （{"stances":[{kind,holder,target,summary,evidence}]}，holder/target 用角色名，
 *   evidence 逐字摘自转录且出自 holder 之口）。
 */

import { describe, it, expect, afterAll } from "vitest";
import { createScenarioSim, type ScenarioSimHandle } from "../../test/helpers/scenario-sim.js";
import { SmartMockLLM } from "../../test/helpers/smart-mock-llm.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/types.js";
import type { WorldEvent } from "../core/event-bus.js";

/** 请求捕获包装：⑤ 需要断言晨间打算的 prompt 里真的带了执念行 */
class CapturingProvider implements LLMProvider {
  readonly id: string;
  readonly requests: LLMRequest[] = [];
  constructor(private readonly inner: SmartMockLLM) {
    this.id = inner.id;
  }
  async chat(request: LLMRequest, modelId: string): Promise<LLMResponse> {
    this.requests.push(request);
    return this.inner.chat(request, modelId);
  }
  /** 某 kind 的全部 user prompt 文本（拼接便于 substring 断言） */
  promptsOf(kind: string): string[] {
    return this.requests
      .filter((r) => r.kind === kind)
      .map((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
  }
}

describe("default-verify 离线彩排（day1 上午 → day2 中午）", () => {
  let handle: ScenarioSimHandle | undefined;

  afterAll(() => {
    handle?.dispose();
  });

  it("验收信号机制链全部点火", async () => {
    const mock = new SmartMockLLM();
    const capture = new CapturingProvider(mock);
    handle = createScenarioSim({
      scenarioId: "default-verify",
      provider: capture,
      director: { dailyBudget: 5 }, // director 走同一个 mock（默认 do_nothing）
    });
    const { sim, world } = handle;
    const cards = Object.fromEntries(handle.scenario.characters.map((c) => [c.id, c]));
    const asukaName = cards.asuka!.name;
    const shinjiName = cards.shinji!.name;

    // 事件总线取证：罪案投放走 narrative.auto_event
    const autoEvents: WorldEvent[] = [];
    handle.eventBus.on((e) => {
      if (e.type === "narrative.auto_event") autoEvents.push(e);
    });
    // 摊牌场景闸的逐 tick 采样（闸有 24 tick TTL，跑完再查会漏掉）
    let sceneObservedActive = false;
    sim.onTick((s) => {
      if (sim.isConfrontationSceneActive("asuka", "shinji", s.tick)) sceneObservedActive = true;
    });

    // 种子基线（shipped-beats 标定锁 40，这里只留作 run 内增量的对照值）
    sim.pressureGraph.update({ world, relationships: sim.relationships, impressions: sim.impressions, tick: 24 });
    const seededPressure = sim.pressureGraph.getPairPressure("asuka", "shinji")!.pressure;
    expect(seededPressure).toBeLessThan(45);

    // ── 段 A：day1 06:00 → 09:00（tick 24..36）——crime beat 在 09:00 扫描点火并入队载荷 ──
    await handle.run(13);
    expect(world.narrative.getWorld().triggeredBeats).toContain("verify_d1_crime");

    // ── 段 B：tick 37——入队载荷 drain，罪案落账（信号①）──
    await handle.run(1);
    expect(autoEvents.some((e) => e.targetId === "senjougahara")).toBe(true);
    const senLtm = sim.longTerm.all("senjougahara");
    // 真掉钱：goldChange 只有真实转移了 25 金币才会写成 "-25 金币"
    expect(
      senLtm.some((m) => m.content.includes("不翼而飞") && m.content.includes("-25 金币")),
      "受害者的失窃事件应带真实金币损失落进 LTM",
    ).toBe(true);
    expect(
      sim.memory.getRecent("senjougahara", 30).some((m) => m.content.includes("不翼而飞")),
      "发现记忆应进短期记忆（本 tick prompt 可见）",
    ).toBe(true);

    // ── 段 C：tick 38..41——10:00 定向摊牌 beat 点火（信号②）──
    await handle.run(4);
    expect(world.narrative.getWorld().triggeredBeats).toContain("verify_d1_showdown");
    expect(
      sim.isConfrontationSceneActive("asuka", "shinji", 41),
      "confront: true 的 auto_seed 应抬起摊牌场景闸",
    ).toBe(true);

    // ── 摊牌排戏：把两人拉到同台，剧本化台词 + 立场抽取 mock 响应 ──
    const asukaState = world.getCharacter("asuka")!;
    const shinjiState = world.getCharacter("shinji")!;
    world.moveCharacter("shinji", asukaState.locationId);
    for (const st of [asukaState, shinjiState]) {
      st.currentAction = undefined; // 立即可决策
      for (const k of Object.keys(st.needs)) st.needs[k] = 100; // 生存分支不抢戏（台词脚本本就最高优先）
    }
    mock.scriptTalk("asuka", [
      { target: "shinji", message: "站住。那15金已经拖到第四天了，今天必须把话说清楚——你敢说你忘了？" },
      { target: "shinji", message: "别低头装没听见。说好两天就还，你就是在骗我。这笔账今天必须有个说法。" },
    ]);
    mock.scriptTalk("shinji", [
      { target: "asuka", message: "我、我没有想赖账……只是这几天真的凑不出来。" },
      { target: "asuka", message: "对不起……再给我两天，我一定还。" },
    ]);
    mock.enqueueKindResponse("stance-extract", JSON.stringify({
      stances: [{
        kind: "accuse",
        holder: asukaName,
        target: shinjiName,
        summary: "当面挑明欠债拖延，指控他撒谎",
        evidence: "你就是在骗我",
      }],
    }));
    // 近窗负 valence（B1 预过滤 AND 门第二臂）：mock 印象恒中性，链路见 impression 单测
    sim.pressureGraph.recordValence("asuka", "shinji", -3, 42);

    // ── 段 D：tick 42..81——对话打完、结束（8 tick 静默判定）、抽取、落账（信号③④）。
    // 留足冗余：ping-pong 回声轮 + 16 轮闸的波次可能把对话尾拖后几个 tick ──
    await handle.run(40);
    expect(mock.pendingScriptCount(), "剧本台词应全部说出口").toBe(0);
    expect(mock.callsByKind.get("stance-extract") ?? 0, "立场抽取管线应真被调用").toBeGreaterThanOrEqual(1);

    const active = world.narrative.getActiveOpenStances("asuka", "shinji");
    const accuse = active.find((s) => s.kind === "accuse" && s.holderId === "asuka");
    expect(accuse, "mock 立场响应应被抽取管线消费并落 openStance").toBeDefined();
    expect(accuse!.targetId).toBe("shinji");
    expect(accuse!.evidence).toBe("你就是在骗我");
    // 落账形状连带：unresolvedWith 双向 + 双方执念登记（B5 载体）
    expect(world.narrative.getCharacter("asuka").unresolvedWith["shinji"]).toContain(accuse!.id);
    expect(world.narrative.getCharacter("shinji").unresolvedWith["asuka"]).toContain(accuse!.id);
    expect(world.narrative.getCharacter("asuka").obsessions.length).toBeGreaterThanOrEqual(1);
    expect(world.narrative.getCharacter("shinji").obsessions.length).toBeGreaterThanOrEqual(1);
    expect(sceneObservedActive).toBe(true);

    // 信号④：压力对高于种子初值（增量来自 run 内新账：立场 +18、疙瘩 +25…）
    const nowPressure = sim.pressureGraph.getPairPressure("asuka", "shinji")!.pressure;
    expect(nowPressure, "run 内事件必须把压力顶过种子初值").toBeGreaterThan(seededPressure);
    expect(nowPressure).toBeGreaterThanOrEqual(45);
    expect(
      world.narrative.getWorld().beatLastTrigger["verify_pressure_spike"],
      "压力烧过 45 后状态 beat 应涌现点火",
    ).toBeDefined();

    // ── 段 E：tick 82..144（跨夜到 day2 中午）——执念进晨间打算（信号⑤）──
    await handle.run(63);
    const day2Plans = capture.promptsOf("morning-plan").filter((p) => p.includes("这几天你心里一直压着"));
    expect(day2Plans.length, "day2 晨间打算应带执念输入行").toBeGreaterThanOrEqual(1);
    expect(
      day2Plans.some((p) => p.includes("当面指控")),
      "立场执念（当面指控…这事没完）应出现在晨间打算输入里",
    ).toBe(true);

    // 底盘一致性：跑完无崩溃、经济不归零（金币守恒在各自单测，这里只挂哨兵）
    for (const c of world.getAllCharacters()) {
      expect(Number.isFinite(c.gold)).toBe(true);
    }
  }, 120_000);
});
