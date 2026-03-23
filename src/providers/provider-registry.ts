/**
 * Provider Registry — 管理多个 LLM 提供商
 */

import type { LLMProvider, LLMRequest, LLMResponse, ModelRole, ModelLayerConfig } from "./types.js";

export class ProviderRegistry {
  private _providers = new Map<string, LLMProvider>();
  private _layerConfig: ModelLayerConfig;

  constructor(layerConfig: ModelLayerConfig) {
    this._layerConfig = layerConfig;
  }

  register(provider: LLMProvider): void {
    this._providers.set(provider.id, provider);
  }

  getProvider(id: string): LLMProvider | undefined {
    return this._providers.get(id);
  }

  /** 根据用途获取对应的 provider 和 model */
  getForRole(role: ModelRole): { provider: LLMProvider; modelId: string } | null {
    const config = this._layerConfig[role];
    if (!config) return null;

    const provider = this._providers.get(config.provider);
    if (!provider) return null;

    return { provider, modelId: config.model };
  }

  /** 便捷方法：按用途直接调用 LLM */
  async chat(role: ModelRole, request: LLMRequest): Promise<LLMResponse> {
    const target = this.getForRole(role);
    if (!target) {
      throw new Error(`No provider configured for role: ${role}`);
    }
    return target.provider.chat(request, target.modelId);
  }
}
