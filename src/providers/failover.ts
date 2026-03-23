/**
 * Failover Provider — 主模型失败时自动降级
 */

import type { LLMProvider, LLMRequest, LLMResponse } from "./types.js";

export class FailoverProvider implements LLMProvider {
  readonly id: string;
  private _providers: Array<{ provider: LLMProvider; modelId: string }>;

  constructor(id: string, providers: Array<{ provider: LLMProvider; modelId: string }>) {
    this.id = id;
    this._providers = providers;
  }

  async chat(request: LLMRequest, modelId?: string): Promise<LLMResponse> {
    let lastError: Error | null = null;

    for (const { provider, modelId: fallbackModelId } of this._providers) {
      try {
        return await provider.chat(request, modelId ?? fallbackModelId);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`⚠️ Provider ${provider.id} failed: ${lastError.message}, trying next...`);
        // 第一次失败后，后续尝试不传原始 modelId（用 fallback 的）
        modelId = undefined;
      }
    }

    throw lastError ?? new Error("All providers failed");
  }
}
