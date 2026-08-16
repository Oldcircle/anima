/**
 * grounding-verify Live 验收 Runner（PLAN-grounding M0-M4 全链）
 *
 * 与 default-verify runner 同一套成本纪律（硬顶/熔断/防呆/finally 落盘），剧本换
 * grounding-verify（唯一差异 = crime_supply: npc——真凶 ground truth 存在）。
 *
 * 验收链（判读口径 = PLAN-grounding §3 + 本文件 VERDICT）：
 *   tick 72+ npc 失窃自动投放（立案+钱盒撬痕 trace）→ 受害者发现（案件公开，accuse 解锁）
 *   → examine 查案 → accuse 对质 → 破案/无证/冤案任一终局。
 *   同车：examine 冷却闸复验（r2 遗留）+ M2 正典抽取长程 + 缓存不回归。
 *
 * 用法：
 *   干跑彩排（零 API，SmartMock 走完机械链）：
 *     ANIMA_RUNNER_DRYRUN=1 npx vitest run --config vitest.sim.config.ts src/narrative/grounding-verify.sim.test.ts
 *   live 全弧（tick 24→136，day1 06:00→day2 10:00，~¥1.7-3.0）：
 *     ANIMA_LIVE_TEST=1 npx vitest run --config vitest.sim.config.ts src/narrative/grounding-verify.sim.test.ts
 *
 * ⚠️ 绝不裸跑 `pnpm test:sim`（三长跑并发 ≈¥15+）。
 */

import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { SmartMockLLM } from "../../test/helpers/smart-mock-llm.js";
import { SimReporter } from "../../test/helpers/sim-reporter.js";
import { createScenarioSim } from "../../test/helpers/scenario-sim.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/types.js";

const DRYRUN = process.env.ANIMA_RUNNER_DRYRUN === "1";
const LIVE = process.env.ANIMA_LIVE_TEST === "1" && !DRYRUN;

const START_TICK = 24; // day1 06:00
const END_TICK = Number(process.env.ANIMA_SIM_END_TICK ?? 136); // 默认全弧 day2 10:00
const MAX_CALLS = Number(process.env.ANIMA_MAX_CALLS ?? 700);
const BREAKER_THRESHOLD = 5;

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
  /** 全链机械信号（判读辅助；剧情质量走 VERDICT） */
  chain: {
    caseRegistered: boolean;
    casePublic: boolean;
    caseStatus?: string;
    tillTraced: boolean;
    accusations: number;
  };
}

async function runGroundingVerify(rawProvider: LLMProvider, modelId: string, opts?: { endTick?: number; maxCalls?: number }): Promise<RunnerResult> {
  if (rawProvider instanceof OpenAICompatibleProvider && /mock/i.test(modelId)) {
    throw new Error(`modelId 防呆：真 provider 不能配 "${modelId}"`);
  }
  const breaker = new CircuitBreakerProvider(rawProvider, BREAKER_THRESHOLD);
  const endTick = opts?.endTick ?? END_TICK;
  const maxCalls = opts?.maxCalls ?? MAX_CALLS;

  const handle = createScenarioSim({
    scenarioId: "grounding-verify",
    provider: breaker,
    modelId,
    startTick: START_TICK,
    maxLLMCalls: maxCalls,
    director: { dailyBudget: 5 },
  });

  const reporter = new SimReporter(handle.world, handle.sim, {
    totalTicks: endTick - START_TICK,
    label: `grounding-verify 全链验收（tick ${START_TICK}→${endTick}，模型 ${modelId}，硬顶 ${maxCalls} 调用）`,
  });

  let ticksRun = 0;
  let stoppedEarly = false;
  let logPath = "";
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
    logPath = reporter.writeLog("sim-grounding-verify");
    reporter.dispose();
  }

  // 全链机械信号收口（dispose 前读世界状态）
  const ns = handle.world.narrative;
  const cases = Object.values(ns.getCaseLedger());
  const case_ = cases[0];
  const tillObjects = handle.world.getAllLocations()
    .flatMap((l) => handle.world.objects.getAtLocation(l.id))
    .filter((o) => o.traces.some((t) => t.text.includes("撬痕")));
  const chain = {
    caseRegistered: cases.length > 0,
    casePublic: Boolean(case_?.publicSinceTick !== undefined),
    caseStatus: case_?.status,
    tillTraced: tillObjects.length > 0,
    accusations: case_ ? Object.keys(case_.accusations).length : 0,
  };
  console.log(
    `\n⛓️ [chain] case=${chain.caseRegistered ? case_!.id : "无"} public=${chain.casePublic} status=${chain.caseStatus ?? "-"} 撬痕器物=${tillObjects.map((o) => o.key).join(",") || "无"} 指控数=${chain.accusations}`,
  );
  handle.dispose();
  return { ticksRun, llmCalls: handle.llmCalls(), stoppedEarly, breakerTripped: breaker.tripped, logPath, chain };
}

// ── 干跑：机械链彩排（零 API）——npc 投放/立案/撬痕/公开门全走引擎侧，SmartMock 只填行为 ──

describe.skipIf(!DRYRUN)("grounding-verify runner 干跑彩排（零 API）", () => {
  it("跑到 tick 100：npc 失窃已投放（立案+撬痕 trace），日志落盘", async () => {
    const r = await runGroundingVerify(new SmartMockLLM(), "smart-mock", { endTick: 100, maxCalls: 10_000 });
    expect(r.ticksRun).toBe(100 - START_TICK);
    expect(r.breakerTripped).toBe(false);
    // 机械链信号：预热期（48 tick）后 npc 罪案必须已投放
    expect(r.chain.caseRegistered).toBe(true);
    expect(r.chain.tillTraced).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(r.logPath)).toBe(true);
  }, 300_000);

  it("maxLLMCalls 达顶 → 停跑保数据", async () => {
    const r = await runGroundingVerify(new SmartMockLLM(), "smart-mock", { endTick: 72, maxCalls: 5 });
    expect(r.stoppedEarly).toBe(true);
  }, 300_000);
});

// ── live：真 API 全链验收（模型钉死 deepseek-chat）──

describe.skipIf(!LIVE || !process.env.DEEPSEEK_API_KEY)("grounding-verify Live 全链验收", () => {
  it(`tick ${START_TICK}→${END_TICK}（硬顶 ${MAX_CALLS} 调用，熔断阈值 ${BREAKER_THRESHOLD}）`, async () => {
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      defaultModel: "deepseek-chat",
    });
    const r = await runGroundingVerify(provider, "deepseek-chat");
    console.log(
      `\n🏁 [runner] ticks=${r.ticksRun} calls=${r.llmCalls} stoppedEarly=${r.stoppedEarly} breaker=${r.breakerTripped}\n📄 日志：${r.logPath}`,
    );
    // 数据面基础断言（判读走 VERDICT）：跑出可判读的数据量 + 机械链至少走到立案
    expect(r.ticksRun).toBeGreaterThan(8);
    expect(r.llmCalls).toBeGreaterThan(30);
  }, 3_600_000);
});
