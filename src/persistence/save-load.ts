/**
 * Save/Load — 存档和读档
 */

import { AnimaDB } from "./database.js";
import type { Simulation } from "../agent/simulation.js";
import type { World } from "../world/world.js";
import type { EventBus, WorldEvent } from "../core/event-bus.js";
import type { Weather } from "../world/types.js";

/**
 * 轻量探针：只读出存档里的 scenario 标识（不加载世界）。
 * cli 用它决定存档文件归属，防止"剧本不匹配拒载后，新世界自动存档覆盖旧档"的数据丢失回路。
 */
export function peekSaveScenario(dbPath: string): string | undefined | null {
  try {
    const db = new AnimaDB(dbPath);
    try {
      const ws = db.loadWorldState();
      if (!ws) return null; // 空档
      return ws.scenarioId; // undefined = 老档没有标识
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 保存当前世界状态到 SQLite */
export function saveGame(sim: Simulation, dbPath: string, scenarioId?: string): void {
  // 入队未 drain 的 mutation（beat auto_events / 导演硬事件）先落地再快照：
  // 载荷纯内存，而 beat 触发标记/导演配额在入队当刻已写随档——不 flush 会载荷丢、代价已付
  sim.flushPendingMutations();

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
      garden: c.garden,
      debts: c.debts,
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
      worldObjectsJson: JSON.stringify(sim.world.objects.getSnapshot()),
      chronicleJson: JSON.stringify(sim.world.chronicle.getSnapshot()),
      scenarioId,
      locationStockJson: JSON.stringify(
        Object.fromEntries(
          sim.world.getAllLocations().filter((l) => l.stock).map((l) => [l.id, l.stock]),
        ),
      ),
      locationBansJson: JSON.stringify(
        Object.fromEntries(
          sim.world.getAllLocations().filter((l) => l.bans && Object.keys(l.bans).length > 0).map((l) => [l.id, l.bans]),
        ),
      ),
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

    // 器物层动态状态（traces/flags/lastSeen/运行期正典）——YAML 声明已在 World 构造时登记
    if (worldState.worldObjectsJson) {
      try {
        sim.world.objects.replaceSnapshot(JSON.parse(worldState.worldObjectsJson));
      } catch (e) {
        console.warn(`⚠️  world_objects 读档失败: ${(e as Error).message}`);
      }
    }

    if (worldState.chronicleJson) {
      try {
        sim.world.chronicle.replaceSnapshot(JSON.parse(worldState.chronicleJson));
      } catch (e) {
        console.warn(`⚠️  chronicle 读档失败: ${(e as Error).message}`);
      }
    }

    // B4：narrative 恢复后重新同步 beat 引擎（triggered 集合 + 逐 beat 触发史 beatLastTrigger）。
    // cli 的装配顺序是先 loadBeats 再 loadGame——不重同步的话读档后一次性 beat 会重复点火、
    // cooldown 型 beat 丢触发史。loadBeats 幂等，直接用引擎里已装载的 beats 重灌一遍。
    if (sim.beatEngine.getBeats().length > 0) {
      sim.loadBeats([...sim.beatEngine.getBeats()]);
    }

    // 恢复角色状态
    const savedChars = db.loadCharacters();

    // B3：静态 NPC 读档重建——narrative.npcs 登记的世界注入角色不在剧本 cast 里，
    // 不先 addCharacter 则下面的循环静默跳过（悬空真凶蒸发：赃物/嫌疑链全断）。
    // 位置/金币/物品由 savedChars 循环照常恢复。
    for (const [npcId, npc] of Object.entries(sim.world.narrative.getWorld().npcs ?? {})) {
      if (sim.world.getCharacter(npcId)) continue;
      const saved = savedChars.find((c) => c.id === npcId);
      const locId =
        saved && sim.world.getLocation(saved.locationId)
          ? saved.locationId
          : sim.world.getAllLocations()[0]?.id;
      if (!locId) continue;
      sim.world.addCharacter(npcId, npc.name, locId, undefined, saved?.life, undefined);
      console.log(`🕵️ [B3] 读档重建静态 NPC: ${npc.name} (${npcId}) @ ${locId}`);
    }

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
        char.garden = sc.garden; // 菜地随档：种下去的东西读档后还长在地里
        char.debts = sc.debts;   // 欠账随档：账不会因为读档一笔勾销

        if (sc.inbox) {
          char.inbox = sc.inbox;
        }
      }
    }

    // 恢复店铺拉黑（偷店的账不因读档一笔勾销）
    if (worldState.locationBansJson) {
      try {
        const bans = JSON.parse(worldState.locationBansJson) as Record<string, Record<string, number>>;
        for (const [locId, banMap] of Object.entries(bans)) {
          const loc = sim.world.getLocation(locId);
          if (loc) loc.bans = banMap;
        }
      } catch { /* 旧档无此键，忽略 */ }
    }

    // 恢复店铺库存（不随档会在读档后全体回到"无限"，直到次日 06:00）
    if (worldState.locationStockJson) {
      try {
        const stocks = JSON.parse(worldState.locationStockJson) as Record<string, Record<string, number>>;
        for (const [locId, stock] of Object.entries(stocks)) {
          const loc = sim.world.getLocation(locId);
          if (loc) loc.stock = stock;
        }
      } catch (e) {
        console.warn(`⚠️  location_stock 读档失败: ${(e as Error).message}`);
      }
    }

    // 恢复约定（世界级）
    const savedAppointments = db.loadAppointments();
    sim.world.restoreAppointments(savedAppointments);

    // 恢复关系（含关系史和未解开的疙瘩）
    const savedRels = db.loadRelationships();
    for (const r of savedRels) {
      sim.relationships.set(r.charA, r.charB, r.level, r.type as any);
      if (r.bond) {
        sim.relationships.setBond(r.charA, r.charB, r.bond as any, 0);
      }
      const rel = sim.relationships.get(r.charA, r.charB);
      rel.history = r.history ?? [];
      rel.lastInteraction = r.lastInteraction ?? 0;
      if (r.grudge) rel.grudge = r.grudge;
    }

    // 恢复记忆（记录已回填的条目指纹，供下方 LTM 注入去重——
    // 否则每次重启 top-LTM 都再注入一份，saveAll 快照语义下 memories 表逐次膨胀成复读机）
    const seenMemoryKeys = new Map<string, Set<string>>();
    for (const sc of savedChars) {
      const memories = db.loadMemories(sc.id, 30);
      const keys = new Set<string>();
      for (const m of memories.reverse()) {
        sim.memory.add(sc.id, m);
        keys.add(`${m.tick}|${m.content}`);
      }
      seenMemoryKeys.set(sc.id, keys);
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
      const seen = seenMemoryKeys.get(sc.id) ?? new Set<string>();
      for (const m of allLtm.slice(0, 10).reverse()) {
        if (seen.has(`${m.tick}|${m.content}`)) continue; // 已在短期记忆里，不重复注入
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
