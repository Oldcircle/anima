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

export const ALL_DIRECTOR_TOOLS: DirectorToolDefinition[] = [
  injectIntentTool,
  injectObservationTool,
  addUnresolvedEventTool,
  addRumorTool,
  setObservableStateTool,
  markBeatResolvedTool,
  nudgeWeatherTool,
  doNothingTool,
];

export function getDirectorToolByName(name: string): DirectorToolDefinition | undefined {
  return ALL_DIRECTOR_TOOLS.find((t) => t.tool.name === name);
}
