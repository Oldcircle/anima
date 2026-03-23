/**
 * OpenAI Compatible Provider — 支持 DeepSeek / OpenAI / Together AI 等
 */

import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "./types.js";

export interface OpenAICompatibleConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private _baseUrl: string;
  private _apiKey: string;
  private _defaultModel: string;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this._baseUrl = config.baseUrl.replace(/\/+$/, "");
    this._apiKey = config.apiKey;
    this._defaultModel = config.defaultModel ?? "deepseek-chat";
  }

  async chat(request: LLMRequest, modelId?: string): Promise<LLMResponse> {
    const model = modelId ?? this._defaultModel;

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: request.system },
      ...request.messages,
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 2048,
      temperature: request.temperature ?? 0.7,
    };

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

    const response = await fetch(`${this._baseUrl}/v1/chat/completions`, {
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
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    if (!choice) throw new Error("No response from LLM");

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
    };
  }
}
