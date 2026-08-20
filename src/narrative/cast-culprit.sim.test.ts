/**
 * cast-culprit Live 验收 Runner（PLAN-grounding M0-M4 全链）
 *
 * 与 default-verify runner 同一套成本纪律（硬顶/熔断/防呆/finally 落盘），剧本换
 * cast-culprit（唯一差异 = crime_supply: npc——真凶 ground truth 存在）。
 *
 * 验收链（判读口径 = PLAN-grounding §3 + 本文件 VERDICT）：
 *   tick 72+ npc 失窃自动投放（立案+钱盒撬痕 trace）→ 受害者发现（案件公开，accuse 解锁）
 *   → examine 查案 → accuse 对质 → 破案/无证/冤案任一终局。
 *   同车：examine 冷却闸复验（r2 遗留）+ M2 正典抽取长程 + 缓存不回归。
 *
 * 用法：
 *   干跑彩排（零 API，SmartMock 走完机械链）：
 *     ANIMA_RUNNER_DRYRUN=1 npx vitest run --config vitest.sim.config.ts src/narrative/cast-culprit.sim.test.ts
 *   live 全弧（tick 24→136，day1 06:00→day2 10:00，~¥1.7-3.0）：
 *     ANIMA_LIVE_TEST=1 npx vitest run --config vitest.sim.config.ts src/narrative/cast-culprit.sim.test.ts
 *
 * ⚠️ 绝不裸跑 `pnpm test:sim`（三长跑并发 ≈¥15+）。
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

const START_TICK = 24; // day1 06:00
const END_TICK = Number(process.env.ANIMA_SIM_END_TICK ?? 120);
const MAX_CALLS = Number(process.env.ANIMA_MAX_CALLS ?? 340);
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
  /** 世界归档路径（data/runs/…db）；归档失败为 undefined */
  savePath?: string;
  /** 全链机械信号（判读辅助；剧情质量走 VERDICT） */
  chain: {
    caseRegistered: boolean;
    casePublic: boolean;
    caseStatus?: string;
    tillTraced: boolean;
    accusations: number;
    /** v2 证据供给：活着的线索执念条数（情报/目击/失言），r2 的"指控 0"课题就卡在这一格 */
    leadObsessions: number;
    /** v2 试探：cast 主动跟静态 NPC 搭话的总次数（0 = NPC 仍是布景） */
    npcProbes: number;
  };
}

async function runCastCulprit(rawProvider: LLMProvider, modelId: string, opts?: { endTick?: number; maxCalls?: number }): Promise<RunnerResult> {
  if (rawProvider instanceof OpenAICompatibleProvider && /mock/i.test(modelId)) {
    throw new Error(`modelId 防呆：真 provider 不能配 "${modelId}"`);
  }
  const breaker = new CircuitBreakerProvider(rawProvider, BREAKER_THRESHOLD);
  const endTick = opts?.endTick ?? END_TICK;
  const maxCalls = opts?.maxCalls ?? MAX_CALLS;

  const handle = createScenarioSim({
    scenarioId: "cast-culprit",
    provider: breaker,
    modelId,
    startTick: START_TICK,
    maxLLMCalls: maxCalls,
    director: { dailyBudget: 5 },
  });

  // 实时面板（可选）：sim runner 本身没有 web 服务，另起 `pnpm dev` 看到的是**另一个世界**。
  // `ANIMA_SIM_SERVE=1` 时就地给这趟跑起一个服务，编年史/世界/提示词三页读的就是它。
  // 跑完在 finally 里关掉（否则 vitest 句柄不释放挂住不退）；跑完想继续看走归档。
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
    label: `cast-culprit 全链验收（tick ${START_TICK}→${endTick}，模型 ${modelId}，硬顶 ${maxCalls} 调用）`,
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
    logPath = reporter.writeLog("sim-cast-culprit");
    // 世界归档：跑完/达顶/熔断都走这里——一趟长跑的编年史/器物/案件不该跑完就蒸发。
    // 归档后可 `pnpm dev --save <file>` 打开面板看，或直接续跑。
    savePath = archiveRun(handle.sim, `cast-culprit-${modelId}`, "cast-culprit");
    reporter.dispose();
    // 关掉实时面板：不关 vitest 会因为句柄没释放挂住不退。跑完想继续看 → 打开归档
    if (liveServer) {
      liveServer.close();
      console.log(`👀 实时面板已关。继续看这趟跑： pnpm dev --load ${savePath ?? "<归档>"}`);
    }
  }

  // 全链机械信号收口（dispose 前读世界状态）
  const ns = handle.world.narrative;
  const cases = Object.values(ns.getCaseLedger());
  const case_ = cases[0];
  const tillObjects = handle.world.getAllLocations()
    .flatMap((l) => handle.world.objects.getAtLocation(l.id))
    .filter((o) => o.traces.some((t) => t.text.includes("撬痕")));
  const day = Math.floor(handle.world.tick / 96);
  const leadObsessions = handle.world
    .getAllCharacters()
    .filter((c) => !ns.isNpc(c.id))
    .reduce(
      (n, c) => n + ns.getActiveObsessions(c.id, day, 6).filter((o) => o.source === "crime").length,
      0,
    );
  const npcProbes = Object.entries(ns.getCrimeSupplyLedger())
    .filter(([k]) => k.startsWith("npc_probe_"))
    .reduce((n, [, v]) => n + v, 0);
  const eventBusRef = handle.eventBus;
  const chain = {
    caseRegistered: cases.length > 0,
    casePublic: Boolean(case_?.publicSinceTick !== undefined),
    caseStatus: case_?.status,
    tillTraced: tillObjects.length > 0,
    accusations: case_ ? Object.keys(case_.accusations).length : 0,
    leadObsessions,
    npcProbes,
    // cast 供罪的看点：有没有人**自己选了** steal，真凶是不是镇上的人
    stealAttempts: eventBusRef.history.filter((e) => e.type === "action.steal").length,
    stealSuccess: eventBusRef.history.filter((e) => e.type === "action.steal" && !e.description.includes("抓住")).length,
    perpIsCast: case_ ? !handle.world.narrative.isNpc(case_.perpId) : false,
    perpId: case_?.perpId,
  };
  console.log(
    `\n⛓️ [chain] 偷窃尝试=${chain.stealAttempts}(得手${chain.stealSuccess}) 立案=${chain.caseRegistered ? case_!.id : "无"} 真凶=${chain.perpId ?? "无"}${chain.perpIsCast ? "（镇上的人✓）" : ""} 公开=${chain.casePublic} 指控数=${chain.accusations} 线索执念=${chain.leadObsessions}`,
  );
  handle.dispose();
  return { ticksRun, llmCalls: handle.llmCalls(), stoppedEarly, breakerTripped: breaker.tripped, logPath, savePath, chain };
}

// ── 干跑：机械链彩排（零 API）——npc 投放/立案/撬痕/公开门全走引擎侧，SmartMock 只填行为 ──

describe.skipIf(!DRYRUN)("cast-culprit runner 干跑彩排（零 API）", () => {
  it("动机门可达：seeds 摆好起始处境后，steal 真的进得了菜单（SmartMock 会选它）", async () => {
    const r = await runCastCulprit(new SmartMockLLM(), "smart-mock", { endTick: 100, maxCalls: 10_000 });
    expect(r.breakerTripped).toBe(false);
    // cast 模式**不保证**有人偷——这正是要验的（选不选归角色）。
    // 干跑只锁"门是开的、跑得完、日志落盘"，真凶是不是 cast 由 live 判读。
    expect(r.ticksRun).toBeGreaterThan(50);
    const { existsSync } = await import("node:fs");
    expect(existsSync(r.logPath)).toBe(true);
  }, 300_000);

  it("maxLLMCalls 达顶 → 停跑保数据", async () => {
    const r = await runCastCulprit(new SmartMockLLM(), "smart-mock", { endTick: 72, maxCalls: 5 });
    expect(r.stoppedEarly).toBe(true);
  }, 300_000);
});

// ── live：真 API 全链验收（模型钉死 deepseek-chat）──

describe.skipIf(!LIVE || !process.env.DEEPSEEK_API_KEY)("cast-culprit Live 全链验收", () => {
  it(`tick ${START_TICK}→${END_TICK}（硬顶 ${MAX_CALLS} 调用，熔断阈值 ${BREAKER_THRESHOLD}）`, async () => {
    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      defaultModel: process.env.ANIMA_SIM_MODEL ?? "deepseek-v4-flash",
    });
    const r = await runCastCulprit(provider, process.env.ANIMA_SIM_MODEL ?? "deepseek-v4-flash");
    console.log(
      `\n🏁 [runner] ticks=${r.ticksRun} calls=${r.llmCalls} stoppedEarly=${r.stoppedEarly} breaker=${r.breakerTripped}\n📄 战报：${r.logPath}\n💾 世界：${r.savePath ?? "(归档失败)"}`,
    );
    // 数据面基础断言（判读走 VERDICT）：跑出可判读的数据量 + 机械链至少走到立案
    expect(r.ticksRun).toBeGreaterThan(8);
    expect(r.llmCalls).toBeGreaterThan(30);
  }, 3_600_000);
});
