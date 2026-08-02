/**
 * Director Toolset — LLM 导演的可用工具
 *
 * 关键约束（DESIGN-narrative §3.4 + 用户决策 D1）:
 * **导演不能让角色直接说话**。这些工具只能改世界状态、注入念头、加观察。
 * 角色的台词、行动永远由角色 agent 自己产出。
 *
 * 工具集与角色 toolset 完全隔离 — 角色看不到这些工具。
 */

import type { ToolDefinition } from "../providers/types.js";
import type { World } from "../world/world.js";
import type { CharacterIntent } from "../world/types.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import type { ImpressionStore } from "../memory/impressions.js";
import type { InMemoryPulseStore } from "./pulse-store.js";
import type { InMemoryAgendaStore } from "./agenda-store.js";
import type { PressureGraph } from "./pressure-graph.js";
import { getBreakLevel, isWorldEventEnabled } from "../agent/break-config.js";
import { hasItem, resolveItem } from "../world/item-registry.js";
import {
  applyAccidentDamage,
  applyLetterArrival,
  applyTheftWithPerp,
  checkAndReserveWorldEventQuota,
  perpEligibility,
  SURFACE_GRUDGE_COOLDOWN_TICKS,
  SURFACE_GRUDGE_MIN_PRESSURE,
  WORLD_EVENT_TYPES,
  type WorldEventType,
} from "./world-events.js";

export interface DirectorToolContext {
  world: World;
  /** 当前 tick（用于设置 createdTick / expiresAt） */
  tick: number;
  /** D1: read 工具需要访问角色短期记忆 */
  memory?: ShortTermMemory;
  /** D1: read 工具需要访问印象库 */
  impressions?: ImpressionStore;
  /** D2: read_pulse_outcome 工具需要访问 pulse store */
  pulseStore?: InMemoryPulseStore;
  /** D4: agenda 工具需要访问 agenda store */
  agendaStore?: InMemoryAgendaStore;
  /** D4: 当前游戏日（agenda 维护需要） */
  currentDay?: number;
  /**
   * B2 安全通路：运行期改世界必须入队（下一 tick 开头 drainMutations 统一落账）。
   * 导演是 fire-and-forget 后台任务，与 tick 循环并发——硬事件 handler 同步直写必竞态。
   * 缺省 = 硬事件不可用（拒绝，不降级为直写）。
   */
  enqueueMutation?: (fn: () => void) => void;
  /** B2: surface_grudge 需要读 pair 压力（催化门槛判定） */
  pressureGraph?: PressureGraph;
}

export interface DirectorToolResult {
  ok: boolean;
  /** 给日志/审计用的人类可读描述 */
  description: string;
  /** 改写了哪个字段（用于测试断言） */
  changed?: Record<string, unknown>;
  /** 错误原因（ok=false 时） */
  error?: string;
}

export type DirectorToolHandler = (
  args: Record<string, unknown>,
  ctx: DirectorToolContext,
) => DirectorToolResult;

export interface DirectorToolDefinition {
  tool: ToolDefinition;
  handler: DirectorToolHandler;
}

// ── 1. inject_intent ──
// 给角色注入一个短期念头，下个 tick 角色 agent 会看到

export const injectIntentTool: DirectorToolDefinition = {
  tool: {
    name: "inject_intent",
    description:
      "给某角色注入一个短期念头/动机。该念头会出现在角色下一次决策的 prompt 里，影响 TA 的行动选择。不直接产生台词。",
    parameters: {
      type: "object",
      properties: {
        character_id: { type: "string", description: "目标角色 id" },
        summary: { type: "string", description: "念头的简短描述（一句话），从角色第一人称视角写" },
        kind: {
          type: "string",
          enum: ["plan", "recover", "follow_up", "reply"],
          description: "念头类型：plan=计划做某事 | recover=从某事中恢复 | follow_up=跟进 | reply=回应",
        },
        target_character_id: { type: "string", description: "（可选）念头涉及的另一个角色 id" },
        expires_in_ticks: { type: "number", description: "（可选）多少 tick 后过期，默认 16（约 4 小时）" },
      },
      required: ["character_id", "summary"],
    },
  },
  handler: (args, ctx) => {
    const charId = args.character_id as string;
    const summary = args.summary as string;
    const character = ctx.world.getCharacter(charId);
    if (!character) {
      return { ok: false, description: `inject_intent 失败：未知角色 ${charId}`, error: "unknown_character" };
    }
    const intent: CharacterIntent = {
      kind: ((args.kind as string) ?? "plan") as CharacterIntent["kind"],
      summary,
      source: "action",
      targetId: typeof args.target_character_id === "string" ? args.target_character_id : undefined,
      createdTick: ctx.tick,
      expiresAt: ctx.tick + (typeof args.expires_in_ticks === "number" ? args.expires_in_ticks : 16),
    };
    ctx.world.setIntent(charId, intent);
    return {
      ok: true,
      description: `给 ${charId} 注入念头：「${summary}」`,
      changed: { intent },
    };
  },
};

// ── 2. inject_observation ──
// 让某角色"看到"了某事件，写入其短期记忆（模拟 perception）

export const injectObservationTool: DirectorToolDefinition = {
  tool: {
    name: "inject_observation",
    description:
      "让某角色突然注意到/想起某件事。会作为一条记忆写入该角色的短期记忆，影响后续决策。不直接产生台词。",
    parameters: {
      type: "object",
      properties: {
        observer_id: { type: "string", description: "感知到这件事的角色 id" },
        summary: { type: "string", description: "TA 注意到的内容（一句话客观描述）" },
        importance: { type: "number", description: "（可选）重要性 1-10，默认 6" },
      },
      required: ["observer_id", "summary"],
    },
  },
  handler: (args, ctx) => {
    const observerId = args.observer_id as string;
    const summary = args.summary as string;
    if (!ctx.world.getCharacter(observerId)) {
      return { ok: false, description: `inject_observation 失败：未知角色 ${observerId}`, error: "unknown_character" };
    }
    // 通过 narrative_state 记录到地点（如果有），并通过 director-callback 写入 memory
    // memory 写入需要外部 ShortTermMemory 实例，由 simulation 注入。这里只暂存到 character.inbox
    // 作为一种"系统级"的内部讯息让角色下次决策注意到。
    ctx.world.sendMessage(observerId, {
      fromId: "__director__",
      fromName: "（你心里突然浮现）",
      content: summary,
      tick: ctx.tick,
    });
    return {
      ok: true,
      description: `让 ${observerId} 注意到：「${summary}」`,
      changed: { observation: summary },
    };
  },
};

// ── 3. add_unresolved_event ──

export const addUnresolvedEventTool: DirectorToolDefinition = {
  tool: {
    name: "add_unresolved_event",
    description:
      "在世界里加一个未解决事件。这件事会出现在相关角色的 prompt 里作为'还没了结的事'，制造叙事张力。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "事件 id（如 sakiko_disappeared_yesterday）" },
        summary: { type: "string", description: "一句话描述这件事" },
        involved: { type: "array", items: { type: "string" }, description: "涉及的角色 id 列表" },
        visible_to: {
          oneOf: [
            { type: "string", enum: ["*"] },
            { type: "array", items: { type: "string" } },
          ],
          description: "谁知道这事存在：'*' 表示所有人，或 id 列表",
        },
      },
      required: ["id", "summary", "involved", "visible_to"],
    },
  },
  handler: (args, ctx) => {
    const id = args.id as string;
    const summary = args.summary as string;
    const involved = (args.involved as string[]) ?? [];
    const visibleTo = args.visible_to as string[] | "*";
    ctx.world.narrative.addUnresolvedEvent({
      id,
      summary,
      involved,
      visibleTo,
      createdTick: ctx.tick,
    });
    return {
      ok: true,
      description: `添加未解决事件 [${id}]：${summary}`,
      changed: { unresolvedEvent: id },
    };
  },
};

// ── 4. add_rumor ──

export const addRumorTool: DirectorToolDefinition = {
  tool: {
    name: "add_rumor",
    description: "在世界里制造一条流言。会传播到指定角色的认知中。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "流言内容" },
        source_character_id: { type: "string", description: "（可选）流言源头的角色 id" },
        spread_to: {
          type: "array",
          items: { type: "string" },
          description: "（可选）流言已经传到了哪些角色那里，默认空数组",
        },
      },
      required: ["content"],
    },
  },
  handler: (args, ctx) => {
    const content = args.content as string;
    const w = ctx.world.narrative.getWorld();
    w.rumors.push({
      content,
      sourceCharId: typeof args.source_character_id === "string" ? args.source_character_id : undefined,
      tick: ctx.tick,
      reachedChars: Array.isArray(args.spread_to) ? (args.spread_to as string[]) : [],
    });
    return { ok: true, description: `添加流言：「${content}」`, changed: { rumor: content } };
  },
};

// ── 5. set_observable_state ──

export const setObservableStateTool: DirectorToolDefinition = {
  tool: {
    name: "set_observable_state",
    description: "改变某角色的可观察状态痕迹（其他人路过时能看到的）。例：'眼睛红红的，像刚哭过'",
    parameters: {
      type: "object",
      properties: {
        character_id: { type: "string" },
        summary: { type: "string", description: "一句白描，第三人称客观" },
        expires_in_ticks: { type: "number", description: "（可选）默认 8 tick" },
      },
      required: ["character_id", "summary"],
    },
  },
  handler: (args, ctx) => {
    const charId = args.character_id as string;
    if (!ctx.world.getCharacter(charId)) {
      return { ok: false, description: `set_observable_state 失败：未知角色 ${charId}`, error: "unknown_character" };
    }
    ctx.world.setObservableState(charId, {
      actionName: "__director__",
      summary: args.summary as string,
      source: "action",
      createdTick: ctx.tick,
      expiresAt: ctx.tick + (typeof args.expires_in_ticks === "number" ? args.expires_in_ticks : 8),
    });
    return { ok: true, description: `${charId} 的状态：${args.summary}`, changed: { observableState: args.summary } };
  },
};

// ── 6. mark_beat_resolved ──

export const markBeatResolvedTool: DirectorToolDefinition = {
  tool: {
    name: "mark_beat_resolved",
    description: "标记某个 beat 已经按你的处理方式落地。仅用于明示对接：beat 已被处理。",
    parameters: {
      type: "object",
      properties: {
        beat_id: { type: "string" },
        outcome: { type: "string", description: "你最终选了怎样的发生方式（一句话）" },
      },
      required: ["beat_id"],
    },
  },
  handler: (args, _ctx) => {
    return {
      ok: true,
      description: `确认处理 beat [${args.beat_id}]: ${(args.outcome as string) ?? "(无说明)"}`,
      changed: { beatResolved: args.beat_id },
    };
  },
};

// ── 7. nudge_weather ──

export const nudgeWeatherTool: DirectorToolDefinition = {
  tool: {
    name: "nudge_weather",
    description: "微调天气，间接施压角色情绪/行为。仅在确实需要环境氛围支持时使用。",
    parameters: {
      type: "object",
      properties: {
        weather: { type: "string", enum: ["sunny", "cloudy", "rainy", "stormy", "snowy"] },
      },
      required: ["weather"],
    },
  },
  handler: (args, ctx) => {
    const w = args.weather as string;
    if (!["sunny", "cloudy", "rainy", "stormy", "snowy"].includes(w)) {
      return { ok: false, description: `nudge_weather 失败：未知天气 ${w}`, error: "invalid_weather" };
    }
    ctx.world.setWeather(w as any);
    return { ok: true, description: `天气改为 ${w}`, changed: { weather: w } };
  },
};

// ── 8. do_nothing ──

export const doNothingTool: DirectorToolDefinition = {
  tool: {
    name: "do_nothing",
    description: "明确选择不干预世界。当 beat 已经在自然发生的轨道上、或当前 tick 不需要 director 介入时使用。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "（可选）为什么不干预" },
      },
    },
  },
  handler: (args, _ctx) => ({
    ok: true,
    description: `do_nothing: ${(args.reason as string) ?? "(无理由)"}`,
  }),
};

// ── 9. create_arc (D4) ──
// Director 创建一条新的剧情 arc，pin 到某个 beat 或 'freelance'。
// 这是 director 的"长期工作记忆"——下一次 invoke 时 prompt 会自动注入活跃 arc 摘要。

export const createArcTool: DirectorToolDefinition = {
  tool: {
    name: "create_arc",
    description:
      "创建一条新的剧情 arc，记录到 director 的工作记忆里。下次 invoke 时你能在 prompt 顶部看到所有活跃 arc。活跃 arc 上限 3 条；freelance 上限 1 条且只能存在 2 游戏日。",
    parameters: {
      type: "object",
      properties: {
        beat_id: {
          type: "string",
          description: "pin 到的 beat id（来自 beats.yml），或写 'freelance' 表示自由剧情线（受 2 天寿命限制）",
        },
        goal: { type: "string", description: "一句话描述这条 arc 想达成什么" },
        target_day: { type: "number", description: "想在哪天达成" },
        watch_chars: { type: "array", items: { type: "string" }, description: "这条 arc 关注的角色 id 列表" },
        notes: { type: "string", description: "（可选）≤200 字备注" },
      },
      required: ["beat_id", "goal", "target_day", "watch_chars"],
    },
  },
  handler: (args, ctx): DirectorToolResult => {
    if (!ctx.agendaStore)
      return { ok: false, description: "agenda store 未配置（D4 未启用）", error: "no_agenda_store" };
    const day = ctx.currentDay ?? Math.floor(ctx.tick / 96) + 1;
    const result = ctx.agendaStore.create(
      {
        beatId: args.beat_id as string,
        goal: args.goal as string,
        targetDay: args.target_day as number,
        watchChars: (args.watch_chars as string[]) ?? [],
        notes: args.notes as string | undefined,
      },
      ctx.tick,
      day,
    );
    if (!result.ok) return { ok: false, description: result.error, error: "create_failed" };
    return {
      ok: true,
      description: `创建 arc ${result.arc.id}（pin=${result.arc.beatId}, target_day=${result.arc.targetDay}）: ${result.arc.goal}`,
      changed: { arc_id: result.arc.id },
    };
  },
};

// ── 10. update_agenda (D4) ──

export const updateAgendaTool: DirectorToolDefinition = {
  tool: {
    name: "update_agenda",
    description:
      "更新一条已存在的 arc 的状态/备注/目标日。把 arc 标记为 resolved 或 abandoned 之后会被归档，不再出现在 prompt 注入里。",
    parameters: {
      type: "object",
      properties: {
        arc_id: { type: "string", description: "要更新的 arc id" },
        status: {
          type: "string",
          enum: ["setup", "brewing", "climax_ready", "resolved", "abandoned"],
          description: "新状态",
        },
        notes: { type: "string", description: "（可选）覆盖 notes（≤200 字）" },
        target_day: { type: "number", description: "（可选）改 target_day" },
      },
      required: ["arc_id"],
    },
  },
  handler: (args, ctx): DirectorToolResult => {
    if (!ctx.agendaStore)
      return { ok: false, description: "agenda store 未配置（D4 未启用）", error: "no_agenda_store" };
    const result = ctx.agendaStore.update(
      args.arc_id as string,
      {
        status: args.status as any,
        notes: args.notes as string | undefined,
        targetDay: args.target_day as number | undefined,
      },
      ctx.tick,
    );
    if (!result.ok) return { ok: false, description: result.error, error: "update_failed" };
    return {
      ok: true,
      description: `更新 arc ${result.arc.id}: status=${result.arc.status} target_day=${result.arc.targetDay}`,
      changed: { arc_id: result.arc.id, status: result.arc.status },
    };
  },
};

// ── 11. seed_topic (D3) ──
// 给角色塞一个"想聊的话题"。角色下次 talk 时 prompt 会引导围绕这个话题展开。
// 比 inject_intent 更精准——intent 只是"想找谁谈谈"，seed_topic 指定"谈什么"。

export const seedTopicTool: DirectorToolDefinition = {
  tool: {
    name: "seed_topic",
    description:
      "给某角色塞一个'想聊的话题'。效果：角色下次 talk 时，prompt 会提示 TA '你心里有些话想说'并列出这个话题。比 inject_intent 更精准——intent 只能让角色'想找某人谈谈'，seed_topic 能指定'谈什么'。典型用法：seed_topic + inject_intent 组合——先用 seed_topic 指定话题，再用 inject_intent 给角色动力去找人。",
    parameters: {
      type: "object",
      properties: {
        character_id: { type: "string", description: "角色 id" },
        topic: { type: "string", description: "话题内容（角色视角，如'你必须告诉真嗣订婚的消息'）" },
        urgency: {
          type: "string",
          enum: ["low", "med", "high"],
          description: "紧迫度。high = 下次开口必须提，med = 找机会提，low = 有空就提",
        },
        target_char: {
          type: "string",
          description: "（可选）只有和这个角色聊天时才提起。不填 = 和任何人都会提。",
        },
      },
      required: ["character_id", "topic", "urgency"],
    },
  },
  handler: (args, ctx): DirectorToolResult => {
    const charId = args.character_id as string;
    const topic = args.topic as string;
    const urgency = (args.urgency as "low" | "med" | "high") ?? "med";
    const targetChar = args.target_char as string | undefined;

    if (!charId || !topic) {
      return { ok: false, description: "缺少 character_id 或 topic", error: "missing_arg" };
    }
    const ok = ctx.world.addWantToDiscuss(charId, topic, urgency, targetChar, ctx.tick);
    if (!ok) {
      return { ok: false, description: `角色 ${charId} 不存在`, error: "unknown_character" };
    }
    const targetNote = targetChar ? `（仅对 ${targetChar}）` : "";
    return {
      ok: true,
      description: `给 ${charId} 塞话题${targetNote}[${urgency}]: ${topic}`,
      changed: { seed_topic: charId },
    };
  },
};

// ── 12. inject_world_event (B2) ──
// 硬事件原语：动真钱真物、留持久物证的世界侧事实。只入队（安全通路），
// off 档禁用，周池 2 次 + 每类冷却（计数挂 narrative_state.world 随档）。

/** 硬事件共同的守门：off 档 / 入队通路 /（可选）记忆句柄与 cause。通过返回 null，否则返回拒绝结果。 */
function gateHardEvent(
  args: Record<string, unknown>,
  ctx: DirectorToolContext,
  toolName: string,
  opts: { needCause?: boolean; needMemory?: boolean } = {},
): DirectorToolResult | null {
  const { needCause = true, needMemory = true } = opts;
  if (getBreakLevel() === "off") {
    return { ok: false, description: `${toolName} 在 off 档（治愈系基线）禁用`, error: "break_level_off" };
  }
  if (!ctx.enqueueMutation) {
    return { ok: false, description: `${toolName} 需要 enqueueMutation 安全通路（未接线）——硬事件只入队，不同步直写`, error: "no_mutation_queue" };
  }
  if (needMemory && !ctx.memory) {
    return { ok: false, description: `${toolName} 需要 memory 句柄（未接线）`, error: "no_memory" };
  }
  if (needCause && (typeof args.cause !== "string" || args.cause.trim().length === 0)) {
    return { ok: false, description: `${toolName} 必须带 cause——没有因果伪装的硬事件是无源之水，拒绝`, error: "missing_cause" };
  }
  return null;
}

export const injectWorldEventTool: DirectorToolDefinition = {
  tool: {
    name: "inject_world_event",
    description:
      "往世界里注入一件有真实状态后果的硬事件（动真钱/真物、留持久物证）。这是你最硬的干预，有周配额（每周 2 次）+ 每类冷却，好钢用在刀刃上。事件在下一 tick 落地。三类：theft_with_perp（失窃，真凶只能是 NPC 或近期真实偷过东西的角色——绝不无中生有指认；受害者要到场才会发现）/ accident_damage（意外损毁物品或赔钱）/ letter_arrival（镇外来信，需剧本启用）。",
    parameters: {
      type: "object",
      properties: {
        event_type: {
          type: "string",
          enum: [...WORLD_EVENT_TYPES],
          description: "硬事件类型",
        },
        cause: {
          type: "string",
          description: "必填。事件的因果伪装/来龙去脉（一句话，会织进相关角色的记忆与念头里）",
        },
        perp_id: { type: "string", description: "theft: 真凶 id（必须是 NPC 或近窗真实执行过 steal 的角色）" },
        victim_id: { type: "string", description: "theft: 受害者 id" },
        amount: { type: "number", description: "theft: 失窃金额（真金转移，以受害者身上的钱为限）" },
        discovery_location_id: { type: "string", description: "theft: （可选）发现地点，默认受害者的工作地点" },
        target_id: { type: "string", description: "accident: 遭意外的角色 id" },
        item: { type: "string", description: "accident: （可选）被毁物品（须真实持有）" },
        gold_cost: { type: "number", description: "accident: （可选）赔/修的金额（与 item 二选一）" },
        recipient_id: { type: "string", description: "letter: 收信人 id" },
        from_whom: { type: "string", description: "letter: 寄信人（镇外之人，只有信来，人不来）" },
        content_summary: { type: "string", description: "letter: 信的内容概要" },
      },
      required: ["event_type", "cause"],
    },
  },
  handler: (args, ctx) => {
    const eventType = args.event_type as WorldEventType;
    if (!WORLD_EVENT_TYPES.includes(eventType)) {
      return { ok: false, description: `未知硬事件类型 ${String(args.event_type)}`, error: "unknown_event_type" };
    }
    const gated = gateHardEvent(args, ctx, `inject_world_event(${eventType})`);
    if (gated) return gated;
    const cause = (args.cause as string).trim();
    const { world, memory, tick } = ctx;

    // 同步预检（配额之前——不合法的调用不烧配额）：让导演当场拿到真实拒绝理由
    if (eventType === "theft_with_perp") {
      const perpId = args.perp_id as string;
      const victimId = args.victim_id as string;
      if (!perpId || !victimId || !world.getCharacter(victimId)) {
        return { ok: false, description: `theft_with_perp 需要合法的 perp_id 与 victim_id`, error: "unknown_character" };
      }
      if (!perpEligibility(world, perpId, tick)) {
        return {
          ok: false,
          description: `拒绝：${perpId} 不是合法真凶。真凶只允许两种——npc 登记的静态 NPC，或近 2 天真实执行过 steal 的角色。世界绝不替 cast 成员捏造罪行`,
          error: "perp_not_eligible",
        };
      }
    } else if (eventType === "accident_damage") {
      const targetId = args.target_id;
      if (typeof targetId !== "string" || !world.getCharacter(targetId)) {
        return { ok: false, description: `accident_damage 需要合法的 target_id`, error: "unknown_character" };
      }
      if (typeof args.item === "string" && args.item) {
        const def = resolveItem(args.item);
        if (!def || !hasItem(world.getCharacter(targetId)!.inventory ?? [], def.id)) {
          return { ok: false, description: `拒绝：${targetId} 身上没有「${args.item}」——不能毁掉不存在的东西（真实边界）`, error: "item_not_held" };
        }
      } else if (!(typeof args.gold_cost === "number" && args.gold_cost > 0)) {
        return { ok: false, description: "accident_damage 需要 item（须真实持有）或正数 gold_cost 之一", error: "missing_payload" };
      }
    } else if (eventType === "letter_arrival") {
      if (!isWorldEventEnabled("letter_arrival")) {
        return {
          ok: false,
          description: "letter_arrival 未被当前剧本启用（manifest world_events 未声明 letter_arrival）——真实边界块没有豁免行，信会与物理法则打架",
          error: "letter_not_enabled",
        };
      }
      if (typeof args.recipient_id !== "string" || !world.getCharacter(args.recipient_id)) {
        return { ok: false, description: `letter_arrival 需要合法的 recipient_id`, error: "unknown_character" };
      }
      if (typeof args.from_whom !== "string" || !args.from_whom || typeof args.content_summary !== "string" || !args.content_summary) {
        return { ok: false, description: "letter_arrival 需要 from_whom 与 content_summary", error: "missing_payload" };
      }
    }

    // 配额：周池 + 每类冷却（同步预定，落账随档——重启不失控）
    const quota = checkAndReserveWorldEventQuota(world, eventType, tick);
    if (!quota.ok) {
      return { ok: false, description: quota.description, error: quota.error };
    }

    // 只入队：世界写入统一在下一 tick 开头 drain（与 agent 决策不并发）
    const deps = { world, memory: memory!, tick };
    ctx.enqueueMutation!(() => {
      let outcome;
      if (eventType === "theft_with_perp") {
        outcome = applyTheftWithPerp(deps, {
          perpId: args.perp_id as string,
          victimId: args.victim_id as string,
          amount: typeof args.amount === "number" ? args.amount : 0,
          discoveryLocationId: typeof args.discovery_location_id === "string" ? args.discovery_location_id : undefined,
          cause,
        });
      } else if (eventType === "accident_damage") {
        outcome = applyAccidentDamage(deps, {
          targetId: args.target_id as string,
          item: typeof args.item === "string" ? args.item : undefined,
          goldCost: typeof args.gold_cost === "number" ? args.gold_cost : undefined,
          cause,
        });
      } else {
        outcome = applyLetterArrival(deps, {
          recipientId: args.recipient_id as string,
          fromWhom: args.from_whom as string,
          contentSummary: args.content_summary as string,
          cause,
        });
      }
      if (!outcome.ok) {
        console.warn(`🎬 [world_event] ${eventType} 落地失败: ${outcome.description}`);
      } else {
        console.log(`🎬 [world_event] ${outcome.description}`);
      }
    });

    return {
      ok: true,
      description: `硬事件 ${eventType} 已入队（下一 tick 落地）：${cause}`,
      changed: { worldEvent: eventType },
    };
  },
};

// ── 13. surface_grudge (B2) ──
// 催化已有旧账：只对压力 ≥ 阈值的对生效（催化不无中生有），只配注意力不写关系/印象。

export const surfaceGrudgeTool: DirectorToolDefinition = {
  tool: {
    name: "surface_grudge",
    description:
      "把某角色对另一个角色**已经攒起来**的旧账（疙瘩/积怨/欠账/爽约）推到台面：给他一个想把话摊开的强念头。只对压力足够高的对生效——没有旧账的对会被拒绝，这个工具催化已有火种，不无中生有。",
    parameters: {
      type: "object",
      properties: {
        char_id: { type: "string", description: "被催化的角色 id（旧账的持有方，由他去挑明）" },
        about_char_id: { type: "string", description: "旧账指向的角色 id" },
        hint: { type: "string", description: "（可选）一句话点明这次想推到台面的是哪桩旧账" },
      },
      required: ["char_id", "about_char_id"],
    },
  },
  handler: (args, ctx) => {
    const gated = gateHardEvent(args, ctx, "surface_grudge", { needCause: false, needMemory: false });
    if (gated) return gated;
    const charId = args.char_id as string;
    const aboutId = args.about_char_id as string;
    const { world, tick } = ctx;
    const me = world.getCharacter(charId);
    const other = world.getCharacter(aboutId);
    if (!me || !other) {
      return { ok: false, description: `未知角色（${charId} / ${aboutId}）`, error: "unknown_character" };
    }
    if (!ctx.pressureGraph) {
      return { ok: false, description: "surface_grudge 需要压力图（未接线）", error: "no_pressure_graph" };
    }
    const pair = ctx.pressureGraph.getPairPressure(charId, aboutId);
    if (!pair || pair.pressure < SURFACE_GRUDGE_MIN_PRESSURE) {
      return {
        ok: false,
        description: `拒绝：${charId} ↔ ${aboutId} 压力 ${Math.round(pair?.pressure ?? 0)} < ${SURFACE_GRUDGE_MIN_PRESSURE}——他们之间没有攒够的旧账，催化无从谈起（先用世界侧事实造处境）`,
        error: "pressure_too_low",
      };
    }
    // 每对冷却（随档）
    const quota = world.narrative.getWorldEventQuota();
    const pairKey = [charId, aboutId].sort().join(":");
    const coolKey = `surface_grudge:${pairKey}`;
    const last = quota.lastByType[coolKey];
    if (last !== undefined && tick - last < SURFACE_GRUDGE_COOLDOWN_TICKS) {
      return { ok: false, description: `surface_grudge 对 ${pairKey} 冷却中（上次 tick ${last}）`, error: "pair_cooldown" };
    }
    quota.lastByType[coolKey] = tick;

    // 旧账白描（从压力边的真实成分拼，不编造）
    const parts: string[] = [];
    if (pair.inputs.frictions > 0) parts.push(`攒了${pair.inputs.frictions}桩疙瘩`);
    if (pair.inputs.grudge) parts.push("有没解开的积怨");
    if (pair.inputs.debtOverdueDays > 0) parts.push(`欠账逾期${pair.inputs.debtOverdueDays}天`);
    if (pair.inputs.missedAppointments > 0) parts.push(`被爽约${pair.inputs.missedAppointments}次`);
    const ledger = parts.join("、") || "积累的摩擦";
    const hint = typeof args.hint === "string" && args.hint.trim() ? args.hint.trim() : undefined;
    const topic = hint ?? `你和${other.name}之间的旧账（${ledger}），一直压着没说`;

    ctx.enqueueMutation!(() => {
      world.addWantToDiscuss(charId, `${topic}。到了该摊开说的时候了`, "high", aboutId, world.tick);
      world.setIntent(charId, {
        kind: "recover", source: "action", targetId: aboutId,
        summary: `对${other.name}${ledger}——这口气压不住了，找机会把话挑明。`,
        createdTick: world.tick, expiresAt: world.tick + 12,
      });
      console.log(`🎬 [surface_grudge] ${charId} → ${aboutId}（压力 ${Math.round(pair.pressure)}：${ledger}）`);
    });

    return {
      ok: true,
      description: `旧账催化已入队：${me.name} 会想把对 ${other.name} 的账（${ledger}）摊开。只配注意力——摊不摊、怎么摊由他自己决定`,
      changed: { surfaceGrudge: pairKey },
    };
  },
};

// ── 14. set_active_phase (B2) ──
// setActivePhase 的工具封装：切剧幕 + phase 专属工具上/下架（simulation phaseTools 按 activePhase 供给）。

export const setActivePhaseTool: DirectorToolDefinition = {
  tool: {
    name: "set_active_phase",
    description:
      "切换剧本的当前阶段（active_phase）。阶段决定哪些阶段专属工具对角色可用（如审判庭/夜书工具）。传 'none' 收起阶段。下一 tick 生效。",
    parameters: {
      type: "object",
      properties: {
        phase: { type: "string", description: "目标阶段 id；'none' = 清除当前阶段" },
        reason: { type: "string", description: "（可选）为什么此刻切幕" },
      },
      required: ["phase"],
    },
  },
  handler: (args, ctx) => {
    const gated = gateHardEvent(args, ctx, "set_active_phase", { needCause: false, needMemory: false });
    if (gated) return gated;
    const phase = args.phase as string;
    if (!phase || typeof phase !== "string") {
      return { ok: false, description: "set_active_phase 需要 phase", error: "missing_arg" };
    }
    const next = phase === "none" ? undefined : phase;
    const prev = ctx.world.narrative.getWorld().activePhase;
    ctx.enqueueMutation!(() => {
      ctx.world.narrative.setActivePhase(next);
      console.log(`🎬 [set_active_phase] ${prev ?? "(无)"} → ${next ?? "(无)"}`);
    });
    return {
      ok: true,
      description: `阶段切换已入队：${prev ?? "(无)"} → ${next ?? "(无)"}（下一 tick 生效，phase 工具随之上/下架）`,
      changed: { activePhase: next ?? null },
    };
  },
};

export const ALL_DIRECTOR_TOOLS: DirectorToolDefinition[] = [
  injectIntentTool,
  injectObservationTool,
  addUnresolvedEventTool,
  addRumorTool,
  setObservableStateTool,
  markBeatResolvedTool,
  nudgeWeatherTool,
  doNothingTool,
  createArcTool,
  updateAgendaTool,
  seedTopicTool,
  injectWorldEventTool,
  surfaceGrudgeTool,
  setActivePhaseTool,
];

export function getDirectorToolByName(name: string): DirectorToolDefinition | undefined {
  return ALL_DIRECTOR_TOOLS.find((t) => t.tool.name === name);
}
