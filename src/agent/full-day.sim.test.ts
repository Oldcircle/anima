/**
 * Simulation Test — 5 角色跑完整一天
 *
 * 运行方式: pnpm test:sim
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Simulation } from "./simulation.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadCharactersFromDir } from "../character/loader.js";
import { config as loadEnv } from "dotenv";
import { join } from "node:path";

loadEnv();

const SKIP = !process.env.ANIMA_LIVE_TEST && !process.env.DEEPSEEK_API_KEY;

const LOCATIONS = [
  { id: "home_alice", name: "Alice 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_bob", name: "Bob 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_maria", name: "Maria 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_lao_chen", name: "老陈的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_emily", name: "Emily 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "flower_shop", name: "Alice的花店", type: "commercial" as const, openHours: { open: 8, close: 18 }, presentCharacters: [] as string[] },
  { id: "bakery", name: "Maria的面包店", type: "commercial" as const, openHours: { open: 7, close: 17 }, presentCharacters: [] as string[] },
  { id: "cafe", name: "咖啡馆", type: "commercial" as const, openHours: { open: 7, close: 22 }, presentCharacters: [] as string[] },
  { id: "plaza", name: "广场", type: "public" as const, presentCharacters: [] as string[] },
  { id: "shop", name: "杂货店", type: "commercial" as const, openHours: { open: 8, close: 20 }, presentCharacters: [] as string[] },
  { id: "bar", name: "酒吧", type: "commercial" as const, openHours: { open: 17, close: 2 }, presentCharacters: [] as string[] },
  { id: "beach", name: "海边", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "dock", name: "码头", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "forest", name: "森林", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "farm", name: "农田", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "library", name: "图书馆", type: "public" as const, openHours: { open: 9, close: 18 }, presentCharacters: [] as string[] },
];

describe.skipIf(SKIP)("Full Day Simulation — 5 Characters", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("5 角色从早到晚一整天", async () => {
    const characters = loadCharactersFromDir(join(import.meta.dirname, "../../data/characters"));
    expect(characters.length).toBe(5);

    const world = new World(LOCATIONS, 24);
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

    console.log("\n========== 全天模拟：5 角色 ==========\n");

    // 从 06:00 跑到 23:00 = 68 tick
    const summaries = await sim.runTicks(68, 24);

    // 输出时间线
    for (const s of summaries) {
      const time = formatGameTime(s.gameTime);
      const actions = s.results
        .filter((r) => !r.skipped)
        .map((r) => `${r.characterId}→${r.action?.name ?? "?"}`)
        .join(" | ");

      if (actions) {
        console.log(`[${time}] ${actions}`);
      }

      // 随机事件
      for (const re of s.randomEvents ?? []) {
        console.log(`  ⚡ ${re.event.name}: ${re.event.template.replace("{character}", re.affectedCharacters[0] ?? "")}`);
      }

      // talk 行为
      for (const r of s.results) {
        if (r.action?.name === "talk") {
          console.log(`  💬 ${r.characterId} → ${r.action.args.target}: ${String(r.action.args.message).slice(0, 60)}`);
        }
      }

      // 反思
      for (const ref of s.reflections ?? []) {
        if (ref.insights.length > 0) {
          console.log(`  🧠 ${ref.characterId}的反思: ${ref.insights[0]?.slice(0, 60)} | 心情: ${ref.mood}`);
        }
      }
    }

    // 输出最终状态
    console.log("\n========== 一天结束 ==========\n");
    for (const c of world.getAllCharacters()) {
      const n = c.needs;
      console.log(
        `${c.name}: 📍${c.locationId} 💰${c.gold} | H:${n.hunger.toFixed(0)} E:${n.energy.toFixed(0)} S:${n.social.toFixed(0)} Joy:${n.happiness.toFixed(0)}`,
      );
    }

    console.log(`\n事件总数: ${eventBus.history.length}`);
    console.log(`关系:`)
    for (const rel of sim.relationships.getAll()) {
      console.log(`  ${rel.characterA} ↔ ${rel.characterB}: ${rel.type} (${rel.level})`);
    }

    // 验证基本合理性
    for (const c of world.getAllCharacters()) {
      // 所有人都应该活着（需求不为 0）
      expect(c.needs.energy).toBeGreaterThanOrEqual(0);
    }
    expect(eventBus.history.length).toBeGreaterThan(10);
  }, 600_000); // 10 分钟超时
});
