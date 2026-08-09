/**
 * default-verify Live 验收 Runner（DESIGN-revival §7）
 *
 * 走 scenario-sim harness（与 cli 同一条装配路径：scenario-loader → seeds → beats →
 * phase 工具 → Director → crime_supply），模型**钉死 deepseek-chat**（绝不读
 * data/settings.json 的 v4-pro——那是 pnpm dev 的路径）。
 *
 * 成本纪律（审查 blocker 全条落地）：
 * - maxLLMCalls 硬顶（ANIMA_MAX_CALLS，默认 320 ≈ day1-only 预算 ¥2.2-2.6），达顶停跑保数据
 * - 402/网络熔断：连续 ≥5 次 provider 错误 → 优雅停跑（已跑数据保全，不产死世界垃圾段）
 * - 不做任何中途 saveGame（防污染 data/save.db 正档）
 * - modelId 防呆：真 provider 配 smart-mock 类 modelId 直接 throw
 * - SimReporter try/finally writeLog——跑崩也要把已有数据落盘 logs/
 *
 * 用法：
 *   干跑彩排 runner 本体（零 API）：
 *     ANIMA_RUNNER_DRYRUN=1 npx vitest run --config vitest.sim.config.ts src/narrative/default-verify.sim.test.ts
 *   live 第一发（day1-only，tick 24→72）：
 *     ANIMA_LIVE_TEST=1 npx vitest run --config vitest.sim.config.ts src/narrative/default-verify.sim.test.ts
 *   延到 day2 上午（tick 24→136，需先确认余额）：
 *     ANIMA_LIVE_TEST=1 ANIMA_SIM_END_TICK=136 ANIMA_MAX_CALLS=650 npx vitest run --config ...
 *
 * ⚠️ 绝不裸跑 `pnpm test:sim`——那会把 full-day/seven-day/kira-seven-day 一起点火（≈¥15+）。
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
const END_TICK = Number(process.env.ANIMA_SIM_END_TICK ?? 72); // 默认 day1-only 18:00
const MAX_CALLS = Number(process.env.ANIMA_MAX_CALLS ?? 320);
/** 连续 provider 错误熔断阈值 */
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

/** 注入固定错误的 mock（干跑测熔断路径用） */
class AlwaysFailProvider implements LLMProvider {
  readonly id = "always-fail";
  async chat(): Promise<LLMResponse> {
    throw new Error("Payment Required (402)");
  }
}

interface RunnerResult {
  ticksRun: number;
  llmCalls: number;
  stoppedEarly: boolean;
  breakerTripped: boolean;
  logPath: string;
}

/** runner 本体：live 与干跑同一条代码路径（干跑彩排的就是这段编排逻辑本身） */
async function runDefaultVerify(rawProvider: LLMProvider, modelId: string, opts?: { endTick?: number; maxCalls?: number }): Promise<RunnerResult> {
  // modelId 防呆：真 provider 配 mock 模型名 = 全程 400 风暴，白废一发
  if (rawProvider instanceof OpenAICompatibleProvider && /mock/i.test(modelId)) {
    throw new Error(`modelId 防呆：真 provider 不能配 "${modelId}"`);
  }
  const breaker = new CircuitBreakerProvider(rawProvider, BREAKER_THRESHOLD);
  const endTick = opts?.endTick ?? END_TICK;
  const maxCalls = opts?.maxCalls ?? MAX_CALLS;

  const handle = createScenarioSim({
    scenarioId: "default-verify",
    provider: breaker,
    modelId,
    startTick: START_TICK,
    maxLLMCalls: maxCalls,
    director: { dailyBudget: 5 },
  });

  const reporter = new SimReporter(handle.world, handle.sim, {
    totalTicks: endTick - START_TICK,
    label: `default-verify 验收（tick ${START_TICK}→${endTick}，模型 ${modelId}，硬顶 ${maxCalls} 调用）`,
  });

  let ticksRun = 0;
  let stoppedEarly = false;
  let logPath = "";
  try {
    // 逐 tick 推进：每 tick 之间检查熔断（harness 的 maxLLMCalls 硬顶在 run() 内部自查）
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
    // 跑崩/熔断/达顶：已有数据必须落盘（judgment 材料保全）
    reporter.printSummary();
    logPath = reporter.writeLog("sim-default-verify");
    reporter.dispose();
    handle.dispose();
  }
  return { ticksRun, llmCalls: handle.llmCalls(), stoppedEarly, breakerTripped: breaker.tripped, logPath };
}

// ── 干跑：彩排 runner 本体（零 API，SmartMock）──

describe.skipIf(!DRYRUN)("default-verify runner 干跑彩排（零 API）", () => {
  it("跑满区间 + 日志真落盘", async () => {
    const r = await runDefaultVerify(new SmartMockLLM(), "smart-mock", { endTick: 40, maxCalls: 10_000 });
    expect(r.ticksRun).toBe(40 - START_TICK);
    expect(r.breakerTripped).toBe(false);
    const { existsSync } = await import("node:fs");
    expect(r.logPath).toBeTruthy();
    expect(existsSync(r.logPath)).toBe(true);
  }, 300_000);

  it("maxLLMCalls 达顶 → 停跑保数据（不跑满区间）", async () => {
    const r = await runDefaultVerify(new SmartMockLLM(), "smart-mock", { endTick: 72, maxCalls: 5 });
    expect(r.stoppedEarly).toBe(true);
    expect(r.ticksRun).toBeLessThan(72 - START_TICK);
  }, 300_000);

  it("连续 provider 错误 → 熔断跳闸停跑，日志仍落盘", async () => {
    const r = await runDefaultVerify(new AlwaysFailProvider(), "deepseek-chat", { endTick: 72, maxCalls: 10_000 });
    expect(r.breakerTripped).toBe(true);
    expect(r.stoppedEarly).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(r.logPath)).toBe(true);
  }, 300_000);

  it("modelId 防呆：真 provider 配 mock 模型名直接 throw", async () => {
    const real = new OpenAICompatibleProvider({ id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-fake", defaultModel: "deepseek-chat" });
    await expect(runDefaultVerify(real, "smart-mock")).rejects.toThrow(/防呆/);
  });
});

// ── live：真 API 验收（模型钉死 deepseek-chat）──

describe.skipIf(!LIVE || !process.env.DEEPSEEK_API_KEY)("default-verify Live 验收", () => {
  it(`tick ${START_TICK}→${END_TICK}（硬顶 ${MAX_CALLS} 调用，熔断阈值 ${BREAKER_THRESHOLD}）`, async () => {
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      defaultModel: "deepseek-chat",
    });
    const r = await runDefaultVerify(provider, "deepseek-chat");
    console.log(
      `\n🏁 [runner] ticks=${r.ticksRun} calls=${r.llmCalls} stoppedEarly=${r.stoppedEarly} breaker=${r.breakerTripped}\n📄 日志：${r.logPath}`,
    );
    // 数据面基础断言（判读走 VERDICT，不在这里下结论）：至少跑出了可判读的数据量
    expect(r.ticksRun).toBeGreaterThan(8);
    expect(r.llmCalls).toBeGreaterThan(30);
  }, 3_600_000);
});
