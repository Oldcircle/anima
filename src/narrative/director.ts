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
import type { LLMProvider, LLMRequest } from "../providers/types.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import type { ImpressionStore } from "../memory/impressions.js";
import type { BeatReadyEvent, BeatDefinition } from "./beat-engine.js";
import {
  ALL_DIRECTOR_TOOLS,
  getDirectorToolByName as _getWriteToolByName,
  type DirectorToolDefinition,
  type DirectorToolResult,
} from "./director-tools.js";
import { ALL_DIRECTOR_READ_TOOLS, READ_TOOL_NAMES } from "./director-read-tools.js";
import { InMemoryPulseStore, extractTargetChar, type PulseRecord } from "./pulse-store.js";
import { InMemoryAgendaStore } from "./agenda-store.js";

const FORBIDDEN_TOOL_PREFIXES = ["talk", "say", "speak", "message"]; // 兜底防越权

// D1: 合并写工具 + 读工具
// D2: 给所有写工具的 schema 注入可选 expected 字段（不修改原 handler）
const WRITE_TOOLS_WITH_EXPECTED: DirectorToolDefinition[] = ALL_DIRECTOR_TOOLS.map((t) => {
  if (t.tool.name === "do_nothing" || t.tool.name === "mark_beat_resolved") return t;
  const params = t.tool.parameters as { type: string; properties?: Record<string, unknown>; required?: string[] };
  if (!params.properties || params.properties.expected) return t;
  return {
    ...t,
    tool: {
      ...t.tool,
      parameters: {
        ...params,
        properties: {
          ...params.properties,
          expected: {
            type: "string",
            description:
              "(可选) 你期望这次注入之后世界发生什么。仅用于后续 read_pulse_outcome 自查，写一句话即可。",
          },
        },
      },
    },
  };
});
const ALL_TOOLS: DirectorToolDefinition[] = [...WRITE_TOOLS_WITH_EXPECTED, ...ALL_DIRECTOR_READ_TOOLS];
function lookupTool(name: string): DirectorToolDefinition | undefined {
  return ALL_TOOLS.find((t) => t.tool.name === name);
}

const MAX_LOOP_STEPS = 5;
const MAX_WRITE_CALLS = 3;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export interface DirectorConfig {
  provider: LLMProvider;
  modelId: string;
  /** 每天最多 LLM 调用次数；超出 do_nothing。默认 5 */
  dailyBudget?: number;
  /** 是否允许真实 LLM 调用；为 false 时所有触发走 mock 路径（测试用） */
  enabled?: boolean;
  /** D1: 短期记忆引用，read 工具用 */
  memory?: ShortTermMemory;
  /** D1: 印象库引用，read 工具用 */
  impressions?: ImpressionStore;
  /** D1: 是否启用 read 工具 + tool loop 模式（默认 true，可关闭回退到旧单步路径） */
  useReadTools?: boolean;
  /** D2: pulse 反馈闭环。不传则自动创建一个 InMemoryPulseStore（除非 usePulseFeedback=false） */
  pulseStore?: InMemoryPulseStore;
  /** D2: 是否启用 pulse 反馈（默认 true） */
  usePulseFeedback?: boolean;
  /** D4: agenda 持久化。不传则自动创建（除非 useAgenda=false） */
  agendaStore?: InMemoryAgendaStore;
  /** D4: 是否启用 agenda 持久化（默认 true） */
  useAgenda?: boolean;
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
  private memory?: ShortTermMemory;
  private impressions?: ImpressionStore;
  private useReadTools: boolean;
  private pulseStore?: InMemoryPulseStore;
  private usePulseFeedback: boolean;
  private agendaStore?: InMemoryAgendaStore;
  private useAgenda: boolean;

  /** 每天的剩余调用预算（key = game day） */
  private budgetByDay = new Map<number, number>();

  /** 调用日志（最近 50 条） */
  private callLogs: DirectorCallLog[] = [];

  constructor(config: DirectorConfig) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.dailyBudget = config.dailyBudget ?? 5;
    this.enabled = config.enabled ?? true;
    this.memory = config.memory;
    this.impressions = config.impressions;
    this.useReadTools = config.useReadTools ?? true;
    this.usePulseFeedback = config.usePulseFeedback ?? true;
    this.pulseStore = this.usePulseFeedback
      ? config.pulseStore ?? new InMemoryPulseStore()
      : undefined;
    this.useAgenda = config.useAgenda ?? true;
    this.agendaStore = this.useAgenda
      ? config.agendaStore ?? new InMemoryAgendaStore()
      : undefined;
  }

  /** D2: 暴露 pulse store 供外部 reducer 调用 + 测试访问 */
  getPulseStore(): InMemoryPulseStore | undefined {
    return this.pulseStore;
  }

  /** D4: 暴露 agenda store 供 simulation 维护 + 测试访问 */
  getAgendaStore(): InMemoryAgendaStore | undefined {
    return this.agendaStore;
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
    // D4: 维护一次 agenda（自动 abandon 过期 freelance）
    this.agendaStore?.maintenance(event.triggeredDay, event.triggeredTick);
    return this.invoke({
      world,
      tick: event.triggeredTick,
      day: event.triggeredDay,
      trigger: "beat_ready",
      beatId: event.beatId,
      promptContext: this.buildBeatReadyPrompt(event, beatDef, world),
    });
  }

  async handleDailyPacing(world: World, tick: number): Promise<DirectorCallLog | null> {
    const day = Math.floor(tick / 96) + 1;
    this.agendaStore?.maintenance(day, tick);
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

    // 预算检查 + 立即扣减（防止并发竞态）— tool loop 整体只算一次预算
    const remaining = this.budgetByDay.get(params.day) ?? this.dailyBudget;
    if (remaining <= 0) {
      console.log(`🎬 [director] 预算耗尽 (day ${params.day}), skip ${params.trigger}`);
      return null;
    }
    this.budgetByDay.set(params.day, remaining - 1);

    const ctx = {
      world: params.world,
      tick: params.tick,
      memory: this.memory,
      impressions: this.impressions,
      pulseStore: this.pulseStore,
      agendaStore: this.agendaStore,
      currentDay: params.day,
    };

    const useLoop = this.useReadTools;
    const tools = useLoop ? ALL_TOOLS : ALL_DIRECTOR_TOOLS;
    const messages: LLMRequest["messages"] = [{ role: "user", content: params.promptContext.user }];

    const appliedCalls: DirectorCallLog["toolCalls"] = [];
    let writeCallCount = 0;
    let lastThought = "";
    let stepsUsed = 0;
    const maxSteps = useLoop ? MAX_LOOP_STEPS : 1;

    for (let step = 0; step < maxSteps; step++) {
      stepsUsed = step + 1;

      // beat_ready 且还没写过工具时，从 tool list 移除 do_nothing 防止 LLM 逃避
      const isBeatMustWrite = params.trigger === "beat_ready" && writeCallCount === 0;
      const stepTools = isBeatMustWrite
        ? tools.filter((t) => t.tool.name !== "do_nothing")
        : tools;

      let response;
      try {
        response = await this.provider.chat(
          {
            system: params.promptContext.system,
            messages,
            tools: stepTools.map((t) => t.tool),
            temperature: 0.7,
            maxTokens: 800,
          },
          this.modelId,
        );
      } catch (err) {
        console.warn(`🎬 [director] LLM 调用失败 (step ${step}): ${(err as Error).message}`);
        if (step === 0) {
          // 第一步就失败：还原预算并直接返回 null（保持旧行为）
          this.budgetByDay.set(params.day, remaining);
          return null;
        }
        break;
      }

      if (response.content) lastThought = response.content;

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        // beat_ready 且没写过工具：不让 LLM 逃避，强制再给一轮
        if (isBeatMustWrite && step < maxSteps - 1) {
          messages.push(
            { role: "assistant", content: response.content || "(无)" },
            {
              role: "user",
              content: "你没有调用任何工具。这是一个 beat_ready 触发——你**必须**调用至少一个写工具（inject_intent 是最有效的选择）让这个 beat 在世界里发生。请现在调用。",
            },
          );
          continue;
        }
        break;
      }

      // 一次最多处理 2 个 tool call（同一步里）
      let stepHadTerminal = false;
      const stepResults: Array<{ name: string; result: DirectorToolResult; pulseId?: string }> = [];

      for (const tc of toolCalls.slice(0, 2)) {
        // 越权防御
        if (FORBIDDEN_TOOL_PREFIXES.some((p) => tc.name.toLowerCase().startsWith(p))) {
          console.warn(`🎬 [director] 拒绝越权工具调用: ${tc.name}`);
          const r: DirectorToolResult = {
            ok: false,
            description: "rejected: forbidden tool",
            error: "forbidden_tool",
          };
          appliedCalls.push({ name: tc.name, args: tc.arguments, result: r });
          stepResults.push({ name: tc.name, result: r });
          continue;
        }

        const tool = lookupTool(tc.name);
        if (!tool) {
          const r: DirectorToolResult = {
            ok: false,
            description: `未知工具 ${tc.name}`,
            error: "unknown_tool",
          };
          appliedCalls.push({ name: tc.name, args: tc.arguments, result: r });
          stepResults.push({ name: tc.name, result: r });
          continue;
        }

        const isRead = READ_TOOL_NAMES.has(tc.name);

        // 写工具次数硬上限
        if (!isRead && writeCallCount >= MAX_WRITE_CALLS) {
          const r: DirectorToolResult = {
            ok: false,
            description: `写工具调用已达上限 ${MAX_WRITE_CALLS}，本次拒绝。请用 do_nothing 结束。`,
            error: "write_limit",
          };
          appliedCalls.push({ name: tc.name, args: tc.arguments, result: r });
          stepResults.push({ name: tc.name, result: r });
          continue;
        }

        const result = tool.handler(tc.arguments, ctx);
        appliedCalls.push({ name: tc.name, args: tc.arguments, result });

        // D2: 写工具成功 → 记录 pulse
        let pulseId: string | undefined;
        const isTerminal = tc.name === "do_nothing" || tc.name === "mark_beat_resolved";
        if (!isRead && !isTerminal && result.ok && this.pulseStore) {
          pulseId = this.pulseStore.nextId(params.tick);
          const pulse: PulseRecord = {
            id: pulseId,
            tick: params.tick,
            toolName: tc.name,
            targetChar: extractTargetChar(tc.arguments),
            args: tc.arguments,
            expected: typeof tc.arguments.expected === "string" ? tc.arguments.expected : undefined,
          };
          this.pulseStore.record(pulse);
        }
        stepResults.push({ name: tc.name, result, pulseId });

        if (!isRead) writeCallCount++;
        if (isTerminal) stepHadTerminal = true;
      }

      // 如果这一步只调了写工具，达到了写上限，结束
      if (writeCallCount >= MAX_WRITE_CALLS) break;
      if (stepHadTerminal) break;
      if (!useLoop) break; // 单步路径只跑 1 轮

      // 把这一步的结果反喂回 messages，供下一轮决策
      const assistantSummary = stepResults
        .map((r) => {
          const tag = r.pulseId ? ` [${r.pulseId}]` : "";
          return `调用 ${r.name}${tag} → ${r.result.ok ? "ok" : "fail"}: ${truncate(r.result.description, 600)}`;
        })
        .join("\n");
      messages.push({
        role: "assistant",
        content: response.content
          ? `${response.content}\n[工具调用结果]\n${assistantSummary}`
          : `[工具调用结果]\n${assistantSummary}`,
      });
      const isBeatReady = params.trigger === "beat_ready";
      messages.push({
        role: "user",
        content:
          writeCallCount === 0
            ? isBeatReady
              ? "继续。你已经 read 了，现在**必须**调用至少一个写工具（首选 inject_intent）让这个 beat 在世界里发生。还没到调 do_nothing 的时候。"
              : "继续。如果信息够了，请调用 1-2 个写工具，或调 do_nothing 结束。"
            : "继续。你已经做出了改动，可以再补一个写工具或不再调用工具来结束。",
      });
    }

    // 如果 useLoop 但 LLM 全程没调任何写工具且 step 用完，记一条 do_nothing
    if (useLoop && writeCallCount === 0 && !appliedCalls.some((c) => c.name === "do_nothing")) {
      appliedCalls.push({
        name: "do_nothing",
        args: { reason: "loop_ended_without_write" },
        result: { ok: true, description: "loop_ended_without_write" },
      });
    }

    const log: DirectorCallLog = {
      tick: params.tick,
      trigger: params.trigger,
      beatId: params.beatId,
      thought: lastThought || "(无想法)",
      toolCalls: appliedCalls,
      budgetRemaining: this.budgetByDay.get(params.day)!,
    };
    this.appendLog(log);

    const action = appliedCalls.length === 0 ? "(无工具调用)" : appliedCalls.map((c) => c.name).join(",");
    console.log(
      `🎬 [director] ${params.trigger}${params.beatId ? ` [${params.beatId}]` : ""} → ${action} (steps=${stepsUsed}, writes=${writeCallCount}, budget=${log.budgetRemaining})`,
    );

    return log;
  }

  private appendLog(log: DirectorCallLog): void {
    this.callLogs.push(log);
    if (this.callLogs.length > 50) this.callLogs.shift();
  }

  // ── Prompt 构造 ──

  /**
   * 共用的"世界快照"段落：实际角色 id 列表 + 当前 unresolved events + 关键状态。
   * 这是修复 P1/P2 的核心 — 让 director 看见真实世界，而不是凭空想象。
   */
  private buildWorldSnapshot(world: World): string {
    const characters = world.getAllCharacters();
    const ns = world.narrative.getSnapshot();

    // D1: 瘦身。只列角色 id + 当前地点 + 未解决事件 id 列表（不含 summary 全文）。
    // 想看 summary / 角色细节 / 场景活动，让 director 自己调 read_character / read_scene。
    const charLines = characters
      .map((c) => {
        const loc = world.getLocation(c.locationId)?.name ?? c.locationId;
        return `  - ${c.id} (${c.name}) @ ${loc}`;
      })
      .join("\n");

    const eventIds =
      ns.world.unresolvedEvents.length === 0
        ? "（无）"
        : ns.world.unresolvedEvents
            .map((e) => {
              const visibility = e.visibleTo === "*" ? "*" : e.visibleTo.join(",");
              return `${e.id}[涉及:${e.involved.join(",")}|可见:${visibility}]`;
            })
            .join(", ");

    const agendaBlock = this.agendaStore
      ? `\n\n你的当前 agenda（活跃 arc，跨 invoke 持续）:\n${this.agendaStore.renderForPrompt()}`
      : "";

    return `角色（合法 id 列表，禁止编造其他 id）:
${charLines}

未解决事件 id（详情请用 read_character/read_scene 调查具体情况）:
  ${eventIds}

世界张力: ${ns.world.tensionIndex}/100  天气: ${world.weather}  已触发 beats: ${ns.world.triggeredBeats.length}${agendaBlock}`;
  }

  private buildBeatReadyPrompt(
    event: BeatReadyEvent,
    beatDef: BeatDefinition | undefined,
    world: World,
  ): { system: string; user: string } {
    const system = `你是一名"世界导演"。你的工作不是当角色，不是写台词，而是决定"该让什么发生"。
你看不见的角色们正在自主生活；现在一个**剧情节拍 (beat) 已经触发**——这意味着故事需要这件事发生，而你必须让它发生。

铁律：
1. 你**不能**让角色直接说话。你没有任何 talk/say 工具。台词永远由角色自己产出。
2. 所有角色 id 必须来自下面列出的"角色"列表，**绝不允许**编造或使用动漫角色名。
3. **先看后写**：在调用任何写工具之前，**至少先调用一次 read_character 或 read_scene** 调查相关角色/场景的真实状态。世界快照里只有 id 列表，详情必须自己 read。
4. **beat_ready 必须介入**：beat 触发就意味着这一刻该有事发生。read 完之后你**必须**至少调用一个写工具。do_nothing 仅在你确认这个 beat 已经在世界里自然发生（read 看到了证据）时才允许。
5. 写工具（每次调用最多用 3 个）：
   - **inject_intent**（最有效，首选）: 给角色注入念头，直接影响下一 tick 行为
   - **inject_observation**: 让角色注意到某事
   - set_observable_state: 改可观察痕迹
   - add_unresolved_event / add_rumor: 添加事件/流言
   - nudge_weather / mark_beat_resolved
6. **推剧情的最佳组合**：
   - **seed_topic**（最精准）: 指定角色"和谁聊天时必须聊什么话题"，直接影响对话内容
   - **inject_intent**: 给角色动力"去找某人"
   - **add_unresolved_event**: 只是背景信息，角色不会主动反应，效果最弱
   - 推荐组合：seed_topic(角色, 话题) + inject_intent(角色, 动力) → 角色会主动去找人，对话围绕指定话题展开。
6. 工作流：先 read 1-2 次 → 思考 → 写 1-2 个工具 → 不再调用工具来结束。最多 5 步。
7. **每次写工具都建议带 expected 字段**（一句话："我期望 alice 下一 tick 主动 talk bob"）。这会被记成 pulse，下次 invoke 时你可以用 read_pulse_outcome 查回看实际发生了什么。
8. **Agenda（你的工作记忆）**：prompt 顶部会列出你当前的活跃 arc。如果当前 beat 该开一条新 arc 来跟进，用 create_arc(beat_id, goal, target_day, watch_chars)。需要标记 arc 进度时用 update_agenda(arc_id, status=...)。状态值: setup → brewing → climax_ready → resolved/abandoned。活跃 arc 上限 3 条。`;

    const beatHint = beatDef?.on_trigger as { hint?: string; director_hint?: string } | undefined;
    const hintText = beatHint?.director_hint ?? beatHint?.hint ?? event.description ?? "";
    const reasonText =
      event.reason === "fallback_deadline"
        ? "⚠️ 这是 fallback 强制触发——意味着原本预期的前置条件没满足，但 deadline 到了，必须让它发生。"
        : "前置条件已自然满足。";

    const user = `${this.buildWorldSnapshot(world)}

────────────────
BEAT 触发: ${event.beatId}
${reasonText}

${hintText ? `Beat 提示:\n${hintText}\n` : ""}
现在 game day ${event.triggeredDay}, tick ${event.triggeredTick}.

请决定怎么让这个 beat 在世界里发生。先用一两句话说你的判断，然后调用 1-2 个工具（或 do_nothing）。所有角色 id 必须来自上面的列表。`;

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
1. 你**不能**让角色直接说话。所有角色 id 必须来自下面列表，**禁止编造**。
2. **先看后写**：调用任何写工具前，至少先调用一次 read_character 或 read_scene 看看现在角色在干什么。
3. 如果 tension > 40 或最近有 beat 触发，通常 do_nothing 即可。
4. 如果世界太平淡（tension < 15），优先用 inject_intent / inject_observation 给某个真实角色一个微小念头，呼应已有未解决事件。
5. 多数节奏检查应该以 do_nothing 结束。最多 5 步循环，写工具最多 1 个。`;

    const user = `${this.buildWorldSnapshot(world)}

────────────────
日节奏检查 - day ${day}
未解决事件数: ${unresolvedCount}
已触发 beats 总数: ${triggeredCount}

请判断现在是否需要轻推世界。先一句话说你的判断，然后调用 1 个工具。`;

    return { system, user };
  }
}
