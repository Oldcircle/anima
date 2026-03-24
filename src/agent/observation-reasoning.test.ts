import { describe, it, expect } from "vitest";
import { shouldObserve } from "./observation-reasoning.js";
import type { CharacterState } from "../world/types.js";

function makeState(overrides?: Partial<CharacterState>): CharacterState {
  return {
    id: "alice",
    name: "Alice Chen",
    locationId: "cafe",
    needs: { hunger: 60, energy: 60, social: 40, happiness: 60, hygiene: 60 },
    gold: 100,
    inbox: [],
    ...overrides,
  };
}

describe("shouldObserve", () => {
  it("空闲 + 有人 + 无冷却 → 可以观察", () => {
    expect(shouldObserve(makeState(), undefined, 10, 2)).toBe(true);
  });

  it("正在执行多 tick 行为 → 不观察", () => {
    const state = makeState({ currentAction: { name: "work", remainingTicks: 3 } });
    expect(shouldObserve(state, undefined, 10, 2)).toBe(false);
  });

  it("单 tick 行为即将结束 → 可以观察", () => {
    const state = makeState({ currentAction: { name: "eat", remainingTicks: 1 } });
    expect(shouldObserve(state, undefined, 10, 2)).toBe(true);
  });

  it("没有可观察的人 → 不观察", () => {
    expect(shouldObserve(makeState(), undefined, 10, 0)).toBe(false);
  });

  it("冷却中（上次观察在 2 tick 前）→ 不观察", () => {
    expect(shouldObserve(makeState(), 8, 10, 2)).toBe(false);
  });

  it("冷却结束（上次观察在 4 tick 前）→ 可以观察", () => {
    expect(shouldObserve(makeState(), 6, 10, 2)).toBe(true);
  });

  it("冷却结束（上次观察在 5 tick 前）→ 可以观察", () => {
    expect(shouldObserve(makeState(), 5, 10, 2)).toBe(true);
  });
});
