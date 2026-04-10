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
];

export function getDirectorToolByName(name: string): DirectorToolDefinition | undefined {
  return ALL_DIRECTOR_TOOLS.find((t) => t.tool.name === name);
}
