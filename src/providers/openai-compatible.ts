/**
 * OpenAI Compatible Provider — 支持 DeepSeek / OpenAI / Together AI 等
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "./types.js";
import { promptTrace } from "./prompt-trace.js";
import { resolveCheapKinds, tierFor } from "./model-router.js";

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
  /**
   * 便宜档（省钱主杠杆，见 model-router.ts）：印象/观察/抽取这类结构化小任务甩到这里。
   * 只给 model = 同一家换便宜模型；连 baseUrl/apiKey 一起给 = 换一家便宜 provider。
   * 不配则整层不启用，所有调用逐字节回退到单模型行为。
   */
  cheap?: { model: string; baseUrl?: string; apiKey?: string };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private _baseUrl: string;
  private _apiKey: string;
  private _defaultModel: string;
  private _thinking: ThinkingMode;
  private _cheap?: { model: string; baseUrl?: string; apiKey?: string };
  private _cheapKinds = resolveCheapKinds();
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
    this._cheap = config.cheap;
    if (this._cheap) {
      console.log(`💰 [分层模型] 便宜档 ${this._cheap.model}${this._cheap.baseUrl ? ` @ ${this._cheap.baseUrl}` : ""}｜承接: ${[...this._cheapKinds].join(",")}`);
    }
  }

  /** 热更新 provider 配置（前端 Settings 页面用）。 */
  updateConfig(patch: Partial<OpenAICompatibleConfig>): void {
    if (patch.baseUrl !== undefined) this._baseUrl = patch.baseUrl.replace(/\/+$/, "");
    if (patch.apiKey !== undefined) this._apiKey = patch.apiKey;
    if (patch.defaultModel !== undefined) this._defaultModel = patch.defaultModel;
    if (patch.thinking !== undefined) this._thinking = patch.thinking;
    // 分层模型热更新：cheap 传 undefined 不动，传 null 语义由调用方用 {model:""} 表达（空 model = 关掉整层）
    if (patch.cheap !== undefined) this._cheap = patch.cheap.model ? patch.cheap : undefined;
  }

  /** 当前生效的配置（apiKey 不脱敏，调用方负责脱敏）。 */
  getConfig(): OpenAICompatibleConfig {
    return {
      cheap: this._cheap,
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

  /** 网络级重试：fetch failed / 429 / 5xx 退避重试（1.5s → 4s 两次），4xx 业务错误不重试直接返回。 */
  private async _fetchWithRetry(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
    const delays = [1500, 4000];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, init);
        if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
          console.warn(`[LLM retry] HTTP ${res.status}，${delays[attempt]! / 1000}s 后重试（${attempt + 1}/${delays.length}）`);
          await new Promise((r) => setTimeout(r, delays[attempt]!));
          continue;
        }
        return res;
      } catch (err) {
        if (attempt >= delays.length) throw err;
        console.warn(`[LLM retry] 网络错误（${(err as Error)?.message ?? String(err)}），${delays[attempt]! / 1000}s 后重试（${attempt + 1}/${delays.length}）`);
        await new Promise((r) => setTimeout(r, delays[attempt]!));
      }
    }
  }

  /**
   * 提示词追踪包装层（观察者通道）：计时 + 成功/失败两路都写进 promptTrace 环形缓冲，
   * 供管理面板「提示词」页按 kind/角色回看完整输入输出与前缀断点。
   * 记录失败绝不影响调用本身（record 内部吞异常）。
   */
  async chat(request: LLMRequest, modelId?: string): Promise<LLMResponse> {
    // 分层路由（省钱）：这一处解析，覆盖所有调用点。
    // 每类固定走一档，不随 tick 变 → `(kind, 角色, 模型)` 的缓存前缀仍然稳定。
    const useCheap = this._cheap && tierFor(request.kind, this._cheapKinds) === "cheap";
    const model = useCheap ? this._cheap!.model : (modelId ?? this._defaultModel);
    const started = Date.now();
    try {
      const response = await this._chat(request, model, false, useCheap ? this._cheap : undefined);
      promptTrace.record({ request, model, durationMs: Date.now() - started, response });
      return response;
    } catch (err) {
      promptTrace.record({
        request, model, durationMs: Date.now() - started,
        error: (err as Error)?.message?.slice(0, 200) ?? "unknown",
      });
      throw err;
    }
  }

  private async _chat(
    request: LLMRequest,
    modelId?: string,
    _isEmptyRetry = false,
    override?: { baseUrl?: string; apiKey?: string },
  ): Promise<LLMResponse> {
    const model = modelId ?? this._defaultModel;
    // 便宜档换了家：endpoint 与 key 一并切过去（只给 model 就还走本家）
    const baseUrl = override?.baseUrl?.replace(/\/+$/, "") ?? this._baseUrl;
    const apiKey = override?.apiKey ?? this._apiKey;

    // request.system 为空时不前置空 system 消息——酒馆模式把 system 块内联在 request.messages 里，
    // system 字段留空，避免污染前缀。legacy 路径 system 恒非空，行为不变。
    const messages: Array<Record<string, unknown>> = request.system
      ? [{ role: "system", content: request.system }, ...request.messages]
      : [...request.messages];

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
    // 采样参数（酒馆预设照抄）；思考模式下 DeepSeek 忽略，故 enabled 时全不发。
    const applySampling = () => {
      body.temperature = request.temperature ?? 0.7;
      if (request.topP !== undefined) body.top_p = request.topP;
      if (request.topK !== undefined && request.topK > 0) body.top_k = request.topK;
      if (request.frequencyPenalty !== undefined) body.frequency_penalty = request.frequencyPenalty;
      if (request.presencePenalty !== undefined) body.presence_penalty = request.presencePenalty;
    };
    if (thinking === "enabled") {
      body.thinking = { type: "enabled" };
    } else if (thinking === "disabled") {
      body.thinking = { type: "disabled" };
      applySampling();
    } else {
      applySampling();
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
    const endpoint = /\/v\d+$/.test(baseUrl)
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
    // 网络级重试：7 天长跑实测 undici 闪断（fetch failed）+ 偶发 429/5xx 会白丢 tick
    // （kira 7 天 r2 损失 1950 次调用）。网络错误与可重试状态码退避重试 2 次；4xx 业务错误不重试。
    const response = await this._fetchWithRetry(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
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

    // 空返回重试：DeepSeek 偶发返回 200 但 content 空且无工具调用（非长度截断）——重试一次，
    // 避免真机跑对话时"角色一句话不说、这个 tick 白费"。_isEmptyRetry 锁死递归深度为 1。
    if (content.trim() === "" && toolCalls.length === 0 && choice.finish_reason !== "length" && !_isEmptyRetry) {
      console.warn(`[LLM retry] 空返回（200 但 content 空 + 无工具调用），重试一次`);
      return this._chat(request, modelId, true, override);
    }

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
