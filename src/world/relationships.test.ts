import { describe, it, expect } from "vitest";
import { RelationshipManager } from "./relationships.js";

describe("RelationshipManager", () => {
  it("默认关系为 stranger，level 0", () => {
    const rm = new RelationshipManager();
    const rel = rm.get("alice", "bob");
    expect(rel.level).toBe(0);
    expect(rel.type).toBe("stranger");
  });

  it("set 初始化关系", () => {
    const rm = new RelationshipManager();
    rm.set("alice", "bob", 50, "friend");
    const rel = rm.get("alice", "bob");
    expect(rel.level).toBe(50);
    expect(rel.type).toBe("friend");
  });

  it("get(a,b) 和 get(b,a) 返回同一关系", () => {
    const rm = new RelationshipManager();
    rm.set("alice", "bob", 30);
    expect(rm.get("bob", "alice").level).toBe(30);
  });

  it("modify 改变关系值并自动更新类型", () => {
    const rm = new RelationshipManager();
    rm.set("alice", "bob", 25);

    rm.modify("alice", "bob", 10, 100, "一起喝咖啡");
    const rel = rm.get("alice", "bob");
    expect(rel.level).toBe(35);
    expect(rel.type).toBe("friend");
    expect(rel.history).toContain("一起喝咖啡");
    expect(rel.lastInteraction).toBe(100);
  });

  it("level clamp 在 -100 到 100", () => {
    const rm = new RelationshipManager();
    rm.set("alice", "bob", 95);
    rm.modify("alice", "bob", 20, 1);
    expect(rm.get("alice", "bob").level).toBe(100);

    rm.set("alice", "charlie", -90);
    rm.modify("alice", "charlie", -20, 1);
    expect(rm.get("alice", "charlie").level).toBe(-100);
  });

  it("负关系自动设为 rival", () => {
    const rm = new RelationshipManager();
    rm.set("alice", "bob", -30);
    expect(rm.get("alice", "bob").type).toBe("rival");
  });

  it("getRelationshipsOf 返回角色的所有关系", () => {
    const rm = new RelationshipManager();
    rm.set("alice", "bob", 50);
    rm.set("alice", "charlie", 20);
    rm.set("bob", "charlie", 10);

    const aliceRels = rm.getRelationshipsOf("alice");
    expect(aliceRels).toHaveLength(2);
  });

  it("history 最多保留 20 条", () => {
    const rm = new RelationshipManager();
    for (let i = 0; i < 25; i++) {
      rm.modify("alice", "bob", 1, i, `事件${i}`);
    }
    expect(rm.get("alice", "bob").history).toHaveLength(20);
    expect(rm.get("alice", "bob").history[0]).toBe("事件5");
  });
});
