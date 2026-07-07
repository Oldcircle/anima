/**
 * OpenAI Compatible Provider — 支持 DeepSeek / OpenAI / Together AI 等
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "./types.js";

/** ANIMA_PROMPT_DUMP=1 时把每次请求体落盘到 logs/prompt-dumps/<kind>/<tag>-<seq>.json，供相邻请求 diff 定位前缀断点 */
const PROMPT_DUMP_DIR = process.env.ANIMA_PROMPT_DUMP
  ? join(process.cwd(), "logs", "prompt-dumps")
  : undefined;

/**
 * 思考模式开关。仅对支持 thinking 的模型有效（如 deepseek-v4-*）。
 * - "disabled"：关闭思考链（默认，省 token & 延迟低）
 * - "enabled"：开启；此时 DeepSeek 会忽略 temperature/top_p/presence_penalty/frequency_penalty
 * - "auto"：模型名包含 "deepseek-v4" 时默认关闭，其他模型不发送 thinking 参数
 */
export type ThinkingMode = "enabled" | "disabled" | "auto";

export interface OpenAICompatibleConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  /** 思考模式控制；默认 "auto" */
  thinking?: ThinkingMode;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private _baseUrl: string;
  private _apiKey: string;
  private _defaultModel: string;
  private _thinking: ThinkingMode;
  /** 前缀缓存累计统计（DeepSeek 自动缓存），每 25 次调用输出一行摘要；按 kind 分桶定位谁在拖命中率 */
  private _cacheStats = { calls: 0, promptTokens: 0, hitTokens: 0 };
  private _cacheStatsByKind = new Map<string, { calls: number; promptTokens: number; hitTokens: number }>();
  private _dumpSeq = 0;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this._baseUrl = config.baseUrl.replace(/\/+$/, "");
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? "deepseek-v4-flash";
    this._thinking = config.thinking ?? "auto";
  }

  /** 热更新 provider 配置（前端 Settings 页面用）。 */
  updateConfig(patch: Partial<OpenAICompatibleConfig>): void {
    if (patch.baseUrl !== undefined) this._baseUrl = patch.baseUrl.replace(/\/+$/, "");
    if (patch.apiKey !== undefined) this._apiKey = patch.apiKey;
    if (patch.defaultModel !== undefined) this._defaultModel = patch.defaultModel;
    if (patch.thinking !== undefined) this._thinking = patch.thinking;
  }

  /** 当前生效的配置（apiKey 不脱敏，调用方负责脱敏）。 */
  getConfig(): OpenAICompatibleConfig {
    return {
      id: this.id,
      baseUrl: this._baseUrl,
      apiKey: this._apiKey,
      defaultModel: this._defaultModel,
      thinking: this._thinking,
    };
  }

  /** 解析 thinking 参数。"auto" 时只对 deepseek-v4-* 默认 disabled，其他模型不发送。 */
  private resolveThinking(model: string): "enabled" | "disabled" | null {
    if (this._thinking === "enabled") return "enabled";
    if (this._thinking === "disabled") return "disabled";
    // auto: 仅 deepseek-v4-* 默认关闭，其他模型不发参数
    return /deepseek-v4/i.test(model) ? "disabled" : null;
  }

  async chat(request: LLMRequest, modelId?: string): Promise<LLMResponse> {
    const model = modelId ?? this._defaultModel;

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: request.system },
      ...request.messages,
    ];

    // Prefill: 预填充助手回复开头，引导模型进入"已接受创作任务"状态
    if (request.prefill) {
      messages.push({ role: "assistant", content: request.prefill });
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 2048,
    };

    // 思考模式：deepseek-v4-* 默认 disabled。enabled 时 temperature 等会被服务端忽略，
    // 为避免无效字段污染 body，开启思考时主动不发 temperature。
    const thinking = this.resolveThinking(model);
    if (thinking === "enabled") {
      body.thinking = { type: "enabled" };
    } else if (thinking === "disabled") {
      body.thinking = { type: "disabled" };
      body.temperature = request.temperature ?? 0.7;
    } else {
      body.temperature = request.temperature ?? 0.7;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    if (PROMPT_DUMP_DIR) {
      try {
        const dir = join(PROMPT_DUMP_DIR, request.kind ?? "unknown");
        mkdirSync(dir, { recursive: true });
        const seq = String(++this._dumpSeq).padStart(5, "0");
        writeFileSync(join(dir, `${request.tag ?? "any"}-${seq}.json`), JSON.stringify(body, null, 2));
      } catch { /* dump 失败不影响调用 */ }
    }

    // 兼容两种 baseUrl 写法：带 /v1 后缀（OpenAI / Together / OpenRouter 等）和不带（DeepSeek 默认）
    const endpoint = /\/v\d+$/.test(this._baseUrl)
      ? `${this._baseUrl}/chat/completions`
      : `${this._baseUrl}/v1/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("No response from LLM");

    // token 截断检测（finish_reason=length 或使用率 >90%）
    if (choice.finish_reason === "length" || (data.usage && data.usage.completion_tokens / (request.maxTokens ?? 2048) > 0.9)) {
      console.warn(`[LLM] ⚠️ 可能截断: out=${data.usage?.completion_tokens ?? "?"}/${request.maxTokens ?? 2048} finish=${choice.finish_reason}`);
    }

    // 前缀缓存命中统计：定位"动态工具/易变 prompt 导致缓存失效"这类问题的量化依据
    if (data.usage) {
      this._cacheStats.calls++;
      this._cacheStats.promptTokens += data.usage.prompt_tokens;
      this._cacheStats.hitTokens += data.usage.prompt_cache_hit_tokens ?? 0;
      const kind = request.kind ?? "unknown";
      let byKind = this._cacheStatsByKind.get(kind);
      if (!byKind) {
        byKind = { calls: 0, promptTokens: 0, hitTokens: 0 };
        this._cacheStatsByKind.set(kind, byKind);
      }
      byKind.calls++;
      byKind.promptTokens += data.usage.prompt_tokens;
      byKind.hitTokens += data.usage.prompt_cache_hit_tokens ?? 0;
      if (this._cacheStats.calls % 25 === 0) {
        const rate = (s: { promptTokens: number; hitTokens: number }) =>
          s.promptTokens > 0 ? ((s.hitTokens / s.promptTokens) * 100).toFixed(1) : "0.0";
        const breakdown = [...this._cacheStatsByKind.entries()]
          .sort((a, b) => b[1].promptTokens - a[1].promptTokens)
          .map(([k, s]) => `${k} ${rate(s)}%×${s.calls}`)
          .join(" | ");
        console.log(`[LLM cache] 累计 ${this._cacheStats.calls} 次调用，前缀缓存命中率 ${rate(this._cacheStats)}%（${this._cacheStats.hitTokens}/${this._cacheStats.promptTokens} tokens）｜ ${breakdown}`);
      }
    }

    const content = choice.message.content ?? "";
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      content,
      toolCalls,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            cacheHitTokens: data.usage.prompt_cache_hit_tokens,
            cacheMissTokens: data.usage.prompt_cache_miss_tokens,
          }
        : undefined,
      finishReason: choice.finish_reason ?? undefined,
    };
  }
}
