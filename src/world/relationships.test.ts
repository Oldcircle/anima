import { describe, it, expect } from "vitest";
import { RelationshipManager } from "./relationships.js";

describe("RelationshipManager", () => {
  it("默认关系为 stranger，level 0", () => {
    const rm = new RelationshipManager();
    const rel = rm.get("tomori", "anon");
    expect(rel.level).toBe(0);
    expect(rel.type).toBe("stranger");
  });

  it("set 初始化关系", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", 50, "friend");
    const rel = rm.get("tomori", "anon");
    expect(rel.level).toBe(50);
    expect(rel.type).toBe("friend");
  });

  it("get(a,b) 和 get(b,a) 返回同一关系", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", 30);
    expect(rm.get("anon", "tomori").level).toBe(30);
  });

  it("modify 改变关系值并自动更新类型", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", 25);

    rm.modify("tomori", "anon", 10, 100, "一起喝咖啡");
    const rel = rm.get("tomori", "anon");
    expect(rel.level).toBe(35);
    expect(rel.type).toBe("friend");
    expect(rel.history).toContain("一起喝咖啡");
    expect(rel.lastInteraction).toBe(100);
  });

  it("level clamp 在 -100 到 100", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", 95);
    rm.modify("tomori", "anon", 20, 1);
    expect(rm.get("tomori", "anon").level).toBe(100);

    rm.set("tomori", "sakiko", -90);
    rm.modify("tomori", "sakiko", -20, 1);
    expect(rm.get("tomori", "sakiko").level).toBe(-100);
  });

  it("负关系自动设为 rival", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", -30);
    expect(rm.get("tomori", "anon").type).toBe("rival");
  });

  it("getRelationshipsOf 返回角色的所有关系", () => {
    const rm = new RelationshipManager();
    rm.set("tomori", "anon", 50);
    rm.set("tomori", "sakiko", 20);
    rm.set("anon", "sakiko", 10);

    const aliceRels = rm.getRelationshipsOf("tomori");
    expect(aliceRels).toHaveLength(2);
  });

  it("history 最多保留 20 条", () => {
    const rm = new RelationshipManager();
    for (let i = 0; i < 25; i++) {
      rm.modify("tomori", "anon", 1, i, `事件${i}`);
    }
    expect(rm.get("tomori", "anon").history).toHaveLength(20);
    expect(rm.get("tomori", "anon").history[0]).toBe("事件5");
  });

  // ── 反 valence 正向通胀：talk 递减 + per-tick 去重 + idle 衰减 ──

  describe("registerTalk（防棘轮）", () => {
    it("talkGain 按水位递减：破冰快、越亲越慢", () => {
      const rm = new RelationshipManager();
      // 从 0 起：每 tick 一次 talk，前几次 +1，过阈值后变慢
      rm.registerTalk("a", "b", 1);
      expect(rm.get("a", "b").level).toBe(1);      // <30 → +1
      rm.set("a", "b", 40);
      rm.registerTalk("a", "b", 2);
      expect(rm.get("a", "b").level).toBe(40.5);   // 30-60 → +0.5
      rm.set("a", "b", 90);
      rm.registerTalk("a", "b", 3);
      expect(rm.get("a", "b").level).toBeCloseTo(90.1, 5);  // ≥85 → +0.1
    });

    it("同一 tick 内多次 talk（反应轮级联）只加一次", () => {
      const rm = new RelationshipManager();
      rm.registerTalk("a", "b", 10);   // 主轮
      rm.registerTalk("b", "a", 10);   // 反应轮同 tick，对称同一对
      rm.registerTalk("a", "b", 10);   // 再来一句，还是同 tick
      expect(rm.get("a", "b").level).toBe(1);   // 三句只 +1
      rm.registerTalk("a", "b", 11);   // 下一 tick 才再加
      expect(rm.get("a", "b").level).toBe(2);
    });

    it("疙瘩期冻结加分，但刷新 lastInteraction", () => {
      const rm = new RelationshipManager();
      rm.set("a", "b", 20);
      rm.setGrudge("a", "b", "吵架", "a", 5);
      const gain = rm.registerTalk("a", "b", 6);
      expect(gain).toBe(0);
      expect(rm.get("a", "b").level).toBe(20);          // 冻结不涨
      expect(rm.get("a", "b").lastInteraction).toBe(6); // 但算互动过（免被 idle 衰减）
    });
  });

  describe("applyIdleDecay（关系要维护）", () => {
    it("超过空窗期无互动的对向 0 回落，幅度不超绝对值", () => {
      const rm = new RelationshipManager();
      rm.set("a", "b", 30);           // 正向
      rm.get("a", "b").lastInteraction = 0;
      rm.set("c", "d", -10);          // 负向
      rm.get("c", "d").lastInteraction = 0;
      rm.applyIdleDecay(200, 96, 1.5);   // tick 200，空窗阈 96
      expect(rm.get("a", "b").level).toBe(28.5);   // 正的降
      expect(rm.get("c", "d").level).toBe(-8.5);   // 负的升（都向 0）
    });

    it("刚互动过的对不衰减；疙瘩对跳过", () => {
      const rm = new RelationshipManager();
      rm.set("a", "b", 30);
      rm.get("a", "b").lastInteraction = 150;   // 距 tick 200 才 50 < 96
      rm.set("c", "d", 30);
      rm.get("c", "d").lastInteraction = 0;
      rm.setGrudge("c", "d", "x", "c", 0);
      rm.applyIdleDecay(200, 96, 1.5);
      expect(rm.get("a", "b").level).toBe(30);   // 未到空窗
      expect(rm.get("c", "d").level).toBe(30);   // 疙瘩跳过（另有淡化）
    });

    it("小于 0.5 的残值不再抖动", () => {
      const rm = new RelationshipManager();
      rm.set("a", "b", 0.3);
      rm.get("a", "b").lastInteraction = 0;
      rm.applyIdleDecay(200, 96, 1.5);
      expect(rm.get("a", "b").level).toBe(0.3);
    });
  });
});
