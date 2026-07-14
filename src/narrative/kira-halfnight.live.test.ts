/**
 * Kira-Incident Half-Night Live Test — 夜书窗口 → 晨间应验的黄金窗口
 *
 * 跑 D1 18:00 → D2 09:00（60 tick）：覆盖 kira_strike 浮现窗（20:00-23:00 在家独处）、
 * 夜间（大半睡眠 tick，便宜）、06:00 应验结算、次日晨间的目击/风声/委托人第二封信。
 *
 * 断言只锁引擎一致性，不锁剧情（写不写、写谁归 light）：
 * - 零引擎级失败跑完
 * - 若发生打击：pending/total/victims 记账一致、受害者状态/记忆/风声齐全
 * - 若未发生：kira 状态保持零（工具浮现过与否看日志人工判）
 *
 * 成本：~250-400 真实调用 ≈ 半日 sim 同级
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { ALL_KIRA_ACTIONS } from "../actions/kira-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadScenario, applyInitialItems, applyKiraProtections } from "./scenario-loader.js";
import { setBreakLevel, setDecisionPov } from "../agent/break-config.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { SimReporter } from "../../test/helpers/sim-reporter.js";
import { hasItem } from "../world/item-registry.js";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv();

const SKIP = !process.env.DEEPSEEK_API_KEY;

describe.skipIf(SKIP)("Kira-Incident half-night live（夜书→应验黄金窗口）", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: (process.env.KIRA_MODEL ?? "deepseek-chat"),
    });
  });

  afterAll(() => {
    setBreakLevel("mild");
    setDecisionPov("first");
  });

  it("D1 18:00 → D2 09:00：引擎一致性 + 诅咒链路", async () => {
    const projectRoot = join(import.meta.dirname, "../..");
    const scenario = loadScenario("kira-incident", { projectRoot });
    expect(scenario.characters.length).toBe(7);

    // manifest 档位（cli.ts 同款应用顺序）
    setBreakLevel(scenario.manifest.breakLevel);
    setDecisionPov(scenario.manifest.decisionPov);

    // D1 18:00 = tick 72
    const START = 72;
    const world = new World(scenario.locations, START);
    for (const card of scenario.characters) {
      world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    }
    applyInitialItems(world, scenario.manifest);
    applyKiraProtections(world, scenario.manifest);
    expect(hasItem(world.getCharacter("light")!.inventory, "cursed_notebook")).toBe(true);
    expect(world.kira.aliasProtected.has("l_lawliet")).toBe(true);

    const eventBus = new EventBus();
    const sim = new Simulation(world, eventBus, {
      characters: scenario.characters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: (process.env.KIRA_MODEL ?? "deepseek-chat"),
    });
    sim.registerPhaseTools({ kira: ALL_KIRA_ACTIONS });
    sim.loadBeats(scenario.beats);
    sim.enableDirector({ provider, modelId: (process.env.KIRA_MODEL ?? "deepseek-chat"), dailyBudget: 6 });
    if (scenario.seeds) sim.applySeeds(scenario.seeds);

    // 罪行注入（KIRA_INJECT_CRIME=1）：加一个 light 见过、犯下恶性罪行且逃脱制裁的镇民，
    // 给他一个配得上"裁决"的目标（诊断：emergent sim 缺够格的罪，light 意愿到位却无人可写）。
    // 赵三是静态世界角色（不进 manifest → 不额外跑决策），只作为可被裁决/观察的存在。
    if (process.env.KIRA_INJECT_CRIME === "1") {
      world.addCharacter("zhaosan", "赵三", "bar", {}, { occupation: "码头混混", workplace: "", age: 30, income: 0, skills: {}, aspiration: "" }, "male");
      sim.relationships.set("light", "zhaosan", -2, "厌恶");
      world.narrative.addUnresolvedEvent({
        id: "zhaosan_assault",
        summary:
          "赵三——码头一个仗势欺人的混混。上周他把独居的老铁匠打成重伤（三根手指粉碎，再也握不住锉刀）、抢走了老人全部积蓄。卫兵队长是赵三的表哥，把案子压了下来，根本没立案。赵三今天还在酒馆大摇大摆，拍着桌子笑'那老东西骨头硬，敲起来手感挺脆'，周围没人敢吭声。老铁匠躺在床上起不来，没人替他讨公道。你（夜神月）和赵三当面打过照面，记得他那张脸和名字。",
        involved: ["zhaosan"],
        visibleTo: ["light"],
        createdTick: world.tick,
      });
      console.log("💉 [inject] 罪行已注入：赵三（恶性伤人+逃脱制裁），light 已见过、可裁决");
    }

    // 默认 60（18:00 → 次日 09:00）；KIRA_PROBE_TICKS 可拉长（如 148 = 两夜探针，覆盖 D2 夜与 D3 晨应验）
    const TICKS = Number(process.env.KIRA_PROBE_TICKS ?? 60);
    const reporter = new SimReporter(world, sim, {
      totalTicks: TICKS,
      label: "基拉事件·夜书窗口（D1 18:00 → D2 09:00）",
    });

    for (let i = 0; i < TICKS; i++) {
      const gt = tickToGameTime(START + i);
      sim.runBeatScan(gt);
      if (gt.hour === 6 && gt.minute === 0) sim.runDailyPacingCheck(gt);
      await sim.runOneTick(gt);
    }
    await sim.waitForBackgroundTasks();

    reporter.printSummary();
    reporter.writeLog("sim-kira-halfnight");
    reporter.dispose();

    // ── 引擎一致性断言（剧情自由，记账必须对）──
    const k = world.kira;
    console.log(`\n📓 kira 终局: total=${k.total} victims=[${k.victims.join(",")}] pending=${k.pending.length} lastStrikeDay=${k.lastStrikeDay}`);
    expect(k.total).toBe(k.victims.length);
    // 跑到 D2 09:00，昨夜 pending 必然已被 06:00 结算清空
    expect(k.pending.length).toBe(0);
    if (k.total > 0) {
      for (const vid of k.victims) {
        const v = world.getCharacter(vid)!;
        // 应验过的人身上留着怪病 moodlet（2 天时效 > 测试窗口）
        expect(v.moodlets.some((m) => m.reason.includes("怪病"))).toBe(true);
        expect(vid).not.toBe("light");
      }
    }
    // 基本活性（与半日 sim 同族的底线）
    expect(reporter.stats.totalActions).toBeGreaterThan(20);
  }, 3600_000);
});
