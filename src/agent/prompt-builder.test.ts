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

  it("社交值过高时会提示不必继续硬社交", () => {
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

    expect(prompt).toContain("社交上基本是饱的");
    expect(prompt).toContain("不必硬找话题");
  });

});
