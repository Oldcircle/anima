/**
 * LLM Provider 目录 — 参考 ~/Opensource/projects/ai/fable/src/data/providers.ts
 *
 * Anima 当前后端只有 OpenAICompatibleProvider，所以只列 openai 兼容的家族。
 * Anthropic / Gemini 原生 API 需要后端再加适配器，先不放出来避免误导。
 *
 * 用户在 Settings 页选 provider → 自动填 endpoint + 模型下拉。
 * 可以手动改 endpoint / model（自定义模型），表单本身不强校验。
 */

export const LLM_PROVIDERS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    defaultEndpoint: "https://api.deepseek.com",
    description: "性价比高，中文能力强",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultEndpoint: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    defaultEndpoint: "https://openrouter.ai/api/v1",
    description: "聚合多家模型",
    models: [
      "anthropic/claude-sonnet-4",
      "anthropic/claude-haiku-4",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "meta-llama/llama-4-maverick",
      "deepseek/deepseek-chat-v3-0324",
    ],
  },
  {
    id: "groq",
    name: "Groq",
    defaultEndpoint: "https://api.groq.com/openai/v1",
    description: "极速推理",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemma2-9b-it"],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    defaultEndpoint: "https://api.mistral.ai/v1",
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    defaultEndpoint: "https://api.x.ai/v1",
    models: ["grok-3", "grok-3-mini"],
  },
  {
    id: "together",
    name: "Together AI",
    defaultEndpoint: "https://api.together.xyz/v1",
    description: "开源模型推理平台",
    models: [
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    defaultEndpoint: "https://api.fireworks.ai/inference/v1",
    models: [
      "accounts/fireworks/models/llama4-maverick-instruct-basic",
      "accounts/fireworks/models/qwen2p5-72b-instruct",
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot / Kimi",
    defaultEndpoint: "https://api.moonshot.cn/v1",
    description: "超长上下文，中文优化",
    models: ["moonshot-v1-128k", "moonshot-v1-32k"],
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    defaultEndpoint: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-32B-Instruct", "deepseek-ai/DeepSeek-V3"],
  },
  {
    id: "ollama",
    name: "Ollama (本地)",
    defaultEndpoint: "http://localhost:11434/v1",
    description: "本地模型，无需 API Key",
    models: ["qwen2.5:32b", "qwen2.5:14b", "llama3.1:8b", "gemma2:9b"],
  },
  {
    id: "custom",
    name: "自定义 (OpenAI 兼容)",
    defaultEndpoint: "",
    description: "任何 OpenAI 兼容端点",
    models: [],
  },
];

export function getProvider(id) {
  return LLM_PROVIDERS.find((p) => p.id === id);
}
