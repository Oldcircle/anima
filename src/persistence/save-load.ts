/**
 * Save/Load — 存档和读档
 */

import { AnimaDB } from "./database.js";
import type { Simulation } from "../agent/simulation.js";
import type { World } from "../world/world.js";
import type { EventBus, WorldEvent } from "../core/event-bus.js";
import type { Weather } from "../world/types.js";

/** 保存当前世界状态到 SQLite */
export function saveGame(sim: Simulation, dbPath: string): void {
  const db = new AnimaDB(dbPath);

  try {
    const characters = sim.world.getAllCharacters().map((c) => ({
      id: c.id,
      name: c.name,
      locationId: c.locationId,
      gold: c.gold,
      needs: c.needs,
      currentAction: c.currentAction,
    }));

    const relationships = sim.relationships.getAll();

    // 收集所有角色的记忆
    const memories: Array<{ characterId: string; tick: number; type: string; content: string; importance: number }> = [];
    for (const c of characters) {
      const charMemories = sim.memory.getRecent(c.id, 30);
      for (const m of charMemories) {
        memories.push({ characterId: c.id, ...m });
      }
    }

    const events = sim.eventBus.history.slice(-200).map((e) => ({
      id: e.id,
      tick: e.tick,
      type: e.type,
      actorId: e.actorId,
      targetId: e.targetId,
      locationId: e.locationId,
      description: e.description,
      witnesses: e.witnesses,
    }));

    db.saveAll({
      tick: sim.world.tick,
      weather: sim.world.weather,
      characters,
      relationships,
      memories,
      events,
    });

    console.log(`💾 已保存到 ${dbPath} (tick=${sim.world.tick}, ${characters.length} 角色, ${memories.length} 记忆, ${relationships.length} 关系)`);
  } finally {
    db.close();
  }
}

/** 从 SQLite 恢复世界状态 */
export function loadGame(sim: Simulation, dbPath: string): boolean {
  let db: AnimaDB;
  try {
    db = new AnimaDB(dbPath);
  } catch {
    return false;
  }

  try {
    const worldState = db.loadWorldState();
    if (!worldState) return false;

    // 恢复世界状态
    sim.world.setTick(worldState.tick);
    sim.world.setWeather(worldState.weather as Weather);

    // 恢复角色状态
    const savedChars = db.loadCharacters();
    for (const sc of savedChars) {
      const char = sim.world.getCharacter(sc.id);
      if (char) {
        sim.world.moveCharacter(sc.id, sc.locationId);
        char.gold = sc.gold;
        char.needs = { ...sc.needs };
        char.currentAction = sc.currentAction;
      }
    }

    // 恢复关系
    const savedRels = db.loadRelationships();
    for (const r of savedRels) {
      sim.relationships.set(r.charA, r.charB, r.level, r.type as any);
    }

    // 恢复记忆
    for (const sc of savedChars) {
      const memories = db.loadMemories(sc.id, 30);
      for (const m of memories.reverse()) {
        sim.memory.add(sc.id, m);
      }
    }

    console.log(`📂 已读取存档 (tick=${worldState.tick}, ${savedChars.length} 角色, ${savedRels.length} 关系)`);
    return true;
  } finally {
    db.close();
  }
}
