import { describe, it, expect } from "vitest";
import {
  dailyUpkeep, applyDailyUpkeep, financeBand, financeLabel, financeFeeling, financeMoodlet,
  seasonalPriceMultiplier, effectivePrice, getWorkIncome,
} from "./economy.js";
import type { CharacterState } from "./types.js";

function mkChar(gold: number, income?: number): CharacterState {
  return {
    id: "c", name: "C", gold, moodlets: [],
    life: income !== undefined ? { income } : undefined,
  } as unknown as CharacterState;
}

describe("dailyUpkeep", () => {
  it("higher earners owe more (progressive, not a poll tax)", () => {
    expect(dailyUpkeep(50)).toBeGreaterThan(dailyUpkeep(15));
  });
  it("always positive even with no income", () => {
    expect(dailyUpkeep(undefined)).toBeGreaterThan(0);
  });
});

describe("applyDailyUpkeep", () => {
  it("deducts the full cost when affordable", () => {
    const c = mkChar(200, 20);
    const r = applyDailyUpkeep(c, 100);
    expect(r.paid).toBe(true);
    expect(r.shortfall).toBe(0);
    expect(c.gold).toBe(200 - r.cost);
  });
  it("cannot pay in full → shortfall + anxiety moodlet + never negative gold", () => {
    const c = mkChar(3, 20);
    const r = applyDailyUpkeep(c, 100);
    expect(r.paid).toBe(false);
    expect(r.shortfall).toBeGreaterThan(0);
    expect(c.gold).toBe(0);
    expect(c.moodlets.some((m) => m.emotion === "anxious")).toBe(true);
  });
  it("writes a livelihood memory when short", () => {
    const c = mkChar(0, 20);
    const notes: string[] = [];
    applyDailyUpkeep(c, 100, { add: (_id, e) => notes.push(e.content) });
    expect(notes.join("")).toContain("生计");
  });
});

describe("finance perception", () => {
  it("band is measured in days-of-runway, not absolute gold", () => {
    // same gold, but a big spender is closer to broke than a frugal one
    expect(financeBand(60, 30)).toBe("tight");       // 2 days
    expect(financeBand(60, 3)).toBe("flush");         // 20 days
  });
  it("destitute vs flush labels", () => {
    expect(financeLabel(0, 20)).toBe("揭不开锅");
    expect(financeLabel(9999, 20)).toBe("宽裕");
  });
  it("financeFeeling stays quiet when comfortable, warns when tight", () => {
    expect(financeFeeling(9999, 20)).toBe("");
    expect(financeFeeling(5, 20)).toContain("金币");
  });
  it("financeMoodlet fires only when broke or worse", () => {
    const rich = mkChar(9999, 20); financeMoodlet(rich, 1);
    expect(rich.moodlets.length).toBe(0);
    const poor = mkChar(2, 20); financeMoodlet(poor, 1);
    expect(poor.moodlets.length).toBe(1);
  });
});

describe("seasonal market prices", () => {
  it("food is cheaper in autumn and dearer in winter", () => {
    expect(seasonalPriceMultiplier("consumable", "autumn")).toBeLessThan(1);
    expect(seasonalPriceMultiplier("consumable", "winter")).toBeGreaterThan(1);
  });
  it("unknown item types are unaffected", () => {
    expect(seasonalPriceMultiplier(undefined, "winter")).toBe(1);
  });
  it("effectivePrice never drops below 1", () => {
    expect(effectivePrice(1, "nonexistent_item", "autumn")).toBeGreaterThanOrEqual(1);
  });
});

describe("existing income helper still works", () => {
  it("falls back to 15 for unknown occupations", () => {
    expect(getWorkIncome("无业游民")).toBe(15);
  });
});
