/**
 * drama-verify 离线彩排（烧钱前的必备闸）
 *
 * 与 live 验收完全相同的装配路径（scenario-loader → seeds → 无 beats 无 director），
 * SmartMockLLM 干跑，断言结算链**下半段**的机制环节全部点火——这半段 r1/r2 零样本：
 *
 * ① seeds 落账形状：A 对欠条（baseline=15 由 _verifiableProgress 现算、07:30 到期）、
 *    B 对拒绝账开局即 tier 2
 * ② 到期爽约（S2 最锋利的那一下）：欠条清掉 → 拒绝账 count1+broken1=tier2 →
 *    编年史「放了空话」→ 执念 + 疙瘩 + 关系扣分
 * ③ 摊牌闸（S1 第二入口）：tier≥2 + 同台 → ⚡ intent（措辞含「挑明」）——A、B 两对都到位
 * ④ 所求行硬化：爽约后 asuka 的对话 prompt 带「上回他答应得好好的」尾巴
 *
 * 文件名故意用 .sim-mock.test.ts：跑默认 vitest config（离线、无 API key），
 * 不落进 *.sim.test.ts 的真 API sim config 排除面。
 */

import { describe, it, expect, afterAll } from "vitest";
import { createScenarioSim, type ScenarioSimHandle } from "../../test/helpers/scenario-sim.js";
import { SmartMockLLM } from "../../test/helpers/smart-mock-llm.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/types.js";

/** 请求捕获包装：④ 要断言对话 prompt 里真的带了爽约尾巴 */
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
  /** 全部请求的正文拼接（system + messages），substring 断言用 */
  allText(): string {
    return this.requests
      .map((r) =>
        [
          typeof r.system === "string" ? r.system : "",
          ...r.messages.map((m) => (typeof m.content === "string" ? m.content : "")),
        ].join("\n"),
      )
      .join("\n");
  }
}

describe("drama-verify 离线彩排（结算链下半段）", () => {
  let handle: ScenarioSimHandle | undefined;

  afterAll(() => {
    handle?.dispose();
  });

  it("爽约 → 升档 → 摊牌注入 → 所求行硬化，全链点火", async () => {
    const mock = new SmartMockLLM();
    const capture = new CapturingProvider(mock);
    // 无 director：摊牌必须由账本自燃（归因纪律，与 live 验收同配置）
    handle = createScenarioSim({ scenarioId: "drama-verify", provider: capture });
    const { sim, world } = handle;
    const ns = world.narrative;

    // ── ① seeds 落账形状 ──
    const seededDeferral = ns.getDeferral("asuka", "shinji");
    expect(seededDeferral, "A 对欠条应已种下").toBeDefined();
    expect(seededDeferral!.baseline, "baseline 必须由 _verifiableProgress 现算出 15").toBe(15);
    expect(seededDeferral!.dueTick).toBe(30); // 开局 24 + 6 = 07:30
    expect(seededDeferral!.kind).toBe("debt");

    const seededRefusal = ns.getRefusal("senjougahara", "lelouch");
    expect(seededRefusal, "B 对拒绝账应已种下").toBeDefined();
    expect(seededRefusal!).toMatchObject({ kind: "hostile", count: 2, tier: 2, brokenPromises: 0 });

    expect(world.getCharacter("shinji")!.gold, "initial_gold 预热").toBe(20);
    const relBefore = sim.relationships.get("asuka", "shinji").level;

    // ── 摊牌 intent 观测：钩住 setIntent 记录注入瞬间 ──
    // 不能逐 tick 采样残留：SmartMock 乱枪的失败反馈 intent 会在同一 tick 内把
    // ⚡ 注入的 intent 盖掉（setIntent 是覆盖语义），端点采样必漏
    const confrontIntents = new Map<string, string>(); // charId → 首次注入的摊牌 intent 措辞
    const origSetIntent = world.setIntent.bind(world);
    world.setIntent = (charId, intent) => {
      if (intent?.summary?.includes("挑明") && !confrontIntents.has(charId)) {
        confrontIntents.set(charId, intent.summary);
      }
      origSetIntent(charId, intent);
    };

    // ── ② 跑过 07:30 到期点：机械爽约（决策前扫，零 LLM）──
    await handle.run(7); // tick 24 → 31
    expect(ns.getDeferral("asuka", "shinji"), "到期欠条应被清掉").toBeUndefined();
    const afterBreak = ns.getRefusal("asuka", "shinji");
    expect(afterBreak, "爽约必须落成带 brokenPromise 的拒绝账").toBeDefined();
    expect(afterBreak!).toMatchObject({ kind: "debt", count: 1, brokenPromises: 1, tier: 2 });

    // 落账连带：编年史（放空话，importance 7）/ 执念 / 疙瘩 / 关系扣分
    const chr = world.chronicle.list({});
    expect(
      chr.some((e) => e.id === "chr_defer_broken_asuka_shinji_30"),
      "编年史应有「放了空话」条目",
    ).toBe(true);
    expect(
      ns.getCharacter("asuka").obsessions.some((o) => o.id === "obs_refusal_asuka_shinji"),
      "爽约应给 asuka 挂执念",
    ).toBe(true);
    expect(
      sim.impressions.get("asuka", "shinji")!.frictions.length,
      "爽约应追加疙瘩（种子 1 + 爽约 1）",
    ).toBeGreaterThanOrEqual(2);
    expect(sim.relationships.get("asuka", "shinji").level).toBeLessThan(relBefore);

    // ── ③ 摊牌闸：tier≥2 + 同台 → ⚡ intent（含「挑明」）──
    // 两对都做**受控探针**：SmartMock 每 tick 乱试工具，失败反馈 intent 会把槽位一直
    // 占着，游走路径也不保证同台（首版靠"有机交汇"过了一次，复跑即碎）。
    // live 里真模型没有这种镜头级噪声（r2 实测 ⚡ 6 次说明槽位流通）——
    // 彩排验的是闸门接线本身，有机自燃是 live 判读项，不在 mock 里赌。
    const pinPair = sim.onTick(() => {
      for (const [anchor, follower] of [["asuka", "shinji"], ["senjougahara", "lelouch"]] as const) {
        const loc = world.getCharacter(anchor)!.locationId;
        if (world.getCharacter(follower)!.locationId !== loc) world.moveCharacter(follower, loc);
      }
    });
    const freeSlot = sim.onTick(() => {
      for (const id of ["asuka", "senjougahara"]) {
        const intent = world.getCurrentIntent(id, world.tick);
        if (intent && !intent.summary.includes("挑明")) world.clearIntent(id);
      }
    });
    await handle.run(6);
    freeSlot();
    expect(
      confrontIntents.get("asuka"),
      "A 对：爽约推开的摊牌门应注入「挑明」intent",
    ).toBeDefined();
    expect(
      confrontIntents.get("senjougahara"),
      "B 对：种子 tier2 的摊牌门应注入「挑明」intent",
    ).toBeDefined();
    expect(confrontIntents.get("senjougahara")).toContain("2 回");

    // ── ④ 所求行硬化：对话 prompt 带爽约尾巴（bp=1 的专属措辞）──
    mock.scriptTalk("asuka", [
      { target: "shinji", message: "站住。打烊前给准数的话是你自己说的——现在呢？" },
    ]);
    mock.scriptTalk("shinji", [{ target: "asuka", message: "对不起……我、我这就想办法。" }]);
    await handle.run(6);
    pinPair();
    expect(mock.pendingScriptCount(), "剧本台词应全部说出口").toBe(0);
    expect(
      capture.allText(),
      "asuka 的对话 prompt 应带「上回他答应得好好的」尾巴",
    ).toContain("上回他答应得好好的");
  }, 120_000);
});
