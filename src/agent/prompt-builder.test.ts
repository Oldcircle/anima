import { describe, expect, it } from "vitest";
import { buildUserPrompt } from "./prompt-builder.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";
import { tickToGameTime } from "../core/tick-engine.js";

const baseCard: CharacterCard = {
  id: "alice",
  name: "Alice Chen",
  age: 28,
  occupation: "花店老板",
  personality: {
    traits: ["温柔"],
    interests: ["园艺"],
    dislikes: ["噪音"],
    speechStyle: "轻声细语",
  },
  background: "开了镇上唯一的花店",
  relationships: {},
};

function createState(): CharacterState {
  return {
    id: "alice",
    name: "Alice Chen",
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
          id: "bob",
          name: "Bob Wang",
          relationship: { level: 42, type: "friend" },
          currentAction: "在看书",
        },
      ],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_alice", name: "Alice的家" }],
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
      targetId: "bob",
      createdTick: 48,
      expiresAt: 54,
      summary: "Bob 刚刚跟你搭话，你还在想要不要立刻回他。",
    };

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_alice", name: "Alice的家" }],
    });

    expect(prompt).toContain("你心里还挂着的事");
    expect(prompt).toContain("Bob 刚刚跟你搭话");
  });
});
