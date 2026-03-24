/**
 * 半天加速模拟脚本 — 验证修复效果
 */
import { config as loadEnv } from "dotenv";
loadEnv();

import { World } from "../src/world/world.js";
import { EventBus } from "../src/core/event-bus.js";
import { Simulation } from "../src/agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../src/actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { loadCharactersFromDir } from "../src/character/loader.js";
import { loadLocationsFromDir } from "../src/world/location-loader.js";
import { tickToGameTime } from "../src/core/tick-engine.js";
import { join } from "node:path";

const DATA = join(import.meta.dirname, "..", "data");
const locations = loadLocationsFromDir(join(DATA, "locations"));
const characters = loadCharactersFromDir(join(DATA, "characters"));

const provider = new OpenAICompatibleProvider({
  id: "deepseek",
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  defaultModel: "deepseek-chat",
});

const world = new World(locations, 24);
for (const c of characters) world.addCharacter(c.id, c.name, c.home);

const eventBus = new EventBus();
const sim = new Simulation(world, eventBus, {
  characters,
  actions: ALL_BASIC_ACTIONS,
  provider,
  modelId: "deepseek-chat",
});

const START = 24; // 06:00
const END = 60;   // 15:00
let talks = 0;
let actions = 0;

console.log("=== 半天加速模拟 (06:00→15:00) ===\n");
const t0 = Date.now();

for (let tick = START; tick < END; tick++) {
  const gt = tickToGameTime(tick);
  const s = await sim.runOneTick(gt);
  for (const r of s.results) {
    if (!r.skipped) {
      actions++;
      if (r.action?.name === "talk" && r.result?.success !== false) {
        talks++;
        const ch = world.getCharacter(r.characterId);
        const msg = (r.action.args.message as string)?.slice(0, 60);
        console.log(`  [${gt.hour}:${String(gt.minute).padStart(2, "0")}] ${ch?.name} → ${r.action.args.target}: ${msg}...`);
      }
    }
  }
  process.stdout.write(".");
}

// 等印象异步完成
await new Promise((r) => setTimeout(r, 5000));

const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n\n=== 完成 ===`);
console.log(`总行为: ${actions}, 对话: ${talks}, 耗时: ${elapsed}s`);

// 关系网络（双向）
console.log("\n--- 关系网络（双向） ---");
const chars = world.getAllCharacters();
for (const a of chars) {
  for (const b of chars) {
    if (a.id >= b.id) continue;
    const ab = sim.relationships.get(a.id, b.id);
    const ba = sim.relationships.get(b.id, a.id);
    if ((ab && ab.level > 0) || (ba && ba.level > 0)) {
      console.log(`  ${a.name} → ${b.name}: ${ab?.level ?? 0}  |  ${b.name} → ${a.name}: ${ba?.level ?? 0}`);
    }
  }
}

// 印象
console.log(`\n--- 印象 (${sim.impressions.size} 条) ---`);
for (const { observerId, impression } of sim.impressions.getAll()) {
  console.log(`  ${observerId} → ${impression.characterId}: ${impression.summary} [${impression.mentalLabel}]`);
}
