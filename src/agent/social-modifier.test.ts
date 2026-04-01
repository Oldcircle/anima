import { describe, it, expect } from "vitest";
import { applySocialModifier, getSocialModifierActions } from "./social-modifier.js";
import { RelationshipManager } from "../world/relationships.js";
import type { ActionResult } from "../actions/types.js";

describe("Social Modifier", () => {
  function makeRelationships(): RelationshipManager {
    const rel = new RelationshipManager();
    rel.set("tomori", "anon", 25); // 认识的朋友
    // sakiko 和 tomori 默认 level=0（陌生人）
    return rel;
  }

  const getName = (id: string) => {
    const map: Record<string, string> = {
      tomori: "高松灯",
      anon: "千早爱音",
      sakiko: "丰川祥子",
    };
    return map[id] ?? id;
  };

  const successResult: ActionResult = {
    description: "吃了三明治",
    effects: [{ type: "need_change", targetId: "tomori", field: "hunger", delta: 40 }],
  };

  it("有认识的人在场吃饭 → 社交修正生效", () => {
    const rel = makeRelationships();
    const mod = applySocialModifier({
      actionName: "eat",
      result: successResult,
      actorId: "tomori",
      nearbyCharacterIds: ["anon"],
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(true);
    expect(mod.companionName).toBe("千早爱音");
    expect(mod.observableState).toContain("千早爱音");
    expect(mod.observableState).toContain("一起");
    // 应有 social 增量
    const socialEffect = mod.extraEffects.find(
      (e) => e.targetId === "tomori" && e.field === "social",
    );
    expect(socialEffect).toBeDefined();
    expect(socialEffect!.delta).toBeGreaterThan(0);
    // 同伴也应得到 social 增益
    const companionEffect = mod.extraEffects.find(
      (e) => e.targetId === "anon" && e.field === "social",
    );
    expect(companionEffect).toBeDefined();
    expect(companionEffect!.delta).toBeGreaterThan(0);
  });

  it("附近只有陌生人 → 社交修正不生效", () => {
    const rel = makeRelationships();
    const mod = applySocialModifier({
      actionName: "eat",
      result: successResult,
      actorId: "tomori",
      nearbyCharacterIds: ["sakiko"], // 陌生人
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(false);
    expect(mod.extraEffects).toHaveLength(0);
  });

  it("没有人在场 → 社交修正不生效", () => {
    const rel = makeRelationships();
    const mod = applySocialModifier({
      actionName: "eat",
      result: successResult,
      actorId: "tomori",
      nearbyCharacterIds: [],
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(false);
  });

  it("行为失败 → 社交修正不生效", () => {
    const rel = makeRelationships();
    const failedResult: ActionResult = {
      description: "没吃成",
      effects: [],
      success: false,
    };
    const mod = applySocialModifier({
      actionName: "eat",
      result: failedResult,
      actorId: "tomori",
      nearbyCharacterIds: ["anon"],
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(false);
  });

  it("没有社交规则的行为 → 不生效", () => {
    const rel = makeRelationships();
    const mod = applySocialModifier({
      actionName: "go_to",
      result: successResult,
      actorId: "tomori",
      nearbyCharacterIds: ["anon"],
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(false);
  });

  it("一起散步 → social 增加、fun 略减", () => {
    const rel = makeRelationships();
    const walkResult: ActionResult = {
      description: "沿着海边走",
      effects: [{ type: "need_change", targetId: "tomori", field: "fun", delta: 10 }],
    };
    const mod = applySocialModifier({
      actionName: "walk_beach",
      result: walkResult,
      actorId: "tomori",
      nearbyCharacterIds: ["anon"],
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(true);
    const socialDelta = mod.extraEffects.find(e => e.targetId === "tomori" && e.field === "social");
    const funDelta = mod.extraEffects.find(e => e.targetId === "tomori" && e.field === "fun");
    expect(socialDelta!.delta).toBeGreaterThan(0);
    expect(funDelta!.delta).toBeLessThan(0); // fun 略减
  });

  it("多人在场时选择最亲近的人", () => {
    const rel = new RelationshipManager();
    rel.set("tomori", "anon", 10);
    rel.set("tomori", "sakiko", 50); // sakiko 更亲近

    const mod = applySocialModifier({
      actionName: "eat",
      result: successResult,
      actorId: "tomori",
      nearbyCharacterIds: ["anon", "sakiko"],
      relationships: rel,
      getCharacterName: getName,
    });

    expect(mod.applied).toBe(true);
    expect(mod.companionName).toBe("丰川祥子"); // 选了更亲近的
  });

  it("getSocialModifierActions 返回有规则的 action 列表", () => {
    const actions = getSocialModifierActions();
    expect(actions).toContain("eat");
    expect(actions).toContain("walk");
    expect(actions).toContain("read");
    expect(actions).toContain("rest");
    expect(actions).not.toContain("go_to");
    expect(actions).not.toContain("talk");
  });
});
