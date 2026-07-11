/**
 * SillyTavern（酒馆）Chat Completion 预设的类型模型。
 *
 * 一份预设 = 有序可开关的 prompt block 列表（`prompts` + `prompt_order`）+ 顶层采样参数。
 * 这是 Anima 提示词工程一比一复刻酒馆的地基（PLAN-tavern.md，S0）。
 * 字段名对齐酒馆导出的 JSON（如 reference/tavern-presets/TGbreak-v3.1.1.json）。
 */

export type PromptRole = "system" | "user" | "assistant";

/** 酒馆的 8 个 marker（占位符）——渲染时替换成角色卡/对话的动态内容 */
export const TAVERN_MARKERS = [
  "worldInfoBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
] as const;
export type TavernMarker = (typeof TAVERN_MARKERS)[number];

/**
 * 一条预设 prompt block，对应 ST prompt manager 里的一行。
 * marker=true 的块没有 content（内容在渲染期由 marker 名决定）。
 */
export interface PresetPrompt {
  identifier: string;
  name: string;
  role: PromptRole;
  /** marker 块无此字段 */
  content?: string;
  system_prompt?: boolean;
  marker: boolean;
  /** prompts[] 里的默认开关；真实开关状态以 prompt_order 为准 */
  enabled?: boolean;
  forbid_overrides?: boolean;
  /** 0/null = 按序位摆放；1 = 插入对话历史指定 depth（本期暂不处理，见 PLAN S1） */
  injection_position?: number | null;
  injection_depth?: number;
  injection_order?: number;
}

/** prompt_order 里的一项：某 block 在该角色下的开关状态 */
export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

/** 每个角色一组开关/排序状态；character_id 100001 = ST 的全局默认 */
export interface PromptOrderGroup {
  character_id: number;
  order: PromptOrderEntry[];
}

/** 从预设顶层抽出的采样参数，照抄进 provider */
export interface PresetSampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  /** openai_max_context */
  max_context?: number;
  /** openai_max_tokens */
  max_tokens?: number;
  seed?: number;
  stream?: boolean;
}

/** 规范化后的酒馆预设 */
export interface TavernPreset {
  /** 预设名（取自文件名，酒馆导出 JSON 不含名字） */
  name: string;
  prompts: PresetPrompt[];
  prompt_order: PromptOrderGroup[];
  sampling: PresetSampling;
  /** 原始 JSON 备查（S4 开关页回写时需要保真） */
  raw: Record<string, unknown>;
}

export function isMarkerIdentifier(id: string): id is TavernMarker {
  return (TAVERN_MARKERS as readonly string[]).includes(id);
}
