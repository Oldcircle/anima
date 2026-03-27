import { describe, expect, it } from "vitest";
import { buildUserPrompt } from "./prompt-builder.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";
import { tickToGameTime } from "../core/tick-engine.js";

const baseCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  personality: {
    traits: ["内向"],
    interests: ["写东西"],
    dislikes: ["人多的场合"],
    speechStyle: "声音微弱",
  },
  background: "从城市来的安静女孩，在面包店当学徒",
  relationships: {},
};

function createState(): CharacterState {
  return {
    id: "tomori",
    name: "高松灯",
    locationId: "cafe",
    needs: {
      hunger: 80,
      energy: 70,
      social: 60,
      fun: 70,
      hygiene: 80,
      bladder: 90,
    },
    gold: 30,
    moodlets: [], inbox: [],
  };
}

describe("prompt-builder", () => {
  it("不再直接暴露亲密度数值，而是用主观感觉描述关系", () => {
    const prompt = buildUserPrompt({
      card: baseCard,
      state: createState(),
      gameTime: tickToGameTime(48),
      nearbyCharacters: [
        {
          id: "anon",
          name: "千早爱音",
          relationship: { level: 42, type: "friend" },
          currentAction: "在看书",
        },
      ],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("你对他们的主观感觉");
    expect(prompt).toContain("说话不会太拘谨");
    expect(prompt).not.toContain("亲密度");
    expect(prompt).not.toContain("42");
  });

  it("需求值正常时显示身体状态不错", () => {
    const state = createState(); // all needs are high
    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("身体状态不错");
    expect(prompt).not.toContain("/100");
    expect(prompt).not.toContain("饥饿:");
  });

  it("饥饿偏低时显示身体感受", () => {
    const state = createState();
    state.needs.hunger = 25;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("你的身体感受");
    expect(prompt).toContain("饿");
    expect(prompt).not.toContain("/100");
  });

  it("社交饱和时感受中提示想安静", () => {
    const state = createState();
    state.needs.social = 92;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("安静");
  });

  it("没钱时感受中提及口袋空", () => {
    const state = createState();
    state.gold = 0;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("口袋空空");
  });

  it("极端饥饿+没钱时显示紧急感受", () => {
    const state = createState();
    state.gold = 0;
    state.needs.hunger = 10;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("又穷又饿");
    expect(prompt).toContain("胃在抽痛");
  });

  it("会把当前还挂着的短期意图注入 prompt", () => {
    const state = createState();
    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
      currentIntent: {
        kind: "reply",
        source: "message",
        targetId: "anon",
        summary: "爱音刚刚对你说了「等会要不要一起坐坐？」，你还没回应。",
        createdTick: 48,
        expiresAt: 52,
      },
    });

    expect(prompt).toContain("你心里挂着的事");
    expect(prompt).toContain("你还没回应");
  });
});
