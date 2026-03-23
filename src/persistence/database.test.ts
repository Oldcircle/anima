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
