/**
 * Koukou-Judgment Mini Live Test (N6.5 第一档)
 *
 * 目标：在不烧太多 token 的情况下验证 koukou-judgment scenario 端到端可工作。
 *
 * 策略:
 *   - 加载完整 koukou-judgment scenario (14 角色 + seeds + beats)
 *   - 只跑 ~6 个角色 tick + 1 个 director 调用 ≈ 7-10 LLM 调用 ≈ ~$0.10-0.30
 *   - 验证: director 在 koukou 上下文下产出的工具调用引用真实角色 id 和真实事件
 *
 * 不在范围 (留给完整 N6.5):
 *   - 跑完整一天 (96 ticks × 14 角色 = 1300+ LLM 调用)
 *   - phase 切换 peaceful → investigation
 *   - trial 阶段
 *   - 完整 5 天 sim
 */

import { describe, it, expect, beforeAll } from "vitest";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { ALL_TRIAL_ACTIONS, PHASE_TOOL_WHITELIST } from "../actions/trial-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadScenario } from "./scenario-loader.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { addToInventory } from "../world/item-registry.js";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

const SKIP = !process.env.DEEPSEEK_API_KEY;

describe.skipIf(SKIP)("Koukou-judgment scenario mini live test", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("scenario 加载 + seeds 应用 + 1 个 director 调用 + 1 个角色 tick", async () => {
    // 加载 scenario
    const projectRoot = join(import.meta.dirname, "../..");
    const scenario = loadScenario("koukou-judgment", { projectRoot });
    expect(scenario.characters.length).toBe(14);
    expect(scenario.locations.length).toBe(25);
    expect(scenario.beats.length).toBe(14);
    expect(scenario.seeds).toBeDefined();

    // 创建世界
    const world = new World(scenario.locations, 23);
    for (const card of scenario.characters) {
      world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    }

    const eventBus = new EventBus();
    const sim = new Simulation(world, eventBus, {
      characters: scenario.characters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    sim.loadBeats(scenario.beats);

    // 注册 phase tools
    const phaseTools: Record<string, typeof ALL_TRIAL_ACTIONS> = {};
    for (const [phase, names] of Object.entries(PHASE_TOOL_WHITELIST)) {
      phaseTools[phase] = ALL_TRIAL_ACTIONS.filter((a) => names.includes(a.tool.name));
    }
    sim.registerPhaseTools(phaseTools);

    sim.enableDirector({ provider, modelId: "deepseek-chat", dailyBudget: 5 });

    // 应用 seeds
    if (scenario.seeds) sim.applySeeds(scenario.seeds);

    console.log("\n=== Koukou Mini Live Test ===");
    console.log(`角色: ${world.getAllCharacters().length}`);
    console.log(`地点: ${world.getAllLocations().length}`);
    console.log(`Beats: ${sim.beatEngine.getBeats().length}`);
    console.log(`未解决事件: ${world.narrative.getWorld().unresolvedEvents.length}`);
    console.log(`active phase: ${world.narrative.getWorld().activePhase}`);

    // ─── Phase 1: 触发 1 个 director 调用 (06:00 daily pacing) ───
    console.log("\n--- Phase 1: director daily pacing ---");
    sim.runDailyPacingCheck(tickToGameTime(24));
    await new Promise((r) => setTimeout(r, 30_000)); // 等 director

    const directorLogs = sim.director!.getCallLogs();
    console.log(`Director 调用数: ${directorLogs.length}`);

    // ─── 验证 director 输出 ───
    expect(directorLogs.length).toBeGreaterThanOrEqual(1);

    const validCharIds = new Set(scenario.characters.map((c) => c.id));
    const validEventIds = new Set(world.narrative.getWorld().unresolvedEvents.map((e) => e.id));

    let toolCallsCount = 0;
    let validCharRefs = 0;
    let invalidCharRefs = 0;
    let validEventRefs = 0;

    for (const log of directorLogs) {
      console.log(`\n[${log.trigger}${log.beatId ? " | " + log.beatId : ""}] tick=${log.tick} budget=${log.budgetRemaining}`);
      console.log(`  💭 ${log.thought.slice(0, 250)}`);
      for (const tc of log.toolCalls) {
        toolCallsCount++;
        console.log(`  🔧 ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)}) → ${tc.result.ok ? "✓" : "✗"}`);

        // 检查所有引用的 character_id 是否真实存在
        for (const key of ["character_id", "observer_id", "source_character_id", "target_character_id"]) {
          const v = tc.args[key];
          if (typeof v === "string" && v) {
            if (validCharIds.has(v)) validCharRefs++;
            else {
              invalidCharRefs++;
              console.log(`    ⚠️ 无效角色 id: ${key}=${v}`);
            }
          }
        }
        if (Array.isArray(tc.args.spread_to)) {
          for (const v of tc.args.spread_to) {
            if (typeof v === "string") {
              if (validCharIds.has(v)) validCharRefs++;
              else {
                invalidCharRefs++;
                console.log(`    ⚠️ 无效角色 id (spread_to): ${v}`);
              }
            }
          }
        }
        // 检查 references_event
        if (typeof tc.args.references_event === "string" && validEventIds.has(tc.args.references_event)) {
          validEventRefs++;
        }
      }
    }

    console.log("\n=== 统计 ===");
    console.log(`总 director 调用: ${directorLogs.length}`);
    console.log(`总工具调用: ${toolCallsCount}`);
    console.log(`引用真实角色 id: ${validCharRefs}`);
    console.log(`引用无效角色 id: ${invalidCharRefs}`);
    console.log(`引用真实未解决事件: ${validEventRefs}`);

    // 关键断言: 至少 1 个工具调用，且 0 个无效角色 id
    expect(toolCallsCount).toBeGreaterThan(0);
    expect(invalidCharRefs).toBe(0);

    // ─── Phase 2: 跑 1 个角色 tick 看角色反应 ───
    console.log("\n--- Phase 2: 1 个角色 tick (07:00) ---");

    // 找到 director 注入了 intent 的角色，看他下一 tick 的反应
    const charsWithIntent: string[] = [];
    for (const log of directorLogs) {
      for (const tc of log.toolCalls) {
        if (tc.name === "inject_intent" && tc.result.ok) {
          const cid = tc.args.character_id as string;
          if (validCharIds.has(cid)) charsWithIntent.push(cid);
        }
      }
    }

    if (charsWithIntent.length > 0) {
      console.log(`Director 注入 intent 的角色: ${charsWithIntent.join(",")}`);
      const targetId = charsWithIntent[0]!;
      const intent = world.getCurrentIntent(targetId, 28);
      console.log(`目标角色 ${targetId} 的 intent: ${intent?.summary}`);

      // 跑 1 tick
      const summary = await sim.runOneTick(tickToGameTime(28));
      const targetResult = summary.results.find((r) => r.characterId === targetId);
      console.log(`\n[${targetId}] tick 结果:`);
      console.log(`  💭 ${targetResult?.thought?.slice(0, 200) ?? "(无想法)"}`);
      if (targetResult?.action) {
        console.log(`  🎬 ${targetResult.action.name}(${JSON.stringify(targetResult.action.args).slice(0, 150)})`);
      }
      if (targetResult?.result?.description) {
        console.log(`  → ${targetResult.result.description.slice(0, 200)}`);
      }
    } else {
      console.log("⚠️ Director 没注入 intent，跳过 Phase 2");
    }

    console.log("\n✅ Koukou-judgment mini live test 完成");
  }, 600_000);
});
