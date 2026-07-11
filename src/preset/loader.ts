/**
 * 酒馆预设加载器：把 ST 导出的 Chat Completion 预设 JSON 规范化成 TavernPreset。
 * PLAN-tavern.md S0。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type {
  TavernPreset,
  PresetPrompt,
  PromptOrderGroup,
  PresetSampling,
} from "./types.js";

/** 顶层键 → PresetSampling 字段的映射（酒馆命名 → 我们的命名） */
function extractSampling(raw: Record<string, unknown>): PresetSampling {
  const num = (k: string): number | undefined =>
    typeof raw[k] === "number" ? (raw[k] as number) : undefined;
  return {
    temperature: num("temperature"),
    top_p: num("top_p"),
    top_k: num("top_k"),
    top_a: num("top_a"),
    min_p: num("min_p"),
    frequency_penalty: num("frequency_penalty"),
    presence_penalty: num("presence_penalty"),
    repetition_penalty: num("repetition_penalty"),
    max_context: num("openai_max_context"),
    max_tokens: num("openai_max_tokens"),
    seed: num("seed"),
    stream: typeof raw.stream_openai === "boolean" ? (raw.stream_openai as boolean) : undefined,
  };
}

/** 解析一个 JSON 字符串成 TavernPreset（name 需外部传入，因为 ST 导出不含名字） */
export function parseTavernPreset(json: string, name: string): TavernPreset {
  const raw = JSON.parse(json) as Record<string, unknown>;

  if (!Array.isArray(raw.prompts)) {
    throw new Error(`预设「${name}」缺少 prompts 数组，不是有效的酒馆 Chat Completion 预设`);
  }
  if (!Array.isArray(raw.prompt_order)) {
    throw new Error(`预设「${name}」缺少 prompt_order 数组`);
  }

  const prompts = raw.prompts as PresetPrompt[];
  const prompt_order = raw.prompt_order as PromptOrderGroup[];

  // 完整性自检：prompt_order 引用的 identifier 必须都在 prompts 里
  const known = new Set(prompts.map((p) => p.identifier));
  for (const group of prompt_order) {
    for (const entry of group.order) {
      if (!known.has(entry.identifier)) {
        throw new Error(
          `预设「${name}」的 prompt_order(char ${group.character_id}) 引用了未知 block: ${entry.identifier}`,
        );
      }
    }
  }

  return { name, prompts, prompt_order, sampling: extractSampling(raw), raw };
}

/** 从文件加载预设；预设名默认取文件名（去扩展名） */
export function loadTavernPreset(filePath: string, name?: string): TavernPreset {
  const json = readFileSync(filePath, "utf-8");
  const derivedName = name ?? basename(filePath).replace(/\.json$/i, "");
  return parseTavernPreset(json, derivedName);
}

/**
 * 取某角色的开关/排序状态；找不到就回退到全局默认（character_id 100001），
 * 再找不到用第一组。
 */
export function orderForCharacter(preset: TavernPreset, characterId = 100001): PromptOrderGroup {
  return (
    preset.prompt_order.find((g) => g.character_id === characterId) ??
    preset.prompt_order.find((g) => g.character_id === 100001) ??
    preset.prompt_order[0]
  );
}
