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
import { ALL_TRIAL_ACTIONS, PHASE_TOOL_WHITELIST } from "./actions/trial-actions.js";
import { ALL_KIRA_ACTIONS } from "./actions/kira-actions.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { createApiServer } from "./api/server.js";
import { loadScenario, applyInitialItems } from "./narrative/scenario-loader.js";
import { setBreakLevel, getBreakLevel, setDecisionPov, getDecisionPov } from "./agent/break-config.js";
import { saveGame, loadGame } from "./persistence/save-load.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addToInventory } from "./world/item-registry.js";

// --- 配置 ---
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const PROJECT_ROOT = join(import.meta.dirname, "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const AUTO_SAVE_INTERVAL = 96; // 每游戏日自动存档

// --- 解析 --scenario 参数 ---
function parseScenarioArg(argv: string[]): string {
  const i = argv.findIndex((a) => a === "--scenario" || a === "-s");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith("--scenario="));
  if (eq) return eq.slice("--scenario=".length);
  return process.env.ANIMA_SCENARIO ?? "default";
}
const SCENARIO_ID = parseScenarioArg(process.argv.slice(2));

// --- 存档文件按剧本归属 ---
// data/save.db 属于"它里面存的那个剧本"（老档无标识时视为当前剧本，向后兼容）；
// 剧本不匹配时改用 data/save-<scenario>.db，绝不让新世界的自动存档覆盖别的剧本的档。
import { peekSaveScenario } from "./persistence/save-load.js";
function resolveSaveFile(): string {
  const legacy = join(DATA_DIR, "save.db");
  const saved = peekSaveScenario(legacy);
  if (saved === null || saved === undefined || saved === SCENARIO_ID) return legacy;
  const scoped = join(DATA_DIR, `save-${SCENARIO_ID}.db`);
  console.log(`📂 data/save.db 属于剧本 ${saved}，当前剧本 ${SCENARIO_ID} 改用 ${scoped}`);
  return scoped;
}
const SAVE_FILE = resolveSaveFile();

// --- 加载 Scenario（角色 + 地点） ---
const scenario = loadScenario(SCENARIO_ID, { projectRoot: PROJECT_ROOT });
const LOCATIONS = scenario.locations;
const characters = scenario.characters;
console.log(`🎬 Scenario: ${scenario.manifest.name ?? scenario.manifest.id} (${scenario.manifest.id})`);
console.log(`📍 加载了 ${LOCATIONS.length} 个地点: ${LOCATIONS.map((l) => l.name).join(", ")}`);

// --- 破线强度（下行通道解锁）：scenario manifest > env ANIMA_BREAK_LEVEL > 默认 mild ---
setBreakLevel(scenario.manifest.breakLevel);
const breakSource = scenario.manifest.breakLevel ? "scenario" : process.env.ANIMA_BREAK_LEVEL ? "env" : "默认";
console.log(`🔥 破线强度 (breakLevel): ${getBreakLevel()} [${breakSource}]`);

// --- 决策视角：scenario manifest > env ANIMA_DECISION_POV > 默认 first ---
setDecisionPov(scenario.manifest.decisionPov);
const povSource = scenario.manifest.decisionPov ? "scenario" : process.env.ANIMA_DECISION_POV ? "env" : "默认";
console.log(`🎭 决策视角 (decisionPov): ${getDecisionPov()} [${povSource}]`);

// --- LLM Provider ---
// settings.json（前端 Settings 写入）优先于 .env
import { SettingsStore } from "./api/settings-store.js";
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const settingsStore = new SettingsStore(SETTINGS_FILE);
const persistedLLM = settingsStore.load().llm;
// 思考模式：仅对 deepseek-v4-* 起作用。env 写 enabled/disabled/auto；不设默认 auto（v4 自动 disabled）
const thinkingEnv = (process.env.DEEPSEEK_THINKING ?? "auto").toLowerCase();
const thinkingMode: "enabled" | "disabled" | "auto" =
  thinkingEnv === "enabled" || thinkingEnv === "disabled" ? thinkingEnv : "auto";
const provider = new OpenAICompatibleProvider({
  id: persistedLLM?.provider ?? "deepseek",
  baseUrl: persistedLLM?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  apiKey: persistedLLM?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
  defaultModel: persistedLLM?.model ?? "deepseek-v4-flash",
  thinking: persistedLLM?.thinking ?? thinkingMode,
});

// --- 角色已由 scenario 加载 ---
console.log(`📋 加载了 ${characters.length} 个角色: ${characters.map((c) => c.name).join(", ")}`);

// --- 初始化世界 ---
const world = new World(LOCATIONS, 24); // 从 06:00 开始 (tick 24)
for (const card of characters) {
  world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
  if (card.startingItems) {
    const state = world.getCharacter(card.id);
    if (state) {
      for (const itemId of card.startingItems) {
        addToInventory(state.inventory, itemId);
      }
    }
  }
}
// 剧本开局道具（manifest initial_items）：卡片跨剧本共享，剧本专属道具走这里
// （如 kira-incident 把诅咒之册放进 light 口袋——default 剧本的 light 不受影响）
applyInitialItems(world, scenario.manifest);

const eventBus = new EventBus();

// --- 创建模拟 ---
const simulation = new Simulation(world, eventBus, {
  characters,
  actions: ALL_BASIC_ACTIONS,
  provider,
  modelId: persistedLLM?.model ?? "deepseek-v4-flash",
});

// 加载剧本的 beats（N3）
if (scenario.beats.length > 0) {
  simulation.loadBeats(scenario.beats);
  console.log(`🎬 加载了 ${scenario.beats.length} 个 beats（规则导演）`);
}

// 注册 phase-specific 工具（N6.4）— koukou-judgment 的 trial/investigation tools + kira-incident 的夜书
{
  const phaseTools: Record<string, typeof ALL_TRIAL_ACTIONS> = {};
  for (const [phase, names] of Object.entries(PHASE_TOOL_WHITELIST)) {
    phaseTools[phase] = ALL_TRIAL_ACTIONS.filter((a) => names.includes(a.tool.name));
  }
  // kira 阶段工具（seeds.yml active_phase: kira 时激活；kira_strike 自带 emerge 谓词再过滤持册/夜间/在家）
  phaseTools["kira"] = ALL_KIRA_ACTIONS;
  simulation.registerPhaseTools(phaseTools);
  console.log(`🎬 注册了 phase 工具: ${Object.keys(phaseTools).join(",")}`);
}

// 加载 seeds（N6.3）— 只在新存档时 apply (已读档则跳过避免覆盖玩家进度)
const isNewSave = !existsSync(SAVE_FILE);
if (isNewSave && scenario.seeds) {
  simulation.applySeeds(scenario.seeds);
}

// 启用 LLM 导演（N4）。可通过 ANIMA_DIRECTOR=off 关闭。
const directorEnabled = process.env.ANIMA_DIRECTOR !== "off" && Boolean(persistedLLM?.apiKey ?? process.env.DEEPSEEK_API_KEY);
if (directorEnabled) {
  simulation.enableDirector({
    provider,
    modelId: persistedLLM?.model ?? "deepseek-v4-flash",
    dailyBudget: parseInt(process.env.ANIMA_DIRECTOR_BUDGET ?? "5", 10),
  });
  console.log(`🎬 LLM 导演已启用 (预算: ${process.env.ANIMA_DIRECTOR_BUDGET ?? "5"} 调用/天)`);
} else {
  console.log("🎬 LLM 导演已禁用 (无 API key 或 ANIMA_DIRECTOR=off)");
}

// --- 尝试读档 ---
let startTick = 23;
if (existsSync(SAVE_FILE)) {
  const loaded = loadGame(simulation, SAVE_FILE, SCENARIO_ID);
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
      try { saveGame(simulation, SAVE_FILE, SCENARIO_ID); } catch (e) { console.error("存档失败:", e); }
    }
  },
});

// 退出时存档
process.on("SIGINT", () => {
  console.log("\n正在保存...");
  try { saveGame(simulation, SAVE_FILE, SCENARIO_ID); } catch {}
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
  admin: {
    charactersDir: join(PROJECT_ROOT, scenario.manifest.characterDir),
    locationsDir: join(PROJECT_ROOT, scenario.manifest.locationDir),
    settingsFile: SETTINGS_FILE,
    provider,
  },
});
api.start();

console.log(`\n🌍 Anima 模拟启动`);
console.log(`👥 角色: ${characters.map(c => c.name).join(", ")}`);
console.log(`⏱️  速率: 1x (现实 1 分钟 = 游戏 1 小时)`);
console.log(`🌐 前端: http://localhost:${PORT}`);
console.log(`📡 API: http://localhost:${PORT}/api/state`);
console.log(`\n按 Ctrl+C 停止\n`);

engine.start();
