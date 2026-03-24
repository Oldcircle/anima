/**
 * Live Simulation Test — 多角色 + 真实对话
 *
 * 运行方式: pnpm test:live
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Simulation } from "./simulation.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";
import { config as loadEnv } from "dotenv";

loadEnv();

const SKIP = !process.env.ANIMA_LIVE_TEST && !process.env.DEEPSEEK_API_KEY;

const tomoriCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: {
    traits: ["内向", "纯真", "固执"],
    interests: ["写东西", "捡石头", "烘焙"],
    dislikes: ["人多的场合", "浪费"],
    speechStyle: "声音微弱，断断续续，经常欲言又止",
  },
  background: "从城市来的安静女孩，在面包店当学徒。喜欢安静的生活。",
  relationships: {},
};

const anonCard: CharacterCard = {
  id: "anon",
  name: "千早爱音",
  age: 19,
  occupation: "咖啡馆兼职",
  home: "home_anon",
  personality: {
    traits: ["开朗", "外向", "察言观色", "有时冒失"],
    interests: ["社交", "逛街", "聊天"],
    dislikes: ["被忽视", "复杂的事情"],
    speechStyle: "活泼外向，语气夸张，经常哈哈大笑",
  },
  background: "从东京转来的社交达人，在咖啡馆兼职。",
  relationships: {},
};

describe.skipIf(SKIP)("Simulation — Live (DeepSeek)", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("灯和爱音在咖啡馆相遇并对话", async () => {
    const world = new World(TEST_LOCATIONS);
    // 中午 12 点，两人都在咖啡馆
    world.addCharacter("tomori", "高松灯", "cafe", { hunger: 30, social: 35 });
    world.addCharacter("anon", "千早爱音", "cafe", { hunger: 40, social: 25 });
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters: [tomoriCard, anonCard],
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    console.log("\n=== 咖啡馆相遇 ===");
    console.log("时间: 中午 12:00，灯和爱音都在咖啡馆");
    console.log("灯: 饥饿 30, 社交 35 | 爱音: 饥饿 40, 社交 25\n");

    const summary = await sim.runOneTick(tickToGameTime(48));

    // 输出角色决策
    for (const r of summary.results) {
      const name = r.characterId === "tomori" ? "灯" : "爱音";
      if (r.skipped) {
        console.log(`[${name}] ⏭️ ${r.skipReason}`);
      } else {
        console.log(`[${name}] 💭 ${r.thought}`);
        if (r.action) {
          console.log(`[${name}] 🎬 ${r.action.name}(${JSON.stringify(r.action.args)})`);
        }
      }
    }

    // 输出信箱状态
    for (const id of ["tomori", "anon"]) {
      const s = world.getCharacter(id)!;
      if (s.inbox.length > 0) {
        console.log(`\n📬 ${s.name} 的信箱:`, s.inbox.map(m => `${m.fromName}: ${m.content}`));
      }
    }

    // 输出最终状态
    console.log("\n=== 最终状态 ===");
    for (const id of ["tomori", "anon"]) {
      const s = world.getCharacter(id)!;
      console.log(`${s.name}: 📍${s.locationId} 饥饿:${s.needs.hunger.toFixed(0)} 社交:${s.needs.social.toFixed(0)}`);
    }

    // 至少 2 个结果（主轮），反应轮可能产生更多
    expect(summary.results.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("2 角色跑半天（24 tick = 6 小时）", async () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters: [tomoriCard, anonCard],
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    console.log("\n=== 半天生活（06:00 - 12:00）===\n");

    const summaries = await sim.runTicks(24, 24); // tick 24 = 06:00

    for (const s of summaries) {
      const time = formatGameTime(s.gameTime);
      const actions = s.results
        .filter((r) => !r.skipped)
        .map((r) => `${r.characterId}→${r.action?.name ?? "?"}`)
        .join(" | ");
      const skips = s.results.filter((r) => r.skipped).length;

      if (actions) {
        console.log(`[${time}] ${actions}`);
      } else if (skips === s.results.length) {
        // 全部跳过，简化输出
        const reasons = s.results.map((r) => `${r.characterId}:${r.skipReason?.slice(0, 15)}`).join(" ");
        console.log(`[${time}] ⏭️ ${reasons}`);
      }

      // 输出 talk 行为
      for (const r of s.results) {
        if (r.action?.name === "talk") {
          console.log(`  💬 ${r.characterId} → ${r.action.args.target}: ${r.action.args.message}`);
        }
      }
    }

    // 输出事件日志
    console.log("\n=== 事件日志 ===");
    for (const e of eventBus.history) {
      console.log(`  [tick ${e.tick}] ${e.description}`);
    }

    // 最终状态
    console.log("\n=== 最终状态 ===");
    for (const id of ["tomori", "anon"]) {
      const s = world.getCharacter(id)!;
      console.log(`${s.name}: 📍${s.locationId} 饥饿:${s.needs.hunger.toFixed(0)} 精力:${s.needs.energy.toFixed(0)} 社交:${s.needs.social.toFixed(0)}`);
    }

    expect(summaries).toHaveLength(24);
  }, 300_000); // 5 分钟超时（含反应轮和观察推理）
});
