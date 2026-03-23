import { describe, it, expect } from "vitest";
import {
  calculateTemporalDecayMultiplier,
  applyTemporalDecayToScore,
  applyDecayByTick,
} from "./temporal-decay.js";

describe("calculateTemporalDecayMultiplier", () => {
  it("age=0 → multiplier=1", () => {
    expect(calculateTemporalDecayMultiplier({ ageInDays: 0, halfLifeDays: 14 })).toBe(1);
  });

  it("age=halfLife → multiplier≈0.5", () => {
    const m = calculateTemporalDecayMultiplier({ ageInDays: 14, halfLifeDays: 14 });
    expect(m).toBeCloseTo(0.5, 5);
  });

  it("age=2*halfLife → multiplier≈0.25", () => {
    const m = calculateTemporalDecayMultiplier({ ageInDays: 28, halfLifeDays: 14 });
    expect(m).toBeCloseTo(0.25, 5);
  });

  it("halfLife=0 → multiplier=1 (no decay)", () => {
    expect(calculateTemporalDecayMultiplier({ ageInDays: 100, halfLifeDays: 0 })).toBe(1);
  });
});

describe("applyTemporalDecayToScore", () => {
  it("衰减分数", () => {
    const result = applyTemporalDecayToScore({ score: 1.0, ageInDays: 14, halfLifeDays: 14 });
    expect(result).toBeCloseTo(0.5, 5);
  });
});

describe("applyDecayByTick", () => {
  it("基于 tick 差值衰减", () => {
    const items = [
      { id: "a", score: 1.0, tick: 0 },     // 很久以前
      { id: "b", score: 1.0, tick: 1344 },   // 14 天前 (14*96)
      { id: "c", score: 1.0, tick: 1440 },   // 当前附近
    ];
    const currentTick = 1440; // 15 天

    const result = applyDecayByTick(items, currentTick);
    // a: 15 天前，衰减最多
    // b: 1 天前，衰减较少
    // c: 0 天前，几乎不衰减
    expect(result[0].score).toBeLessThan(result[1].score);
    expect(result[1].score).toBeLessThan(result[2].score);
  });

  it("disabled 时不衰减", () => {
    const items = [{ id: "a", score: 1.0, tick: 0 }];
    const result = applyDecayByTick(items, 10000, { enabled: false });
    expect(result[0].score).toBe(1.0);
  });
});
