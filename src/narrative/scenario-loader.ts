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
import { addToInventory } from "../world/item-registry.js";
import { normalizeObjectDefs } from "../world/world-objects.js";
import type { CharacterCard } from "../character/types.js";
import type { Location } from "../world/types.js";
import { lintBeats, parseBeatsConfig, type BeatDefinition } from "./beat-engine.js";
import { OPEN_STANCE_KINDS, type OpenStanceKind } from "./narrative-state.js";

export interface ScenarioManifest {
  id: string;
  name?: string;
  description?: string;
  characters: "*" | string[];
  locations: "*" | string[];
  characterDir: string;
  locationDir: string;
  /**
   * 破线强度（下行通道解锁）：off=纯和谐(回归旧行为) / mild=允许摩擦 / strong=戏剧化冲突。
   * 未指定时由 env `ANIMA_BREAK_LEVEL` 决定（见 agent/break-config.ts），二者都无则默认 mild。
   * cozy 剧本可写 off/mild，狗血剧本可写 strong。
   */
  breakLevel?: "off" | "mild" | "strong";
  /**
   * 决策视角：first=第一人称沉浸（默认）/ third=作者预测框架（深翻+私有通道，见 break-config.ts）。
   * 未指定时由 env `ANIMA_DECISION_POV` 决定。kira-incident 等双面人格剧本写 third。
   */
  decisionPov?: "first" | "third";
  /**
   * 开局随身物品：characterId → 物品 defId 列表（如 kira-incident 把诅咒之册放进 light 口袋）。
   * 由 cli / sim 测试在 addCharacter 之后调用 applyInitialItems 应用。
   */
  initialItems?: Record<string, string[]>;
  /**
   * kira 剧本专属：真名保护名单——这些角色在镇上用的是化名/代号，诅咒之册写不动
   * （正典核心张力：L 的匿名护甲）。由 applyKiraProtections 写进 world.kira.aliasProtected。
   */
  kiraAliasProtected?: string[];
  /**
   * B2 剧本门控的导演硬事件（manifest `world_events`）：目前只有 letter_arrival 受此门控
   * （声明后①解锁该硬事件②真实边界块加"镇外来信真实存在"豁免行——否则信与物理法则打架）。
   * 由 cli / sim 测试经 setEnabledWorldEvents 应用。
   */
  worldEvents?: string[];
  /**
   * B3 罪行供给器配置（DESIGN-revival §2 B3，实现在 narrative/crime-supply.ts）。
   * manifest 写法：`crime_supply: cast` 或 `crime_supply: { mode: cast }`。
   * mode: cast=放大器（只监听 cast 真实灰行为，补被发现链）/ npc=够格之罪（静态 NPC 供罪）/ off=关闭。
   * cli / scenario-sim 经 Simulation.configureCrimeSupply 消费。
   */
  crimeSupply?: { mode: "cast" | "npc" | "off" };
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
  /**
   * seeds 扩展（DESIGN-revival §4 / §6 步骤 5）——验收剧本的预热三件套。
   * YAML 写 snake_case（mental_label / borrowed_days_ago / days_ago / open_stances），
   * loadSeeds 逐字段显式映射（visible_to 泄漏教训：绝不整体 cast）。
   */
  /** 印象疙瘩预热：observer 对 target 攒的 frictions 条目（压力图 friction 边的数据源） */
  frictions?: Array<{
    observer: string;
    target: string;
    entries: string[];
    summary?: string;
    mentalLabel?: string;
  }>;
  /**
   * 起始金币预热：默认全员 100（≈"够用"档），验收剧本要造贫富差或绝境时用。
   * 只在**新档**应用（读档跳过整个 applySeeds），不会覆盖玩家进度。
   */
  initialGold?: Array<{ character: string; gold: number }>;
  /** 欠账预热：borrowedDaysAgo 把 borrowedTick 设到过去（>宽限 2 天即制造逾期压力） */
  debts?: Array<{
    debtor: string;
    lender: string;
    amount: number;
    borrowedDaysAgo?: number;
  }>;
  /** B1 未了结立场预热：daysAgo 设过去（注意压力图只计近 3 天有活动的 active 条目） */
  openStances?: Array<{
    id?: string;
    kind: OpenStanceKind;
    holder: string;
    target: string;
    summary: string;
    evidence?: string;
    daysAgo?: number;
    witnesses?: string[];
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
    breakLevel: normalizeBreakLevel(data.break_level ?? data.breakLevel),
    decisionPov: normalizeDecisionPov(data.decision_pov ?? data.decisionPov),
    initialItems: normalizeInitialItems(data.initial_items ?? data.initialItems),
    kiraAliasProtected: normalizeAliasProtected(data.kira),
    worldEvents: normalizeWorldEvents(data.world_events ?? data.worldEvents),
    crimeSupply: normalizeCrimeSupply(data.crime_supply ?? data.crimeSupply),
  };
}

/**
 * 解析 manifest 的 crime_supply：支持 `crime_supply: cast` 简写与
 * `crime_supply: { mode: cast }` 对象两种写法；非法值返回 undefined（= 不启用）。
 */
function normalizeCrimeSupply(v: unknown): { mode: "cast" | "npc" | "off" } | undefined {
  const mode =
    typeof v === "string"
      ? v
      : v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>).mode
        : undefined;
  if (mode === "cast" || mode === "npc" || mode === "off") return { mode };
  return undefined;
}

/** 解析 manifest 的 world_events：字符串数组；结构不对/空返回 undefined。 */
function normalizeWorldEvents(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.some((i) => typeof i !== "string")) return undefined;
  return v.length > 0 ? (v as string[]) : undefined;
}

/** 解析 manifest 的 kira.alias_protected：字符串数组；结构不对返回 undefined。 */
function normalizeAliasProtected(kira: unknown): string[] | undefined {
  if (!kira || typeof kira !== "object") return undefined;
  const v = (kira as Record<string, unknown>).alias_protected ?? (kira as Record<string, unknown>).aliasProtected;
  if (!Array.isArray(v) || v.some((i) => typeof i !== "string")) return undefined;
  return v.length > 0 ? (v as string[]) : undefined;
}

/** 解析 manifest 的 break_level 字段；非法值/缺省返回 undefined（交给 env/默认）。 */
function normalizeBreakLevel(v: unknown): "off" | "mild" | "strong" | undefined {
  if (v === "off" || v === "mild" || v === "strong") return v;
  return undefined;
}

/** 解析 manifest 的 decision_pov 字段；非法值/缺省返回 undefined（交给 env/默认）。 */
function normalizeDecisionPov(v: unknown): "first" | "third" | undefined {
  if (v === "first" || v === "third") return v;
  return undefined;
}

/** 解析 manifest 的 initial_items：{characterId: [defId, ...]}；结构不对返回 undefined。 */
function normalizeInitialItems(v: unknown): Record<string, string[]> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [charId, items] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(items) || items.some((i) => typeof i !== "string")) return undefined;
    out[charId] = items as string[];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 把 manifest.initialItems 发到已加入世界的角色背包里（cli 与 sim 测试共用）。 */
export function applyInitialItems(
  world: { getCharacter(id: string): { inventory: import("../world/item-types.js").ItemInstance[] } | undefined; tick: number },
  manifest: ScenarioManifest,
): void {
  if (!manifest.initialItems) return;
  for (const [charId, defIds] of Object.entries(manifest.initialItems)) {
    const state = world.getCharacter(charId);
    if (!state) continue;
    for (const defId of defIds) {
      addToInventory(state.inventory, defId, 1, { obtainedTick: world.tick });
    }
  }
}

/** 把 manifest 的 kira 真名保护名单写进 world.kira（cli 与 sim 测试共用）。 */
export function applyKiraProtections(
  world: { kira: { aliasProtected: Set<string> } },
  manifest: ScenarioManifest,
): void {
  for (const id of manifest.kiraAliasProtected ?? []) {
    world.kira.aliasProtected.add(id);
  }
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

  // B4：beat 表达式加载期 lint（fail loud）——写错的表达式在启动时炸出来，
  // 而不是求值时静默 false（live 跑到那天才发现 = 烧掉预算）。
  try {
    lintBeats(beats, { characterIds: characters.map((c) => c.id) });
  } catch (err) {
    throw new Error(`Scenario ${scenarioId}: ${(err as Error).message}`);
  }

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
    // ── seeds 扩展（§6 步骤 5）：同样逐字段显式映射，非法条目直接丢弃（宁缺毋泄）──
    frictions: Array.isArray(parsed.frictions)
      ? (parsed.frictions as Array<Record<string, unknown>>)
          .filter(
            (f) =>
              f && typeof f === "object" &&
              typeof f.observer === "string" &&
              typeof f.target === "string" &&
              Array.isArray(f.entries),
          )
          .map((f) => ({
            observer: f.observer as string,
            target: f.target as string,
            entries: (f.entries as unknown[]).filter((e): e is string => typeof e === "string"),
            summary: typeof f.summary === "string" ? f.summary : undefined,
            mentalLabel: typeof f.mental_label === "string" ? (f.mental_label as string) : undefined,
          }))
      : undefined,
    // 起始金币（逐字段显式映射，对齐 visible_to 泄漏教训：绝不整体 cast）
    initialGold: Array.isArray(parsed.initial_gold)
      ? (parsed.initial_gold as Array<Record<string, unknown>>)
          .filter((g) => g && typeof g === "object" && typeof g.character === "string"
            && typeof g.gold === "number" && Number.isFinite(g.gold) && (g.gold as number) >= 0)
          .map((g) => ({ character: g.character as string, gold: Math.floor(g.gold as number) }))
      : undefined,
    debts: Array.isArray(parsed.debts)
      ? (parsed.debts as Array<Record<string, unknown>>)
          .filter(
            (d) =>
              d && typeof d === "object" &&
              typeof d.debtor === "string" &&
              typeof d.lender === "string" &&
              typeof d.amount === "number" && Number.isFinite(d.amount),
          )
          .map((d) => ({
            debtor: d.debtor as string,
            lender: d.lender as string,
            amount: d.amount as number,
            borrowedDaysAgo:
              typeof d.borrowed_days_ago === "number" && Number.isFinite(d.borrowed_days_ago)
                ? (d.borrowed_days_ago as number)
                : undefined,
          }))
      : undefined,
    openStances: Array.isArray(parsed.open_stances)
      ? (parsed.open_stances as Array<Record<string, unknown>>)
          .filter(
            (s) =>
              s && typeof s === "object" &&
              OPEN_STANCE_KINDS.includes(s.kind as OpenStanceKind) &&
              typeof s.holder === "string" &&
              typeof s.target === "string" &&
              typeof s.summary === "string",
          )
          .map((s) => ({
            id: typeof s.id === "string" ? (s.id as string) : undefined,
            kind: s.kind as OpenStanceKind,
            holder: s.holder as string,
            target: s.target as string,
            summary: s.summary as string,
            evidence: typeof s.evidence === "string" ? (s.evidence as string) : undefined,
            daysAgo:
              typeof s.days_ago === "number" && Number.isFinite(s.days_ago)
                ? (s.days_ago as number)
                : undefined,
            witnesses: Array.isArray(s.witnesses)
              ? (s.witnesses as unknown[]).filter((w): w is string => typeof w === "string")
              : undefined,
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
        objects: normalizeObjectDefs(c.objects),
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
