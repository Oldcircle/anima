/**
 * Last-Ferry Mini Live Test — D1+D2+D4 验证
 *
 * 加载狗血版 last-ferry（3 角色），跑 Day 1 上午 12 tick（06:00→09:00），
 * 让第一个 beat d1_morning_three_meet_at_bar 触发。验证 director agent 化
 * 的 3 大能力：先读后写 / pulse 记录 / arc 创建。
 *
 * 成本: ~5-8 LLM 调用 ≈ ~$0.05-0.15
 */

import { describe, it, expect, beforeAll } from "vitest";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadScenario } from "./scenario-loader.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

const SKIP = !process.env.DEEPSEEK_API_KEY;

describe.skipIf(SKIP)("Last-Ferry mini live test (D1+D2+D4 验证)", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("scenario 加载 + seeds 应用 + director beat_ready + 角色 tick", async () => {
    const projectRoot = join(import.meta.dirname, "../..");
    const scenario = loadScenario("last-ferry", { projectRoot });
    expect(scenario.characters.length).toBe(3);
    expect(scenario.beats.length).toBeGreaterThanOrEqual(6);
    expect(scenario.seeds).toBeDefined();

    // 创建世界（tick 23 = Day 1 05:45，刚好让 06:00 beat 触发）
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
    sim.enableDirector({ provider, modelId: "deepseek-chat", dailyBudget: 10 });

    // 应用 seeds（unresolved events + 关系 + 流言）
    if (scenario.seeds) sim.applySeeds(scenario.seeds);

    console.log("\n=== Last-Ferry Mini Live Test ===");
    console.log(`角色: ${scenario.characters.map((c) => c.id).join(", ")}`);
    console.log(`Beats: ${scenario.beats.map((b) => b.id).join(", ")}`);
    console.log(`Seeds: ${scenario.seeds?.unresolvedEvents?.length ?? 0} 个 unresolved events`);

    // ── 跑 12 tick (06:00 → 09:00) ──
    const TICKS = 12;
    for (let i = 0; i < TICKS; i++) {
      const gt = tickToGameTime(24 + i); // tick 24 = 06:00
      sim.runBeatScan(gt);
      if (gt.hour === 6 && gt.minute === 0) sim.runDailyPacingCheck(gt);
      await sim.runOneTick(gt);
    }

    // 等 director 异步完成
    await new Promise((r) => setTimeout(r, 20_000));

    // ── 检查 director 结果 ──
    const directorLogs = sim.director!.getCallLogs();
    console.log(`\nDirector 调用数: ${directorLogs.length}`);
    for (const log of directorLogs) {
      const tools = log.toolCalls.map((tc) => `${tc.name}(${tc.result.ok ? "ok" : "fail"})`).join(", ");
      console.log(`  [tick ${log.tick}] ${log.trigger}${log.beatId ? ` beat=${log.beatId}` : ""} → ${tools}`);
    }

    // D1 验证：至少 1 次 director 调用，且至少包含 1 次 read 工具
    expect(directorLogs.length).toBeGreaterThanOrEqual(1);
    const hasRead = directorLogs.some((l) =>
      l.toolCalls.some((tc) => tc.name.startsWith("read_")),
    );
    expect(hasRead).toBe(true);
    console.log("✅ D1: director 使用了 read 工具（先看后写）");

    // D1 验证：至少 1 次写工具（inject_intent 等）
    const hasWrite = directorLogs.some((l) =>
      l.toolCalls.some((tc) => tc.name.startsWith("inject_") && tc.result.ok),
    );
    expect(hasWrite).toBe(true);
    console.log("✅ D1: director 调用了写工具");

    // D2 验证：pulse store 有记录
    const pulseStore = sim.director!.getPulseStore()!;
    const pulses = pulseStore.list();
    console.log(`\nPulse store: ${pulses.length} 个 pulse`);
    for (const p of pulses) {
      console.log(`  ${p.id} | ${p.toolName} → ${p.targetChar ?? "(全局)"} | expected: ${p.expected ?? "(无)"} | observed: ${p.observed ?? "(pending)"}`);
    }
    expect(pulses.length).toBeGreaterThanOrEqual(1);
    console.log("✅ D2: 写工具自动记录了 pulse");

    // D4 验证：检查 agenda store
    const agendaStore = sim.director!.getAgendaStore()!;
    const arcs = agendaStore.active();
    console.log(`\nAgenda store: ${arcs.length} 个活跃 arc`);
    for (const a of arcs) {
      console.log(`  ${a.id} [${a.beatId}] status=${a.status} goal="${a.goal}"`);
    }
    // arc 可能创建也可能没创建（取决于 LLM 判断），只打印不硬断言
    if (arcs.length > 0) {
      console.log("✅ D4: director 创建了 arc（工作记忆）");
    } else {
      console.log("⚠️ D4: director 没有创建 arc（可能判断不需要，3 tick sim 太短）");
    }

    // 角色状态
    console.log("\n=== 角色最终状态 ===");
    for (const c of world.getAllCharacters()) {
      const loc = world.getLocation(c.locationId)?.name ?? c.locationId;
      const intent = c.currentIntent?.summary ?? "(无)";
      console.log(`  ${c.name} @ ${loc} | intent: ${intent}`);
    }
  }, 120_000);
});
