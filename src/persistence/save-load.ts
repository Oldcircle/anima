/**
 * Save/Load — 存档和读档
 */

import { AnimaDB } from "./database.js";
import type { Simulation } from "../agent/simulation.js";
import type { World } from "../world/world.js";
import type { EventBus, WorldEvent } from "../core/event-bus.js";
import type { Weather } from "../world/types.js";

/** 保存当前世界状态到 SQLite */
export function saveGame(sim: Simulation, dbPath: string, scenarioId?: string): void {
  const db = new AnimaDB(dbPath);

  try {
    const characters = sim.world.getAllCharacters().map((c) => ({
      id: c.id,
      name: c.name,
      locationId: c.locationId,
      gold: c.gold,
      needs: c.needs,
      currentAction: c.currentAction,
      life: c.life,
      moodlets: c.moodlets,
      inventory: c.inventory,
      recentActions: c.recentActions,
      // 生活主线状态：晨间打算 / 短期意图 / 信箱（读档后主线才不会蒸发）
      todayPlan: c.todayPlan,
      currentIntent: c.currentIntent,
      inbox: c.inbox,
      lastReflection: c.lastReflection,
    }));

    // 约定（世界级）：pending 的赴约/爽约结算依赖它，必须随档保存
    const appointments = [...sim.world.getAllAppointments()];

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

    // 印象数据
    const impressions = sim.impressions.getAll();

    // 长期记忆：直接持久化运行时 LTM store（反思/冲突/约定结算在发生当刻已写入），
    // 不再做"存档瞬间 importance≥7 快照"——那只会把对话碎片重复堆进 DB
    const longTermMemories: Array<{ characterId: string; tick: number; type: string; content: string; importance: number; relatedCharacterId?: string }> = [];
    for (const c of characters) {
      for (const m of sim.longTerm.all(c.id)) {
        longTermMemories.push({ characterId: c.id, tick: m.tick, type: m.type, content: m.content, importance: m.importance, relatedCharacterId: m.relatedCharacterId });
      }
    }

    db.saveAll({
      tick: sim.world.tick,
      weather: sim.world.weather,
      characters,
      relationships,
      memories,
      events,
      impressions,
      longTermMemories,
      appointments,
      narrativeJson: JSON.stringify(sim.world.narrative.getSnapshot()),
      scenarioId,
    });

    console.log(`💾 已保存到 ${dbPath} (tick=${sim.world.tick}, ${characters.length} 角色, ${memories.length} 记忆, ${relationships.length} 关系, ${appointments.length} 约定)`);
  } finally {
    db.close();
  }
}

/** 从 SQLite 恢复世界状态 */
export function loadGame(sim: Simulation, dbPath: string, scenarioId?: string): boolean {
  let db: AnimaDB;
  try {
    db = new AnimaDB(dbPath);
  } catch {
    return false;
  }

  try {
    const worldState = db.loadWorldState();
    if (!worldState) return false;

    // 跨剧本存档护栏：default 世界续了 last-ferry 的档就会把别人的剧本事件/记忆
    // 挂进日常角色的 prompt（生产环境实际发生过）。剧本不匹配拒载，另起新档。
    if (scenarioId && worldState.scenarioId && worldState.scenarioId !== scenarioId) {
      console.warn(
        `⚠️  存档剧本不匹配（存档=${worldState.scenarioId}，当前=${scenarioId}），拒绝读档以避免跨剧本污染。` +
        `\n    如需继续旧档请用 --scenario ${worldState.scenarioId} 启动；如想重开请删除/改名存档文件。`,
      );
      return false;
    }

    // 恢复世界状态
    sim.world.setTick(worldState.tick);
    sim.world.setWeather(worldState.weather as Weather);
    if (worldState.narrativeJson) {
      try {
        const snap = JSON.parse(worldState.narrativeJson);
        sim.world.narrative.replaceSnapshot(snap);
      } catch (e) {
        console.warn(`⚠️  narrative_state 读档失败: ${(e as Error).message}`);
      }
    }

    // 恢复角色状态
    const savedChars = db.loadCharacters();
    for (const sc of savedChars) {
      const char = sim.world.getCharacter(sc.id);
      if (char) {
        sim.world.moveCharacter(sc.id, sc.locationId);
        char.gold = sc.gold;
        char.needs = { ...sc.needs };
        char.currentAction = sc.currentAction;
        // 恢复 life state（技能、目标等运行时可变数据）
        if (sc.life && char.life) {
          char.life.skills = { ...sc.life.skills };
          char.life.occupation = sc.life.occupation;
          char.life.income = sc.life.income;
          char.life.currentGoal = sc.life.currentGoal;
          char.life.currentConcern = sc.life.currentConcern;
        }
        // 恢复 moodlets
        if (sc.moodlets) {
          char.moodlets = sc.moodlets;
        }
        // 恢复物品和行为记录
        if (sc.inventory) {
          char.inventory = sc.inventory;
        }
        if (sc.recentActions) {
          char.recentActions = sc.recentActions;
        }
        // 恢复生活主线状态：晨间打算 / 短期意图 / 信箱 / 昨晚反思
        char.todayPlan = sc.todayPlan;
        char.currentIntent = sc.currentIntent;
        char.lastReflection = sc.lastReflection;
        if (sc.inbox) {
          char.inbox = sc.inbox;
        }
      }
    }

    // 恢复约定（世界级）
    const savedAppointments = db.loadAppointments();
    sim.world.restoreAppointments(savedAppointments);

    // 恢复关系
    const savedRels = db.loadRelationships();
    for (const r of savedRels) {
      sim.relationships.set(r.charA, r.charB, r.level, r.type as any);
      if (r.bond) {
        sim.relationships.setBond(r.charA, r.charB, r.bond as any, 0);
      }
    }

    // 恢复记忆
    for (const sc of savedChars) {
      const memories = db.loadMemories(sc.id, 30);
      for (const m of memories.reverse()) {
        sim.memory.add(sc.id, m);
      }
    }

    // 恢复印象
    const savedImpressions = db.loadImpressions();
    for (const { observerId, impression } of savedImpressions) {
      sim.impressions.set(observerId, impression);
    }

    // 恢复长期记忆：整体回填运行时 LTM store（对话检索"你们之间发生过的"依赖它），
    // 并把最重要的几条注入短期记忆让角色醒来就"记得"
    let ltmCount = 0;
    for (const sc of savedChars) {
      const allLtm = db.loadLongTermMemories(sc.id, 200);
      sim.longTerm.restore(sc.id, allLtm.map((m) => ({
        tick: m.tick, type: m.type, content: m.content,
        importance: m.importance, relatedCharacterId: m.relatedCharacterId,
      })));
      ltmCount += allLtm.length;
      for (const m of allLtm.slice(0, 10).reverse()) {
        sim.memory.add(sc.id, {
          tick: m.tick,
          type: m.type as any,
          content: m.content,
          importance: m.importance,
          relatedCharacterId: m.relatedCharacterId,
        });
      }
    }

    console.log(`📂 已读取存档 (tick=${worldState.tick}, ${savedChars.length} 角色, ${savedRels.length} 关系, ${savedImpressions.length} 印象, ${ltmCount} 长期记忆, ${savedAppointments.length} 约定)`);
    return true;
  } finally {
    db.close();
  }
}
