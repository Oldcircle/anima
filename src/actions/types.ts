/**
 * Action Types — 行为工具定义
 */

import type { ToolDefinition } from "../providers/types.js";

export interface ActionResult {
  description: string;
  effects: ActionEffect[];
  /** 行为占用的 tick 数（默认 1） */
  duration?: number;
  /** 行为是否成功执行（默认 true）。false 表示前置条件不满足 */
  success?: boolean;
  /** 别人能直接看见的行为痕迹 */
  observableState?: string;
}

export interface ActionEffect {
  type: "need_change" | "relationship_change" | "location_change" | "mood_change" | "inbox_message" | "skill_up" | "moodlet";
  targetId: string;
  field?: string;
  delta?: number;
  value?: string;
  /** For inbox_message: sender name */
  fromName?: string;
  /** For inbox_message: message content */
  message?: string;
  /** For skill_up: skill name */
  skill?: string;
  /** For moodlet */
  emotion?: string;
  intensity?: number;
  reason?: string;
  durationTicks?: number;
}

export interface ActionContext {
  characterId: string;
  locationId: string;
  locationType: string;
  tick: number;
  nearbyCharacters: string[];
  gold: number;
  needs: Record<string, number>;
  /** 当前工作地点对应的主技能名（用于 skill_up） */
  workSkill?: string;
}

/** 工具调用参数 → 行为结果 */
export type ActionHandler = (
  args: Record<string, unknown>,
  ctx: ActionContext,
) => ActionResult;

export interface ActionDefinition {
  tool: ToolDefinition;
  handler: ActionHandler;
}
