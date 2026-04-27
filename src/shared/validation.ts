/**
 * Lightweight runtime validation for API payloads.
 *
 * 故意不引入 zod 等依赖。只覆盖 CRUD 接口必须的字段校验，
 * 详细字段允许 pass-through。返回 { ok: true, value } 或 { ok: false, error }。
 */

import type { CharacterCard } from "../character/types.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ID_PATTERN = /^[a-z0-9_-]{1,40}$/;

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验前端提交的角色卡。允许大部分字段 pass-through，
 * 只强制要求 id / name / home / personality 等核心字段存在且类型正确。
 */
export function validateCharacterPayload(input: unknown): ValidationResult<CharacterCard & { disabled?: boolean }> {
  if (!isObject(input)) return { ok: false, error: "payload must be an object" };

  if (!isString(input.id) || !ID_PATTERN.test(input.id)) {
    return { ok: false, error: "id must match /^[a-z0-9_-]{1,40}$/" };
  }
  if (!isString(input.name) || input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (!isString(input.home) || input.home.length === 0) {
    return { ok: false, error: "home is required" };
  }

  const personality = input.personality;
  if (!isObject(personality)) {
    return { ok: false, error: "personality must be an object" };
  }
  const traits = personality.traits ?? [];
  if (!Array.isArray(traits)) {
    return { ok: false, error: "personality.traits must be an array" };
  }

  // 不强制其他字段，但保证形状
  const card: CharacterCard & { disabled?: boolean } = {
    id: input.id,
    name: input.name,
    gender: isString(input.gender) ? input.gender : undefined,
    age: typeof input.age === "number" ? input.age : 20,
    occupation: isString(input.occupation) ? input.occupation : "",
    home: input.home,
    appearance: isString(input.appearance) ? input.appearance : undefined,
    personality: {
      traits: traits as string[],
      interests: Array.isArray(personality.interests) ? (personality.interests as string[]) : [],
      dislikes: Array.isArray(personality.dislikes) ? (personality.dislikes as string[]) : [],
      speechStyle: isString(personality.speechStyle) ? personality.speechStyle : (isString((personality as any).speech_style) ? (personality as any).speech_style : ""),
      coreTraits: isString((personality as any).coreTraits) ? (personality as any).coreTraits : (isString((personality as any).core_traits) ? (personality as any).core_traits : undefined),
      psychology: isString((personality as any).psychology) ? (personality as any).psychology : undefined,
      stressResponse: isString((personality as any).stressResponse) ? (personality as any).stressResponse : undefined,
      speech: isObject((personality as any).speech) ? ((personality as any).speech as CharacterCard["personality"]["speech"]) : undefined,
    },
    background: isString(input.background) ? input.background : "",
    backstory: Array.isArray(input.backstory) ? (input.backstory as CharacterCard["backstory"]) : undefined,
    preferences: isObject(input.preferences) ? (input.preferences as Record<string, string>) : undefined,
    life: isObject(input.life) ? (input.life as unknown as CharacterCard["life"]) : undefined,
    startingItems: Array.isArray(input.startingItems) ? (input.startingItems as string[]) : undefined,
    relationships: isObject(input.relationships) ? (input.relationships as CharacterCard["relationships"]) : {},
    disabled: input.disabled === true,
  };

  return { ok: true, value: card };
}

/**
 * 校验地点 payload。地点结构相对简单。
 */
export function validateLocationPayload(input: unknown): ValidationResult<Record<string, unknown>> {
  if (!isObject(input)) return { ok: false, error: "payload must be an object" };
  if (!isString(input.id) || !ID_PATTERN.test(input.id)) {
    return { ok: false, error: "id must match /^[a-z0-9_-]{1,40}$/" };
  }
  if (!isString(input.name) || input.name.length === 0) {
    return { ok: false, error: "name is required" };
  }
  if (!isString(input.type)) {
    return { ok: false, error: "type is required" };
  }
  const ALLOWED_TYPES = ["residential", "commercial", "public", "nature", "special"];
  if (!ALLOWED_TYPES.includes(input.type)) {
    return { ok: false, error: `type must be one of ${ALLOWED_TYPES.join(", ")}` };
  }
  // 把 disabled 标准化成 boolean，再透传剩余字段
  const normalized = { ...input, disabled: input.disabled === true };
  return { ok: true, value: normalized };
}

export interface LLMSettingsPayload {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: "enabled" | "disabled" | "auto";
}

export function validateLLMSettings(input: unknown): ValidationResult<LLMSettingsPayload> {
  if (!isObject(input)) return { ok: false, error: "payload must be an object" };
  if (!isString(input.provider) || input.provider.length === 0) {
    return { ok: false, error: "provider is required" };
  }
  if (!isString(input.baseUrl) || !/^https?:\/\//.test(input.baseUrl)) {
    return { ok: false, error: "baseUrl must be a valid http(s) URL" };
  }
  if (!isString(input.apiKey)) {
    return { ok: false, error: "apiKey is required (use empty string to clear)" };
  }
  if (!isString(input.model) || input.model.length === 0) {
    return { ok: false, error: "model is required" };
  }
  let thinking: "enabled" | "disabled" | "auto" | undefined;
  if (input.thinking !== undefined) {
    if (input.thinking !== "enabled" && input.thinking !== "disabled" && input.thinking !== "auto") {
      return { ok: false, error: "thinking must be one of: enabled, disabled, auto" };
    }
    thinking = input.thinking;
  }
  return {
    ok: true,
    value: {
      provider: input.provider,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      apiKey: input.apiKey,
      model: input.model,
      temperature: typeof input.temperature === "number" ? input.temperature : undefined,
      maxTokens: typeof input.maxTokens === "number" ? input.maxTokens : undefined,
      thinking,
    },
  };
}
