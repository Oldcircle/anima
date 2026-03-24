/**
 * Full Day Simulation — 6 角色跑完整一天（活人感重构后）
 *
 * 运行方式: pnpm test:sim
 * 输出: logs/sim-1day-<timestamp>.md
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Simulation, type TickSummary } from "./simulation.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { loadCharactersFromDir } from "../character/loader.js";
import { loadLocationsFromDir } from "../world/location-loader.js";
import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

loadEnv();

const SKIP = !process.env.ANIMA_LIVE_TEST && !process.env.DEEPSEEK_API_KEY;

// 从 YAML 加载地点（含 atmosphere 感官描写）
const LOCATIONS = loadLocationsFromDir(join(import.meta.dirname, "../../data/locations"))
  .filter((l) => l.id !== "home_player"); // Live 测试不包含玩家

const GRAY_ACTIONS = new Set(["argue", "steal", "beg"]);
const SOCIAL_ACTIONS = new Set(["talk", "gossip", "comfort", "give_gift", "argue"]);

describe.skipIf(SKIP)("Full Day Simulation — 6 Characters (Post-Refactor)", () => {
  let provider: OpenAICompatibleProvider;

  beforeAll(() => {
    provider = new OpenAICompatibleProvider({
      id: "deepseek",
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      apiKey: process.env.DEEPSEEK_API_KEY!,
      defaultModel: "deepseek-chat",
    });
  });

  it("6 角色从早到晚一整天", async () => {
    const characters = loadCharactersFromDir(join(import.meta.dirname, "../../data/characters"));
    // 排除玩家角色，只跑 AI 角色
    const aiCharacters = characters.filter((c) => c.id !== "player");
    expect(aiCharacters.length).toBe(6);

    const world = new World(LOCATIONS, 24); // tick 24 = 06:00
    for (const card of aiCharacters) {
      world.addCharacter(card.id, card.name, card.home);
    }
    const eventBus = new EventBus();

    const sim = new Simulation(world, eventBus, {
      characters: aiCharacters,
      actions: ALL_BASIC_ACTIONS,
      provider,
      modelId: "deepseek-chat",
    });

    const startWall = Date.now();

    // ── 统计容器 ──
    const actionCounts = new Map<string, number>();
    const charActionCounts = new Map<string, Map<string, number>>();
    const failedActions: Array<{ time: string; who: string; action: string; reason: string }> = [];
    const grayEvents: Array<{ time: string; who: string; action: string; detail: string }> = [];
    const conversations: Array<{ time: string; from: string; to: string; msg: string }> = [];
    const movements: Array<{ time: string; who: string; from: string; to: string }> = [];
    const timelineLines: string[] = [];
    let totalSkipped = 0;
    let totalActions = 0;

    // ── 运行 06:00 → 23:45 = 72 ticks ──
    console.log("\n========== 一日模拟：6 角色（活人感重构后）==========\n");

    const summaries = await sim.runTicks(72, 24);

    // ── 收集数据 ──
    for (const s of summaries) {
      const time = formatGameTime(s.gameTime);

      // 随机事件
      for (const re of s.randomEvents ?? []) {
        const line = `[${time}] ⚡ ${re.event.name}: ${re.event.template.replace("{character}", re.affectedCharacters[0] ?? "")}`;
        timelineLines.push(line);
        console.log(line);
      }

      const activeResults = s.results.filter((r) => !r.skipped);
      const skippedResults = s.results.filter((r) => r.skipped);
      totalSkipped += skippedResults.length;

      if (activeResults.length > 0) {
        const actionLine = activeResults
          .map((r) => {
            const tag = r.result?.success === false ? "✗" : "→";
            return `${r.characterId}${tag}${r.action?.name ?? "?"}`;
          })
          .join(" | ");
        timelineLines.push(`[${time}] ${actionLine}`);
        console.log(`[${time}] ${actionLine}`);
      }

      for (const r of s.results) {
        if (r.skipped) continue;
        totalActions++;
        const name = r.action?.name ?? "unknown";

        // 全局计数
        actionCounts.set(name, (actionCounts.get(name) ?? 0) + 1);

        // 角色计数
        if (!charActionCounts.has(r.characterId)) charActionCounts.set(r.characterId, new Map());
        const cm = charActionCounts.get(r.characterId)!;
        cm.set(name, (cm.get(name) ?? 0) + 1);

        // 移动追踪
        if (name === "move" && r.action?.args.destination) {
          const charState = world.getCharacter(r.characterId);
          movements.push({
            time,
            who: r.characterId,
            from: r.action.args.from ?? "?",
            to: String(r.action.args.destination),
          });
        }

        // 对话
        if (name === "talk" && r.action?.args.target) {
          const msg = String(r.action.args.message ?? "").slice(0, 120);
          conversations.push({ time, from: r.characterId, to: String(r.action.args.target), msg });
          const line = `  💬 ${r.characterId} → ${r.action.args.target}: ${msg.slice(0, 80)}`;
          timelineLines.push(line);
          console.log(line);
        }

        // 失败
        if (r.result?.success === false) {
          failedActions.push({ time, who: r.characterId, action: name, reason: r.result.description });
          const line = `  ❌ ${r.characterId}: ${r.result.description}`;
          timelineLines.push(line);
          console.log(line);
        }

        // 灰色行为
        if (GRAY_ACTIONS.has(name)) {
          grayEvents.push({ time, who: r.characterId, action: name, detail: r.result?.description ?? "" });
          const line = `  ⚠️ ${r.characterId}: ${r.result?.description ?? ""}`;
          timelineLines.push(line);
          console.log(line);
        }

        // 思考（只记录有内容的）
        if (r.thought && r.thought.length > 5) {
          timelineLines.push(`  💭 ${r.characterId}: ${r.thought.slice(0, 100)}`);
        }
      }

      // 反思
      for (const ref of s.reflections ?? []) {
        if (ref.insights.length > 0) {
          const line = `  🧠 ${ref.characterId}: ${ref.insights.join(" / ").slice(0, 120)} | 心情: ${ref.mood}`;
          timelineLines.push(line);
          console.log(line);
        }
      }
    }

    const elapsedSec = ((Date.now() - startWall) / 1000).toFixed(0);

    // ══════════════════════════════════════════════════════════
    // 生成 Markdown 日志
    // ══════════════════════════════════════════════════════════
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const logDir = join(import.meta.dirname, "../../logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `sim-1day-${ts}.md`);

    const md: string[] = [];

    md.push(`# 一日模拟日志`);
    md.push(`> 时间: ${now.toISOString()} | 耗时: ${elapsedSec}s | 版本: P0 活人感深度改造（环境感知 + 内心独白分级 + 对话模式）`);
    md.push("");

    // ── 1. 概要 ──
    md.push("## 概要");
    md.push("");
    md.push(`| 指标 | 值 |`);
    md.push(`|------|-----|`);
    md.push(`| 角色数 | ${characters.length} |`);
    md.push(`| 时间范围 | 06:00 → 23:45 (72 tick) |`);
    md.push(`| 总行为 | ${totalActions} |`);
    md.push(`| 总跳过 | ${totalSkipped} |`);
    md.push(`| 对话次数 | ${conversations.length} |`);
    md.push(`| 约束失败 | ${failedActions.length} |`);
    md.push(`| 灰色行为 | ${grayEvents.length} |`);
    md.push(`| 事件总数 | ${eventBus.history.length} |`);
    md.push(`| 耗时 | ${elapsedSec}s |`);
    md.push("");

    // ── 2. 行为分布 ──
    md.push("## 行为分布");
    md.push("");
    md.push("| 行为 | 次数 | 占比 | 类型 |");
    md.push("|------|------|------|------|");
    const sorted = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      const pct = ((count / totalActions) * 100).toFixed(1);
      const tag = GRAY_ACTIONS.has(name) ? "灰色" : SOCIAL_ACTIONS.has(name) ? "社交" : "普通";
      md.push(`| ${name} | ${count} | ${pct}% | ${tag} |`);
    }
    md.push("");

    // ── 3. 角色行为明细 ──
    md.push("## 角色行为明细");
    md.push("");
    for (const [charId, counts] of [...charActionCounts.entries()].sort()) {
      const total = [...counts.values()].reduce((s, c) => s + c, 0);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}(${c})`).join(", ");
      md.push(`**${charId}** (${total} 次): ${top}`);
      md.push("");
    }

    // ── 4. 对话记录 ──
    md.push("## 对话记录");
    md.push("");
    if (conversations.length === 0) {
      md.push("_无对话_");
    } else {
      for (const c of conversations) {
        md.push(`- **[${c.time}]** ${c.from} → ${c.to}: ${c.msg}`);
      }
    }
    md.push("");

    // ── 5. 关系网络 ──
    md.push("## 关系网络（从零涌现）");
    md.push("");
    const rels = sim.relationships.getAll();
    if (rels.length === 0) {
      md.push("_一天内没有建立任何关系_");
    } else {
      md.push("| 角色A | 角色B | 类型 | 亲密度 |");
      md.push("|-------|-------|------|--------|");
      for (const rel of rels) {
        md.push(`| ${rel.characterA} | ${rel.characterB} | ${rel.type} | ${rel.level} |`);
      }
    }
    md.push("");

    // ── 6. 约束失败 ──
    md.push("## 约束失败");
    md.push("");
    if (failedActions.length === 0) {
      md.push("_无约束失败_");
    } else {
      for (const f of failedActions) {
        md.push(`- **[${f.time}]** ${f.who}: ${f.action} — ${f.reason}`);
      }
    }
    md.push("");

    // ── 7. 灰色行为 ──
    md.push("## 灰色行为");
    md.push("");
    if (grayEvents.length === 0) {
      md.push("_无灰色行为_");
    } else {
      for (const g of grayEvents) {
        md.push(`- **[${g.time}]** ${g.who}: ${g.action} — ${g.detail}`);
      }
    }
    md.push("");

    // ── 8. 经济 ──
    md.push("## 经济");
    md.push("");
    md.push("| 角色 | 金币 | 变化 |");
    md.push("|------|------|------|");
    for (const c of world.getAllCharacters()) {
      const delta = c.gold - 100;
      md.push(`| ${c.name} | ${c.gold} | ${delta >= 0 ? "+" : ""}${delta} |`);
    }
    md.push("");

    // ── 9. 最终角色状态 ──
    md.push("## 最终角色状态");
    md.push("");
    md.push("| 角色 | 位置 | 饥饿 | 精力 | 社交 | 快乐 | 卫生 | 金币 |");
    md.push("|------|------|------|------|------|------|------|------|");
    for (const c of world.getAllCharacters()) {
      const n = c.needs;
      md.push(`| ${c.name} | ${c.locationId} | ${n.hunger.toFixed(0)} | ${n.energy.toFixed(0)} | ${n.social.toFixed(0)} | ${n.happiness.toFixed(0)} | ${n.hygiene.toFixed(0)} | ${c.gold} |`);
    }
    md.push("");

    // ── 10. 完整时间线 ──
    md.push("## 完整时间线");
    md.push("");
    md.push("```");
    md.push(timelineLines.join("\n"));
    md.push("```");
    md.push("");

    // ── 11. 复盘要点 ──
    md.push("## 复盘要点（自动生成）");
    md.push("");

    // 活人感指标
    const uniqueLocations = new Map<string, Set<string>>();
    for (const m of movements) {
      if (!uniqueLocations.has(m.who)) uniqueLocations.set(m.who, new Set());
      uniqueLocations.get(m.who)!.add(m.to);
    }

    md.push("### 活人感指标");
    md.push("");
    md.push("- **位置多样性**: " + [...uniqueLocations.entries()].map(([who, locs]) => `${who}(${locs.size}处)`).join(", "));

    const talkPairs = new Map<string, number>();
    for (const c of conversations) {
      const key = [c.from, c.to].sort().join("↔");
      talkPairs.set(key, (talkPairs.get(key) ?? 0) + 1);
    }
    md.push("- **社交对**: " + (talkPairs.size > 0 ? [...talkPairs.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}(${n}次)`).join(", ") : "无"));

    const relFromZero = rels.filter((r) => r.level !== 0);
    md.push("- **从零涌现的关系**: " + (relFromZero.length > 0 ? relFromZero.map((r) => `${r.characterA}↔${r.characterB}(${r.type},${r.level})`).join(", ") : "无"));

    // 行为多样性
    const avgActionsPerChar = totalActions / characters.length;
    const avgUniqueActions = [...charActionCounts.values()].reduce((s, m) => s + m.size, 0) / characters.length;
    md.push(`- **人均行为**: ${avgActionsPerChar.toFixed(1)} 次, 人均行为种类: ${avgUniqueActions.toFixed(1)} 种`);
    md.push(`- **LLM 调用率**: ${((totalActions / (totalActions + totalSkipped)) * 100).toFixed(0)}%`);
    md.push("");

    md.push("### 需要关注");
    md.push("");
    if (failedActions.length > 5) md.push(`- ⚠️ 约束失败 ${failedActions.length} 次，可能需要强化 prompt 中的约束提示`);
    if (conversations.length < 3) md.push(`- ⚠️ 对话仅 ${conversations.length} 次，社交系统可能需要调整`);
    if (relFromZero.length === 0) md.push(`- ⚠️ 一天内无关系涌现，可能是社交需求衰减或 move 策略问题`);
    const stuckChars = [...charActionCounts.entries()].filter(([, m]) => m.size <= 2);
    if (stuckChars.length > 0) md.push(`- ⚠️ 行为单一的角色: ${stuckChars.map(([id]) => id).join(", ")}（可能卡在某个循环中）`);
    if (failedActions.length <= 5 && conversations.length >= 3 && relFromZero.length > 0 && stuckChars.length === 0) {
      md.push("- ✅ 无明显问题");
    }
    md.push("");

    // ── 写入文件 ──
    writeFileSync(logPath, md.join("\n"), "utf-8");

    // 控制台输出最终状态
    console.log("\n========== 一天结束 ==========\n");
    for (const c of world.getAllCharacters()) {
      const n = c.needs;
      console.log(
        `${c.name}: 📍${c.locationId} 💰${c.gold} | H:${n.hunger.toFixed(0)} E:${n.energy.toFixed(0)} S:${n.social.toFixed(0)} Joy:${n.happiness.toFixed(0)} Hyg:${n.hygiene.toFixed(0)}`,
      );
    }
    console.log(`\n事件总数: ${eventBus.history.length} | 耗时: ${elapsedSec}s`);
    console.log(`关系:`);
    for (const rel of rels) {
      console.log(`  ${rel.characterA} ↔ ${rel.characterB}: ${rel.type} (${rel.level})`);
    }
    console.log(`\n📝 完整日志: ${logPath}`);

    // ── 验证 ──
    expect(summaries).toHaveLength(72);
    for (const c of world.getAllCharacters()) {
      expect(c.needs.energy).toBeGreaterThanOrEqual(0);
    }
    expect(eventBus.history.length).toBeGreaterThan(10);
  }, 600_000); // 10 分钟超时
});
