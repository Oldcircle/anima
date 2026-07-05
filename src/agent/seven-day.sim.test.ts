/**
 * 7-Day Live Simulation — 默认阵容（7 角色）跑 7 天
 *
 * 运行方式: pnpm test:sim
 * 预计耗时: 20-40 分钟
 *
 * 长线基线：观察涌现引擎的多日表现——约定兑现/爽约、积怨-和解弧线、
 * valence（关系水位）是否正向通胀。实时输出每个 tick 的决策，
 * 收尾在 logs/ 下产出含「涌现引擎长线信号」章节的 Markdown。
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Simulation } from "./simulation.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadCharactersFromDir } from "../character/loader.js";
import { loadLocationsFromDir } from "../world/location-loader.js";
import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { SimReporter } from "../../test/helpers/sim-reporter.js";

loadEnv();

const SKIP = !process.env.ANIMA_LIVE_TEST && !process.env.DEEPSEEK_API_KEY;

describe.skipIf(SKIP)("7-Day Live Simulation", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("7 角色跑 7 天", async () => {
    const DATA_DIR = join(import.meta.dirname, "../../data");
    const locations = loadLocationsFromDir(join(DATA_DIR, "locations"));
    const characters = loadCharactersFromDir(join(DATA_DIR, "characters"));
    // 默认阵容 = data/characters 里未 disabled 的 7 个角色
    // （asuka/L/lelouch/light/rei/senjougahara/shinji）。改动阵容时同步这里。
    expect(characters.length).toBe(7);

    const world = new World(locations, 0);
    for (const card of characters) {
      world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    }
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    const TOTAL_TICKS = 96 * 7; // 672

    // 实时输出
    const reporter = new SimReporter(world, sim, {
      totalTicks: TOTAL_TICKS,
      label: "7 天模拟：默认阵容 7 角色",
    });

    await sim.runTicks(TOTAL_TICKS, 0);
    await sim.waitForBackgroundTasks();

    reporter.printSummary();
    reporter.writeLog("sim-7day");
    reporter.dispose();

    // 基本验证
    expect(reporter.stats.totalActions).toBeGreaterThan(50);
    expect(eventBus.history.length).toBeGreaterThan(50);
  }, 3600_000);
});
