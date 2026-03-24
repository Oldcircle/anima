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
      happiness: 70,
      hygiene: 80,
    },
    gold: 30,
    inbox: [],
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

  it("会把短期意图注入 prompt，保留跨 tick 连续性", () => {
    const state = createState();
    state.currentIntent = {
      kind: "reply",
      source: "message",
      targetId: "anon",
      createdTick: 48,
      expiresAt: 54,
      summary: "爱音刚刚跟你搭话，你还在想要不要立刻回她。",
    };

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

    expect(prompt).toContain("你心里还挂着的事");
    expect(prompt).toContain("爱音刚刚跟你搭话");
  });
});
