/**
 * OpenAI Compatible Provider — 支持 DeepSeek / OpenAI / Together AI 等
 */

import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "./types.js";

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
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("No response from LLM");

    // token 截断检测（finish_reason=length 或使用率 >90%）
    if (choice.finish_reason === "length" || (data.usage && data.usage.completion_tokens / (request.maxTokens ?? 2048) > 0.9)) {
      console.warn(`[LLM] ⚠️ 可能截断: out=${data.usage?.completion_tokens ?? "?"}/${request.maxTokens ?? 2048} finish=${choice.finish_reason}`);
    }

    const content = choice.message.content ?? "";
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      content,
      toolCalls,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
      finishReason: choice.finish_reason ?? undefined,
    };
  }
}
