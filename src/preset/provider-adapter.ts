/**
 * ST 原生消息 + 预设采样参数 → Anima provider 请求件。
 * PLAN-tavern.md S2（provider 适配层）。
 *
 * 关键：system 字段留空，全部消息（含 system 块）内联进 messages，忠实保留酒馆的块顺序
 * （破限/post-history 在对话历史之后）。采样参数从预设照抄。
 */
import type { LLMMessage } from "../providers/types.js";
import type { TavernPreset } from "./types.js";
import type { TavernMessage } from "./assembler.js";
import { postProcessPrompt, type PostProcessingType, type PostProcessNames } from "./post-processing.js";

export interface TavernRequestParts {
  /** 恒为 ""——system 内联在 messages 里 */
  system: string;
  messages: LLMMessage[];
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
}

export interface AdapterOptions {
  /** 上限 max_tokens（预设常给 65535，决策调用不需要那么多；决策场景传如 4096） */
  maxTokensCap?: number;
  /** 提示词后处理（对齐 ST custom_prompt_post_processing）；DeepSeek 常用 none/merge/semi */
  postProcessing?: PostProcessingType;
  /** 后处理名字前缀（charName/userName） */
  names?: PostProcessNames;
}

export function toRequestParts(
  messages: TavernMessage[],
  preset: TavernPreset,
  opts: AdapterOptions = {},
): TavernRequestParts {
  const s = preset.sampling;
  let maxTokens = s.max_tokens;
  if (maxTokens !== undefined && opts.maxTokensCap !== undefined) {
    maxTokens = Math.min(maxTokens, opts.maxTokensCap);
  }
  const processed = opts.postProcessing
    ? postProcessPrompt(messages, opts.postProcessing, opts.names ?? {})
    : messages;
  return {
    system: "",
    messages: processed.map((m) => ({ role: m.role, content: m.content }) as LLMMessage),
    temperature: s.temperature,
    topP: s.top_p,
    topK: s.top_k,
    frequencyPenalty: s.frequency_penalty,
    presencePenalty: s.presence_penalty,
    maxTokens,
  };
}
