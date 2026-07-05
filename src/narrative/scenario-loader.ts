/**
 * Scenario Loader — 加载剧本包
 *
 * 一个 Scenario Pack = data/scenarios/<id>/ 目录，定义启用哪些角色 + 哪些地点。
 * 后续 phase 还会加 lore.yml / seeds.yml / beats.yml，本期只做 characters + locations。
 *
 * Manifest schema:
 *   id: string                              # 必填，剧本 id
 *   name?: string                           # 显示名
 *   description?: string                    # 一句话描述
 *   characters: "*" | string[]              # "*" = 加载所有非 disabled；数组 = 按 id 显式加载（忽略 disabled flag）
 *   locations: "*" | string[]               # 同上
 *   character_dir?: string                  # 默认 data/characters
 *   location_dir?: string                   # 默认 data/locations
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";
import { loadCharacterFromYAML, loadCharactersFromDir } from "../character/loader.js";
import { loadLocationsFromDir } from "../world/location-loader.js";
import type { CharacterCard } from "../character/types.js";
import type { Location } from "../world/types.js";
import { parseBeatsConfig, type BeatDefinition } from "./beat-engine.js";

export interface ScenarioManifest {
  id: string;
  name?: string;
  description?: string;
  characters: "*" | string[];
  locations: "*" | string[];
  characterDir: string;
  locationDir: string;
}

export interface LoadedScenario {
  manifest: ScenarioManifest;
  characters: CharacterCard[];
  locations: Location[];
  /** beats.yml 内容（如有） */
  beats: BeatDefinition[];
  /** seeds.yml 内容（如有） — 初始 narrative 状态 */
  seeds?: ScenarioSeeds;
}

export interface ScenarioSeeds {
  activePhase?: string;
  unresolvedEvents?: Array<{
    id: string;
    summary: string;
    involved?: string[];
    visibleTo?: string[] | "*";
  }>;
  characterRelationships?: Array<{
    a: string;
    b: string;
    level?: number;
    type?: string;
    bond?: string;
  }>;
  initialRumors?: Array<{
    content: string;
    sourceCharId?: string | null;
    spreadTo?: string[];
  }>;
}

const DEFAULT_CHARACTER_DIR = "data/characters";
const DEFAULT_LOCATION_DIR = "data/locations";

export function loadScenarioManifest(
  scenarioId: string,
  scenariosRoot: string,
): ScenarioManifest {
  const dir = join(scenariosRoot, scenarioId);
  const manifestPath = join(dir, "manifest.yml");
  if (!existsSync(manifestPath)) {
    throw new Error(`Scenario not found: ${scenarioId} (expected ${manifestPath})`);
  }

  const raw = readFileSync(manifestPath, "utf-8");
  const data = parseYAML(raw) ?? {};

  if (!data.id) {
    throw new Error(`Scenario ${scenarioId}: manifest.yml missing required field 'id'`);
  }
  if (data.id !== scenarioId) {
    throw new Error(
      `Scenario ${scenarioId}: manifest id '${data.id}' does not match directory name`,
    );
  }

  const characters = normalizeSelector(data.characters, "characters", scenarioId);
  const locations = normalizeSelector(data.locations, "locations", scenarioId);

  return {
    id: data.id,
    name: data.name,
    description: data.description,
    characters,
    locations,
    characterDir: data.character_dir ?? DEFAULT_CHARACTER_DIR,
    locationDir: data.location_dir ?? DEFAULT_LOCATION_DIR,
  };
}

function normalizeSelector(
  value: unknown,
  field: string,
  scenarioId: string,
): "*" | string[] {
  if (value === "*" || value === undefined || value === null) {
    return "*";
  }
  if (Array.isArray(value)) {
    if (value.some((v) => typeof v !== "string")) {
      throw new Error(`Scenario ${scenarioId}: ${field} must be "*" or string[]`);
    }
    return value as string[];
  }
  throw new Error(`Scenario ${scenarioId}: ${field} must be "*" or string[], got ${typeof value}`);
}

export function loadScenario(
  scenarioId: string,
  options?: { scenariosRoot?: string; projectRoot?: string },
): LoadedScenario {
  const projectRoot = options?.projectRoot ?? process.cwd();
  const scenariosRoot = options?.scenariosRoot ?? join(projectRoot, "data", "scenarios");

  const manifest = loadScenarioManifest(scenarioId, scenariosRoot);

  const characterDirAbs = join(projectRoot, manifest.characterDir);
  const locationDirAbs = join(projectRoot, manifest.locationDir);

  const characters = loadCharactersBySelector(characterDirAbs, manifest.characters);
  const locations = loadLocationsBySelector(locationDirAbs, manifest.locations);
  const beats = loadBeats(scenariosRoot, scenarioId);
  const seeds = loadSeeds(scenariosRoot, scenarioId);

  // P5: 校验角色 workplace 是否在当前 scenario 的 locations 列表中
  const locationIds = new Set(locations.map((l) => l.id));
  for (const char of characters) {
    const wp = char.life?.workplace;
    if (wp && !locationIds.has(wp)) {
      console.warn(
        `⚠️ [scenario ${scenarioId}] 角色 ${char.id} 的 workplace "${wp}" 不在当前 scenario 的地点列表中，prompt 将不会注入具体工作地点`,
      );
    }
  }

  return { manifest, characters, locations, beats, seeds };
}

function loadBeats(scenariosRoot: string, scenarioId: string): BeatDefinition[] {
  const path = join(scenariosRoot, scenarioId, "beats.yml");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYAML(raw);
  return parseBeatsConfig(parsed);
}

function loadSeeds(scenariosRoot: string, scenarioId: string): ScenarioSeeds | undefined {
  const path = join(scenariosRoot, scenarioId, "seeds.yml");
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYAML(raw) as Record<string, unknown> | null;
  if (!parsed) return undefined;
  // ⚠️ 不能把 YAML 的 snake_case 对象直接 cast 成 camelCase 类型：
  // 此前 visible_to 从未被读取 → applySeeds 的 `visibleTo ?? "*"` 兜底把**所有剧本秘密
  // 泄漏给所有角色**（生产存档实测：配置 [asuka] 的私生子秘密落库成 "*"，
  // 每个演员从第 1 tick 就读过全部剧本——戏剧反讽全毁）。逐字段显式映射。
  return {
    activePhase: typeof parsed.active_phase === "string" ? parsed.active_phase : undefined,
    unresolvedEvents: Array.isArray(parsed.unresolved_events)
      ? (parsed.unresolved_events as Array<Record<string, unknown>>).map((e) => ({
          id: String(e.id ?? ""),
          summary: String(e.summary ?? ""),
          involved: Array.isArray(e.involved) ? (e.involved as string[]) : undefined,
          visibleTo: e.visible_to === "*"
            ? ("*" as const)
            : Array.isArray(e.visible_to)
              ? (e.visible_to as string[])
              : undefined,
        }))
      : undefined,
    characterRelationships: Array.isArray(parsed.character_relationships) ? (parsed.character_relationships as ScenarioSeeds["characterRelationships"]) : undefined,
    initialRumors: Array.isArray(parsed.initial_rumors)
      ? (parsed.initial_rumors as Array<Record<string, unknown>>).map((r) => ({
          content: String(r.content ?? ""),
          sourceCharId: typeof r.source_char_id === "string" ? r.source_char_id : (typeof (r as any).sourceCharId === "string" ? (r as any).sourceCharId : undefined),
          spreadTo: Array.isArray(r.spread_to) ? (r.spread_to as string[]) : (Array.isArray((r as any).spreadTo) ? ((r as any).spreadTo as string[]) : undefined),
        }))
      : undefined,
  };
}

function loadCharactersBySelector(
  characterDir: string,
  selector: "*" | string[],
): CharacterCard[] {
  if (selector === "*") {
    // 通配符：保持原 loader 行为（含 disabled 过滤）
    return loadCharactersFromDir(characterDir);
  }
  // 显式列表：按 id 查找文件，忽略 disabled flag（剧本声明 = 强制启用）
  const files = readdirSync(characterDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const byId = new Map<string, string>();
  for (const file of files) {
    const data = parseYAML(readFileSync(join(characterDir, file), "utf-8"));
    if (data?.id) byId.set(data.id, join(characterDir, file));
  }
  const out: CharacterCard[] = [];
  const missing: string[] = [];
  for (const id of selector) {
    const path = byId.get(id);
    if (!path) {
      missing.push(id);
      continue;
    }
    out.push(loadCharacterFromYAML(path));
  }
  if (missing.length > 0) {
    throw new Error(`Scenario references unknown character ids: ${missing.join(", ")}`);
  }
  return out;
}

function loadLocationsBySelector(
  locationDir: string,
  selector: "*" | string[],
): Location[] {
  if (selector === "*") {
    return loadLocationsFromDir(locationDir);
  }
  // 显式列表：忽略 disabled flag，scenario 声明 = 强制启用
  // 自己实现一个 raw 加载器，跳过过滤逻辑
  const wanted = new Set(selector);
  const out: Location[] = [];
  const seen = new Set<string>();

  const files = readdirSync(locationDir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );
  for (const file of files) {
    const data = parseYAML(readFileSync(join(locationDir, file), "utf-8"));
    const candidates: any[] = [];
    if (data?.homes && Array.isArray(data.homes)) {
      candidates.push(...data.homes);
    } else if (data?.id) {
      candidates.push(data);
    }
    for (const c of candidates) {
      if (!c?.id || !wanted.has(c.id)) continue;
      out.push({
        id: c.id,
        name: c.name,
        type: c.type,
        summary: c.summary,
        openHours: c.openHours ?? null,
        presentCharacters: [],
        atmosphere: c.atmosphere,
        tools: c.tools,
        workerTools: c.worker_tools,
        careerTrack: c.career_track,
        shop: c.shop,
      } as Location);
      seen.add(c.id);
    }
  }

  const missing = selector.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`Scenario references unknown location ids: ${missing.join(", ")}`);
  }
  // 保持 selector 顺序
  out.sort((a, b) => selector.indexOf(a.id) - selector.indexOf(b.id));
  return out;
}
