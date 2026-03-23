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
        hunger REAL DEFAULT 80,
        energy REAL DEFAULT 100,
        social REAL DEFAULT 60,
        happiness REAL DEFAULT 70,
        hygiene REAL DEFAULT 90,
        current_action TEXT,
        current_action_remaining INTEGER DEFAULT 0
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
    needs: { hunger: number; energy: number; social: number; happiness: number; hygiene: number };
    currentAction?: { name: string; remainingTicks: number };
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO characters (id, name, location_id, gold, hunger, energy, social, happiness, hygiene, current_action, current_action_remaining)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      c.id, c.name, c.locationId, c.gold,
      c.needs.hunger, c.needs.energy, c.needs.social, c.needs.happiness, c.needs.hygiene,
      c.currentAction?.name ?? null, c.currentAction?.remainingTicks ?? 0,
    );
  }

  loadCharacters(): Array<{
    id: string; name: string; locationId: string; gold: number;
    needs: { hunger: number; energy: number; social: number; happiness: number; hygiene: number };
    currentAction?: { name: string; remainingTicks: number };
  }> {
    const rows = this.db.prepare("SELECT * FROM characters").all() as any[];
    return rows.map((r) => ({
      id: r.id, name: r.name, locationId: r.location_id, gold: r.gold,
      needs: { hunger: r.hunger, energy: r.energy, social: r.social, happiness: r.happiness, hygiene: r.hygiene },
      currentAction: r.current_action ? { name: r.current_action, remainingTicks: r.current_action_remaining } : undefined,
    }));
  }

  // --- 记忆 ---

  saveMemory(characterId: string, tick: number, type: string, content: string, importance: number) {
    this.db.prepare(
      "INSERT INTO memories (character_id, tick, type, content, importance) VALUES (?, ?, ?, ?, ?)",
    ).run(characterId, tick, type, content, importance);
  }

  loadMemories(characterId: string, limit = 30): Array<{ tick: number; type: string; content: string; importance: number }> {
    return this.db.prepare(
      "SELECT tick, type, content, importance FROM memories WHERE character_id = ? ORDER BY tick DESC LIMIT ?",
    ).all(characterId, limit) as any[];
  }

  // --- 关系 ---

  saveRelationship(a: string, b: string, level: number, type: string, lastInteraction: number, history: string[]) {
    const [charA, charB] = a < b ? [a, b] : [b, a];
    this.db.prepare(`
      INSERT OR REPLACE INTO relationships (char_a, char_b, level, type, last_interaction, history)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(charA, charB, level, type, lastInteraction, JSON.stringify(history));
  }

  loadRelationships(): Array<{ charA: string; charB: string; level: number; type: string; lastInteraction: number; history: string[] }> {
    const rows = this.db.prepare("SELECT * FROM relationships").all() as any[];
    return rows.map((r) => ({
      charA: r.char_a, charB: r.char_b, level: r.level, type: r.type,
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

  // --- 批量操作 ---

  saveAll(params: {
    tick: number;
    weather: string;
    characters: any[];
    relationships: any[];
    memories: Array<{ characterId: string; tick: number; type: string; content: string; importance: number }>;
    events: any[];
  }) {
    const tx = this.db.transaction(() => {
      this.saveWorldState(params.tick, params.weather);
      for (const c of params.characters) this.saveCharacter(c);
      for (const r of params.relationships) {
        this.saveRelationship(r.characterA, r.characterB, r.level, r.type, r.lastInteraction, r.history);
      }
      for (const m of params.memories) {
        this.saveMemory(m.characterId, m.tick, m.type, m.content, m.importance);
      }
      for (const e of params.events) this.saveEvent(e);
    });
    tx();
  }

  close() {
    this.db.close();
  }
}
