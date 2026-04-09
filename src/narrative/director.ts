/**
 * LLM Director Agent — 决定 beat 怎么发生 + 节奏调控
 *
 * 触发场景:
 *   1. BeatEngine emit beat.ready 事件 → handleBeatReady
 *   2. 每天 06:00 节奏检查 → handleDailyPacing
 *   3. 玩家手动 nudge（N5 引入）
 *
 * 关键约束（DESIGN-narrative §3.4 + 用户决策 D1）:
 *   导演**不能让角色直接说话**。Toolset 中没有任何 say/talk 类工具。
 *
 * 预算（PLAN-narrative N4 完成条件）:
 *   每天最多 5 次 LLM 调用，超出走 do_nothing。
 */

import type { World } from "../world/world.js";
import type { LLMProvider, LLMRequest, ToolCall } from "../providers/types.js";
import type { BeatReadyEvent, BeatDefinition } from "./beat-engine.js";
import {
  ALL_DIRECTOR_TOOLS,
  getDirectorToolByName,
  type DirectorToolResult,
} from "./director-tools.js";

const FORBIDDEN_TOOL_PREFIXES = ["talk", "say", "speak", "message"]; // 兜底防越权

export interface DirectorConfig {
  provider: LLMProvider;
  modelId: string;
  /** 每天最多 LLM 调用次数；超出 do_nothing。默认 5 */
  dailyBudget?: number;
  /** 是否允许真实 LLM 调用；为 false 时所有触发走 mock 路径（测试用） */
  enabled?: boolean;
}

export interface DirectorCallLog {
  tick: number;
  trigger: "beat_ready" | "daily_pacing" | "player_nudge";
  beatId?: string;
  thought: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: DirectorToolResult }>;
  budgetRemaining: number;
}

export class Director {
  private provider: LLMProvider;
  private modelId: string;
  private dailyBudget: number;
  private enabled: boolean;

  /** 每天的剩余调用预算（key = game day） */
  private budgetByDay = new Map<number, number>();

  /** 调用日志（最近 50 条） */
  private callLogs: DirectorCallLog[] = [];

  constructor(config: DirectorConfig) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.dailyBudget = config.dailyBudget ?? 5;
    this.enabled = config.enabled ?? true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  getCallLogs(): readonly DirectorCallLog[] {
    return this.callLogs;
  }

  getBudgetRemaining(day: number): number {
    return this.budgetByDay.get(day) ?? this.dailyBudget;
  }

  // ── 核心入口 ──

  async handleBeatReady(
    event: BeatReadyEvent,
    world: World,
    beatDef?: BeatDefinition,
  ): Promise<DirectorCallLog | null> {
    return this.invoke({
      world,
      tick: event.triggeredTick,
      day: event.triggeredDay,
      trigger: "beat_ready",
      beatId: event.beatId,
      promptContext: this.buildBeatReadyPrompt(event, beatDef),
    });
  }

  async handleDailyPacing(world: World, tick: number): Promise<DirectorCallLog | null> {
    const day = Math.floor(tick / 96) + 1;
    return this.invoke({
      world,
      tick,
      day,
      trigger: "daily_pacing",
      promptContext: this.buildPacingPrompt(world, day),
    });
  }

  // ── 内部 ──

  private async invoke(params: {
    world: World;
    tick: number;
    day: number;
    trigger: DirectorCallLog["trigger"];
    beatId?: string;
    promptContext: { system: string; user: string };
  }): Promise<DirectorCallLog | null> {
    if (!this.enabled) return null;

    // 预算检查
    const remaining = this.budgetByDay.get(params.day) ?? this.dailyBudget;
    if (remaining <= 0) {
      console.log(`🎬 [director] 预算耗尽 (day ${params.day}), skip ${params.trigger}`);
      return null;
    }

    let response;
    try {
      const request: LLMRequest = {
        system: params.promptContext.system,
        messages: [{ role: "user", content: params.promptContext.user }],
        tools: ALL_DIRECTOR_TOOLS.map((t) => t.tool),
        temperature: 0.7,
        maxTokens: 800,
      };
      response = await this.provider.chat(request, this.modelId);
    } catch (err) {
      console.warn(`🎬 [director] LLM 调用失败: ${(err as Error).message}`);
      return null;
    }

    // 扣预算
    this.budgetByDay.set(params.day, remaining - 1);

    // 应用 tool calls
    const appliedCalls: DirectorCallLog["toolCalls"] = [];
    for (const tc of response.toolCalls.slice(0, 3)) {
      // 兜底防越权：拒绝任何看起来像角色台词的工具
      if (FORBIDDEN_TOOL_PREFIXES.some((p) => tc.name.toLowerCase().startsWith(p))) {
        console.warn(`🎬 [director] 拒绝越权工具调用: ${tc.name}`);
        appliedCalls.push({
          name: tc.name,
          args: tc.arguments,
          result: { ok: false, description: "rejected: forbidden tool", error: "forbidden_tool" },
        });
        continue;
      }
      const tool = getDirectorToolByName(tc.name);
      if (!tool) {
        appliedCalls.push({
          name: tc.name,
          args: tc.arguments,
          result: { ok: false, description: `未知工具 ${tc.name}`, error: "unknown_tool" },
        });
        continue;
      }
      const result = tool.handler(tc.arguments, { world: params.world, tick: params.tick });
      appliedCalls.push({ name: tc.name, args: tc.arguments, result });
    }

    const log: DirectorCallLog = {
      tick: params.tick,
      trigger: params.trigger,
      beatId: params.beatId,
      thought: response.content || "(无想法)",
      toolCalls: appliedCalls,
      budgetRemaining: this.budgetByDay.get(params.day)!,
    };
    this.appendLog(log);

    // 控制台 trace
    const action = appliedCalls.length === 0 ? "(无工具调用)" : appliedCalls.map((c) => c.name).join(",");
    console.log(
      `🎬 [director] ${params.trigger}${params.beatId ? ` [${params.beatId}]` : ""} → ${action} (budget=${log.budgetRemaining})`,
    );

    return log;
  }

  private appendLog(log: DirectorCallLog): void {
    this.callLogs.push(log);
    if (this.callLogs.length > 50) this.callLogs.shift();
  }

  // ── Prompt 构造 ──

  private buildBeatReadyPrompt(
    event: BeatReadyEvent,
    beatDef?: BeatDefinition,
  ): { system: string; user: string } {
    const system = `你是一名"世界导演"。你的工作不是当角色，不是写台词，而是决定"该让什么发生"。
你看不见的角色们正在自主生活；你只在世界需要轻推时介入。

铁律：
1. 你**不能**让角色直接说话。你没有任何 talk/say 工具。台词永远由角色自己产出。
2. 你只能通过以下方式影响世界：
   - 给角色注入念头（inject_intent）
   - 让角色注意到某事（inject_observation）
   - 添加未解决事件（add_unresolved_event）
   - 加流言（add_rumor）
   - 改可观察痕迹（set_observable_state）
   - 调天气（nudge_weather，谨慎用）
3. 触发后的发生方式必须**符合当前世界状态和角色性格**。如果没必要介入就调 do_nothing。
4. 一次最多调用 1-2 个工具。简洁。`;

    const beatHint = beatDef?.on_trigger as { hint?: string; director_hint?: string } | undefined;
    const hintText = beatHint?.director_hint ?? beatHint?.hint ?? event.description ?? "";
    const reasonText =
      event.reason === "fallback_deadline"
        ? "⚠️ 这是 fallback 强制触发——意味着原本预期的前置条件没满足，但 deadline 到了，必须让它发生。"
        : "前置条件已自然满足。";

    const user = `BEAT 触发: ${event.beatId}
${reasonText}

${hintText ? `Beat 提示:\n${hintText}\n` : ""}
现在 game day ${event.triggeredDay}, tick ${event.triggeredTick}.

请决定怎么让这个 beat 在世界里发生。先用一两句话说你的判断，然后调用 1-2 个工具（或 do_nothing）。`;

    return { system, user };
  }

  private buildPacingPrompt(world: World, day: number): { system: string; user: string } {
    const ns = world.narrative.getWorld();
    const tension = ns.tensionIndex;
    const unresolvedCount = ns.unresolvedEvents.length;
    const triggeredCount = ns.triggeredBeats.length;

    const system = `你是一名"世界导演"，每天早上 06:00 对世界做一次节奏检查。
你的目标：让世界既不失控也不陷入死水。

铁律：
1. 你**不能**让角色直接说话。
2. 如果世界的张力（tension_index）已经够高（>40）或最近有 beat 触发，通常调 do_nothing。
3. 如果世界太平淡（tension < 15 且最近没什么事），可以注入一个轻度扰动（一条流言、一次天气变化、给某角色注入一个小念头）。
4. 一次最多 1 个工具。`;

    const user = `日节奏检查 - day ${day}
tension_index: ${tension}/100
未解决事件数: ${unresolvedCount}
已触发 beats 总数: ${triggeredCount}

请判断现在是否需要轻推世界。先一句话说你的判断，然后调用 1 个工具（多数情况下应该是 do_nothing）。`;

    return { system, user };
  }
}
