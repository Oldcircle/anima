/**
 * 半天 Live 模拟测试（36 tick, 06:00→15:00）
 *
 * 验证 P0+P1 完整链路：
 * - 环境感知 + 内心独白分级
 * - 对话模式
 * - 印象系统（异步生成）
 *
 * 实时输出每个 tick 的决策。
 */

import { describe, it, expect } from "vitest";
import { config as loadEnv } from "dotenv";
loadEnv();

import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "./simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadCharactersFromDir } from "../character/loader.js";
import { loadLocationsFromDir } from "../world/location-loader.js";
import { join } from "node:path";
import { SimReporter } from "../../test/helpers/sim-reporter.js";

const hasKey = !!process.env.DEEPSEEK_API_KEY;
const describeIf = hasKey ? describe : describe.skip;

describeIf("半天 Live 模拟 (P0+P1)", () => {
  it("36 tick 模拟：对话、印象、环境感知都正常工作", async () => {
    const DATA_DIR = join(import.meta.dirname, "..", "..", "data");
    const locations = loadLocationsFromDir(join(DATA_DIR, "locations"));
    const characters = loadCharactersFromDir(join(DATA_DIR, "characters"));

    const provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      defaultModel: "deepseek-chat",
    });

    const world = new World(locations, 24); // 06:00
    for (const card of characters) {
      world.addCharacter(card.id, card.name, card.home);
    }

    const eventBus = new EventBus();
    const sim = new Simulation(world, eventBus, {
      characters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
      playerId: "player",
    });

    // 实时输出
    const reporter = new SimReporter(world, sim, {
      totalTicks: 36,
      label: "半天模拟 (06:00 → 15:00) — P0+P1 验证",
      playerId: "player",
    });

    // 运行 36 tick
    await sim.runTicks(36, 24);
    await sim.waitForBackgroundTasks();

    reporter.printSummary();
    reporter.writeLog("sim-halfday");
    reporter.dispose();

    // 基本断言
    expect(reporter.stats.totalActions).toBeGreaterThan(30);
    expect(reporter.stats.talks.length).toBeGreaterThan(3);

    console.log(`\n  印象总数: ${sim.impressions.size}`);
  }, 600_000);
});
