/**
 * Database — SQLite 持久化层
 *
 * 存储：世界状态、角色状态、记忆、关系、事件历史
 */

import Database from "better-sqlite3";
import { join } from "node:path";

export class AnimaDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._initSchema();
    this._migrate();
  }

  private _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location_id TEXT NOT NULL,
        gold INTEGER DEFAULT 100,
        needs_json TEXT NOT NULL DEFAULT '{}',
        current_action TEXT,
        current_action_remaining INTEGER DEFAULT 0,
        life_json TEXT,
        moodlets_json TEXT,
        inventory_json TEXT,
        recent_actions_json TEXT,
        today_plan_json TEXT,
        current_intent_json TEXT,
        inbox_json TEXT
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER DEFAULT 5,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_memories_char ON memories(character_id, tick);

      CREATE TABLE IF NOT EXISTS relationships (
        char_a TEXT NOT NULL,
        char_b TEXT NOT NULL,
        level INTEGER DEFAULT 0,
        type TEXT DEFAULT 'stranger',
        bond TEXT,
        last_interaction INTEGER DEFAULT 0,
        history TEXT DEFAULT '[]',
        grudge_json TEXT,
        PRIMARY KEY (char_a, char_b)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        tick INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        target_id TEXT,
        location_id TEXT NOT NULL,
        description TEXT NOT NULL,
        witnesses TEXT DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_events_tick ON events(tick);

      CREATE TABLE IF NOT EXISTS impressions (
        observer_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        observations TEXT DEFAULT '[]',
        mental_label TEXT DEFAULT '',
        unresolved TEXT DEFAULT '[]',
        frictions TEXT,
        unresolved_counts TEXT,
        last_updated INTEGER DEFAULT 0,
        PRIMARY KEY (observer_id, target_id)
      );

      CREATE TABLE IF NOT EXISTS long_term_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        character_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER DEFAULT 7,
        related_character_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_ltm_char ON long_term_memories(character_id);
      CREATE INDEX IF NOT EXISTS idx_ltm_related ON long_term_memories(related_character_id);

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        proposer_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        at_tick INTEGER NOT NULL,
        activity TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        missed_by TEXT,
        created_tick INTEGER NOT NULL
      );
    `);
  }

  /**
   * 轻量迁移：给已存在的老库补上后加的列。
   * `CREATE TABLE IF NOT EXISTS` 不会改动已存在表的结构，所以历史存档需要 ALTER 补列。
   */
  private _migrate() {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    const addColumn = (name: string, decl: string) => {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE characters ADD COLUMN ${name} ${decl}`);
      }
    };
    addColumn("today_plan_json", "TEXT");
    addColumn("current_intent_json", "TEXT");
    addColumn("inbox_json", "TEXT");
    addColumn("last_reflection_json", "TEXT");
    addColumn("garden_json", "TEXT");
    addColumn("debts_json", "TEXT");

    const relCols = new Set(
      (this.db.prepare("PRAGMA table_info(relationships)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!relCols.has("grudge_json")) {
      this.db.exec("ALTER TABLE relationships ADD COLUMN grudge_json TEXT");
    }

    // 疙瘩持久化（DESIGN-revival A 前置）：老档 impressions 表补 frictions 列——
    // 不修则读档后压力图的 friction 边全部塌 0
    const impCols = new Set(
      (this.db.prepare("PRAGMA table_info(impressions)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!impCols.has("frictions")) {
      this.db.exec("ALTER TABLE impressions ADD COLUMN frictions TEXT");
    }
    // C4 疑惑槽节流：老档 impressions 表补 unresolved_counts 列（未解次数 Record）
    if (!impCols.has("unresolved_counts")) {
      this.db.exec("ALTER TABLE impressions ADD COLUMN unresolved_counts TEXT");
    }

    // 爽约派生计数：老档 appointments 表补 missed_by 列（单方爽约的缺席者）
    const apptCols = new Set(
      (this.db.prepare("PRAGMA table_info(appointments)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!apptCols.has("missed_by")) {
      this.db.exec("ALTER TABLE appointments ADD COLUMN missed_by TEXT");
    }
  }

  // --- 世界状态 ---

  saveWorldState(tick: number, weather: string, narrativeJson?: string, scenarioId?: string, locationStockJson?: string, locationBansJson?: string, worldObjectsJson?: string, chronicleJson?: string) {
    const upsert = this.db.prepare("INSERT OR REPLACE INTO world_state (key, value) VALUES (?, ?)");
    upsert.run("tick", String(tick));
    upsert.run("weather", weather);
    if (narrativeJson !== undefined) {
      upsert.run("narrative_state", narrativeJson);
    }
    if (scenarioId !== undefined) {
      upsert.run("scenario_id", scenarioId);
    }
    if (locationStockJson !== undefined) {
      upsert.run("location_stock", locationStockJson);
    }
    if (locationBansJson !== undefined) {
      upsert.run("location_bans", locationBansJson);
    }
    if (chronicleJson !== undefined) {
      upsert.run("chronicle", chronicleJson);
    }
    if (worldObjectsJson !== undefined) {
      upsert.run("world_objects", worldObjectsJson);
    }
  }

  loadWorldState(): { tick: number; weather: string; narrativeJson?: string; scenarioId?: string; locationStockJson?: string; locationBansJson?: string; worldObjectsJson?: string; chronicleJson?: string } | null {
    const get = this.db.prepare("SELECT key, value FROM world_state");
    const rows = get.all() as Array<{ key: string; value: string }>;
    if (rows.length === 0) return null;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      tick: parseInt(map.tick ?? "0", 10),
      weather: map.weather ?? "sunny",
      narrativeJson: map.narrative_state,
      scenarioId: map.scenario_id,
      locationStockJson: map.location_stock,
      locationBansJson: map.location_bans,
      worldObjectsJson: map.world_objects,
      chronicleJson: map.chronicle,
    };
  }

  // --- 角色状态 ---

  saveCharacter(c: {
    id: string; name: string; locationId: string; gold: number;
    needs: Record<string, number>;
    currentAction?: { name: string; remainingTicks: number };
    life?: import("../character/types.js").LifeState;
    moodlets?: import("../world/types.js").Moodlet[];
    inventory?: import("../world/item-types.js").ItemInstance[];
    recentActions?: { actionId: string; tick: number }[];
    todayPlan?: { day: number; items: string[] };
    currentIntent?: import("../world/types.js").CharacterIntent;
    inbox?: import("../world/types.js").InboxMessage[];
    lastReflection?: { day: number; insights: string[]; mood: string; wish?: string; concern?: string };
    garden?: import("../world/types.js").GardenPlot;
    debts?: import("../world/types.js").Debt[];
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO characters (id, name, location_id, gold, needs_json, current_action, current_action_remaining, life_json, moodlets_json, inventory_json, recent_actions_json, today_plan_json, current_intent_json, inbox_json, last_reflection_json, garden_json, debts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id, c.name, c.locationId, c.gold,
      JSON.stringify(c.needs),
      c.currentAction?.name ?? null, c.currentAction?.remainingTicks ?? 0,
      c.life ? JSON.stringify(c.life) : null,
      c.moodlets && c.moodlets.length > 0 ? JSON.stringify(c.moodlets) : null,
      c.inventory && c.inventory.length > 0 ? JSON.stringify(c.inventory) : null,
      c.recentActions && c.recentActions.length > 0 ? JSON.stringify(c.recentActions) : null,
      c.todayPlan ? JSON.stringify(c.todayPlan) : null,
      c.currentIntent ? JSON.stringify(c.currentIntent) : null,
      c.inbox && c.inbox.length > 0 ? JSON.stringify(c.inbox) : null,
      c.lastReflection ? JSON.stringify(c.lastReflection) : null,
      c.garden ? JSON.stringify(c.garden) : null,
      c.debts && c.debts.length > 0 ? JSON.stringify(c.debts) : null,
    );
  }

  loadCharacters(): Array<{
    id: string; name: string; locationId: string; gold: number;
    needs: Record<string, number>;
    currentAction?: { name: string; remainingTicks: number };
    life?: import("../character/types.js").LifeState;
    moodlets?: import("../world/types.js").Moodlet[];
    inventory?: import("../world/item-types.js").ItemInstance[];
    recentActions?: { actionId: string; tick: number }[];
    todayPlan?: { day: number; items: string[] };
    currentIntent?: import("../world/types.js").CharacterIntent;
    inbox?: import("../world/types.js").InboxMessage[];
    lastReflection?: { day: number; insights: string[]; mood: string; wish?: string; concern?: string };
    garden?: import("../world/types.js").GardenPlot;
    debts?: import("../world/types.js").Debt[];
  }> {
    const rows = this.db.prepare("SELECT * FROM characters").all() as any[];
    return rows.map((r) => ({
      id: r.id, name: r.name, locationId: r.location_id, gold: r.gold,
      needs: r.needs_json ? JSON.parse(r.needs_json) : {},
      currentAction: r.current_action ? { name: r.current_action, remainingTicks: r.current_action_remaining } : undefined,
      life: r.life_json ? JSON.parse(r.life_json) : undefined,
      moodlets: r.moodlets_json ? JSON.parse(r.moodlets_json) : undefined,
      inventory: r.inventory_json ? JSON.parse(r.inventory_json) : undefined,
      recentActions: r.recent_actions_json ? JSON.parse(r.recent_actions_json) : undefined,
      todayPlan: r.today_plan_json ? JSON.parse(r.today_plan_json) : undefined,
      currentIntent: r.current_intent_json ? JSON.parse(r.current_intent_json) : undefined,
      inbox: r.inbox_json ? JSON.parse(r.inbox_json) : undefined,
      lastReflection: r.last_reflection_json ? JSON.parse(r.last_reflection_json) : undefined,
      garden: r.garden_json ? JSON.parse(r.garden_json) : undefined,
      debts: r.debts_json ? JSON.parse(r.debts_json) : undefined,
    }));
  }

  // --- 记忆 ---

  saveMemory(characterId: string, tick: number, type: string, content: string, importance: number) {
    this.db.prepare(
      "INSERT INTO memories (character_id, tick, type, content, importance) VALUES (?, ?, ?, ?, ?)",
    ).run(characterId, tick, type, content, importance);
  }

  loadMemories(characterId: string, limit = 30): Array<{ tick: number; type: "event" | "conversation" | "thought" | "observation"; content: string; importance: number }> {
    return this.db.prepare(
      "SELECT tick, type, content, importance FROM memories WHERE character_id = ? ORDER BY tick DESC LIMIT ?",
    ).all(characterId, limit) as any[];
  }

  // --- 关系 ---

  saveRelationship(a: string, b: string, level: number, type: string, lastInteraction: number, history: string[], bond?: string, grudge?: { reason: string; instigatorId: string; sinceTick: number }) {
    const [charA, charB] = a < b ? [a, b] : [b, a];
    this.db.prepare(`
      INSERT OR REPLACE INTO relationships (char_a, char_b, level, type, bond, last_interaction, history, grudge_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(charA, charB, level, type, bond ?? null, lastInteraction, JSON.stringify(history), grudge ? JSON.stringify(grudge) : null);
  }

  loadRelationships(): Array<{ charA: string; charB: string; level: number; type: string; bond?: string; lastInteraction: number; history: string[]; grudge?: { reason: string; instigatorId: string; sinceTick: number } }> {
    const rows = this.db.prepare("SELECT * FROM relationships").all() as any[];
    return rows.map((r) => ({
      charA: r.char_a, charB: r.char_b, level: r.level, type: r.type,
      bond: r.bond ?? undefined,
      lastInteraction: r.last_interaction, history: JSON.parse(r.history),
      grudge: r.grudge_json ? JSON.parse(r.grudge_json) : undefined,
    }));
  }

  // --- 事件 ---

  saveEvent(e: { id: string; tick: number; type: string; actorId: string; targetId?: string; locationId: string; description: string; witnesses: string[] }) {
    this.db.prepare(
      "INSERT OR IGNORE INTO events (id, tick, type, actor_id, target_id, location_id, description, witnesses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(e.id, e.tick, e.type, e.actorId, e.targetId ?? null, e.locationId, e.description, JSON.stringify(e.witnesses));
  }

  loadRecentEvents(limit = 50): any[] {
    return this.db.prepare("SELECT * FROM events ORDER BY tick DESC LIMIT ?").all(limit) as any[];
  }

  // --- 印象 ---

  saveImpression(observerId: string, imp: {
    characterId: string; summary: string; observations: string[];
    mentalLabel: string; unresolved: string[]; frictions?: string[];
    unresolvedCounts?: Record<string, number>; lastUpdated: number;
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO impressions (observer_id, target_id, summary, observations, mental_label, unresolved, frictions, unresolved_counts, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observerId, imp.characterId, imp.summary, JSON.stringify(imp.observations), imp.mentalLabel,
      JSON.stringify(imp.unresolved),
      imp.frictions && imp.frictions.length > 0 ? JSON.stringify(imp.frictions) : null,
      imp.unresolvedCounts && Object.keys(imp.unresolvedCounts).length > 0 ? JSON.stringify(imp.unresolvedCounts) : null,
      imp.lastUpdated,
    );
  }

  loadImpressions(): Array<{ observerId: string; impression: { characterId: string; summary: string; observations: string[]; mentalLabel: string; unresolved: string[]; frictions?: string[]; unresolvedCounts?: Record<string, number>; lastUpdated: number } }> {
    const rows = this.db.prepare("SELECT * FROM impressions").all() as any[];
    return rows.map((r) => {
      const unresolved: string[] = JSON.parse(r.unresolved);
      // C4 旧档 normalize：无计数（老档/老行）的疑惑视为已成熟（=2）——
      // 老档的疑惑本来就在被注入，读档后不该突然消失（行为保持）；新字段一律 Record。
      let counts: Record<string, number> | undefined;
      if (r.unresolved_counts) {
        try { counts = JSON.parse(r.unresolved_counts); } catch { counts = undefined; }
      }
      const unresolvedCounts = unresolved.length > 0
        ? Object.fromEntries(unresolved.map((q) => [q, counts?.[q] ?? 2]))
        : undefined;
      return {
        observerId: r.observer_id,
        impression: {
          characterId: r.target_id,
          summary: r.summary,
          observations: JSON.parse(r.observations),
          mentalLabel: r.mental_label,
          unresolved,
          frictions: r.frictions ? JSON.parse(r.frictions) : undefined,
          unresolvedCounts,
          lastUpdated: r.last_updated,
        },
      };
    });
  }

  // --- 长期记忆 ---

  saveLongTermMemory(characterId: string, tick: number, type: string, content: string, importance: number, relatedCharacterId?: string) {
    this.db.prepare(
      "INSERT INTO long_term_memories (character_id, tick, type, content, importance, related_character_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(characterId, tick, type, content, importance, relatedCharacterId ?? null);
  }

  /** 按角色 ID 检索长期记忆（最近的在前） */
  loadLongTermMemories(characterId: string, limit = 20): Array<{ tick: number; type: string; content: string; importance: number; relatedCharacterId?: string }> {
    return this.db.prepare(
      "SELECT tick, type, content, importance, related_character_id as relatedCharacterId FROM long_term_memories WHERE character_id = ? ORDER BY importance DESC, tick DESC LIMIT ?",
    ).all(characterId, limit) as any[];
  }

  /** 按相关角色检索长期记忆（用于见面时回忆） */
  loadMemoriesAbout(characterId: string, aboutCharacterId: string, limit = 5): Array<{ tick: number; type: string; content: string; importance: number }> {
    return this.db.prepare(
      "SELECT tick, type, content, importance FROM long_term_memories WHERE character_id = ? AND related_character_id = ? ORDER BY tick DESC LIMIT ?",
    ).all(characterId, aboutCharacterId, limit) as any[];
  }

  /** 关键词搜索长期记忆 */
  searchLongTermMemories(characterId: string, keyword: string, limit = 5): Array<{ tick: number; type: string; content: string; importance: number }> {
    return this.db.prepare(
      "SELECT tick, type, content, importance FROM long_term_memories WHERE character_id = ? AND content LIKE ? ORDER BY importance DESC, tick DESC LIMIT ?",
    ).all(characterId, `%${keyword}%`, limit) as any[];
  }

  // --- 约定 ---

  saveAppointment(a: import("../world/types.js").Appointment) {
    this.db.prepare(`
      INSERT OR REPLACE INTO appointments (id, proposer_id, target_id, location_id, at_tick, activity, status, missed_by, created_tick)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(a.id, a.proposerId, a.targetId, a.locationId, a.atTick, a.activity ?? null, a.status, a.missedBy ?? null, a.createdTick);
  }

  loadAppointments(): import("../world/types.js").Appointment[] {
    const rows = this.db.prepare("SELECT * FROM appointments").all() as any[];
    return rows.map((r) => ({
      id: r.id,
      proposerId: r.proposer_id,
      targetId: r.target_id,
      locationId: r.location_id,
      atTick: r.at_tick,
      activity: r.activity ?? undefined,
      status: r.status,
      missedBy: r.missed_by ?? undefined,
      createdTick: r.created_tick,
    }));
  }

  // --- 批量操作 ---

  saveAll(params: {
    tick: number;
    weather: string;
    characters: any[];
    relationships: any[];
    memories: Array<{ characterId: string; tick: number; type: string; content: string; importance: number }>;
    events: any[];
    impressions?: Array<{ observerId: string; impression: { characterId: string; summary: string; observations: string[]; mentalLabel: string; unresolved: string[]; frictions?: string[]; unresolvedCounts?: Record<string, number>; lastUpdated: number } }>;
    longTermMemories?: Array<{ characterId: string; tick: number; type: string; content: string; importance: number; relatedCharacterId?: string }>;
    appointments?: import("../world/types.js").Appointment[];
    narrativeJson?: string;
    scenarioId?: string;
    locationStockJson?: string;
    locationBansJson?: string;
    worldObjectsJson?: string;
    chronicleJson?: string;
  }) {
    const tx = this.db.transaction(() => {
      this.saveWorldState(params.tick, params.weather, params.narrativeJson, params.scenarioId, params.locationStockJson, params.locationBansJson, params.worldObjectsJson, params.chronicleJson);
      // 全量覆盖：memories/long_term_memories/appointments 都是完整快照，
      // 裸 INSERT 会让每次自动存档重复追加一遍（实测重复率 74%/86%，读档后角色变复读机）
      this.db.exec("DELETE FROM appointments");
      this.db.exec("DELETE FROM memories");
      this.db.exec("DELETE FROM long_term_memories");
      for (const c of params.characters) this.saveCharacter(c);
      for (const r of params.relationships) {
        this.saveRelationship(r.characterA, r.characterB, r.level, r.type, r.lastInteraction, r.history, r.bond, r.grudge);
      }
      for (const m of params.memories) {
        this.saveMemory(m.characterId, m.tick, m.type, m.content, m.importance);
      }
      for (const e of params.events) this.saveEvent(e);
      for (const imp of params.impressions ?? []) {
        this.saveImpression(imp.observerId, imp.impression);
      }
      for (const ltm of params.longTermMemories ?? []) {
        this.saveLongTermMemory(ltm.characterId, ltm.tick, ltm.type, ltm.content, ltm.importance, ltm.relatedCharacterId);
      }
      for (const a of params.appointments ?? []) {
        this.saveAppointment(a);
      }
    });
    tx();
  }

  close() {
    this.db.close();
  }
}
