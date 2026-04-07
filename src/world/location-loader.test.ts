import { describe, it, expect } from "vitest";
import { getAtmosphereText, loadLocationsFromDir } from "./location-loader.js";
import { join } from "node:path";
import type { LocationAtmosphere } from "./types.js";

const testAtmosphere: LocationAtmosphere = {
  morning: "Morning light fills the room.",
  afternoon: "Afternoon sun warms the floor.",
  evening: "Evening glow through the window.",
  night: "Quiet darkness outside.",
  rainy: "Rain patters on the roof.",
};

describe("getAtmosphereText", () => {
  it("returns morning text for 6-11h", () => {
    expect(getAtmosphereText(testAtmosphere, 6, "sunny")).toBe("Morning light fills the room.");
    expect(getAtmosphereText(testAtmosphere, 11, "sunny")).toBe("Morning light fills the room.");
  });

  it("returns afternoon text for 12-16h", () => {
    expect(getAtmosphereText(testAtmosphere, 12, "sunny")).toBe("Afternoon sun warms the floor.");
    expect(getAtmosphereText(testAtmosphere, 16, "sunny")).toBe("Afternoon sun warms the floor.");
  });

  it("returns evening text for 17-20h", () => {
    expect(getAtmosphereText(testAtmosphere, 17, "sunny")).toBe("Evening glow through the window.");
    expect(getAtmosphereText(testAtmosphere, 20, "sunny")).toBe("Evening glow through the window.");
  });

  it("returns night text for 21-5h", () => {
    expect(getAtmosphereText(testAtmosphere, 21, "sunny")).toBe("Quiet darkness outside.");
    expect(getAtmosphereText(testAtmosphere, 0, "sunny")).toBe("Quiet darkness outside.");
    expect(getAtmosphereText(testAtmosphere, 5, "sunny")).toBe("Quiet darkness outside.");
  });

  it("returns rainy text for rainy/stormy/snowy weather regardless of time", () => {
    expect(getAtmosphereText(testAtmosphere, 10, "rainy")).toBe("Rain patters on the roof.");
    expect(getAtmosphereText(testAtmosphere, 15, "stormy")).toBe("Rain patters on the roof.");
    expect(getAtmosphereText(testAtmosphere, 20, "snowy")).toBe("Rain patters on the roof.");
  });

  it("falls back to time-based when no rainy text", () => {
    const noRainy: LocationAtmosphere = { morning: "Morning.", afternoon: "Afternoon." };
    expect(getAtmosphereText(noRainy, 10, "rainy")).toBe("Morning.");
  });

  it("returns undefined for empty atmosphere", () => {
    expect(getAtmosphereText(undefined, 10, "sunny")).toBeUndefined();
    expect(getAtmosphereText({}, 10, "sunny")).toBeUndefined();
  });
});

describe("loadLocationsFromDir", () => {
  it("loads all locations from data/locations", () => {
    const dir = join(import.meta.dirname, "..", "..", "data", "locations");
    const locations = loadLocationsFromDir(dir);

    // residential.yml: 6 个原角色家（已 disabled，跳过）+ 7 个动漫角色家 = 7
    // 加上 commercial / public / nature 共 11 个 → 18
    expect(locations.length).toBe(18);

    // Check a commercial location has atmosphere
    const cafe = locations.find((l) => l.id === "cafe");
    expect(cafe).toBeDefined();
    expect(cafe!.atmosphere).toBeDefined();
    expect(cafe!.atmosphere!.morning).toBeTruthy();
    expect(cafe!.atmosphere!.rainy).toBeTruthy();

    // Check residential locations loaded from homes array
    // home_tomori 已 disabled，改用 home_l 验证 multi-home 加载
    const homeL = locations.find((l) => l.id === "home_l");
    expect(homeL).toBeDefined();
    expect(homeL!.type).toBe("residential");
    expect(homeL!.atmosphere).toBeDefined();

    // Check nature location
    const beach = locations.find((l) => l.id === "beach");
    expect(beach).toBeDefined();
    expect(beach!.type).toBe("nature");
    expect(beach!.atmosphere!.evening).toBeTruthy();
  });
});
