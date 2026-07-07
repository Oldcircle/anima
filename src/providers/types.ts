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
  /** OpenAI tool_calls[i].id；可选，仅当下一轮要把 tool_result 喂回时需要 */
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** LLM 请求消息（OpenAI 多轮 tool-calling 协议）。 */
export type LLMMessage =
  | { role: "user" | "assistant"; content: string }
  | {
      /** assistant 发起工具调用：content 可空，tool_calls 必填。 */
      role: "assistant";
      content?: string;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      /** 工具执行结果：必须紧跟在对应 tool_calls 之后，tool_call_id 对齐。 */
      role: "tool";
      tool_call_id: string;
      content: string;
    };

/** LLM 请求 */
export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** 预填充助手回复开头（prefill），引导模型进入特定状态 */
  prefill?: string;
  /** 调用类型（decision/conversation/reflection/...），用于前缀缓存命中率分桶统计 */
  kind?: string;
  /** 调试标签（如角色 id），ANIMA_PROMPT_DUMP 落盘时按 kind/tag 分目录，供相邻请求 diff */
  tag?: string;
}

/** LLM 响应 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** DeepSeek 前缀缓存命中的输入 token（prompt_cache_hit_tokens），命中部分按 0.1 倍计费 */
    cacheHitTokens?: number;
    /** DeepSeek 前缀缓存未命中的输入 token（prompt_cache_miss_tokens） */
    cacheMissTokens?: number;
  };
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
