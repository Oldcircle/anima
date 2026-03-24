/**
 * Full Day Simulation — 6 角色跑完整一天
 *
 * 运行方式: pnpm test:sim
 * 输出: logs/sim-1day-<timestamp>.md
 *
 * 实时输出每个 tick 的决策，不需要等到最后。
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

describe.skipIf(SKIP)("Full Day Simulation — 6 Characters", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("6 角色从早到晚一整天 (06:00→23:45)", async () => {
    const DATA_DIR = join(import.meta.dirname, "../../data");
    const locations = loadLocationsFromDir(join(DATA_DIR, "locations"));
    const characters = loadCharactersFromDir(join(DATA_DIR, "characters"));
    expect(characters.length).toBe(5);

    const world = new World(locations, 24); // tick 24 = 06:00
    for (const card of characters) {
      world.addCharacter(card.id, card.name, card.home);
    }
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    // 实时输出
    const reporter = new SimReporter(world, sim, {
      totalTicks: 72,
      label: "一日模拟：6 角色 (06:00 → 23:45)",
    });

    // 运行 72 tick = 06:00 → 23:45
    await sim.runTicks(72, 24);
    await sim.waitForBackgroundTasks();

    reporter.printSummary();
    reporter.writeLog("sim-1day");
    reporter.dispose();

    // 验证
    expect(reporter.stats.totalActions).toBeGreaterThan(10);
    expect(eventBus.history.length).toBeGreaterThan(10);
    for (const c of world.getAllCharacters()) {
      expect(c.needs.energy).toBeGreaterThanOrEqual(0);
    }
  }, 900_000);
});
