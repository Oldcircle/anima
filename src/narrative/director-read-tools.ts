/**
 * Director Read Tools — D1
 *
 * 让 director 能"先看后写"。这些工具不修改世界状态，
 * 只把世界的真实切片返回给 LLM，让导演基于事实做决策。
 *
 * 设计原则:
 *   - 历史窗口固定 8 tick（≈2 小时游戏内），不可配置（D-Agent-1）
 *   - 返回结构紧凑（避免炸 prompt），但要包含足够语义
 *   - 角色不存在时返回 ok=false 而不是抛异常
 */

import type { DirectorToolDefinition, DirectorToolResult } from "./director-tools.js";
import { OBSERVATION_WINDOW } from "./pulse-store.js";

const HISTORY_WINDOW_TICKS = 8;
const SCENE_EVENT_WINDOW = 10;
const TOP_IMPRESSIONS = 3;
const RECENT_THOUGHTS = 3;

// ── read_character ──

export const readCharacterTool: DirectorToolDefinition = {
  tool: {
    name: "read_character",
    description:
      "查看某个角色当前的真实状态：位置、当前念头、可观察痕迹、最近 8 tick 的行为、最近 3 条内心独白、对其他角色 top 3 印象。在做出任何 inject/amplify/seed 决策前必须先 read 一下相关角色。",
    parameters: {
      type: "object",
      properties: {
        character_id: { type: "string", description: "角色 id（必须来自世界存在的角色列表）" },
      },
      required: ["character_id"],
    },
  },
  handler: (args, ctx): DirectorToolResult => {
    const id = args.character_id as string;
    if (!id) return { ok: false, description: "缺少 character_id", error: "missing_arg" };

    const char = ctx.world.getCharacter(id);
    if (!char) return { ok: false, description: `角色 ${id} 不存在`, error: "unknown_character" };

    const loc = ctx.world.getLocation(char.locationId)?.name ?? char.locationId;

    // 最近 8 tick 行为（从 short-term memory event/observation 类型抽）
    const memEntries = ctx.memory?.getRecent(id, 30) ?? [];
    const cutoff = ctx.tick - HISTORY_WINDOW_TICKS;
    const recentActions = memEntries
      .filter((e) => e.tick >= cutoff && (e.type === "event" || e.type === "observation"))
      .slice(-8)
      .map((e) => `[t${e.tick}] ${e.content}`);

    // 最近 3 条内心独白
    const thoughts = (ctx.memory?.getRecentThoughts(id, RECENT_THOUGHTS) ?? []).map(
      (e) => `[t${e.tick}] ${e.content}`,
    );

    // top 3 印象（仅当 impressionStore 提供 export 接口；否则降级跳过）
    const topImpressions: Array<{ of: string; label: string; summary: string }> = [];
    if (ctx.impressions) {
      const others = ctx.world.getAllCharacters().filter((c) => c.id !== id);
      for (const other of others) {
        const imp = ctx.impressions.get(id, other.id);
        if (imp) {
          topImpressions.push({
            of: other.id,
            label: imp.mentalLabel,
            summary: imp.summary,
          });
        }
      }
      topImpressions.sort(
        (a, b) =>
          ((ctx.impressions!.get(id, b.of)?.lastUpdated ?? 0) -
            (ctx.impressions!.get(id, a.of)?.lastUpdated ?? 0)),
      );
      topImpressions.splice(TOP_IMPRESSIONS);
    }

    const intent = char.currentIntent
      ? `${char.currentIntent.kind}: ${char.currentIntent.summary} (expires t${char.currentIntent.expiresAt})`
      : "(无)";
    const obs = char.observableState
      ? `${char.observableState.actionName}: ${char.observableState.summary}`
      : "(无)";

    const lines = [
      `角色: ${char.name} (id=${char.id})`,
      `当前位置: ${loc}`,
      `当前念头(currentIntent): ${intent}`,
      `可观察痕迹(observableState): ${obs}`,
      `最近 ${HISTORY_WINDOW_TICKS} tick 行为:`,
      ...(recentActions.length ? recentActions.map((l) => `  ${l}`) : ["  (无)"]),
      `最近内心独白:`,
      ...(thoughts.length ? thoughts.map((l) => `  ${l}`) : ["  (无)"]),
      `Top ${TOP_IMPRESSIONS} 印象:`,
      ...(topImpressions.length
        ? topImpressions.map((i) => `  对 ${i.of}: [${i.label}] ${i.summary}`)
        : ["  (无)"]),
    ];

    return {
      ok: true,
      description: lines.join("\n"),
      changed: { read_character: id },
    };
  },
};

// ── read_scene ──

export const readSceneTool: DirectorToolDefinition = {
  tool: {
    name: "read_scene",
    description:
      "查看某个地点当前的状态：当前在场角色、最近 10 tick 在该地点发生的事件摘要。用于判断现在那里有几个人、气氛如何、能不能让某个 beat 在那里发生。",
    parameters: {
      type: "object",
      properties: {
        location_id: { type: "string", description: "地点 id" },
      },
      required: ["location_id"],
    },
  },
  handler: (args, ctx): DirectorToolResult => {
    const id = args.location_id as string;
    if (!id) return { ok: false, description: "缺少 location_id", error: "missing_arg" };

    const loc = ctx.world.getLocation(id);
    if (!loc) return { ok: false, description: `地点 ${id} 不存在`, error: "unknown_location" };

    const occupants = ctx.world.getCharactersAtLocation(id);
    const occupantNames = occupants
      .map((cid) => ctx.world.getCharacter(cid))
      .filter(Boolean)
      .map((c) => `${c!.name}(${c!.id})`);

    // 从所有在场角色的 short-term memory 中抽取近 10 tick 的事件作为"场景活动"近似
    const cutoff = ctx.tick - SCENE_EVENT_WINDOW;
    const sceneEvents: string[] = [];
    if (ctx.memory) {
      for (const cid of occupants) {
        const entries = ctx.memory.getRecent(cid, 15);
        for (const e of entries) {
          if (e.tick >= cutoff && (e.type === "event" || e.type === "conversation")) {
            sceneEvents.push(`[t${e.tick}] ${cid}: ${e.content}`);
          }
        }
      }
      sceneEvents.sort();
    }

    const lines = [
      `地点: ${loc.name} (id=${loc.id})`,
      `当前在场: ${occupantNames.length ? occupantNames.join(", ") : "(无人)"}`,
      `最近 ${SCENE_EVENT_WINDOW} tick 该地相关事件:`,
      ...(sceneEvents.length ? sceneEvents.slice(-10).map((l) => `  ${l}`) : ["  (无)"]),
    ];

    return {
      ok: true,
      description: lines.join("\n"),
      changed: { read_scene: id },
    };
  },
};

// ── read_arc_status (D1 stub, D4 真正实现) ──

export const readArcStatusTool: DirectorToolDefinition = {
  tool: {
    name: "read_arc_status",
    description:
      "查看某条剧情 arc 的当前状态、目标、已经推过的 pulse 历史。D1 阶段为 stub，D4 才完整支持。当前总是返回 not_implemented。",
    parameters: {
      type: "object",
      properties: {
        arc_id: { type: "string", description: "arc id" },
      },
      required: ["arc_id"],
    },
  },
  handler: (args, _ctx): DirectorToolResult => {
    return {
      ok: false,
      description: `read_arc_status(${args.arc_id}) — D4 未实现，当前 director 没有 agenda 持久化。请改用 read_character 或 read_scene。`,
      error: "not_implemented",
    };
  },
};

// ── read_pulse_outcome (D2) ──

export const readPulseOutcomeTool: DirectorToolDefinition = {
  tool: {
    name: "read_pulse_outcome",
    description:
      "查看你之前一次写工具调用（pulse）后世界实际发生了什么。返回 expected（你当时的期望）+ observed（reducer 自动回填的目标角色后续行为摘要）。如果 pulse 还在 observation 窗口内（< 8 tick），observed 会是空。可用 list_recent_pulses 找 pulse_id（D2 暂未实现 list，请记住自己刚才返回的 pulse_id）。",
    parameters: {
      type: "object",
      properties: {
        pulse_id: { type: "string", description: "pulse id（形如 pulse_<tick>_<n>）" },
      },
      required: ["pulse_id"],
    },
  },
  handler: (args, ctx): DirectorToolResult => {
    const id = args.pulse_id as string;
    if (!id) return { ok: false, description: "缺少 pulse_id", error: "missing_arg" };
    if (!ctx.pulseStore) {
      return {
        ok: false,
        description: "pulseStore 未配置（director 未启用 D2 反馈）",
        error: "no_pulse_store",
      };
    }
    const p = ctx.pulseStore.get(id);
    if (!p) return { ok: false, description: `pulse ${id} 不存在`, error: "unknown_pulse" };

    const lines = [
      `pulse_id: ${p.id}`,
      `tick: ${p.tick} (创建)`,
      `工具: ${p.toolName}`,
      `目标角色: ${p.targetChar ?? "(无)"}`,
      `expected: ${p.expected ?? "(未声明)"}`,
      `observed: ${
        p.observed ?? `(尚在观察窗口内，需等到 tick ${p.tick + OBSERVATION_WINDOW} 之后)`
      }`,
      p.observedAtTick !== undefined ? `observed_at_tick: ${p.observedAtTick}` : "",
    ].filter(Boolean);

    return {
      ok: true,
      description: lines.join("\n"),
      changed: { read_pulse_outcome: id },
    };
  },
};

export const ALL_DIRECTOR_READ_TOOLS: DirectorToolDefinition[] = [
  readCharacterTool,
  readSceneTool,
  readArcStatusTool,
  readPulseOutcomeTool,
];

export const READ_TOOL_NAMES = new Set(ALL_DIRECTOR_READ_TOOLS.map((t) => t.tool.name));
