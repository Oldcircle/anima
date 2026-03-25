/**
 * Anima CLI — 启动模拟
 */

import { config as loadEnv } from "dotenv";
loadEnv();

import { TickEngine, tickToGameTime, formatGameTime } from "./core/tick-engine.js";
import { EventBus } from "./core/event-bus.js";
import { World } from "./world/world.js";
import { Simulation } from "./agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "./actions/basic-actions.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { createApiServer } from "./api/server.js";
import { loadCharactersFromDir } from "./character/loader.js";
import { loadLocationsFromDir } from "./world/location-loader.js";
import { saveGame, loadGame } from "./persistence/save-load.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// --- 配置 ---
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const DATA_DIR = join(import.meta.dirname, "..", "data");
const SAVE_FILE = join(DATA_DIR, "save.db");
const AUTO_SAVE_INTERVAL = 96; // 每游戏日自动存档

// --- 地点（从 YAML 加载，含 atmosphere 感官描写）---
const locationDir = join(DATA_DIR, "locations");
const LOCATIONS = loadLocationsFromDir(locationDir);
console.log(`📍 加载了 ${LOCATIONS.length} 个地点: ${LOCATIONS.map((l) => l.name).join(", ")}`);

// --- LLM Provider ---
const provider = new OpenAICompatibleProvider({
  id: "deepseek",
  baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  defaultModel: "deepseek-chat",
});

// --- 加载角色 ---
const characterDir = join(DATA_DIR, "characters");
const characters = loadCharactersFromDir(characterDir);
console.log(`📋 加载了 ${characters.length} 个角色: ${characters.map((c) => c.name).join(", ")}`);

// --- 初始化世界 ---
const world = new World(LOCATIONS, 24); // 从 06:00 开始 (tick 24)
for (const card of characters) {
  world.addCharacter(card.id, card.name, card.home);
}

const eventBus = new EventBus();

// --- 创建模拟 ---
const simulation = new Simulation(world, eventBus, {
  characters,
  actions: ALL_BASIC_ACTIONS,
  provider,
  modelId: "deepseek-chat",
});

// --- 尝试读档 ---
let startTick = 23;
if (existsSync(SAVE_FILE)) {
  const loaded = loadGame(simulation, SAVE_FILE);
  if (loaded) {
    startTick = world.tick - 1; // tick 会在第一次执行时 +1
  }
}

// --- 启动 Tick 循环 ---
const engine = new TickEngine({
  startTick,
  speed: 1,
  onTick: async (tick, gameTime) => {
    const startMs = Date.now();
    await simulation.runOneTick(gameTime);
    const elapsed = Date.now() - startMs;

    const chars = world.getAllCharacters();
    const active = chars.filter((c) => !c.currentAction).length;
    console.log(
      `[${formatGameTime(gameTime)}] tick=${tick} active=${active}/${chars.length} ${elapsed}ms`,
    );

    // 自动存档（每游戏日）
    if (tick % AUTO_SAVE_INTERVAL === 0) {
      try { saveGame(simulation, SAVE_FILE); } catch (e) { console.error("存档失败:", e); }
    }
  },
});

// 退出时存档
process.on("SIGINT", () => {
  console.log("\n正在保存...");
  try { saveGame(simulation, SAVE_FILE); } catch {}
  engine.stop();
  process.exit(0);
});

// --- 启动 API 服务器 ---
const api = createApiServer({
  port: PORT,
  simulation,
  engine,
  staticDir: join(import.meta.dirname, "..", "web"),
  characterCards: new Map(characters.map((c) => [c.id, c])),
});
api.start();

console.log(`\n🌍 Anima 模拟启动`);
console.log(`👥 角色: ${characters.map(c => c.name).join(", ")}`);
console.log(`⏱️  速率: 1x (现实 1 分钟 = 游戏 1 小时)`);
console.log(`🌐 前端: http://localhost:${PORT}`);
console.log(`📡 API: http://localhost:${PORT}/api/state`);
console.log(`\n按 Ctrl+C 停止\n`);

engine.start();
