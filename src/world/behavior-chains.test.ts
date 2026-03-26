import { describe, it, expect, beforeEach } from "vitest";
import { detectBehaviorPatterns, resetBehaviorChainTriggers } from "./behavior-chains.js";
import type { CharacterState } from "./types.js";
import { getDefaultNeeds } from "./need-definitions.js";

function makeState(overrides?: Partial<CharacterState>): CharacterState {
  return {
    id: "test",
    name: "测试角色",
    locationId: "home_test",
    needs: { ...getDefaultNeeds() },
    gold: 100,
    moodlets: [],
    inbox: [],
    inventory: [],
    recentActions: [],
    ...overrides,
  };
}

describe("Behavior Chains", () => {
  beforeEach(() => {
    resetBehaviorChainTriggers();
  });

  it("连续工作 8+ 次触发过劳 moodlet", () => {
    const state = makeState({
      recentActions: Array.from({ length: 10 }, (_, i) => ({
        actionId: "serve_customer",
        tick: 100 + i,
      })),
    });
    const moodlets = detectBehaviorPatterns(state, 112);
    expect(moodlets.length).toBe(1);
    expect(moodlets[0]!.id).toBe("chain_overwork");
    expect(moodlets[0]!.emotion).toBe("anxious");
  });

  it("工作次数不足不触发过劳", () => {
    const state = makeState({
      recentActions: [
        { actionId: "serve_customer", tick: 100 },
        { actionId: "serve_customer", tick: 101 },
        { actionId: "talk", tick: 102 },
      ],
    });
    const moodlets = detectBehaviorPatterns(state, 105);
    expect(moodlets.filter(m => m.id === "chain_overwork")).toHaveLength(0);
  });

  it("长期无社交 + social 低触发孤僻 moodlet", () => {
    const state = makeState({
      needs: { ...getDefaultNeeds(), social: 20 },
      recentActions: Array.from({ length: 6 }, (_, i) => ({
        actionId: "read",
        tick: 100 + i,
      })),
    });
    const moodlets = detectBehaviorPatterns(state, 108);
    expect(moodlets.some(m => m.id === "chain_lonely")).toBe(true);
  });

  it("有社交行为时不触发孤僻", () => {
    const state = makeState({
      needs: { ...getDefaultNeeds(), social: 20 },
      recentActions: [
        { actionId: "read", tick: 100 },
        { actionId: "talk", tick: 101 }, // 有社交！
        { actionId: "read", tick: 102 },
        { actionId: "read", tick: 103 },
      ],
    });
    const moodlets = detectBehaviorPatterns(state, 108);
    expect(moodlets.some(m => m.id === "chain_lonely")).toBe(false);
  });

  it("连续发呆触发无聊 moodlet", () => {
    const state = makeState({
      recentActions: Array.from({ length: 5 }, (_, i) => ({
        actionId: "idle",
        tick: 100 + i,
      })),
    });
    const moodlets = detectBehaviorPatterns(state, 106);
    expect(moodlets.some(m => m.id === "chain_bored_stiff")).toBe(true);
  });

  it("冷却期内不重复触发", () => {
    const state = makeState({
      recentActions: Array.from({ length: 10 }, (_, i) => ({
        actionId: "serve_customer",
        tick: 100 + i,
      })),
    });

    // 第一次触发
    const first = detectBehaviorPatterns(state, 112);
    expect(first.length).toBeGreaterThan(0);

    // 模拟 moodlet 已过期但还在冷却期
    const second = detectBehaviorPatterns(state, 115);
    expect(second.filter(m => m.id === "chain_overwork")).toHaveLength(0);
  });

  it("已有同类 moodlet 时不重复添加", () => {
    const state = makeState({
      moodlets: [{ id: "chain_overwork", emotion: "anxious", intensity: 3, reason: "test", expiresAtTick: 200, source: "event" }],
      recentActions: Array.from({ length: 10 }, (_, i) => ({
        actionId: "serve_customer",
        tick: 100 + i,
      })),
    });
    const moodlets = detectBehaviorPatterns(state, 112);
    expect(moodlets.filter(m => m.id === "chain_overwork")).toHaveLength(0);
  });

  it("大量社交触发社交疲惫", () => {
    const state = makeState({
      needs: { ...getDefaultNeeds(), social: 90 },
      recentActions: Array.from({ length: 7 }, (_, i) => ({
        actionId: "talk",
        tick: 100 + i,
      })),
    });
    const moodlets = detectBehaviorPatterns(state, 108);
    expect(moodlets.some(m => m.id === "chain_social_exhaustion")).toBe(true);
  });
});
