/**
 * Live Test — 用真实 DeepSeek API 跑单角色决策
 *
 * 运行方式: pnpm test:live
 * 需要 .env 中配置 DEEPSEEK_API_KEY
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runAgentTick, type AgentConfig } from "./agent-loop.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";
import { config as loadEnv } from "dotenv";

// 加载 .env
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
  background:
    "从城市来的安静女孩，在面包店当学徒。最好的朋友是咖啡馆的爱音。喜欢安静的生活。",
  relationships: {},
};

describe.skipIf(SKIP)("Agent Loop — Live (DeepSeek)", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("单角色 - 中午决策：应该去吃饭或社交", async () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori", { hunger: 35 }); // 饿了
    world.addCharacter("anon", "千早爱音", "cafe");
    const eventBus = new EventBus();

    const config: AgentConfig = {
      card: tomoriCard,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    };

    const gameTime = tickToGameTime(48); // 中午 12:00
    console.log(`\n🕐 游戏时间: ${formatGameTime(gameTime)}`);
    console.log(`📍 灯 在: home_tomori, 饥饿值: 35`);

    const result = await runAgentTick({ config, world, eventBus, gameTime });

    console.log(`\n💭 想法: ${result.thought}`);
    if (result.action) {
      console.log(`🎬 行为: ${result.action.name}(${JSON.stringify(result.action.args)})`);
      console.log(`📝 描述: ${result.result?.description}`);
    } else {
      console.log(`⏭️ 跳过: ${result.skipReason}`);
    }

    // 基本断言：应该有思考内容
    expect(result.thought.length).toBeGreaterThan(0);
    // 不强制要求特定行为，但应该有行为或有思考
    expect(result.thought || result.action).toBeTruthy();
  });

  it("单角色跑 8 个 tick（2 小时）", async () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "cafe");
    const eventBus = new EventBus();

    const config: AgentConfig = {
      card: tomoriCard,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    };

    console.log("\n=== 灯的 2 小时生活 ===\n");

    for (let tick = 32; tick < 40; tick++) {
      // 08:00 - 10:00
      const gameTime = tickToGameTime(tick);

      // 每 tick 衰减需求
      world.decayNeeds();

      const result = await runAgentTick({ config, world, eventBus, gameTime });

      const state = world.getCharacter("tomori")!;
      const time = formatGameTime(gameTime);

      if (result.skipped) {
        console.log(`[${time}] ⏭️ ${result.skipReason}`);
      } else {
        console.log(`[${time}] 💭 ${result.thought.slice(0, 60)}...`);
        if (result.action) {
          console.log(`         🎬 ${result.action.name}(${JSON.stringify(result.action.args)})`);
        }
      }
      console.log(
        `         📊 饥饿:${state.needs.hunger.toFixed(0)} 精力:${state.needs.energy.toFixed(0)} 社交:${state.needs.social.toFixed(0)} 📍${state.locationId}`,
      );
    }

    // 验证世界状态被正确更新
    const finalState = world.getCharacter("tomori")!;
    expect(finalState).toBeDefined();

    // 输出事件日志
    console.log("\n=== 事件日志 ===");
    for (const e of eventBus.history) {
      console.log(`[tick ${e.tick}] ${e.description}`);
    }
  }, 120_000);
});
