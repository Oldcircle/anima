/**
 * POV 探针 — 抓「决策前内心原文」对比第一人称 vs 第三人称。
 * 只读：不改任何生产代码，跑短 sim（18 tick）把每个决策的 thought 落盘。
 * 用法：DEEPSEEK_API_KEY=... tsx scripts/probe-thoughts.ts <first|third>
 */
import { config as loadEnv } from "dotenv";
loadEnv();

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { World } from "../src/world/world.js";
import { EventBus } from "../src/core/event-bus.js";
import { Simulation } from "../src/agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../src/actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { loadCharactersFromDir } from "../src/character/loader.js";
import { loadLocationsFromDir } from "../src/world/location-loader.js";
import { tickToGameTime } from "../src/core/tick-engine.js";
import { setBreakLevel, setDecisionPov, type DecisionPov } from "../src/agent/break-config.js";

const pov = (process.argv[2] ?? "first") as DecisionPov;
setBreakLevel("strong");
setDecisionPov(pov);

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
for (const c of characters) world.addCharacter(c.id, c.name, c.home, undefined, c.life, c.gender);

const sim = new Simulation(world, new EventBus(), {
  characters,
  actions: ALL_BASIC_ACTIONS,
  provider,
  modelId: "deepseek-chat",
});

const START = 24;
const END = 42; // 18 tick，06:00→10:30
const out: string[] = [`# POV 探针 — ${pov}（break=strong, 18 tick）\n`];

console.log(`=== 探针 pov=${pov}（18 tick）===`);
for (let tick = START; tick < END; tick++) {
  const gt = tickToGameTime(tick);
  const s = await sim.runOneTick(gt);
  for (const r of s.results) {
    if (r.skipped || !r.thought?.trim()) continue;
    const ch = world.getCharacter(r.characterId);
    out.push(`\n## [${gt.hour}:${String(gt.minute).padStart(2, "0")}] ${ch?.name} → ${r.action?.name}${r.action?.args?.target ? " @" + r.action.args.target : ""}\n${r.thought.trim()}`);
  }
  process.stdout.write(".");
}
await new Promise((r) => setTimeout(r, 3000));

const file = join(import.meta.dirname, "..", "logs", `probe-thoughts-${pov}.md`);
writeFileSync(file, out.join("\n"));
console.log(`\n落盘: ${file}（${out.length - 1} 条决策）`);
