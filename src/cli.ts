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
import { readdirSync } from "node:fs";
import { join } from "node:path";

// --- 配置 ---
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const DATA_DIR = join(import.meta.dirname, "..", "data");

// --- 地点 ---
const LOCATIONS = [
  { id: "home_alice", name: "Alice 的家", type: "residential" as const, presentCharacters: [] },
  { id: "home_bob", name: "Bob 的家", type: "residential" as const, presentCharacters: [] },
  { id: "flower_shop", name: "Alice的花店", type: "commercial" as const, openHours: { open: 8, close: 18 }, presentCharacters: [] },
  { id: "cafe", name: "咖啡馆", type: "commercial" as const, openHours: { open: 7, close: 22 }, presentCharacters: [] },
  { id: "plaza", name: "广场", type: "public" as const, presentCharacters: [] },
  { id: "shop", name: "杂货店", type: "commercial" as const, openHours: { open: 8, close: 20 }, presentCharacters: [] },
  { id: "bar", name: "酒吧", type: "commercial" as const, openHours: { open: 17, close: 2 }, presentCharacters: [] },
  { id: "beach", name: "海边", type: "nature" as const, presentCharacters: [] },
  { id: "dock", name: "码头", type: "nature" as const, presentCharacters: [] },
  { id: "forest", name: "森林", type: "nature" as const, presentCharacters: [] },
  { id: "farm", name: "农田", type: "nature" as const, presentCharacters: [] },
  { id: "library", name: "图书馆", type: "public" as const, openHours: { open: 9, close: 18 }, presentCharacters: [] },
];

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

// --- 启动 API 服务器 ---
const api = createApiServer({
  port: PORT,
  simulation,
  staticDir: join(import.meta.dirname, "..", "web"),
});
api.start();

// --- 启动 Tick 循环 ---
const engine = new TickEngine({
  startTick: 23, // will increment to 24 on first tick
  speed: 1,
  onTick: async (tick, gameTime) => {
    const startMs = Date.now();
    await simulation.runOneTick(gameTime);
    const elapsed = Date.now() - startMs;

    const chars = world.getAllCharacters();
    const active = chars.filter((c) => !c.currentAction && !c.inConversation).length;
    console.log(
      `[${formatGameTime(gameTime)}] tick=${tick} active=${active}/${chars.length} ${elapsed}ms`,
    );
  },
});

console.log(`\n🌍 Anima 模拟启动`);
console.log(`⏱️  速率: 1x (现实 1 分钟 = 游戏 1 小时)`);
console.log(`🌐 前端: http://localhost:${PORT}`);
console.log(`📡 API: http://localhost:${PORT}/api/state`);
console.log(`\n按 Ctrl+C 停止\n`);

engine.start();
