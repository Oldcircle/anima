/**
 * Kira-Incident 7 天全戏（真实 DeepSeek，~50-80 分钟，2500+ 调用）
 *
 * 一石三鸟：
 * 1. kira 弧线：light 对真实镇民下不下手（真名保护后 L 写不动）、写谁、L 的模式推理爬不爬
 * 2. POV 深翻 + 私有通道的 7 天稳定性（两层动机比例走势，🎭 日志）
 * 3. 上轮联合复验的遗留观察项（经济曲线/食物话题/argue/约定/饿倒命运讨债，各 emoji 日志）
 *
 * 断言只锁引擎一致性；剧情自由。跑长程必须 nohup 脱管（07-07 教训）。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { ALL_KIRA_ACTIONS } from "../actions/kira-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadScenario, applyInitialItems, applyKiraProtections } from "./scenario-loader.js";
import { setBreakLevel, setDecisionPov } from "../agent/break-config.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { SimReporter } from "../../test/helpers/sim-reporter.js";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

const SKIP = !process.env.DEEPSEEK_API_KEY;

describe.skipIf(SKIP)("Kira-Incident 7 天全戏", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  afterAll(() => {
    setBreakLevel("mild");
    setDecisionPov("first");
  });

  it("7 角色 × 7 天 @kira-incident", async () => {
    const projectRoot = join(import.meta.dirname, "../..");
    const scenario = loadScenario("kira-incident", { projectRoot });
    expect(scenario.characters.length).toBe(7);

    setBreakLevel(scenario.manifest.breakLevel);
    setDecisionPov(scenario.manifest.decisionPov);

    const START = 24; // D1 06:00
    const world = new World(scenario.locations, START);
    for (const card of scenario.characters) {
      world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    }
    applyInitialItems(world, scenario.manifest);
    applyKiraProtections(world, scenario.manifest);

    const eventBus = new EventBus();
    const sim = new Simulation(world, eventBus, {
      characters: scenario.characters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });
    sim.registerPhaseTools({ kira: ALL_KIRA_ACTIONS });
    sim.loadBeats(scenario.beats);
    sim.enableDirector({ provider, modelId: "deepseek-chat", dailyBudget: 5 });
    if (scenario.seeds) sim.applySeeds(scenario.seeds);

    const TICKS = 96 * 7; // 672
    const reporter = new SimReporter(world, sim, {
      totalTicks: TICKS,
      label: "基拉事件 · 7 天全戏（strong + third + 真名保护）",
    });

    for (let i = 0; i < TICKS; i++) {
      const gt = tickToGameTime(START + i);
      sim.runBeatScan(gt);
      if (gt.hour === 6 && gt.minute === 0) sim.runDailyPacingCheck(gt);
      await sim.runOneTick(gt);
    }
    await sim.waitForBackgroundTasks();

    reporter.printSummary();
    reporter.writeLog("sim-kira-7day");
    reporter.dispose();

    const k = world.kira;
    console.log(`\n📓 kira 终局: total=${k.total} victims=[${k.victims.join(",")}] pending=${k.pending.length} lastStrikeDay=${k.lastStrikeDay}`);
    // 引擎一致性（剧情自由）
    expect(k.total).toBe(k.victims.length);
    for (const vid of k.victims) expect(vid).not.toBe("light");
    expect(k.victims).not.toContain("l_lawliet"); // 真名保护下 L 写不动
    expect(reporter.stats.totalActions).toBeGreaterThan(300);
  }, 7200_000);
});
