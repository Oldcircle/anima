/**
 * drama-verify Live 验收 Runner —— 结算链下半段（S1/S2 的摊牌弧）
 *
 * r1/r2 的缺口：300 调用只够 ~30 tick，拒绝账本从没攒到 tier≥2，
 * 升档链下半段（爽约 → 摊牌 intent → 摊牌戏 → 结算）在 live 里零样本。
 * 本剧本用 seeds 把账本预热到闸的下方一格（见 data/scenarios/drama-verify/seeds.yml），
 * 让下半段在一次 ~300 调用的短跑里就能上台——不必等 96+ tick 自然发酵。
 *
 * 无 beats 无 director（归因纪律）：摊牌必须由账本自燃，不由导演编排。
 *
 * 判读优先看四个数（⛓️ [drama-chain] 一行全给）：
 *   ①爽约/兑现次数 ②tier≥2 的对数 ③⚡摊牌注入次数 ④摊牌戏的结算判定（翻 md 战报）
 *
 * 成本纪律（与 default-verify runner 同规格）：
 * - maxLLMCalls 硬顶（ANIMA_MAX_CALLS，默认 300 ≈ ¥0.85 @v4-flash）
 * - 402/网络熔断：连续 ≥5 次 provider 错误 → 优雅停跑保数据
 * - 不做任何中途 saveGame；跑完 archiveRun 世界归档（可 --load 续跑/开面板）
 * - modelId 防呆：真 provider 配 smart-mock 类 modelId 直接 throw
 *
 * 用法：
 *   干跑彩排（零 API）：
 *     ANIMA_RUNNER_DRYRUN=1 npx vitest run --config vitest.sim.config.ts src/narrative/drama-verify.sim.test.ts
 *   live（day1 06:00→18:00，默认硬顶 300 调用）：
 *     ANIMA_LIVE_TEST=1 npx vitest run --config vitest.sim.config.ts src/narrative/drama-verify.sim.test.ts
 *
 * ⚠️ 绝不裸跑 `pnpm test:sim`——那会把 full-day/seven-day/kira-seven-day 一起点火（≈¥15+）。
 */

import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { archiveRun } from "../persistence/run-archive.js";
import { SmartMockLLM } from "../../test/helpers/smart-mock-llm.js";
import { SimReporter } from "../../test/helpers/sim-reporter.js";
import { createScenarioSim } from "../../test/helpers/scenario-sim.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/types.js";

const DRYRUN = process.env.ANIMA_RUNNER_DRYRUN === "1";
const LIVE = process.env.ANIMA_LIVE_TEST === "1" && !DRYRUN;

const START_TICK = 24; // day1 06:00（欠条 07:30 到期，摊牌窗口在上午）
const END_TICK = Number(process.env.ANIMA_SIM_END_TICK ?? 72); // 默认 day1-only 18:00
const MAX_CALLS = Number(process.env.ANIMA_MAX_CALLS ?? 300);
const BREAKER_THRESHOLD = 5;

/** 熔断包装：连续 ≥N 次 chat 失败后跳闸——之后所有调用快速失败，runner 逐 tick 检查后停跑 */
class CircuitBreakerProvider implements LLMProvider {
  readonly id: string;
  consecutiveFailures = 0;
  tripped = false;
  lastError = "";
  constructor(private readonly inner: LLMProvider, private readonly threshold: number) {
    this.id = inner.id;
  }
  async chat(request: LLMRequest, modelId: string): Promise<LLMResponse> {
    if (this.tripped) throw new Error(`circuit_open: ${this.lastError}`);
    try {
      const r = await this.inner.chat(request, modelId);
      this.consecutiveFailures = 0;
      return r;
    } catch (err) {
      this.consecutiveFailures++;
      this.lastError = (err as Error)?.message?.slice(0, 120) ?? "unknown";
      if (this.consecutiveFailures >= this.threshold) {
        this.tripped = true;
        console.error(`🔌 [熔断] 连续 ${this.consecutiveFailures} 次 provider 错误，跳闸停跑保数据：${this.lastError}`);
      }
      throw err;
    }
  }
}

interface RunnerResult {
  ticksRun: number;
  llmCalls: number;
  stoppedEarly: boolean;
  breakerTripped: boolean;
  logPath: string;
  savePath?: string;
  chain: {
    /** 爽约（放空话）次数——S2 最锋利的那一下 */
    brokenPromises: number;
    /** 兑现（说到做到）次数——另一半分支 */
    keptPromises: number;
    /** 跑完时 tier≥2 的拒绝账对数 */
    stonewalledPairs: number;
    /** ⚡ 摊牌 intent 注入次数（setIntent 钩子逐次计数，含被拒升档与疙瘩两路） */
    confrontNudges: number;
    /** 跑完时的拒绝账本（判读用完整条目） */
    refusals: Record<string, { kind: string; count: number; brokenPromises: number; tier: number }>;
  };
}

async function runDramaVerify(rawProvider: LLMProvider, modelId: string, opts?: { endTick?: number; maxCalls?: number }): Promise<RunnerResult> {
  if (rawProvider instanceof OpenAICompatibleProvider && /mock/i.test(modelId)) {
    throw new Error(`modelId 防呆：真 provider 不能配 "${modelId}"`);
  }
  const breaker = new CircuitBreakerProvider(rawProvider, BREAKER_THRESHOLD);
  const endTick = opts?.endTick ?? END_TICK;
  const maxCalls = opts?.maxCalls ?? MAX_CALLS;

  // 无 director：摊牌自燃归因纪律（manifest 也没有 beats）
  const handle = createScenarioSim({
    scenarioId: "drama-verify",
    provider: breaker,
    modelId,
    startTick: START_TICK,
    maxLLMCalls: maxCalls,
  });

  // ⚡ 摊牌注入计数：intent 会被后续 setIntent 覆盖，端点采样必漏——钩住注入瞬间
  let confrontNudges = 0;
  const origSetIntent = handle.world.setIntent.bind(handle.world);
  handle.world.setIntent = (charId, intent) => {
    if (intent?.summary?.includes("挑明")) confrontNudges++;
    origSetIntent(charId, intent);
  };

  // 实时面板（可选）：ANIMA_SIM_SERVE=1 就地起服务看这趟跑的世界，跑完即关
  let liveServer: { close: () => void } | undefined;
  if (process.env.ANIMA_SIM_SERVE === "1") {
    const port = Number(process.env.ANIMA_SIM_PORT ?? 3002);
    const { createApiServer } = await import("../api/server.js");
    const { join } = await import("node:path");
    const api = createApiServer({
      port,
      simulation: handle.sim,
      staticDir: join(import.meta.dirname, "..", "..", "web"),
      characterCards: new Map(handle.scenario.characters.map((c) => [c.id, c])),
    });
    api.start();
    liveServer = { close: () => api.server.close() };
    console.log(`\n👀 实时面板：http://localhost:${port}/#/chronicle （这趟跑的世界，跑完即关）\n`);
  }

  const reporter = new SimReporter(handle.world, handle.sim, {
    totalTicks: endTick - START_TICK,
    label: `drama-verify 验收（tick ${START_TICK}→${endTick}，模型 ${modelId}，硬顶 ${maxCalls} 调用）`,
  });

  let ticksRun = 0;
  let stoppedEarly = false;
  let logPath = "";
  let savePath: string | undefined;
  try {
    while (START_TICK + ticksRun < endTick) {
      if (breaker.tripped) {
        stoppedEarly = true;
        break;
      }
      const r = await handle.run(1);
      ticksRun += r.summaries.length;
      if (r.stoppedEarly) {
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    reporter.printSummary();
    logPath = reporter.writeLog("sim-drama-verify");
    savePath = archiveRun(handle.sim, `drama-verify-${modelId}`, "drama-verify");
    reporter.dispose();
    if (liveServer) {
      liveServer.close();
      console.log(`👀 实时面板已关。继续看这趟跑： pnpm dev --load ${savePath ?? "<归档>"}`);
    }
  }

  // 结算链机械信号收口（dispose 前读世界状态）
  const ns = handle.world.narrative;
  const chr = handle.world.chronicle.list({});
  const refusalsRaw = ns.getRefusals();
  const refusals = Object.fromEntries(
    Object.entries(refusalsRaw).map(([k, r]) => [
      k,
      { kind: r.kind, count: r.count, brokenPromises: r.brokenPromises, tier: r.tier },
    ]),
  );
  const chain = {
    brokenPromises: chr.filter((e) => e.id.startsWith("chr_defer_broken_")).length,
    keptPromises: chr.filter((e) => e.id.startsWith("chr_defer_ok_")).length,
    stonewalledPairs: Object.values(refusalsRaw).filter((r) => r.tier >= 2).length,
    confrontNudges,
    refusals,
  };
  console.log(
    `\n⛓️ [drama-chain] 爽约=${chain.brokenPromises} 兑现=${chain.keptPromises} ` +
      `tier≥2对数=${chain.stonewalledPairs} ⚡摊牌注入=${chain.confrontNudges} ` +
      `拒绝账=${JSON.stringify(refusals)} 未了欠条=${Object.keys(ns.getDeferrals()).length}`,
  );
  handle.dispose();
  return { ticksRun, llmCalls: handle.llmCalls(), stoppedEarly, breakerTripped: breaker.tripped, logPath, savePath, chain };
}

// ── 干跑：runner 编排彩排（零 API）——结算链机制彩排在 drama-verify-rehearsal.sim-mock.test.ts ──

describe.skipIf(!DRYRUN)("drama-verify runner 干跑彩排（零 API）", () => {
  it("跑满区间 + seeds 落账 + 爽约机械点火 + 日志/归档落盘", async () => {
    const r = await runDramaVerify(new SmartMockLLM(), "smart-mock", { endTick: 48, maxCalls: 10_000 });
    expect(r.ticksRun).toBe(48 - START_TICK);
    expect(r.breakerTripped).toBe(false);
    // seeds 预热 + 07:30 爽约是引擎侧机械路径，SmartMock 世界里也必然发生：
    // B 对种子 tier2 + A 对爽约后 tier2 → 至少 2 对开着摊牌门
    expect(r.chain.brokenPromises).toBeGreaterThanOrEqual(1);
    expect(r.chain.stonewalledPairs).toBeGreaterThanOrEqual(2);
    const { existsSync } = await import("node:fs");
    expect(existsSync(r.logPath)).toBe(true);
  }, 300_000);

  it("maxLLMCalls 达顶 → 停跑保数据（不跑满区间）", async () => {
    const r = await runDramaVerify(new SmartMockLLM(), "smart-mock", { endTick: 72, maxCalls: 5 });
    expect(r.stoppedEarly).toBe(true);
    expect(r.ticksRun).toBeLessThan(72 - START_TICK);
  }, 300_000);
});

// ── live：真 API 验收（默认 v4-flash，ANIMA_SIM_MODEL 可覆盖）──

describe.skipIf(!LIVE || !process.env.DEEPSEEK_API_KEY)("drama-verify Live 验收", () => {
  it(`tick ${START_TICK}→${END_TICK}（硬顶 ${MAX_CALLS} 调用，熔断阈值 ${BREAKER_THRESHOLD}）`, async () => {
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      defaultModel: process.env.ANIMA_SIM_MODEL ?? "deepseek-v4-flash",
    });
    const r = await runDramaVerify(provider, process.env.ANIMA_SIM_MODEL ?? "deepseek-v4-flash");
    console.log(
      `\n🏁 [runner] ticks=${r.ticksRun} calls=${r.llmCalls} stoppedEarly=${r.stoppedEarly} breaker=${r.breakerTripped}\n📄 战报：${r.logPath}\n💾 世界：${r.savePath ?? "(归档失败)"}`,
    );
    // 数据面基础断言（判读走 VERDICT，不在这里下结论）：至少跑出可判读的数据量
    expect(r.ticksRun).toBeGreaterThan(8);
    expect(r.llmCalls).toBeGreaterThan(30);
  }, 3_600_000);
});
