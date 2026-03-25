/**
 * Relationship Bond Tests — 关系身份（bond）系统
 */

import { describe, it, expect } from "vitest";
import { RelationshipManager, type BondType } from "./relationships.js";

describe("Relationship Bond", () => {
  it("默认没有 bond", () => {
    const rm = new RelationshipManager();
    const rel = rm.get("tomori", "anon");
    expect(rel.bond).toBeUndefined();
  });

  it("setBond 设置关系身份", () => {
    const rm = new RelationshipManager();
    rm.setBond("tomori", "anon", "colleague", 100, "在咖啡馆一起工作");
    const rel = rm.get("tomori", "anon");
    expect(rel.bond).toBe("colleague");
    expect(rel.lastInteraction).toBe(100);
    expect(rel.history).toContain("在咖啡馆一起工作");
  });

  it("setBond 为 undefined 可以清除 bond", () => {
    const rm = new RelationshipManager();
    rm.setBond("tomori", "anon", "partner", 100);
    expect(rm.get("tomori", "anon").bond).toBe("partner");

    rm.setBond("tomori", "anon", undefined, 200, "分手了");
    expect(rm.get("tomori", "anon").bond).toBeUndefined();
  });

  it("bond 不影响 level 和 type", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", 50, "friend");
    rm.setBond("tomori", "anon", "colleague", 100);

    const rel = rm.get("tomori", "anon");
    expect(rel.level).toBe(50);
    expect(rel.type).toBe("friend");
    expect(rel.bond).toBe("colleague");
  });

  it("bond 对称：get(a,b) 和 get(b,a) 返回同一 bond", () => {
    const rm = new RelationshipManager();
    rm.setBond("tomori", "anon", "colleague", 100);
    expect(rm.get("anon", "tomori").bond).toBe("colleague");
  });
});
