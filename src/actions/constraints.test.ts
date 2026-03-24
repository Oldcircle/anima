/**
 * Action Constraints Tests — 工具约束检查
 */

import { describe, it, expect } from "vitest";
import { eatAction, sleepAction, workAction, washAction } from "./basic-actions.js";
import { giveGiftAction } from "./social-actions.js";
import { drinkAction } from "./leisure-actions.js";
import { argueAction, stealAction, begAction } from "./gray-actions.js";
import type { ActionContext } from "./types.js";

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    characterId: "alice",
    locationId: "cafe",
    locationType: "commercial",
    tick: 100,
    nearbyCharacters: ["bob"],
    gold: 100,
    needs: { hunger: 50, energy: 50, social: 50, happiness: 50, hygiene: 50 },
    ...overrides,
  };
}

describe("工具约束", () => {
  describe("eat", () => {
    it("在商业地点有钱 → 成功", () => {
      const result = eatAction.handler({ location: "cafe" }, makeCtx());
      expect(result.success).not.toBe(false);
      expect(result.effects.length).toBeGreaterThan(0);
    });

    it("在商业地点没钱 → 失败", () => {
      const result = eatAction.handler({ location: "cafe" }, makeCtx({ gold: 5 }));
      expect(result.success).toBe(false);
      expect(result.effects).toHaveLength(0);
      expect(result.description).toContain("钱不够");
    });

    it("在家吃 → 免费，不检查金币", () => {
      const result = eatAction.handler({ location: "home_alice" }, makeCtx({ gold: 0 }));
      expect(result.success).not.toBe(false);
    });
  });

  describe("drink", () => {
    it("有钱 → 成功", () => {
      const result = drinkAction.handler({ beverage: "咖啡" }, makeCtx());
      expect(result.success).not.toBe(false);
    });

    it("没钱 → 失败", () => {
      const result = drinkAction.handler({ beverage: "啤酒" }, makeCtx({ gold: 3 }));
      expect(result.success).toBe(false);
      expect(result.description).toContain("钱不够");
    });
  });

  describe("sleep", () => {
    it("在家 → 成功", () => {
      const result = sleepAction.handler({}, makeCtx({ locationType: "residential" }));
      expect(result.success).not.toBe(false);
      expect(result.duration).toBe(32);
    });

    it("不在家 → 失败", () => {
      const result = sleepAction.handler({}, makeCtx({ locationType: "commercial" }));
      expect(result.success).toBe(false);
      expect(result.description).toContain("不是家");
    });
  });

  describe("wash", () => {
    it("在家 → 成功", () => {
      const result = washAction.handler({}, makeCtx({ locationType: "residential" }));
      expect(result.success).not.toBe(false);
    });

    it("不在家 → 失败", () => {
      const result = washAction.handler({}, makeCtx({ locationType: "public" }));
      expect(result.success).toBe(false);
      expect(result.description).toContain("没法洗澡");
    });
  });

  describe("work", () => {
    it("精力充足 → 成功", () => {
      const result = workAction.handler({}, makeCtx({ needs: { hunger: 50, energy: 50, social: 50, happiness: 50, hygiene: 50 } }));
      expect(result.success).not.toBe(false);
    });

    it("精力不足 → 失败", () => {
      const result = workAction.handler({}, makeCtx({ needs: { hunger: 50, energy: 5, social: 50, happiness: 50, hygiene: 50 } }));
      expect(result.success).toBe(false);
      expect(result.description).toContain("太累了");
    });
  });

  describe("give_gift", () => {
    it("有钱 → 成功", () => {
      const result = giveGiftAction.handler({ target: "bob", item: "花" }, makeCtx({ gold: 50 }));
      expect(result.success).not.toBe(false);
    });

    it("没钱 → 失败", () => {
      const result = giveGiftAction.handler({ target: "bob", item: "花" }, makeCtx({ gold: 10 }));
      expect(result.success).toBe(false);
      expect(result.description).toContain("买不起");
    });
  });
});

describe("灰色行为", () => {
  describe("argue", () => {
    it("降低双方关系和快乐，提升社交", () => {
      const result = argueAction.handler({ target: "bob", reason: "你太吵了" }, makeCtx());
      expect(result.success).not.toBe(false);
      const relEffect = result.effects.find(e => e.type === "relationship_change");
      expect(relEffect?.delta).toBe(-10);
      const happyEffects = result.effects.filter(e => e.field === "happiness");
      expect(happyEffects.every(e => e.delta! < 0)).toBe(true);
      const socialEffects = result.effects.filter(e => e.field === "social");
      expect(socialEffects.every(e => e.delta! > 0)).toBe(true);
    });
  });

  describe("steal", () => {
    it("返回结果（成功或被抓）", () => {
      // 跑多次，应该有被抓和成功两种情况
      let caughtCount = 0;
      let successCount = 0;
      for (let i = 0; i < 50; i++) {
        const result = stealAction.handler({ target: "shop" }, makeCtx());
        if (result.description.includes("被当场抓住")) {
          caughtCount++;
          expect(result.effects.some(e => e.type === "relationship_change" && e.delta! < 0)).toBe(true);
        } else {
          successCount++;
          expect((result as any)._stolenAmount).toBeGreaterThanOrEqual(20);
          expect((result as any)._stolenAmount).toBeLessThanOrEqual(40);
        }
      }
      // 40% 被抓概率，50 次试验中应该有合理分布
      expect(caughtCount).toBeGreaterThan(5);
      expect(successCount).toBeGreaterThan(15);
    });
  });

  describe("beg", () => {
    it("获得少量金币，降低快乐", () => {
      const result = begAction.handler({}, makeCtx());
      const amount = (result as any)._begAmount;
      expect(amount).toBeGreaterThanOrEqual(5);
      expect(amount).toBeLessThanOrEqual(15);
      expect(result.effects.some(e => e.field === "happiness" && e.delta! < 0)).toBe(true);
    });
  });
});
