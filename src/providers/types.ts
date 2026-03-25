/**
 * LLM Provider Types — 模型提供商抽象层
 */

export type ModelApi = "openai-compatible" | "anthropic-messages" | "google-generative-ai" | "ollama";

export interface ModelConfig {
  id: string;
  name: string;
  api: ModelApi;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number };
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string;
  api: ModelApi;
  models: ModelConfig[];
}

/** LLM 调用的工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** LLM 返回的工具调用 */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** LLM 请求 */
export interface LLMRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  /** "stop" = 正常结束，"length" = token 用尽被截断 */
  finishReason?: "stop" | "length" | string;
}

/** 模型提供商接口 */
export interface LLMProvider {
  readonly id: string;
  chat(request: LLMRequest, modelId: string): Promise<LLMResponse>;
}

/** 模型用途 */
export type ModelRole = "decision" | "conversation" | "reflection" | "embedding";

/** 全局模型配置 */
export interface ModelLayerConfig {
  decision: { provider: string; model: string };
  conversation: { provider: string; model: string };
  reflection: { provider: string; model: string };
  embedding?: { provider: string; model: string };
}
