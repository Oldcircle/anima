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

const aliceCard: CharacterCard = {
  id: "alice",
  name: "Alice Chen",
  age: 28,
  occupation: "花店老板",
  home: "home_alice",
  personality: {
    traits: ["温柔", "内向", "细心"],
    interests: ["园艺", "阅读", "烘焙"],
    dislikes: ["噪音", "浪费"],
    speechStyle: "说话轻声细语，经常用花的比喻",
  },
  background: "从城市搬来三年了，开了镇上唯一的花店。喜欢安静的生活。",
  relationships: {},
};

const bobCard: CharacterCard = {
  id: "bob",
  name: "Bob Wang",
  age: 35,
  occupation: "渔夫",
  home: "home_bob",
  personality: {
    traits: ["豪爽", "外向", "乐观", "粗心"],
    interests: ["钓鱼", "喝酒", "讲故事"],
    dislikes: ["早起", "复杂的事情"],
    speechStyle: "说话大大咧咧，爱用夸张的比喻，经常哈哈大笑",
  },
  background: "土生土长的镇民，家族世代捕鱼。妻子三年前去世后一个人生活。",
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

  it("Alice 和 Bob 在咖啡馆相遇并对话", async () => {
    const world = new World(TEST_LOCATIONS);
    // 中午 12 点，两人都在咖啡馆
    world.addCharacter("alice", "Alice Chen", "cafe", { hunger: 30, social: 35 });
    world.addCharacter("bob", "Bob Wang", "cafe", { hunger: 40, social: 25 });
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters: [aliceCard, bobCard],
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    console.log("\n=== 咖啡馆相遇 ===");
    console.log("时间: 中午 12:00，Alice 和 Bob 都在咖啡馆");
    console.log("Alice: 饥饿 30, 社交 35 | Bob: 饥饿 40, 社交 25\n");

    const summary = await sim.runOneTick(tickToGameTime(48));

    // 输出角色决策
    for (const r of summary.results) {
      const name = r.characterId === "alice" ? "Alice" : "Bob";
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
    for (const id of ["alice", "bob"]) {
      const s = world.getCharacter(id)!;
      if (s.inbox.length > 0) {
        console.log(`\n📬 ${s.name} 的信箱:`, s.inbox.map(m => `${m.fromName}: ${m.content}`));
      }
    }

    // 输出最终状态
    console.log("\n=== 最终状态 ===");
    for (const id of ["alice", "bob"]) {
      const s = world.getCharacter(id)!;
      console.log(`${s.name}: 📍${s.locationId} 饥饿:${s.needs.hunger.toFixed(0)} 社交:${s.needs.social.toFixed(0)}`);
    }

    expect(summary.results).toHaveLength(2);
  }, 60_000);

  it("2 角色跑半天（24 tick = 6 小时）", async () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("alice", "Alice Chen", "home_alice");
    world.addCharacter("bob", "Bob Wang", "home_bob");
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters: [aliceCard, bobCard],
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
    for (const id of ["alice", "bob"]) {
      const s = world.getCharacter(id)!;
      console.log(`${s.name}: 📍${s.locationId} 饥饿:${s.needs.hunger.toFixed(0)} 精力:${s.needs.energy.toFixed(0)} 社交:${s.needs.social.toFixed(0)}`);
    }

    expect(summaries).toHaveLength(24);
  }, 180_000);
});
