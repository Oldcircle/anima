/**
 * 7-Day Live Simulation — 5 角色跑 7 天
 *
 * 运行方式: ANIMA_LIVE_TEST=1 npx vitest run --config vitest.sim.config.ts
 * 预计耗时: 20-40 分钟
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Simulation, type TickSummary } from "./simulation.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadCharactersFromDir } from "../character/loader.js";
import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

loadEnv();

const SKIP = !process.env.ANIMA_LIVE_TEST && !process.env.DEEPSEEK_API_KEY;

const LOCATIONS = [
  { id: "home_alice", name: "Alice 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_bob", name: "Bob 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_maria", name: "Maria 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_lao_chen", name: "老陈的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_emily", name: "Emily 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_sakiko", name: "祥子的家", type: "residential" as const, presentCharacters: [] as string[] },
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

const GRAY_ACTIONS = new Set(["argue", "steal", "beg"]);
const SOCIAL_ACTIONS = new Set(["talk", "gossip", "comfort", "give_gift", "argue"]);

describe.skipIf(SKIP)("7-Day Live Simulation", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("5 角色跑 7 天", async () => {
    const allChars = loadCharactersFromDir(join(import.meta.dirname, "../../data/characters"));
    const characters = allChars.filter((c) => c.id !== "player");
    expect(characters.length).toBe(6);

    const world = new World(LOCATIONS, 0);
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

    console.log("\n" + "═".repeat(70));
    console.log("  7 天 Live 模拟：5 角色");
    console.log("═".repeat(70) + "\n");

    const TOTAL_TICKS = 96 * 7;
    const allSummaries: TickSummary[] = [];

    // 统计
    const actionCounts = new Map<string, number>();
    const failedActions: Array<{ tick: number; who: string; action: string; reason: string }> = [];
    const grayEvents: Array<{ tick: number; who: string; action: string; detail: string }> = [];
    const conversations: Array<{ tick: number; from: string; to: string; msg: string }> = [];
    let totalLLMCalls = 0;
    const logLines: string[] = []; // 完整时间线日志

    // 逐天运行
    for (let day = 0; day < 7; day++) {
      const dayStart = day * 96;
      const dayTicks = 96;
      const startTime = Date.now();

      const summaries = await sim.runTicks(dayTicks, dayStart);
      allSummaries.push(...summaries);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      // 当天统计
      let dayActions = 0;
      let daySkipped = 0;
      let dayFailed = 0;
      const dayActionCounts = new Map<string, number>();

      for (const s of summaries) {
        // ── 完整时间线日志 ──
        const gt = formatGameTime(s.gameTime);
        const activeResults = s.results.filter((r) => !r.skipped);
        if (activeResults.length > 0) {
          const actionLine = activeResults
            .map((r) => {
              const tag = r.result?.success === false ? "✗" : "→";
              return `${r.characterId}${tag}${r.action?.name ?? "?"}`;
            })
            .join(" | ");
          logLines.push(`[${gt}] ${actionLine}`);

          // 详细行为
          for (const r of activeResults) {
            if (r.action?.name === "talk") {
              logLines.push(`  💬 ${r.characterId} → ${r.action.args.target}: ${String(r.action.args.message ?? "").slice(0, 100)}`);
            } else if (r.result?.success === false) {
              logLines.push(`  ❌ ${r.characterId}: ${r.result.description}`);
            } else if (GRAY_ACTIONS.has(r.action?.name ?? "")) {
              logLines.push(`  ⚠️ ${r.characterId}: ${r.result?.description ?? ""}`);
            }
          }
        }

        // 随机事件
        for (const re of s.randomEvents ?? []) {
          logLines.push(`  ⚡ ${re.event.name}: ${re.event.template.replace("{character}", re.affectedCharacters[0] ?? "")}`);
        }

        // 反思
        for (const ref of s.reflections ?? []) {
          if (ref.insights.length > 0) {
            logLines.push(`  🧠 ${ref.characterId}: ${ref.insights.join(" / ")} | 心情: ${ref.mood}`);
          }
        }

        for (const r of s.results) {
          if (r.skipped) {
            daySkipped++;
            continue;
          }
          const name = r.action?.name ?? "unknown";
          dayActions++;
          dayActionCounts.set(name, (dayActionCounts.get(name) ?? 0) + 1);
          actionCounts.set(name, (actionCounts.get(name) ?? 0) + 1);

          // 失败行为
          if (r.result?.success === false) {
            dayFailed++;
            failedActions.push({
              tick: s.tick,
              who: r.characterId,
              action: name,
              reason: r.result.description,
            });
          }

          // 灰色行为
          if (GRAY_ACTIONS.has(name)) {
            grayEvents.push({
              tick: s.tick,
              who: r.characterId,
              action: name,
              detail: r.result?.description ?? "",
            });
          }

          // 对话
          if (name === "talk" && r.action?.args.target) {
            conversations.push({
              tick: s.tick,
              from: r.characterId,
              to: String(r.action.args.target),
              msg: String(r.action.args.message ?? "").slice(0, 80),
            });
          }
        }

        // 反思
        for (const ref of s.reflections ?? []) {
          if (ref.insights.length > 0) {
            const gt = formatGameTime(s.gameTime);
            console.log(`  🧠 [${gt}] ${ref.characterId}: ${ref.insights[0]?.slice(0, 70)} | 心情: ${ref.mood}`);
          }
        }
      }

      // 每日总结
      const topActions = [...dayActionCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, c]) => `${n}(${c})`)
        .join(" ");

      console.log(`\n📅 第 ${day + 1} 天 (${elapsed}s) — 行为:${dayActions} 跳过:${daySkipped} 失败:${dayFailed}`);
      console.log(`   行为: ${topActions}`);

      // 当天对话
      const dayConvs = conversations.filter((c) => c.tick >= dayStart && c.tick < dayStart + dayTicks);
      if (dayConvs.length > 0) {
        console.log(`   💬 对话 ${dayConvs.length} 次:`);
        for (const c of dayConvs.slice(0, 5)) {
          console.log(`      ${c.from}→${c.to}: ${c.msg}`);
        }
        if (dayConvs.length > 5) console.log(`      ...还有 ${dayConvs.length - 5} 条`);
      }

      // 当天灰色行为
      const dayGray = grayEvents.filter((g) => g.tick >= dayStart && g.tick < dayStart + dayTicks);
      if (dayGray.length > 0) {
        console.log(`   ⚠️ 灰色行为:`);
        for (const g of dayGray) {
          console.log(`      ${g.who}: ${g.detail}`);
        }
      }

      // 当天失败行为（只显示前 3 个）
      const dayFails = failedActions.filter((f) => f.tick >= dayStart && f.tick < dayStart + dayTicks);
      if (dayFails.length > 0) {
        console.log(`   ❌ 失败 ${dayFails.length} 次:`);
        for (const f of dayFails.slice(0, 3)) {
          console.log(`      ${f.who}: ${f.reason}`);
        }
        if (dayFails.length > 3) console.log(`      ...还有 ${dayFails.length - 3} 次`);
      }

      // 每日角色状态
      console.log(`   👤 状态:`);
      logLines.push(`\n--- 第 ${day + 1} 天结束 ---`);
      for (const c of world.getAllCharacters()) {
        const n = c.needs;
        const line = `${c.name}: 📍${c.locationId} 💰${c.gold} | H:${n.hunger.toFixed(0)} E:${n.energy.toFixed(0)} S:${n.social.toFixed(0)} Joy:${n.happiness.toFixed(0)} Hyg:${n.hygiene.toFixed(0)}`;
        console.log(`      ${line}`);
        logLines.push(`  ${line}`);
      }
      logLines.push("");
    }

    // ── 7 天总结 ──
    console.log("\n" + "═".repeat(70));
    console.log("  7 天总结");
    console.log("═".repeat(70));

    // 行为分布
    console.log("\n🎯 行为分布:");
    const sorted = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const totalActions = sorted.reduce((s, [, c]) => s + c, 0);
    for (const [name, count] of sorted) {
      const tag = GRAY_ACTIONS.has(name) ? " ⚠️" : SOCIAL_ACTIONS.has(name) ? " 💬" : "";
      console.log(`  ${name}: ${count} (${((count / totalActions) * 100).toFixed(1)}%)${tag}`);
    }

    // 社交网络
    console.log("\n🤝 关系网络:");
    for (const rel of sim.relationships.getAll()) {
      console.log(`  ${rel.characterA} ↔ ${rel.characterB}: ${rel.type} (${rel.level})`);
    }

    // 对话统计
    console.log(`\n💬 总对话: ${conversations.length}`);
    if (conversations.length > 0) {
      const pairs = new Map<string, number>();
      for (const c of conversations) {
        const key = [c.from, c.to].sort().join("↔");
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
      console.log("  对话对:");
      for (const [pair, count] of [...pairs.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${pair}: ${count} 次`);
      }
    }

    // 灰色行为统计
    console.log(`\n⚠️ 灰色行为: ${grayEvents.length}`);
    if (grayEvents.length > 0) {
      for (const g of grayEvents) {
        const gt = formatGameTime(tickToGameTime(g.tick));
        console.log(`  [${gt}] ${g.who}: ${g.detail}`);
      }
    }

    // 失败行为统计
    console.log(`\n❌ 约束失败: ${failedActions.length}`);
    if (failedActions.length > 0) {
      const byType = new Map<string, number>();
      for (const f of failedActions) {
        byType.set(f.action, (byType.get(f.action) ?? 0) + 1);
      }
      for (const [action, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${action}: ${count} 次失败`);
      }
    }

    // 经济
    console.log("\n💰 经济:");
    for (const c of world.getAllCharacters()) {
      console.log(`  ${c.name}: ${c.gold} 金 (${c.gold >= 100 ? "+" : ""}${c.gold - 100})`);
    }

    console.log("\n" + "═".repeat(70) + "\n");

    // 写完整日志到文件
    const logPath = join(import.meta.dirname, "../../sim-7day-log.txt");
    writeFileSync(logPath, logLines.join("\n"), "utf-8");
    console.log(`📝 完整时间线日志已写入: ${logPath}`);

    // 基本验证
    expect(allSummaries.length).toBe(96 * 7);
    expect(eventBus.history.length).toBeGreaterThan(50);
  }, 3600_000); // 1 小时超时
});
