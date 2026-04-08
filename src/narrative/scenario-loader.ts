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

  return { manifest, characters, locations };
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
