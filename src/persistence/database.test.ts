import { describe, it, expect, afterEach } from "vitest";
import { AnimaDB } from "./database.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DB = join(tmpdir(), `anima-test-${Date.now()}.db`);

describe("AnimaDB", () => {
  let db: AnimaDB;

  afterEach(() => {
    db?.close();
    for (const ext of ["", "-wal", "-shm"]) {
      const p = TEST_DB + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("创建数据库和表", () => {
    db = new AnimaDB(TEST_DB);
    expect(existsSync(TEST_DB)).toBe(true);
  });

  it("保存和读取世界状态", () => {
    db = new AnimaDB(TEST_DB);
    db.saveWorldState(100, "rainy");
    const state = db.loadWorldState();
    expect(state).toEqual({ tick: 100, weather: "rainy" });
  });

  it("保存和读取角色", () => {
    db = new AnimaDB(TEST_DB);
    db.saveCharacter({
      id: "alice", name: "Alice", locationId: "cafe", gold: 200,
      needs: { hunger: 50, energy: 80, social: 60, happiness: 70, hygiene: 90 },
      currentAction: { name: "work", remainingTicks: 3 },
    });

    const chars = db.loadCharacters();
    expect(chars).toHaveLength(1);
    expect(chars[0]!.id).toBe("alice");
    expect(chars[0]!.gold).toBe(200);
    expect(chars[0]!.needs.hunger).toBe(50);
    expect(chars[0]!.currentAction?.name).toBe("work");
  });

  it("保存和读取记忆", () => {
    db = new AnimaDB(TEST_DB);
    db.saveMemory("alice", 10, "event", "去了咖啡馆", 5);
    db.saveMemory("alice", 20, "conversation", "和Bob聊天", 7);

    const mems = db.loadMemories("alice", 10);
    expect(mems).toHaveLength(2);
    expect(mems[0]!.content).toBe("和Bob聊天"); // DESC order
  });

  it("保存和读取关系", () => {
    db = new AnimaDB(TEST_DB);
    db.saveRelationship("alice", "bob", 50, "friend", 100, ["一起喝咖啡"]);

    const rels = db.loadRelationships();
    expect(rels).toHaveLength(1);
    expect(rels[0]!.level).toBe(50);
    expect(rels[0]!.history).toEqual(["一起喝咖啡"]);
  });

  it("保存和读取印象", () => {
    db = new AnimaDB(TEST_DB);
    db.saveImpression("maria", {
      characterId: "sakiko",
      summary: "咖啡馆工作的女孩，礼貌但有距离感",
      observations: ["说话先说请容我", "手指很修长"],
      mentalLabel: "有秘密的人",
      unresolved: ["她为什么来这个小镇"],
      lastUpdated: 48,
    });

    const imps = db.loadImpressions();
    expect(imps).toHaveLength(1);
    expect(imps[0]!.observerId).toBe("maria");
    expect(imps[0]!.impression.characterId).toBe("sakiko");
    expect(imps[0]!.impression.summary).toContain("咖啡馆");
    expect(imps[0]!.impression.observations).toHaveLength(2);
    expect(imps[0]!.impression.mentalLabel).toBe("有秘密的人");
    expect(imps[0]!.impression.unresolved).toEqual(["她为什么来这个小镇"]);
  });

  it("保存和检索长期记忆", () => {
    db = new AnimaDB(TEST_DB);
    db.saveLongTermMemory("alice", 92, "thought", "[反思] 今天和Maria聊了很多，她很热情", 9, "maria");
    db.saveLongTermMemory("alice", 92, "thought", "[反思] Bob的鲈鱼比喻很有趣", 8, "bob");
    db.saveLongTermMemory("alice", 50, "event", "和Maria一起看日落", 7, "maria");

    // 按角色检索（按重要性排序）
    const all = db.loadLongTermMemories("alice", 10);
    expect(all).toHaveLength(3);
    expect(all[0]!.importance).toBe(9);

    // 按相关角色检索
    const aboutMaria = db.loadMemoriesAbout("alice", "maria", 5);
    expect(aboutMaria).toHaveLength(2);
    expect(aboutMaria[0]!.content).toContain("反思");

    // 关键词搜索
    const results = db.searchLongTermMemories("alice", "鲈鱼", 5);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("鲈鱼");
  });

  it("saveAll 事务性保存", () => {
    db = new AnimaDB(TEST_DB);
    db.saveAll({
      tick: 50,
      weather: "snowy",
      characters: [{
        id: "alice", name: "Alice", locationId: "home", gold: 100,
        needs: { hunger: 80, energy: 100, social: 60, happiness: 70, hygiene: 90 },
      }],
      relationships: [{ characterA: "alice", characterB: "bob", level: 30, type: "friend", lastInteraction: 40, history: [] }],
      memories: [{ characterId: "alice", tick: 45, type: "event", content: "test", importance: 5 }],
      events: [{ id: "e1", tick: 50, type: "action.eat", actorId: "alice", locationId: "cafe", description: "吃饭", witnesses: [] }],
    });

    expect(db.loadWorldState()?.tick).toBe(50);
    expect(db.loadCharacters()).toHaveLength(1);
    expect(db.loadRelationships()).toHaveLength(1);
    expect(db.loadMemories("alice")).toHaveLength(1);
    expect(db.loadRecentEvents()).toHaveLength(1);
  });
});
