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
import type { PressureGraph } from "./pressure-graph.js";

/** B2: recent-motive 环形缓冲条目（simulation 侧内存 buffer，third 档才有数据） */
export interface RecentMotiveEntry {
  charId: string;
  name: string;
  surface: string;
  hidden: string;
  tick: number;
}

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
  /**
   * B2: 硬事件安全通路。simulation 注入 enqueueMutation——硬事件工具只入队，
   * 下一 tick 开头统一落账（导演 fire-and-forget 与 tick 循环并发，同步直写必竞态）。
   */
  enqueueMutation?: (fn: () => void) => void;
  /** B2: 压力图（worldSnapshot 热点摘要 + surface_grudge 门槛判定） */
  pressureGraph?: PressureGraph;
  /** B2: recent-motive 环形缓冲读取口（只给导演；空集安全——没有就不注入） */
  getRecentMotives?: () => ReadonlyArray<RecentMotiveEntry>;
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
  private enqueueMutation?: (fn: () => void) => void;
  private pressureGraph?: PressureGraph;
  private getRecentMotives?: () => ReadonlyArray<RecentMotiveEntry>;

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
    this.enqueueMutation = config.enqueueMutation;
    this.pressureGraph = config.pressureGraph;
    this.getRecentMotives = config.getRecentMotives;
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
      // B2: 硬事件安全通路 + 压力图（surface_grudge 门槛判定）
      enqueueMutation: this.enqueueMutation,
      pressureGraph: this.pressureGraph,
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

      // 导演有"此刻不该有事"的权利：do_nothing 永远在工具表里。
      // 旧版 beat_ready 时移除 do_nothing 强制写入 → 日历驱动的假戏（无中生有的干预比没有干预更假）
      const isBeatMustWrite = params.trigger === "beat_ready" && writeCallCount === 0;
      const stepTools = tools;

      let response;
      try {
        response = await this.provider.chat(
          {
            system: params.promptContext.system,
            messages,
            tools: stepTools.map((t) => t.tool),
            temperature: 0.7,
            maxTokens: 800,
            kind: "director",
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
              content: "你没有调用任何工具。这是一个 beat_ready 触发——如果你判断此刻确实该有事发生，请调用写工具让它发生；如果你判断这个 beat 已经在自然发生、或者时机完全不对，请显式调用 do_nothing 并说明理由（不调用任何工具会被当作失误）。",
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
              ? "继续。你已经 read 了。如果 read 显示时机成熟，调用写工具让 beat 发生；如果 read 显示它已在自然发生或时机不对，调 do_nothing 并说明理由。"
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

    // B2: 压力图热点摘要——已攒起来的旧账（催化优先于新开线）。无热点不注入。
    const hotspots = this.pressureGraph?.formatHotspotSummary(world) ?? "";
    const pressureBlock = hotspots
      ? `\n\n压力图热点（这些对之间已经攒了真实旧账——催化它们优先于凭空开新线）:\n${hotspots}`
      : "";

    // B2: recent-motive 环形缓冲（third 档才有数据；空集安全——没有就整块不出现）
    const motives = this.getRecentMotives?.() ?? [];
    const motiveBlock =
      motives.length > 0
        ? `\n\n最近真心层（角色不肯承认的真实动机，只有你看得见，别让角色"知道"）:\n` +
          motives
            .slice(-6)
            .map((m) => `  - [tick ${m.tick}] ${m.name}: 表面「${truncate(m.surface, 60)}」｜真心「${truncate(m.hidden, 60)}」`)
            .join("\n")
        : "";

    return `角色（合法 id 列表，禁止编造其他 id）:
${charLines}

未解决事件 id（详情请用 read_character/read_scene 调查具体情况）:
  ${eventIds}

世界张力: ${ns.world.tensionIndex}/100  天气: ${world.weather}  已触发 beats: ${ns.world.triggeredBeats.length}${pressureBlock}${motiveBlock}${agendaBlock}`;
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
4. **beat_ready 先判断再介入**：beat 触发 = 值得看一眼，不 = 必须制造。read 之后：世界里已有苗头 → 轻推放大它；毫无因果基础 → do_nothing 并说明（无中生有的剧情比没有剧情更伤真实感）。你是涌现的放大器，不是剧情制造机。
5. 写工具优先级（每次调用最多用 3 个）——**世界侧事实优先，心灵直写是最后手段**：
   - **inject_world_event**（最硬）: 失窃/意外/来信——动真钱真物、留持久物证。有周配额，好钢用在刀刃上
   - **surface_grudge**: 把一对角色**已经攒起来**的旧账推到台面（只对压力够高的对生效，催化不无中生有）
   - **set_active_phase**: 切换剧本阶段（阶段专属工具随之上/下架）
   - **add_unresolved_event / add_rumor / set_observable_state**: 往世界里放事实、风声、痕迹——角色靠感知自己拼出因果
   - **seed_topic**: 给知情者一个"想说出口"的话题——让事情从人嘴里说出来，而不是凭空知道
   - **inject_intent / inject_observation**（心灵直写，最后手段）: 直接改角色脑内。没有因果铺垫的念头是无源之水，用多了世界会显假——动手前先问：这个念头能不能改用上面的世界侧通道让角色自己长出来？
6. 组合建议：先用世界侧事实造处境（inject_world_event / add_rumor / surface_grudge），再视需要用 seed_topic 给知情者递话头。角色的行为永远由角色自己产出。
7. 工作流：先 read 1-2 次 → 思考 → 写 1-2 个工具 → 不再调用工具来结束。最多 5 步。
8. **每次写工具都建议带 expected 字段**（一句话："我期望 alice 下一 tick 主动 talk bob"）。这会被记成 pulse，下次 invoke 时你可以用 read_pulse_outcome 查回看实际发生了什么。
9. **Agenda（你的工作记忆）**：prompt 顶部会列出你当前的活跃 arc。如果当前 beat 该开一条新 arc 来跟进，用 create_arc(beat_id, goal, target_day, watch_chars)。需要标记 arc 进度时用 update_agenda(arc_id, status=...)。状态值: setup → brewing → climax_ready → resolved/abandoned。活跃 arc 上限 3 条。`;

    const beatHint = beatDef?.on_trigger as { hint?: string; director_hint?: string } | undefined;
    const hintText = beatHint?.director_hint ?? beatHint?.hint ?? event.description ?? "";
    const reasonText =
      event.reason === "fallback_deadline"
        ? "⚠️ 这是 fallback 触发——前置条件没满足但 deadline 到了。优先播种条件（seed_topic/inject_intent 让前置更可能自然发生），硬把结果按日历砸下去是最后手段；时机完全不对就 do_nothing。"
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

  /** B2 pacing 分档：<25 播种 / 25-60 催化热点 / >60 收手看戏 */
  static pacingBand(tension: number): "seed" | "catalyze" | "hands_off" {
    if (tension < 25) return "seed";
    if (tension <= 60) return "catalyze";
    return "hands_off";
  }

  private buildPacingPrompt(world: World, day: number): { system: string; user: string } {
    const ns = world.narrative.getWorld();
    const tension = ns.tensionIndex;
    const unresolvedCount = ns.unresolvedEvents.length;
    const triggeredCount = ns.triggeredBeats.length;
    const band = Director.pacingBand(tension);
    const bandLabel =
      band === "seed" ? "播种（沉寂）" : band === "catalyze" ? "催化热点（发酵）" : "收手看戏（沸腾）";

    const system = `你是一名"世界导演"，每天早上 06:00 对世界做一次节奏检查。
你的目标：让世界既不失控也不陷入死水。

铁律：
1. 你**不能**让角色直接说话。所有角色 id 必须来自下面列表，**禁止编造**。
2. **先看后写**：调用任何写工具前，至少先调用一次 read_character 或 read_scene 看看现在角色在干什么。
3. 按张力分档行事（当前档位见下方）：
   - **tension < 25 → 播种**：世界太沉。优先用世界侧事实播下新处境——add_rumor / inject_world_event / surface_grudge / add_unresolved_event，呼应已有未解决事件；心灵直写（inject_intent/inject_observation）是最后手段。
   - **25 ≤ tension ≤ 60 → 催化热点**：火种已有。看压力图热点里最热的一两对，用 surface_grudge / seed_topic 把**已经攒起来**的旧账推向台面；不要另开新线稀释压强。
   - **tension > 60 → 收手看戏**：世界已经够紧，角色们自己在燃。几乎总是 do_nothing——此刻任何注入都是画蛇添足。
4. 多数节奏检查应该以 do_nothing 结束。最多 5 步循环，写工具最多 1 个。`;

    const user = `${this.buildWorldSnapshot(world)}

────────────────
日节奏检查 - day ${day}
当前分档: ${bandLabel}（tension=${tension}）
未解决事件数: ${unresolvedCount}
已触发 beats 总数: ${triggeredCount}

请按上面的分档行事。先一句话说你的判断，然后调用 1 个工具（或 do_nothing）。`;

    return { system, user };
  }
}
