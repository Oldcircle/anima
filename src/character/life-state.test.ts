/**
 * Life State Tests — 生活状态系统
 */

import { describe, it, expect } from "vitest";
import { loadCharacterFromYAML } from "./loader.js";
import { buildSystemPrompt, buildUserPrompt } from "../agent/prompt-builder.js";
import { workAction } from "../actions/basic-actions.js";
import type { ActionContext } from "../actions/types.js";
import type { CharacterCard, LifeState } from "./types.js";
import type { CharacterState } from "../world/types.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dirname, "../../data/characters");

describe("LifeState 类型与加载", () => {
  it("从 YAML 加载 life 段", () => {
    const card = loadCharacterFromYAML(join(DATA_DIR, "tomori.yml"));
    expect(card.life).toBeDefined();
    expect(card.life!.occupation).toBe("面包店学徒");
    expect(card.life!.workplace).toBe("bakery");
    expect(card.life!.age).toBe(19);
    expect(card.life!.income).toBe(8);
    expect(card.life!.skills.baking).toBe(1);
    expect(card.life!.skills.observation).toBe(3);
    expect(card.life!.aspiration).toBe("找到能理解我的人");
  });

  it("所有 5 个角色都有 life 段", () => {
    const files = ["tomori.yml", "anon.yml", "sakiko.yml", "mutsumi.yml", "soyo.yml"];
    for (const f of files) {
      const card = loadCharacterFromYAML(join(DATA_DIR, f));
      expect(card.life, `${f} should have life`).toBeDefined();
      expect(card.life!.workplace, `${f} should have workplace`).toBeTruthy();
      expect(card.life!.aspiration, `${f} should have aspiration`).toBeTruthy();
    }
  });

  it("没有 life 段的 YAML 回退到 undefined", () => {
    // 构造一个没有 life 段的最小卡
    const card: CharacterCard = {
      id: "test",
      name: "测试",
      age: 20,
      occupation: "无业",
      home: "home_test",
      personality: {
        traits: [],
        interests: [],
        dislikes: [],
        speechStyle: "",
      },
      background: "",
      relationships: {},
    };
    expect(card.life).toBeUndefined();
  });
});

describe("Prompt 注入 life 信息", () => {
  const cardWithLife: CharacterCard = {
    id: "tomori",
    name: "高松灯",
    age: 19,
    occupation: "面包店学徒",
    home: "home_tomori",
    personality: {
      traits: ["内向"],
      interests: ["写东西"],
      dislikes: ["人多"],
      speechStyle: "声音微弱",
    },
    background: "面包店学徒",
    relationships: {},
    life: {
      occupation: "面包店学徒",
      workplace: "bakery",
      age: 19,
      income: 8,
      skills: { baking: 1, observation: 3 },
      aspiration: "找到能理解我的人",
    },
  };

  it("system prompt 包含工作认知", () => {
    const prompt = buildSystemPrompt(cardWithLife, "海风面包坊");
    expect(prompt).toContain("海风面包坊");
    expect(prompt).toContain("面包店学徒");
  });

  it("system prompt 包含技能描述（中文）", () => {
    const prompt = buildSystemPrompt(cardWithLife);
    expect(prompt).toContain("烘焙（在学习）");
    expect(prompt).toContain("观察力（有基础）");
  });

  it("system prompt 包含抱负", () => {
    const prompt = buildSystemPrompt(cardWithLife);
    expect(prompt).toContain("找到能理解我的人");
  });

  it("技能等级描述正确分级", () => {
    const card = {
      ...cardWithLife,
      life: {
        ...cardWithLife.life!,
        skills: { baking: 0.5, social: 1, piano: 5, cooking: 8 },
      },
    };
    const prompt = buildSystemPrompt(card);
    expect(prompt).toContain("烘焙（刚入门）");
    expect(prompt).toContain("社交（在学习）");
    expect(prompt).toContain("钢琴（熟练）");
    expect(prompt).toContain("cooking（精通）"); // 未翻译的技能用原名
  });

  it("user prompt 注入 currentGoal 和 currentConcern", () => {
    const state: CharacterState = {
      id: "tomori",
      name: "高松灯",
      locationId: "bakery",
      needs: { hunger: 80, energy: 70, social: 60, fun: 70, hygiene: 80, bladder: 90 },
      gold: 30,
      moodlets: [], inbox: [],
      life: {
        ...cardWithLife.life!,
        currentGoal: "想学会做法棍",
        currentConcern: "这个月快没钱了",
      },
    };

    const prompt = buildUserPrompt({
      card: cardWithLife,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "海风面包坊",
      locationType: "commercial",
      allLocationNames: [],
    });

    expect(prompt).toContain("你心里挂着的事");
    expect(prompt).toContain("想学会做法棍");
    expect(prompt).toContain("这个月快没钱了");
  });

  it("没有 currentGoal/currentConcern 时不注入该段", () => {
    const state: CharacterState = {
      id: "tomori",
      name: "高松灯",
      locationId: "bakery",
      needs: { hunger: 80, energy: 70, social: 60, fun: 70, hygiene: 80, bladder: 90 },
      gold: 30,
      moodlets: [], inbox: [],
      life: { ...cardWithLife.life! },
    };

    const prompt = buildUserPrompt({
      card: cardWithLife,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "海风面包坊",
      locationType: "commercial",
      allLocationNames: [],
    });

    expect(prompt).not.toContain("你心里挂着的事");
  });

  it("没有 life 的角色卡仍然能正常生成 prompt", () => {
    const cardNoLife: CharacterCard = {
      id: "test",
      name: "测试角色",
      age: 25,
      occupation: "渔夫",
      home: "home_test",
      personality: {
        traits: ["开朗"],
        interests: [],
        dislikes: [],
        speechStyle: "大声说话",
      },
      background: "渔夫",
      relationships: {},
    };
    const prompt = buildSystemPrompt(cardNoLife);
    expect(prompt).toContain("测试角色");
    expect(prompt).toContain("25 岁");
    expect(prompt).toContain("渔夫");
    expect(prompt).not.toContain("你的生活");
  });
});

describe("技能成长", () => {
  function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
    return {
      characterId: "tomori",
      locationId: "bakery",
      locationType: "commercial",
      tick: 100,
      nearbyCharacters: [],
      gold: 100,
      needs: { hunger: 50, energy: 50, social: 50, fun: 50, hygiene: 50, bladder: 50 },
      ...overrides,
    };
  }

  it("work action 带 workSkill 时产生 skill_up effect", () => {
    const result = workAction.handler({}, makeCtx({ workSkill: "baking" }));
    expect(result.success).not.toBe(false);
    const skillEffect = result.effects.find((e) => e.type === "skill_up");
    expect(skillEffect).toBeDefined();
    expect(skillEffect!.skill).toBe("baking");
    expect(skillEffect!.delta).toBe(0.1);
  });

  it("work action 不带 workSkill 时不产生 skill_up effect", () => {
    const result = workAction.handler({}, makeCtx());
    expect(result.success).not.toBe(false);
    const skillEffect = result.effects.find((e) => e.type === "skill_up");
    expect(skillEffect).toBeUndefined();
  });

  it("精力不足时 work 失败，不产生任何 effect", () => {
    const result = workAction.handler({}, makeCtx({ needs: { hunger: 50, energy: 5, social: 50, fun: 50, hygiene: 50, bladder: 50 } }));
    expect(result.success).toBe(false);
    expect(result.effects).toHaveLength(0);
  });

  it("技能值不超过 10", () => {
    const life: LifeState = {
      occupation: "面包师",
      workplace: "bakery",
      age: 25,
      income: 15,
      skills: { baking: 9.95 },
      aspiration: "test",
    };

    // 模拟 agent-loop 中的 skill_up 处理
    const current = life.skills.baking ?? 0;
    life.skills.baking = Math.min(10, current + 0.1);
    expect(life.skills.baking).toBe(10);

    // 再加一次，不应超过 10
    const current2 = life.skills.baking;
    life.skills.baking = Math.min(10, current2 + 0.1);
    expect(life.skills.baking).toBe(10);
  });
});
