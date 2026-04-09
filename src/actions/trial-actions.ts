/**
 * Trial Actions — 审判阶段专属工具 (N6.4)
 *
 * 这些工具只在 narrative_state.world.activePhase 为特定值时可用。
 * Phase gating 在 buildToolList 时由 simulation 注入 narrative state 后过滤。
 *
 * 工具列表:
 *   investigation phase: collect_evidence, interview
 *   trial phase: present_evidence, accuse, vote, counter
 */

import type { ActionDefinition, ActionResult } from "./types.js";

// ── investigation phase 工具 ──

export const collectEvidenceAction: ActionDefinition = {
  tool: {
    name: "collect_evidence",
    description: "在搜查阶段：在当前地点收集一项证据。物品/痕迹/线索等。",
    parameters: {
      type: "object",
      properties: {
        evidence_id: { type: "string", description: "证据的 id（如 broken_arrow_in_trash）" },
        description: { type: "string", description: "证据的简短描述" },
      },
      required: ["evidence_id", "description"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const id = args.evidence_id as string;
    const desc = args.description as string;
    return {
      description: `在${ctx.locationId}发现了证据：${desc}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "fun", delta: 5 },
      ],
      duration: 1,
      observableState: `蹲下来仔细查看${desc}`,
    };
  },
};

export const interviewAction: ActionDefinition = {
  tool: {
    name: "interview",
    description: "在搜查阶段：详细询问某个在场角色关于某个话题。比 talk 更正式，对方一定会回答。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "对象角色 id (必须在同一地点)" },
        topic: { type: "string", description: "你想问的话题，如'昨晚 8 点你在哪'" },
      },
      required: ["target", "topic"],
    },
  },
  handler: (args, ctx): ActionResult => {
    const target = args.target as string;
    if (!ctx.nearbyCharacters.includes(target)) {
      return { description: `想询问${target}，但对方不在这里`, effects: [], success: false };
    }
    return {
      description: `严肃地询问${target}：「${args.topic}」`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 2 },
      ],
      duration: 1,
      observableState: `表情严肃地在询问${target}`,
    };
  },
};

// ── trial phase 工具 ──

export const presentEvidenceAction: ActionDefinition = {
  tool: {
    name: "present_evidence",
    description: "在审判阶段：出示一项证据并说明它的意义。是审判辩论的核心动作。",
    parameters: {
      type: "object",
      properties: {
        evidence_id: { type: "string", description: "证据 id" },
        argues_against: { type: "string", description: "（可选）你想用这证据反驳谁" },
        reasoning: { type: "string", description: "你的推理一句话" },
      },
      required: ["evidence_id", "reasoning"],
    },
  },
  handler: (args, ctx): ActionResult => {
    return {
      description: `出示证据「${args.evidence_id}」: ${args.reasoning}`,
      effects: [
        { type: "need_change", targetId: ctx.characterId, field: "social", delta: 5 },
      ],
      duration: 1,
      observableState: `站直，举起证据「${args.evidence_id}」`,
    };
  },
};

export const accuseAction: ActionDefinition = {
  tool: {
    name: "accuse",
    description: "在审判阶段：正式指控某角色是凶手。是非常严肃的动作 — 错了会被反驳。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "你指控的角色 id" },
        reasoning: { type: "string", description: "你的指控理由" },
      },
      required: ["target", "reasoning"],
    },
  },
  handler: (args, ctx): ActionResult => {
    return {
      description: `指控${args.target}是凶手：${args.reasoning}`,
      effects: [
        { type: "relationship_change", targetId: ctx.characterId, field: args.target as string, delta: -10 },
      ],
      duration: 1,
      observableState: `直直地指着${args.target}`,
    };
  },
};

export const counterAction: ActionDefinition = {
  tool: {
    name: "counter",
    description: "在审判阶段：反驳上一个论点。",
    parameters: {
      type: "object",
      properties: {
        against: { type: "string", description: "你在反驳谁的论点" },
        reasoning: { type: "string", description: "你的反驳理由" },
      },
      required: ["against", "reasoning"],
    },
  },
  handler: (args, ctx): ActionResult => {
    return {
      description: `反驳${args.against}：${args.reasoning}`,
      effects: [],
      duration: 1,
      observableState: `打断${args.against}并反驳`,
    };
  },
};

export const voteAction: ActionDefinition = {
  tool: {
    name: "vote",
    description: "在审判阶段的投票环节：投票指认一个角色为魔女。每人只能投一次。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "你投票的角色 id" },
        confidence: { type: "number", description: "你的确信度 0-1" },
      },
      required: ["target"],
    },
  },
  handler: (args, ctx): ActionResult => {
    return {
      description: `投票指认${args.target}是魔女`,
      effects: [],
      duration: 1,
      observableState: `按下了投票按钮`,
    };
  },
};

// ── Phase gating 元数据 ──
// active_phase → allowed action names

export const PHASE_TOOL_WHITELIST: Record<string, string[]> = {
  investigation: ["collect_evidence", "interview"],
  trial: ["present_evidence", "accuse", "counter", "vote"],
  // peaceful / execution: 不加任何额外工具（用基础 action 集合）
};

export const ALL_TRIAL_ACTIONS: ActionDefinition[] = [
  collectEvidenceAction,
  interviewAction,
  presentEvidenceAction,
  accuseAction,
  counterAction,
  voteAction,
];
