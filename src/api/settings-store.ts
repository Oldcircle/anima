/**
 * Settings Store — data/settings.json 持久化
 *
 * 优先级：settings.json > .env。前端通过 /api/settings/llm 修改。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PersistedLLMSettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface PersistedSettings {
  llm?: PersistedLLMSettings;
}

export class SettingsStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedSettings {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8"));
    } catch (e) {
      console.error("[settings] failed to parse, using empty:", e);
      return {};
    }
  }

  save(settings: PersistedSettings): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  patchLLM(patch: PersistedLLMSettings): PersistedSettings {
    const current = this.load();
    const next: PersistedSettings = { ...current, llm: patch };
    this.save(next);
    return next;
  }
}

/** 把 apiKey 脱敏成只显示末 4 位。 */
export function maskKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 4) return "****";
  return "*".repeat(Math.max(0, key.length - 4)) + key.slice(-4);
}
