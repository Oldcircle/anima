/**
 * Admin Routes — 管理面板用的 CRUD + 设置接口
 *
 * 设计要点：
 * - 写盘到 data/characters/*.yml / data/locations/*.yml，与 loader 兼容
 * - 修改世界状态走 simulation.enqueueMutation，runOneTick 开头 drain
 * - 删除角色默认软停用（YAML 加 disabled: true），永久删除需要 ?hard=1
 * - LLM 设置写到 data/settings.json，热更新 OpenAICompatibleProvider
 */

import type { Express, Request, Response } from "express";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import type { Simulation } from "../agent/simulation.js";
import type { CharacterCard } from "../character/types.js";
import { loadCharacterFromYAML } from "../character/loader.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { SettingsStore, maskKey, type PersistedLLMSettings } from "./settings-store.js";
import {
  validateCharacterPayload,
  validateLLMSettings,
  validateLocationPayload,
} from "../shared/validation.js";

export interface AdminRoutesConfig {
  app: Express;
  simulation: Simulation;
  charactersDir: string;
  locationsDir: string;
  settingsStore: SettingsStore;
  /** 当前正在使用的 provider 实例，用于热更新。仅支持 OpenAICompatibleProvider。 */
  provider?: OpenAICompatibleProvider;
}

export function registerAdminRoutes(config: AdminRoutesConfig): void {
  const { app, simulation, charactersDir, locationsDir, settingsStore, provider } = config;

  mkdirSync(charactersDir, { recursive: true });
  mkdirSync(locationsDir, { recursive: true });

  // ===== Characters =====

  app.get("/api/admin/characters", (_req, res) => {
    const out: Array<CharacterCard & { disabled?: boolean }> = [];
    for (const file of readdirSync(charactersDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      try {
        const fp = join(charactersDir, file);
        const meta = parseYAML(readFileSync(fp, "utf-8")) ?? {};
        const card = loadCharacterFromYAML(fp);
        out.push({ ...card, disabled: meta.disabled === true });
      } catch {}
    }
    res.json(out);
  });

  app.get("/api/admin/characters/:id", (req, res) => {
    const file = findCharacterFile(charactersDir, String(req.params.id));
    if (!file) return res.status(404).json({ error: "not found" });
    try {
      const meta = parseYAML(readFileSync(file, "utf-8")) ?? {};
      const card = loadCharacterFromYAML(file);
      res.json({ ...card, disabled: meta.disabled === true });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.post("/api/admin/characters", (req: Request, res: Response) => {
    const result = validateCharacterPayload(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const card = result.value;
    const target = join(charactersDir, `${card.id}.yml`);
    if (existsSync(target)) return res.status(409).json({ error: "id already exists" });
    writeFileSync(target, stringifyYAML(toYamlCharacter(card)), "utf-8");
    simulation.enqueueMutation(() => simulation.upsertCharacter(card));
    res.status(201).json(card);
  });

  app.put("/api/admin/characters/:id", (req: Request, res: Response) => {
    const id = String(String(req.params.id));
    const result = validateCharacterPayload(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const card = result.value;
    if (card.id !== id) return res.status(400).json({ error: "id mismatch" });
    const file = findCharacterFile(charactersDir, id) ?? join(charactersDir, `${id}.yml`);
    writeFileSync(file, stringifyYAML(toYamlCharacter(card)), "utf-8");
    simulation.enqueueMutation(() => simulation.upsertCharacter(card));
    res.json(card);
  });

  app.delete("/api/admin/characters/:id", (req: Request, res: Response) => {
    const id = String(String(req.params.id));
    const hard = req.query.hard === "1" || req.query.hard === "true";
    const file = findCharacterFile(charactersDir, id);
    if (!file) return res.status(404).json({ error: "not found" });

    if (hard) {
      unlinkSync(file);
      simulation.enqueueMutation(() => simulation.removeCharacterCompletely(id));
      return res.json({ ok: true, hard: true });
    }

    // 软停用：YAML 加 disabled: true
    const raw = readFileSync(file, "utf-8");
    const data = parseYAML(raw) ?? {};
    data.disabled = true;
    writeFileSync(file, stringifyYAML(data), "utf-8");
    simulation.enqueueMutation(() => simulation.removeCharacterCompletely(id));
    res.json({ ok: true, hard: false });
  });

  // ===== Locations =====

  app.get("/api/admin/locations", (_req, res) => {
    const out: any[] = [];
    for (const file of readdirSync(locationsDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      try {
        const data = parseYAML(readFileSync(join(locationsDir, file), "utf-8"));
        if (data?.homes && Array.isArray(data.homes)) {
          for (const h of data.homes) out.push({ ...h, disabled: h.disabled === true, _file: file });
        } else if (data?.id) {
          out.push({ ...data, disabled: data.disabled === true, _file: file });
        }
      } catch {}
    }
    res.json(out);
  });

  app.get("/api/admin/locations/:id", (req, res) => {
    const file = findLocationFile(locationsDir, String(req.params.id));
    if (!file) return res.status(404).json({ error: "not found" });
    const data = parseYAML(readFileSync(file, "utf-8"));
    if (data?.homes && Array.isArray(data.homes)) {
      const found = data.homes.find((h: any) => h.id === String(req.params.id));
      if (!found) return res.status(404).json({ error: "not found" });
      return res.json(found);
    }
    res.json(data);
  });

  app.post("/api/admin/locations", (req, res) => {
    const result = validateLocationPayload(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const loc = result.value as any;
    const target = join(locationsDir, `${loc.id}.yml`);
    if (existsSync(target)) return res.status(409).json({ error: "id already exists" });
    writeFileSync(target, stringifyYAML(loc), "utf-8");
    simulation.enqueueMutation(() => {
      simulation.world.upsertLocation(toLocation(loc));
    });
    res.status(201).json(loc);
  });

  app.put("/api/admin/locations/:id", (req, res) => {
    const id = String(req.params.id);
    const result = validateLocationPayload(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const loc = result.value as any;
    if (loc.id !== id) return res.status(400).json({ error: "id mismatch" });
    const file = findLocationFile(locationsDir, id);
    if (!file) {
      // 文件不存在则新建到独立 yml
      writeFileSync(join(locationsDir, `${id}.yml`), stringifyYAML(loc), "utf-8");
    } else {
      // residential.yml 这种 multi-home 文件需要原地更新
      const data = parseYAML(readFileSync(file, "utf-8"));
      if (data?.homes && Array.isArray(data.homes)) {
        const idx = data.homes.findIndex((h: any) => h.id === id);
        if (idx >= 0) data.homes[idx] = loc; else data.homes.push(loc);
        writeFileSync(file, stringifyYAML(data), "utf-8");
      } else {
        writeFileSync(file, stringifyYAML(loc), "utf-8");
      }
    }
    simulation.enqueueMutation(() => {
      simulation.world.upsertLocation(toLocation(loc));
    });
    res.json(loc);
  });

  app.delete("/api/admin/locations/:id", (req, res) => {
    const id = String(req.params.id);
    const hard = req.query.hard === "1" || req.query.hard === "true";
    const file = findLocationFile(locationsDir, id);
    if (!file) return res.status(404).json({ error: "not found" });

    // 拒绝删除还有人在的地点
    const present = simulation.world.getCharactersAtLocation(id);
    if (present.length > 0) {
      return res.status(409).json({ error: "location has present characters", present });
    }

    const data = parseYAML(readFileSync(file, "utf-8")) ?? {};

    if (hard) {
      // 硬删除：从 multi-home 数组移除条目，或删整个文件
      if (data?.homes && Array.isArray(data.homes)) {
        data.homes = data.homes.filter((h: any) => h.id !== id);
        writeFileSync(file, stringifyYAML(data), "utf-8");
      } else {
        unlinkSync(file);
      }
      simulation.enqueueMutation(() => simulation.world.removeLocation(id));
      return res.json({ ok: true, hard: true });
    }

    // 软停用：YAML 加 disabled: true，loader 下次启动跳过
    if (data?.homes && Array.isArray(data.homes)) {
      const idx = data.homes.findIndex((h: any) => h.id === id);
      if (idx >= 0) data.homes[idx] = { ...data.homes[idx], disabled: true };
      writeFileSync(file, stringifyYAML(data), "utf-8");
    } else {
      data.disabled = true;
      writeFileSync(file, stringifyYAML(data), "utf-8");
    }
    simulation.enqueueMutation(() => simulation.world.removeLocation(id));
    res.json({ ok: true, hard: false });
  });

  // ===== LLM Settings =====

  app.get("/api/admin/settings/llm", (_req, res) => {
    const persisted = settingsStore.load().llm;
    if (!persisted) {
      // 回落到 provider 当前配置
      if (provider) {
        const cfg = provider.getConfig();
        return res.json({
          provider: cfg.id,
          baseUrl: cfg.baseUrl,
          apiKey: maskKey(cfg.apiKey),
          model: cfg.defaultModel ?? "",
          source: "provider",
        });
      }
      return res.json({ provider: "", baseUrl: "", apiKey: "", model: "", source: "none" });
    }
    res.json({ ...persisted, apiKey: maskKey(persisted.apiKey), source: "settings.json" });
  });

  app.put("/api/admin/settings/llm", (req, res) => {
    const result = validateLLMSettings(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const next: PersistedLLMSettings = result.value;
    settingsStore.patchLLM(next);
    if (provider) {
      simulation.enqueueMutation(() => {
        provider.updateConfig({
          baseUrl: next.baseUrl,
          apiKey: next.apiKey,
          defaultModel: next.model,
        });
        simulation.setProvider(provider, next.model);
      });
    }
    res.json({ ...next, apiKey: maskKey(next.apiKey) });
  });

  app.post("/api/admin/settings/llm/test", async (req, res) => {
    const result = validateLLMSettings(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const cfg = result.value;
    const tester = new OpenAICompatibleProvider({
      id: "test",
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      defaultModel: cfg.model,
    });
    const t0 = Date.now();
    try {
      const r = await tester.chat({
        system: "You are a connectivity test. Reply with the single word: pong.",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 16,
        temperature: 0,
      }, cfg.model);
      res.json({ ok: true, latencyMs: Date.now() - t0, sample: r.content });
    } catch (e: any) {
      res.status(502).json({ ok: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) });
    }
  });
}

// ===== helpers =====

/**
 * 把前端提交的 camelCase 角色卡转换为 snake_case YAML 形态，
 * 与现有 data/characters/*.yml 风格保持一致。
 * loader 同时支持两种写法，所以这是纯文件风格层面的转换。
 */
function toYamlCharacter(card: CharacterCard & { disabled?: boolean }): Record<string, unknown> {
  const p = card.personality ?? { traits: [], interests: [], dislikes: [], speechStyle: "" };
  const personality: Record<string, unknown> = {
    traits: p.traits ?? [],
    interests: p.interests ?? [],
    dislikes: p.dislikes ?? [],
  };
  if (p.speechStyle) personality.speech_style = p.speechStyle;
  if (p.coreTraits) personality.core_traits = p.coreTraits;
  if (p.psychology) personality.psychology = p.psychology;
  if (p.stressResponse) personality.stress_response = p.stressResponse;
  if (p.speech) personality.speech = p.speech;

  const out: Record<string, unknown> = {
    id: card.id,
    name: card.name,
  };
  if (card.gender) out.gender = card.gender;
  if (card.age !== undefined) out.age = card.age;
  if (card.occupation) out.occupation = card.occupation;
  if (card.home) out.home = card.home;
  if (card.startingItems) out.starting_items = card.startingItems;
  if (card.appearance) out.appearance = card.appearance;
  out.personality = personality;
  if (card.background) out.background = card.background;
  if (card.backstory) out.backstory = card.backstory;
  if (card.preferences) out.preferences = card.preferences;
  if (card.life) {
    const l = card.life as any;
    const life: Record<string, unknown> = {
      occupation: l.occupation,
      workplace: l.workplace,
      age: l.age,
      income: l.income,
      skills: l.skills ?? {},
      aspiration: l.aspiration,
    };
    if (l.currentGoal) life.current_goal = l.currentGoal;
    if (l.currentConcern) life.current_concern = l.currentConcern;
    out.life = life;
  }
  if (card.relationships && Object.keys(card.relationships).length > 0) {
    out.relationships = card.relationships;
  }
  if (card.disabled) out.disabled = true;
  return out;
}

function findCharacterFile(dir: string, id: string): string | undefined {
  for (const ext of [".yml", ".yaml"]) {
    const p = join(dir, `${id}${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function findLocationFile(dir: string, id: string): string | undefined {
  // 先按 id.yml 找
  const direct = findCharacterFile(dir, id);
  if (direct) return direct;
  // 再扫描 multi-home 文件
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    try {
      const data = parseYAML(readFileSync(join(dir, file), "utf-8"));
      if (data?.homes && Array.isArray(data.homes) && data.homes.some((h: any) => h.id === id)) {
        return join(dir, file);
      }
    } catch {}
  }
  return undefined;
}

function toLocation(raw: any): import("../world/types.js").Location {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    summary: raw.summary,
    openHours: raw.openHours ?? null,
    presentCharacters: [],
    atmosphere: raw.atmosphere,
    tools: raw.tools,
    workerTools: raw.worker_tools ?? raw.workerTools,
    careerTrack: raw.career_track ?? raw.careerTrack,
    shop: raw.shop,
  };
}
