import { describe, it, expect } from "vitest";
import {
  computeTemperature, comfortBand, comfortLabel, isSheltered,
  climateNeedEffects, applyClimateMoodlet, climateEnvLine, climateHint, seasonAmbient,
} from "./climate.js";
import type { CharacterState, Location } from "./types.js";

function loc(id: string, type: Location["type"]): Location {
  return { id, name: id, type, presentCharacters: [] };
}

describe("computeTemperature", () => {
  it("winter is far colder than summer at the same hour", () => {
    expect(computeTemperature("winter", "sunny", 14)).toBeLessThan(
      computeTemperature("summer", "sunny", 14),
    );
  });

  it("night is colder than midday within a season", () => {
    expect(computeTemperature("spring", "cloudy", 5)).toBeLessThan(
      computeTemperature("spring", "cloudy", 14),
    );
  });

  it("bad weather pulls temperature down", () => {
    expect(computeTemperature("autumn", "stormy", 12)).toBeLessThan(
      computeTemperature("autumn", "sunny", 12),
    );
  });
});

describe("comfortBand / comfortLabel", () => {
  it("classifies the extremes", () => {
    expect(comfortBand(-3)).toBe("freezing");
    expect(comfortBand(20)).toBe("mild");
    expect(comfortBand(35)).toBe("hot");
    expect(comfortLabel(20)).toBe("凉爽宜人");
  });
});

describe("isSheltered", () => {
  it("indoor location types are sheltered", () => {
    expect(isSheltered(loc("cafe", "commercial"))).toBe(true);
    expect(isSheltered(loc("home_shinji", "residential"))).toBe(true);
    expect(isSheltered(loc("library", "public"))).toBe(true); // 唯一室内 public
  });
  it("open-air locations are exposed", () => {
    expect(isSheltered(loc("beach", "nature"))).toBe(false);
    expect(isSheltered(loc("plaza", "public"))).toBe(false);
  });
  it("unknown location defaults to sheltered (no punishment)", () => {
    expect(isSheltered(undefined)).toBe(true);
  });
});

describe("climateNeedEffects", () => {
  it("sheltered characters take zero climate hit", () => {
    expect(climateNeedEffects(-5, "stormy", true)).toEqual({});
  });
  it("standing outside in a storm drains hygiene/fun/energy", () => {
    const eff = climateNeedEffects(5, "stormy", false);
    expect(eff.hygiene).toBeLessThan(0);
    expect(eff.fun).toBeLessThan(0);
    expect(eff.energy).toBeLessThan(0);
  });
  it("freezing cold outdoors drains energy", () => {
    expect(climateNeedEffects(-2, "cloudy", false).energy).toBeLessThan(0);
  });
  it("a mild sunny day outdoors is a small mood lift", () => {
    expect(climateNeedEffects(20, "sunny", false).fun).toBeGreaterThan(0);
  });
});

describe("applyClimateMoodlet", () => {
  function mkChar(): CharacterState {
    return { moodlets: [] } as unknown as CharacterState;
  }
  it("rain outdoors adds a discomfort moodlet", () => {
    const c = mkChar();
    applyClimateMoodlet(c, 12, "rainy", false, 100);
    expect(c.moodlets.length).toBe(1);
    expect(c.moodlets[0]!.reason).toContain("雨");
  });
  it("indoors adds nothing", () => {
    const c = mkChar();
    applyClimateMoodlet(c, 12, "rainy", true, 100);
    expect(c.moodlets.length).toBe(0);
  });
  it("a nice sunny day outdoors adds a happy moodlet", () => {
    const c = mkChar();
    applyClimateMoodlet(c, 22, "sunny", false, 100);
    expect(c.moodlets[0]!.emotion).toBe("happy");
  });
});

describe("perception strings", () => {
  it("env line carries temperature and comfort", () => {
    const line = climateEnvLine("winter", "snowy", 14);
    expect(line).toContain("°C");
    expect(line).toContain("（");
  });
  it("rainy weather yields an umbrella hint", () => {
    expect(climateHint("spring", "rainy", 12)).toContain("伞");
  });
  it("every season has ambient flavor text", () => {
    for (const s of ["spring", "summer", "autumn", "winter"] as const) {
      expect(seasonAmbient(s).length).toBeGreaterThan(4);
    }
  });
});
