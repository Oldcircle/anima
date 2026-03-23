/**
 * Action Types — 行为工具定义
 */

import type { ToolDefinition } from "../providers/types.js";

export interface ActionResult {
  description: string;
  effects: ActionEffect[];
  /** 行为占用的 tick 数（默认 1） */
  duration?: number;
}

export interface ActionEffect {
  type: "need_change" | "relationship_change" | "location_change" | "mood_change" | "inbox_message";
  targetId: string;
  field?: string;
  delta?: number;
  value?: string;
  /** For inbox_message: sender name */
  fromName?: string;
  /** For inbox_message: message content */
  message?: string;
}

export interface ActionContext {
  characterId: string;
  locationId: string;
  tick: number;
  nearbyCharacters: string[];
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
