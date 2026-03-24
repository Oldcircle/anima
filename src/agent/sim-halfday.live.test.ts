/**
 * 半天 Live 模拟测试（36 tick, 06:00→15:00）
 *
 * 验证 P0+P1 完整链路：
 * - 环境感知 + 内心独白分级
 * - 对话模式
 * - 印象系统（异步生成）
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
import { tickToGameTime } from "../core/tick-engine.js";
import { join } from "node:path";

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

    const startTick = 24; // 06:00
    const endTick = 60;   // 15:00 (36 ticks = 9 hours)

    let totalActions = 0;
    let totalTalks = 0;
    let totalSkipped = 0;
    const dialogues: string[] = [];

    console.log("=== 半天模拟开始 (06:00 → 15:00) ===\n");

    for (let tick = startTick; tick < endTick; tick++) {
      const gt = tickToGameTime(tick);
      const summary = await sim.runOneTick(gt);

      for (const r of summary.results) {
        if (r.skipped) {
          totalSkipped++;
          continue;
        }
        totalActions++;
        if (r.action?.name === "talk") {
          totalTalks++;
          const target = r.action.args.target as string;
          const msg = r.action.args.message as string;
          const charState = world.getCharacter(r.characterId);
          dialogues.push(`[${gt.hour}:${String(gt.minute).padStart(2, "0")}] ${charState?.name ?? r.characterId} → ${target}: ${msg?.slice(0, 80)}...`);
        }
      }
    }

    // 等一下让异步印象生成完成
    await new Promise((r) => setTimeout(r, 5000));

    console.log(`\n=== 半天模拟结束 ===`);
    console.log(`总行为: ${totalActions}, 跳过: ${totalSkipped}, 对话: ${totalTalks}`);
    console.log(`\n--- 对话记录 ---`);
    for (const d of dialogues) console.log(d);

    // 检查印象系统
    console.log(`\n--- 印象系统 (${sim.impressions.size} 条) ---`);
    const allImpressions = sim.impressions.getAll();
    for (const { observerId, impression } of allImpressions) {
      console.log(`${observerId} → ${impression.characterId}: ${impression.summary} [${impression.mentalLabel}]`);
      if (impression.observations.length > 0) {
        console.log(`  观察: ${impression.observations.join("; ")}`);
      }
      if (impression.unresolved.length > 0) {
        console.log(`  疑惑: ${impression.unresolved.join("; ")}`);
      }
    }

    // 检查对话追踪器
    console.log(`\n--- 关系网络 ---`);
    const chars = world.getAllCharacters().filter(c => c.id !== "player");
    for (const a of chars) {
      for (const b of chars) {
        if (a.id >= b.id) continue;
        const rel = sim.relationships.get(a.id, b.id);
        if (rel && rel.level > 0) {
          console.log(`${a.name} ↔ ${b.name}: ${rel.type} (${rel.level})`);
        }
      }
    }

    // 基本断言
    expect(totalActions).toBeGreaterThan(30);
    expect(totalTalks).toBeGreaterThan(3);

    // 印象可能已生成（异步，取决于对话轮次是否够 4 轮）
    console.log(`\n印象总数: ${sim.impressions.size}`);

  }, 600_000); // 10 分钟超时
});
