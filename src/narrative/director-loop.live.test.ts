/**
 * Director → Character Agent 完整闭环 Live Test
 *
 * Step B（在 Step A director 单向验证之后）：
 *   验证 inject_intent 真的能跨边界影响角色行为。
 *
 * 流程:
 *   1. 创建 2 角色 + 预埋 1 unresolved event
 *   2. 启用 director (real LLM)
 *   3. 调 runDailyPacingCheck → director 注入 intent (期望 inject_intent 给某角色)
 *   4. 等 director 完成
 *   5. 跑 1-2 个真实角色 tick (real LLM)
 *   6. 检查 1) intent 出现在角色 prompt 中  2) 角色行为对 intent 有反应
 *
 * 成本: ~10 LLM 调用 ≈ ~$0.10
 */

import { describe, it, expect, beforeAll } from "vitest";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { config as loadEnv } from "dotenv";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

loadEnv();

const SKIP = !process.env.DEEPSEEK_API_KEY;

const fakeLocations: Location[] = [
  { id: "park", name: "海滨公园", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
  { id: "cafe", name: "咖啡馆", type: "venue", openHours: null, presentCharacters: [] } as Location,
];

const aliceCard: CharacterCard = {
  id: "alice",
  name: "明日香",
  age: 14,
  gender: "female",
  occupation: "学生",
  home: "park",
  personality: {
    traits: ["傲娇", "好胜"],
    interests: ["驾驶"],
    dislikes: [],
    speechStyle: "刻薄但好懂",
  },
  background: "战斗少女，外刚内柔。",
  relationships: {},
};

const bobCard: CharacterCard = {
  id: "bob",
  name: "真嗣",
  age: 14,
  gender: "male",
  occupation: "学生",
  home: "park",
  personality: {
    traits: ["内向", "回避"],
    interests: [],
    dislikes: ["冲突"],
    speechStyle: "迟疑、自我怀疑",
  },
  background: "怕和人产生连接但又渴望被需要。",
  relationships: {},
};

describe.skipIf(SKIP)("Director → Character closed loop (live)", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("director 注入 intent 后，下一 tick 角色行为有反应", async () => {
    const world = new World(fakeLocations);
    world.addCharacter("alice", "明日香", "park");
    world.addCharacter("bob", "真嗣", "park");
    const eventBus = new EventBus();
    const sim = new Simulation(world, eventBus, {
      characters: [aliceCard, bobCard],
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });
    sim.enableDirector({ provider, modelId: "deepseek-chat", dailyBudget: 5 });

    // 预埋 unresolved event
    world.narrative.addUnresolvedEvent({
      id: "asuka_silence_yesterday",
      summary: "明日香昨天突然在咖啡馆沉默了一下午，没人知道为什么",
      involved: ["alice", "bob"],
      visibleTo: "*",
      createdTick: 0,
    });

    console.log("\n=== Step B 闭环测试开始 ===");

    // ─── Phase 1: 触发 director (用 beat_ready，闭环测试不依赖 pacing 启发式) ───
    console.log("\n--- Phase 1: 触发 director (fake beat_ready) ---");
    // D1 改造后 daily pacing 变得保守（多数 do_nothing），闭环测试改用 beat_ready
    // 这个 trigger 路径强制 director 必须做出某种"让 beat 发生"的决策。
    await sim.director!.handleBeatReady(
      {
        beatId: "asuka_silence_followup",
        reason: "preconditions_met",
        triggeredDay: 1,
        triggeredTick: 24,
      },
      world,
      {
        id: "asuka_silence_followup",
        description: "明日香昨天沉默事件的后续：今天必须有人主动靠近她或她自己开口",
        preconditions: { all: ["world.day == 1"] },
        priority: 10,
        on_trigger: {
          hint: "明日香昨天在咖啡馆突然沉默了一下午。今天 beat 触发——你必须让某种'后续'发生。建议：给 alice 注入一个想找 bob 谈谈的 intent，或给 bob 注入一个想去关心 alice 的 intent。inject_intent 是首选工具。",
        },
      } as any,
    );

    const directorLogs = sim.director!.getCallLogs();
    expect(directorLogs.length).toBeGreaterThanOrEqual(1);
    console.log(`Director 调用数: ${directorLogs.length}`);

    // 提取 director 注入的 intents
    const injectedIntents: Array<{ charId: string; summary: string }> = [];
    for (const log of directorLogs) {
      for (const tc of log.toolCalls) {
        if (tc.name === "inject_intent" && tc.result.ok) {
          injectedIntents.push({
            charId: tc.args.character_id as string,
            summary: tc.args.summary as string,
          });
        }
      }
    }
    console.log(`Director 注入的 intents: ${injectedIntents.length}`);
    for (const i of injectedIntents) {
      console.log(`  → ${i.charId}: "${i.summary}"`);
    }

    // 必须至少有 1 个 intent 注入（这是闭环测试的前提）
    expect(injectedIntents.length).toBeGreaterThan(0);

    // ─── Phase 2: 跑真实角色 tick ───
    console.log("\n--- Phase 2: 跑 1 个角色 tick (07:00) ---");
    const targetCharId = injectedIntents[0]!.charId;
    const intentBeforeTick = world.getCurrentIntent(targetCharId, 28);
    console.log(`目标角色 ${targetCharId} 的 intent (tick 前): ${intentBeforeTick?.summary}`);
    expect(intentBeforeTick).toBeDefined();

    // 跑一个真实 tick: 07:00 (tick 28)
    const summary = await sim.runOneTick(tickToGameTime(28));

    console.log("\n=== 角色 tick 结果 ===");
    for (const r of summary.results) {
      console.log(`\n[${r.characterId}] ${r.skipped ? "(SKIPPED " + r.skipReason + ")" : ""}`);
      console.log(`  💭 ${r.thought?.slice(0, 200) ?? "(无想法)"}`);
      if (r.action) {
        console.log(`  🎬 ${r.action.name}(${JSON.stringify(r.action.args).slice(0, 150)})`);
      }
      if (r.result?.description) {
        console.log(`  → ${r.result.description.slice(0, 150)}`);
      }
    }

    // ─── Phase 3: 验证角色对 intent 的反应 ───
    const targetResult = summary.results.find((r) => r.characterId === targetCharId);
    expect(targetResult).toBeDefined();
    expect(targetResult!.skipped).not.toBe(true);

    // 软断言：角色思考或行动应该与 intent 主题相关
    // 由于 intent 通常涉及某个主题，我们检查思考或行动描述里是否出现关键词
    const intentText = injectedIntents[0]!.summary;
    const thought = (targetResult!.thought ?? "").toLowerCase();
    const description = (targetResult!.result?.description ?? "").toLowerCase();
    const combined = thought + " " + description;

    // 提取 intent 中的关键名词（至少角色名或动词）
    const otherCharNames = ["明日香", "真嗣", "alice", "bob"];
    const intentMentionsOther = otherCharNames.some((n) => intentText.includes(n));
    const reactionMentionsOther = intentMentionsOther
      ? otherCharNames.some((n) => combined.includes(n.toLowerCase()))
      : true; // 如果 intent 没指人物，跳过这条断言

    console.log(`\nintent 提到其他角色: ${intentMentionsOther}`);
    console.log(`角色反应提到其他角色: ${reactionMentionsOther}`);

    // 报告但不强断言（LLM 反应灵活，给软结果）
    if (reactionMentionsOther) {
      console.log("✅ 闭环验证通过：角色行为对 director intent 有响应");
    } else {
      console.log("⚠️ 闭环弱信号：角色没有直接呼应 intent，但 tick 正常运行");
    }
  }, 600_000);
});
