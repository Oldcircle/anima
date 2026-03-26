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
        recent_actions_json TEXT
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
    `);
  }

  // --- 世界状态 ---

  saveWorldState(tick: number, weather: string) {
    const upsert = this.db.prepare("INSERT OR REPLACE INTO world_state (key, value) VALUES (?, ?)");
    upsert.run("tick", String(tick));
    upsert.run("weather", weather);
  }

  loadWorldState(): { tick: number; weather: string } | null {
    const get = this.db.prepare("SELECT key, value FROM world_state");
    const rows = get.all() as Array<{ key: string; value: string }>;
    if (rows.length === 0) return null;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { tick: parseInt(map.tick ?? "0", 10), weather: map.weather ?? "sunny" };
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
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO characters (id, name, location_id, gold, needs_json, current_action, current_action_remaining, life_json, moodlets_json, inventory_json, recent_actions_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id, c.name, c.locationId, c.gold,
      JSON.stringify(c.needs),
      c.currentAction?.name ?? null, c.currentAction?.remainingTicks ?? 0,
      c.life ? JSON.stringify(c.life) : null,
      c.moodlets && c.moodlets.length > 0 ? JSON.stringify(c.moodlets) : null,
      c.inventory && c.inventory.length > 0 ? JSON.stringify(c.inventory) : null,
      c.recentActions && c.recentActions.length > 0 ? JSON.stringify(c.recentActions) : null,
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

  saveRelationship(a: string, b: string, level: number, type: string, lastInteraction: number, history: string[], bond?: string) {
    const [charA, charB] = a < b ? [a, b] : [b, a];
    this.db.prepare(`
      INSERT OR REPLACE INTO relationships (char_a, char_b, level, type, bond, last_interaction, history)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(charA, charB, level, type, bond ?? null, lastInteraction, JSON.stringify(history));
  }

  loadRelationships(): Array<{ charA: string; charB: string; level: number; type: string; bond?: string; lastInteraction: number; history: string[] }> {
    const rows = this.db.prepare("SELECT * FROM relationships").all() as any[];
    return rows.map((r) => ({
      charA: r.char_a, charB: r.char_b, level: r.level, type: r.type,
      bond: r.bond ?? undefined,
      lastInteraction: r.last_interaction, history: JSON.parse(r.history),
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
    mentalLabel: string; unresolved: string[]; lastUpdated: number;
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO impressions (observer_id, target_id, summary, observations, mental_label, unresolved, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(observerId, imp.characterId, imp.summary, JSON.stringify(imp.observations), imp.mentalLabel, JSON.stringify(imp.unresolved), imp.lastUpdated);
  }

  loadImpressions(): Array<{ observerId: string; impression: { characterId: string; summary: string; observations: string[]; mentalLabel: string; unresolved: string[]; lastUpdated: number } }> {
    const rows = this.db.prepare("SELECT * FROM impressions").all() as any[];
    return rows.map((r) => ({
      observerId: r.observer_id,
      impression: {
        characterId: r.target_id,
        summary: r.summary,
        observations: JSON.parse(r.observations),
        mentalLabel: r.mental_label,
        unresolved: JSON.parse(r.unresolved),
        lastUpdated: r.last_updated,
      },
    }));
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

  // --- 批量操作 ---

  saveAll(params: {
    tick: number;
    weather: string;
    characters: any[];
    relationships: any[];
    memories: Array<{ characterId: string; tick: number; type: string; content: string; importance: number }>;
    events: any[];
    impressions?: Array<{ observerId: string; impression: { characterId: string; summary: string; observations: string[]; mentalLabel: string; unresolved: string[]; lastUpdated: number } }>;
    longTermMemories?: Array<{ characterId: string; tick: number; type: string; content: string; importance: number; relatedCharacterId?: string }>;
  }) {
    const tx = this.db.transaction(() => {
      this.saveWorldState(params.tick, params.weather);
      for (const c of params.characters) this.saveCharacter(c);
      for (const r of params.relationships) {
        this.saveRelationship(r.characterA, r.characterB, r.level, r.type, r.lastInteraction, r.history, r.bond);
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
    });
    tx();
  }

  close() {
    this.db.close();
  }
}
