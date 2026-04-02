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

    // Should have all 17 locations (7 residential + 10 public)
    expect(locations.length).toBe(17);

    // Check a commercial location has atmosphere
    const cafe = locations.find((l) => l.id === "cafe");
    expect(cafe).toBeDefined();
    expect(cafe!.atmosphere).toBeDefined();
    expect(cafe!.atmosphere!.morning).toBeTruthy();
    expect(cafe!.atmosphere!.rainy).toBeTruthy();

    // Check residential locations loaded from homes array
    const homeTomori = locations.find((l) => l.id === "home_tomori");
    expect(homeTomori).toBeDefined();
    expect(homeTomori!.type).toBe("residential");
    expect(homeTomori!.atmosphere).toBeDefined();

    // Check nature location
    const beach = locations.find((l) => l.id === "beach");
    expect(beach).toBeDefined();
    expect(beach!.type).toBe("nature");
    expect(beach!.atmosphere!.evening).toBeTruthy();
  });
});
