/**
 * Director Live Test (真实 DeepSeek)
 *
 * 目标：在投入 N6 大规模内容工程之前，验证 N3+N4 端到端在真实 LLM 下能跑。
 *
 * 策略：极小成本的验证
 *  - 只 2 个角色（不跑角色 agent tick，省 token）
 *  - 直接调 runBeatScan + runDailyPacingCheck
 *  - 预算 5/天，预期 ~5-6 次 director LLM 调用 ≈ 几分钱
 *
 * 跑法: pnpm vitest run --config vitest.live.config.ts src/narrative/director.live.test.ts
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
  personality: { traits: ["傲娇", "好胜"], interests: [], dislikes: [], speechStyle: "" },
  background: "",
  relationships: {},
};

const bobCard: CharacterCard = {
  id: "bob",
  name: "真嗣",
  age: 14,
  gender: "male",
  occupation: "学生",
  home: "park",
  personality: { traits: ["内向", "回避"], interests: [], dislikes: [], speechStyle: "" },
  background: "",
  relationships: {},
};

describe.skipIf(SKIP)("Director live integration", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("director 在真实 LLM 下处理 beat_ready 和 daily pacing", async () => {
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

    // 启用 director (真实 LLM)
    sim.enableDirector({
      provider,
      modelId: "deepseek-chat",
      dailyBudget: 5,
    });

    // 加载 beats: 一个总会 fire + 一个 fallback only
    sim.loadBeats([
      {
        id: "morning_tension_check",
        description: "开局张力锚点",
        preconditions: ["true"],
        priority: 5,
        on_trigger: {
          hint: "这是世界的第一个剧情节点。明日香和真嗣之间存在某种说不清的不协调感。让 director 决定如何让这种不协调变成可观察的张力。",
        },
      },
      {
        id: "fallback_day3_nudge",
        description: "第 3 天兜底",
        preconditions: ["false"],
        fallback_deadline_day: 3,
        on_trigger: { hint: "已经第 3 天了，世界太平淡。请注入一个轻度扰动。" },
      },
    ]);

    // 预埋两个未解决事件，让 director 有上下文
    world.narrative.addUnresolvedEvent({
      id: "asuka_silence_yesterday",
      summary: "明日香昨天突然在咖啡馆沉默了一下午，没人知道为什么",
      involved: ["alice", "bob"],
      visibleTo: "*",
      createdTick: 0,
    });
    world.narrative.addUnresolvedEvent({
      id: "shinji_nightmare",
      summary: "真嗣最近做了个噩梦，梦见明日香站在很远的地方背对着他",
      involved: ["bob"],
      visibleTo: ["bob"],
      createdTick: 0,
    });

    console.log("\n=== Director Live Test 开始 ===");
    console.log(`初始未解决事件: ${world.narrative.getWorld().unresolvedEvents.length}`);

    // 直接触发 06:00 daily pacing check (day 1)
    console.log("\n--- 1) 触发 06:00 daily pacing check (day 1) ---");
    sim.runDailyPacingCheck(tickToGameTime(24)); // tick 24 = day 1, 06:00

    // 直接触发 22:00 beat scan (day 1)
    console.log("\n--- 2) 触发 22:00 beat scan (day 1) ---");
    sim.runBeatScan(tickToGameTime(88)); // tick 88 = day 1, 22:00

    // 等所有 director 后台任务完成
    await new Promise((r) => setTimeout(r, 60_000)); // 给 director 60 秒

    // 触发 day 2 daily pacing
    console.log("\n--- 3) 触发 06:00 daily pacing check (day 2) ---");
    sim.runDailyPacingCheck(tickToGameTime(24 + 96));

    await new Promise((r) => setTimeout(r, 30_000));

    // ── 检查结果 ──
    const logs = sim.director!.getCallLogs();
    console.log("\n=== Director 调用日志 ===");
    console.log(`总调用数: ${logs.length}`);
    for (const log of logs) {
      console.log(`\n[${log.trigger}${log.beatId ? " | " + log.beatId : ""}] tick=${log.tick} budget=${log.budgetRemaining}`);
      console.log(`  💭 ${log.thought.slice(0, 200)}`);
      for (const tc of log.toolCalls) {
        console.log(`  🔧 ${tc.name}(${JSON.stringify(tc.args).slice(0, 150)}) → ${tc.result.ok ? "✓" : "✗"} ${tc.result.description?.slice(0, 100) ?? ""}`);
      }
    }

    console.log("\n=== 世界状态变化 ===");
    const ns = world.narrative.getSnapshot();
    console.log(`未解决事件: ${ns.world.unresolvedEvents.length}`);
    console.log(`已触发 beats: ${ns.world.triggeredBeats.join(", ")}`);
    console.log(`流言数: ${ns.world.rumors.length}`);
    console.log(`alice intent: ${world.getCurrentIntent("alice", 200)?.summary ?? "(无)"}`);
    console.log(`bob intent: ${world.getCurrentIntent("bob", 200)?.summary ?? "(无)"}`);
    const aliceObs = world.getObservableState("alice", 200);
    const bobObs = world.getObservableState("bob", 200);
    console.log(`alice observable: ${aliceObs?.summary ?? "(无)"}`);
    console.log(`bob observable: ${bobObs?.summary ?? "(无)"}`);

    // ── 断言 ──
    // 至少触发了 1 次 director 调用
    expect(logs.length).toBeGreaterThan(0);
    // 至少有一个调用产出了 ≥1 个工具调用（即使是 do_nothing 也算）
    const callsWithTools = logs.filter((l) => l.toolCalls.length > 0);
    expect(callsWithTools.length).toBeGreaterThan(0);
    // 没有任何 forbidden tool 通过（防御断言）
    for (const log of logs) {
      for (const tc of log.toolCalls) {
        expect(tc.result.error).not.toBe("forbidden_tool");
      }
    }
  }, 300_000);
});
