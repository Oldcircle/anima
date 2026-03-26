/**
 * SimReporter — 模拟测试的实时输出 + 统计收集 + Markdown 日志生成
 *
 * 用法：
 *   const reporter = new SimReporter(world, sim, { totalTicks: 72, label: "一日模拟" });
 *   // reporter 自动通过 sim.onTick() 注册，每 tick 实时输出
 *   await sim.runTicks(72, 24);
 *   await sim.waitForBackgroundTasks();
 *   reporter.printSummary();
 *   reporter.writeLog("sim-1day");
 */

import type { World } from "../../src/world/world.js";
import type { Simulation, TickSummary } from "../../src/agent/simulation.js";
import type { AgentTickResult } from "../../src/agent/agent-loop.js";
import { formatGameTime } from "../../src/core/tick-engine.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// ── 颜色辅助（终端 ANSI） ──

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

const GRAY_ACTIONS = new Set(["argue", "steal", "beg"]);
const SOCIAL_ACTIONS = new Set(["talk", "gossip", "comfort", "give_gift", "argue"]);

export interface SimReporterOptions {
  /** 预计总 tick 数（用于进度条） */
  totalTicks: number;
  /** 测试标题 */
  label: string;
  /** 是否显示每个 tick 的详细思考（默认 false） */
  showThoughts?: boolean;
}

interface TalkRecord {
  time: string;
  from: string;
  to: string;
  msg: string;
  tick: number;
}

interface FailureRecord {
  time: string;
  who: string;
  action: string;
  reason: string;
}

interface GrayRecord {
  time: string;
  who: string;
  action: string;
  detail: string;
}

export class SimReporter {
  private world: World;
  private sim: Simulation;
  private opts: SimReporterOptions;
  private unsubscribe: () => void;

  // 统计
  private ticksProcessed = 0;
  private totalActions = 0;
  private totalSkipped = 0;
  private actionCounts = new Map<string, number>();
  private charActionCounts = new Map<string, Map<string, number>>();
  private talks: TalkRecord[] = [];
  private failures: FailureRecord[] = [];
  private grayEvents: GrayRecord[] = [];
  private timelineLines: string[] = [];
  private startWall = Date.now();

  // ID → 显示名缓存
  private nameCache = new Map<string, string>();

  constructor(world: World, sim: Simulation, opts: SimReporterOptions) {
    this.world = world;
    this.sim = sim;
    this.opts = opts;

    // 缓存所有角色名
    for (const ch of world.getAllCharacters()) {
      this.nameCache.set(ch.id, ch.name);
    }

    // 打印标题
    console.log("");
    console.log(c.bold(`${"─".repeat(60)}`));
    console.log(c.bold(`  ${opts.label}`));
    console.log(c.bold(`${"─".repeat(60)}`));
    console.log("");

    // 注册 onTick 监听器
    this.unsubscribe = sim.onTick((summary) => this.onTick(summary));
  }

  /** 解析 ID 为显示名 */
  private name(idOrName: string): string {
    if (this.nameCache.has(idOrName)) return this.nameCache.get(idOrName)!;
    // 可能已经是名字
    const ch = this.world.getCharacter(idOrName);
    if (ch) {
      this.nameCache.set(idOrName, ch.name);
      return ch.name;
    }
    return idOrName;
  }

  /** 格式化时间（只取 HH:MM 部分） */
  private fmtTime(gt: { hour: number; minute: number }): string {
    return `${String(gt.hour).padStart(2, "0")}:${String(gt.minute).padStart(2, "0")}`;
  }

  /** 进度条 */
  private progressBar(): string {
    const pct = this.ticksProcessed / this.opts.totalTicks;
    const filled = Math.round(pct * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    const elapsed = ((Date.now() - this.startWall) / 1000).toFixed(0);
    const eta = pct > 0.05 ? (((Date.now() - this.startWall) / pct - (Date.now() - this.startWall)) / 1000).toFixed(0) : "?";
    return c.dim(`[${bar}] ${(pct * 100).toFixed(0)}% | ${elapsed}s elapsed | ETA ${eta}s`);
  }

  /** 每 tick 回调 — 实时输出 */
  private onTick(summary: TickSummary): void {
    this.ticksProcessed++;
    const time = this.fmtTime(summary.gameTime);
    const gt = formatGameTime(summary.gameTime);

    // 随机事件
    for (const re of summary.randomEvents ?? []) {
      const line = `  ${c.yellow("⚡")} ${re.event.name}`;
      console.log(line);
      this.timelineLines.push(`[${time}] ⚡ ${re.event.name}`);
    }

    // 分类结果
    const active: AgentTickResult[] = [];
    const skipped: AgentTickResult[] = [];

    for (const r of summary.results) {
      if (r.skipped) {
        skipped.push(r);
        this.totalSkipped++;
      } else {
        active.push(r);
        this.totalActions++;
        const actionName = r.action?.name ?? "unknown";
        this.actionCounts.set(actionName, (this.actionCounts.get(actionName) ?? 0) + 1);

        if (!this.charActionCounts.has(r.characterId)) {
          this.charActionCounts.set(r.characterId, new Map());
        }
        const cm = this.charActionCounts.get(r.characterId)!;
        cm.set(actionName, (cm.get(actionName) ?? 0) + 1);
      }
    }

    // 如果所有人都跳过，简化输出（每 4 tick 才显示一次）
    if (active.length === 0) {
      if (this.ticksProcessed % 4 === 0) {
        console.log(c.dim(`  ${time}  ── 全部跳过 (${skipped.length} 角色休息中) ──`));
      }
      return;
    }

    // ── 主行：时间 + 所有行为摘要 ──
    const actionParts: string[] = [];
    for (const r of active) {
      const who = this.name(r.characterId);
      const actionName = r.action?.name ?? "?";
      const failed = r.result?.success === false;

      if (actionName === "talk" && r.action?.args.target) {
        const target = this.name(r.action.args.target as string);
        const msg = String(r.action.args.message ?? "").slice(0, 60);
        actionParts.push(failed
          ? c.red(`${who}→talk→${target} ✗`)
          : `${c.cyan(who)}→${c.green("talk")}→${c.cyan(target)}`);
      } else if (actionName === "go_to" && r.action?.args.location) {
        const dest = String(r.action.args.location);
        actionParts.push(`${c.cyan(who)}→${c.blue("go_to")} ${dest}`);
      } else if (GRAY_ACTIONS.has(actionName)) {
        actionParts.push(c.yellow(`${who}→${actionName}`));
      } else if (failed) {
        actionParts.push(c.red(`${who}→${actionName} ✗`));
      } else {
        actionParts.push(`${c.cyan(who)}→${actionName}`);
      }
    }

    console.log(`  ${c.bold(time)}  ${actionParts.join(c.dim(" │ "))}`);

    // ── 详情行（对话内容、失败原因、灰色行为） ──
    for (const r of active) {
      const who = this.name(r.characterId);
      const actionName = r.action?.name ?? "unknown";

      // 对话内容
      if (actionName === "talk" && r.action?.args.target) {
        const target = this.name(r.action.args.target as string);
        const msg = String(r.action.args.message ?? "").slice(0, 100);
        this.talks.push({ time, from: who, to: target, msg, tick: summary.tick });
        console.log(c.dim(`         💬 ${who}: "${msg}"`));
        this.timelineLines.push(`[${time}] 💬 ${who} → ${target}: ${msg}`);
      } else {
        this.timelineLines.push(`[${time}] ${who} → ${actionName}`);
      }

      // 失败
      if (r.result?.success === false) {
        this.failures.push({ time, who, action: actionName, reason: r.result.description });
        console.log(c.red(`         ✗ ${r.result.description}`));
      }

      // 灰色行为
      if (GRAY_ACTIONS.has(actionName)) {
        this.grayEvents.push({ time, who, action: actionName, detail: r.result?.description ?? "" });
      }

      // 思考（可选）
      if (this.opts.showThoughts && r.thought && r.thought.length > 5) {
        console.log(c.dim(`         💭 ${r.thought.slice(0, 80)}`));
      }
    }

    // 反思
    for (const ref of summary.reflections ?? []) {
      if (ref.insights.length > 0) {
        console.log(`  ${c.magenta("🧠")} ${this.name(ref.characterId)}: ${ref.insights[0]?.slice(0, 80)} | 心情: ${ref.mood}`);
        this.timelineLines.push(`[${time}] 🧠 ${this.name(ref.characterId)}: ${ref.insights.join(" / ")}`);
      }
    }

    // 每 12 tick（3 小时）显示进度
    if (this.ticksProcessed % 12 === 0) {
      console.log(this.progressBar());
    }
  }

  /** 打印最终摘要 */
  printSummary(): void {
    const elapsed = ((Date.now() - this.startWall) / 1000).toFixed(1);
    const allImpressions = this.sim.impressions.getAll();
    const rels = this.sim.relationships.getAll().filter((r) => r.level > 0);

    console.log("");
    console.log(c.bold(`${"─".repeat(60)}`));
    console.log(c.bold("  结果摘要"));
    console.log(c.bold(`${"─".repeat(60)}`));

    // 概要
    console.log("");
    console.log(`  耗时 ${c.bold(elapsed + "s")} | ${this.totalActions} 行为 | ${this.totalSkipped} 跳过 | ${this.talks.length} 对话 | ${allImpressions.length} 印象`);

    // 行为分布
    const sorted = [...this.actionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const actionLine = sorted.map(([name, count]) => {
      const pct = ((count / this.totalActions) * 100).toFixed(0);
      const tag = SOCIAL_ACTIONS.has(name) ? c.green(name) : GRAY_ACTIONS.has(name) ? c.yellow(name) : name;
      return `${tag}(${count}, ${pct}%)`;
    }).join(c.dim(" · "));
    console.log(`  行为: ${actionLine}`);

    // 对话对
    const talkPairs = new Map<string, number>();
    for (const d of this.talks) {
      const key = [d.from, d.to].sort().join(" ↔ ");
      talkPairs.set(key, (talkPairs.get(key) ?? 0) + 1);
    }
    if (talkPairs.size > 0) {
      const pairLine = [...talkPairs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([pair, count]) => `${pair}(${count})`)
        .join(c.dim(" · "));
      console.log(`  对话: ${pairLine}`);
    }

    // 关系网络
    if (rels.length > 0) {
      console.log("");
      console.log(c.bold("  关系网络"));
      for (const rel of rels.sort((a, b) => b.level - a.level)) {
        const bar = "▓".repeat(Math.min(Math.floor(rel.level / 5), 20));
        console.log(`    ${this.name(rel.characterA)} ↔ ${this.name(rel.characterB)}: ${rel.type} ${c.dim(`(${rel.level})`)} ${c.green(bar)}`);
      }
    }

    // 印象系统
    if (allImpressions.length > 0) {
      console.log("");
      console.log(c.bold("  角色印象"));
      for (const { observerId, impression: imp } of allImpressions) {
        console.log(`    ${c.cyan(this.name(observerId))} → ${c.cyan(this.name(imp.characterId))}: ${imp.summary}`);
        if (imp.mentalLabel) console.log(c.dim(`      标签: 「${imp.mentalLabel}」`));
        if (imp.observations.length > 0) console.log(c.dim(`      观察: ${imp.observations.join("；")}`));
        if (imp.unresolved.length > 0) console.log(c.dim(`      疑惑: ${imp.unresolved.join("；")}`));
      }
    }

    // 最终角色状态
    console.log("");
    console.log(c.bold("  角色状态"));
    const chars = this.world.getAllCharacters();
    for (const ch of chars) {
      const n = ch.needs;
      const needBar = (val: number, label: string) => {
        const color = val < 20 ? c.red : val < 40 ? c.yellow : c.green;
        return `${label}:${color(String(Math.round(val)))}`;
      };
      const charActions = this.charActionCounts.get(ch.id);
      const actionCount = charActions ? [...charActions.values()].reduce((s, v) => s + v, 0) : 0;
      const needLabels: Record<string, string> = { hunger: "饿", energy: "力", social: "社", hygiene: "净", fun: "乐", bladder: "厕" };
      const needStr = Object.entries(needLabels).map(([k, label]) => needBar(n[k] ?? 100, label)).join(" ");
      console.log(`    ${c.cyan(ch.name)} @ ${ch.locationId} 💰${ch.gold} | ${needStr} | ${actionCount}次`);
    }

    // 警告
    const warnings: string[] = [];
    if (this.failures.length > 5) warnings.push(`约束失败 ${this.failures.length} 次`);
    if (this.talks.length < 3) warnings.push(`对话偏少（${this.talks.length} 次）`);
    if (rels.length === 0 && this.opts.totalTicks > 40) warnings.push("无关系涌现");
    const stuckChars = [...this.charActionCounts.entries()].filter(([, m]) => m.size <= 2 && [...m.values()].reduce((s, v) => s + v, 0) > 5);
    if (stuckChars.length > 0) warnings.push(`行为单一: ${stuckChars.map(([id]) => this.name(id)).join(", ")}`);

    if (warnings.length > 0) {
      console.log("");
      console.log(c.yellow("  ⚠️  需要关注"));
      for (const w of warnings) {
        console.log(c.yellow(`    · ${w}`));
      }
    } else {
      console.log("");
      console.log(c.green("  ✅ 无明显异常"));
    }

    console.log("");
    console.log(c.bold(`${"─".repeat(60)}`));
  }

  /** 写入 Markdown 日志文件 */
  writeLog(prefix: string): string {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const logDir = join(import.meta.dirname, "../../logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${prefix}-${ts}.md`);

    const elapsed = ((Date.now() - this.startWall) / 1000).toFixed(0);
    const allImpressions = this.sim.impressions.getAll();
    const rels = this.sim.relationships.getAll().filter((r) => r.level > 0);
    const chars = this.world.getAllCharacters();
    const sorted = [...this.actionCounts.entries()].sort((a, b) => b[1] - a[1]);

    const md: string[] = [];

    md.push(`# ${this.opts.label}`);
    md.push(`> ${now.toISOString()} | 耗时 ${elapsed}s | ${this.ticksProcessed} ticks`);
    md.push("");

    // 概要
    md.push("## 概要");
    md.push("");
    md.push("| 指标 | 值 |");
    md.push("|------|-----|");
    md.push(`| 总行为 | ${this.totalActions} |`);
    md.push(`| 总跳过 | ${this.totalSkipped} |`);
    md.push(`| 对话次数 | ${this.talks.length} |`);
    md.push(`| 印象数 | ${allImpressions.length} |`);
    md.push(`| 约束失败 | ${this.failures.length} |`);
    md.push(`| 灰色行为 | ${this.grayEvents.length} |`);
    md.push(`| 耗时 | ${elapsed}s |`);
    md.push("");

    // 行为分布
    md.push("## 行为分布");
    md.push("");
    md.push("| 行为 | 次数 | 占比 | 类型 |");
    md.push("|------|------|------|------|");
    for (const [name, count] of sorted) {
      const pct = ((count / this.totalActions) * 100).toFixed(1);
      const tag = GRAY_ACTIONS.has(name) ? "灰色" : SOCIAL_ACTIONS.has(name) ? "社交" : "普通";
      md.push(`| ${name} | ${count} | ${pct}% | ${tag} |`);
    }
    md.push("");

    // 角色行为明细
    md.push("## 角色行为明细");
    md.push("");
    for (const [charId, counts] of [...this.charActionCounts.entries()].sort()) {
      const total = [...counts.values()].reduce((s, v) => s + v, 0);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, cnt]) => `${n}(${cnt})`).join(", ");
      md.push(`**${this.name(charId)}** (${total} 次): ${top}`);
      md.push("");
    }

    // 对话记录
    md.push("## 对话记录");
    md.push("");
    if (this.talks.length === 0) {
      md.push("_无对话_");
    } else {
      for (const t of this.talks) {
        md.push(`- **[${t.time}]** ${t.from} → ${t.to}: ${t.msg}`);
      }
    }
    md.push("");

    // 关系网络
    md.push("## 关系网络");
    md.push("");
    if (rels.length === 0) {
      md.push("_暂无关系涌现_");
    } else {
      md.push("| 角色A | 角色B | 类型 | 亲密度 |");
      md.push("|-------|-------|------|--------|");
      for (const rel of rels.sort((a, b) => b.level - a.level)) {
        md.push(`| ${this.name(rel.characterA)} | ${this.name(rel.characterB)} | ${rel.type} | ${rel.level} |`);
      }
    }
    md.push("");

    // 约束失败
    if (this.failures.length > 0) {
      md.push("## 约束失败");
      md.push("");
      for (const f of this.failures) {
        md.push(`- **[${f.time}]** ${f.who}: ${f.action} — ${f.reason}`);
      }
      md.push("");
    }

    // 灰色行为
    if (this.grayEvents.length > 0) {
      md.push("## 灰色行为");
      md.push("");
      for (const g of this.grayEvents) {
        md.push(`- **[${g.time}]** ${g.who}: ${g.action} — ${g.detail}`);
      }
      md.push("");
    }

    // 最终角色状态
    md.push("## 最终角色状态");
    md.push("");
    md.push("| 角色 | 位置 | 饥饿 | 精力 | 社交 | 娱乐 | 卫生 | 生理 | 金币 |");
    md.push("|------|------|------|------|------|------|------|------|------|");
    for (const ch of chars) {
      const n = ch.needs;
      const v = (k: string) => (n[k] ?? 100).toFixed(0);
      md.push(`| ${ch.name} | ${ch.locationId} | ${v("hunger")} | ${v("energy")} | ${v("social")} | ${v("fun")} | ${v("hygiene")} | ${v("bladder")} | ${ch.gold} |`);
    }
    md.push("");

    // 印象系统
    if (allImpressions.length > 0) {
      md.push("## 角色印象");
      md.push("");
      for (const { observerId, impression: imp } of allImpressions) {
        md.push(`**${this.name(observerId)} → ${this.name(imp.characterId)}**: ${imp.summary}`);
        if (imp.observations.length > 0) md.push(`- 观察: ${imp.observations.join("；")}`);
        if (imp.mentalLabel) md.push(`- 标签: 「${imp.mentalLabel}」`);
        if (imp.unresolved.length > 0) md.push(`- 疑惑: ${imp.unresolved.join("；")}`);
        md.push("");
      }
    }

    // 时间线
    md.push("## 时间线");
    md.push("");
    md.push("```text");
    md.push(this.timelineLines.join("\n"));
    md.push("```");

    writeFileSync(logPath, md.join("\n"), "utf-8");
    console.log(`\n  📝 日志: ${logPath}`);
    return logPath;
  }

  /** 清理（取消订阅） */
  dispose(): void {
    this.unsubscribe();
  }

  // ── 公开统计数据 ──

  get stats() {
    return {
      totalActions: this.totalActions,
      totalSkipped: this.totalSkipped,
      talks: this.talks,
      failures: this.failures,
      grayEvents: this.grayEvents,
      actionCounts: this.actionCounts,
      charActionCounts: this.charActionCounts,
      elapsedMs: Date.now() - this.startWall,
    };
  }
}
