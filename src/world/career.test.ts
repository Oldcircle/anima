/**
 * Career Progression Tests — 职业晋升系统
 */

import { describe, it, expect } from "vitest";
import { checkPromotion, applyPromotion } from "./career.js";
import { ShortTermMemory } from "../memory/short-term.js";
import type { CharacterState, Location } from "./types.js";

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: "tomori", name: "高松灯", locationId: "bakery",
    needs: { hunger: 80, energy: 70, social: 60, happiness: 70, hygiene: 80 },
    gold: 100, moodlets: [], inbox: [],
    life: {
      occupation: "面包店学徒",
      workplace: "bakery",
      age: 19,
      income: 8,
      skills: { baking: 1 },
      aspiration: "找到能理解我的人",
    },
    ...overrides,
  };
}

const LOCATIONS: Location[] = [
  {
    id: "bakery", name: "海风面包坊", type: "commercial", presentCharacters: [],
    careerTrack: [
      { level: 1, title: "面包店学徒", income: 8, required_skill: { baking: 0 } },
      { level: 2, title: "面包师", income: 15, required_skill: { baking: 5 } },
      { level: 3, title: "主厨", income: 25, required_skill: { baking: 8 } },
    ],
  },
];

describe("checkPromotion", () => {
  it("技能不够 → 不晋升", () => {
    const state = makeState();
    const result = checkPromotion(state, LOCATIONS);
    expect(result).toBeNull();
  });

  it("技能达到 → 晋升", () => {
    const state = makeState();
    state.life!.skills.baking = 5;
    const result = checkPromotion(state, LOCATIONS);
    expect(result).toBeDefined();
    expect(result!.oldTitle).toBe("面包店学徒");
    expect(result!.newTitle).toBe("面包师");
    expect(result!.newIncome).toBe(15);
  });

  it("已经是最高级 → 不晋升", () => {
    const state = makeState();
    state.life!.occupation = "主厨";
    state.life!.skills.baking = 10;
    const result = checkPromotion(state, LOCATIONS);
    expect(result).toBeNull();
  });

  it("没有 life → 不晋升", () => {
    const state = makeState();
    state.life = undefined;
    const result = checkPromotion(state, LOCATIONS);
    expect(result).toBeNull();
  });

  it("工作地点没有 career_track → 不晋升", () => {
    const state = makeState();
    state.life!.skills.baking = 10;
    const noCareer: Location[] = [
      { id: "bakery", name: "面包坊", type: "commercial", presentCharacters: [] },
    ];
    const result = checkPromotion(state, noCareer);
    expect(result).toBeNull();
  });
});

describe("applyPromotion", () => {
  it("更新 occupation 和 income", () => {
    const state = makeState();
    state.life!.skills.baking = 5;
    const promotion = checkPromotion(state, LOCATIONS)!;
    const memory = new ShortTermMemory();

    applyPromotion(state, promotion, memory, 100);

    expect(state.life!.occupation).toBe("面包师");
    expect(state.life!.income).toBe(15);
  });

  it("写入记忆", () => {
    const state = makeState();
    state.life!.skills.baking = 5;
    const promotion = checkPromotion(state, LOCATIONS)!;
    const memory = new ShortTermMemory();

    applyPromotion(state, promotion, memory, 100);

    const memories = memory.getRecent("tomori", 5);
    expect(memories.some((m) => m.content.includes("晋升"))).toBe(true);
    expect(memories.some((m) => m.content.includes("面包师"))).toBe(true);
  });

  it("添加 confident moodlet", () => {
    const state = makeState();
    state.life!.skills.baking = 5;
    const promotion = checkPromotion(state, LOCATIONS)!;
    const memory = new ShortTermMemory();

    applyPromotion(state, promotion, memory, 100);

    expect(state.moodlets.some((m) => m.emotion === "confident")).toBe(true);
    expect(state.moodlets.find((m) => m.emotion === "confident")!.intensity).toBe(4);
  });

  it("连续晋升两级", () => {
    const state = makeState();
    state.life!.skills.baking = 5;

    const memory = new ShortTermMemory();
    const p1 = checkPromotion(state, LOCATIONS)!;
    applyPromotion(state, p1, memory, 100);
    expect(state.life!.occupation).toBe("面包师");

    // 再升级
    state.life!.skills.baking = 8;
    const p2 = checkPromotion(state, LOCATIONS)!;
    applyPromotion(state, p2, memory, 200);
    expect(state.life!.occupation).toBe("主厨");
    expect(state.life!.income).toBe(25);
  });
});
