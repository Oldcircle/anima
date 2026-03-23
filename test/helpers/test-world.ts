/**
 * Test World Factory — 创建测试用的小镇
 */

import type { Location } from "../../src/world/types.js";
import { World } from "../../src/world/world.js";

export const TEST_LOCATIONS: Location[] = [
  { id: "home_alice", name: "Alice 的家", type: "residential", presentCharacters: [] },
  { id: "home_bob", name: "Bob 的家", type: "residential", presentCharacters: [] },
  { id: "cafe", name: "咖啡馆", type: "commercial", openHours: { open: 7, close: 22 }, presentCharacters: [] },
  { id: "plaza", name: "广场", type: "public", presentCharacters: [] },
  { id: "shop", name: "杂货店", type: "commercial", openHours: { open: 8, close: 20 }, presentCharacters: [] },
  { id: "flower_shop", name: "Alice的花店", type: "commercial", openHours: { open: 8, close: 18 }, presentCharacters: [] },
  { id: "dock", name: "码头", type: "nature", presentCharacters: [] },
  { id: "bar", name: "酒吧", type: "commercial", openHours: { open: 17, close: 2 }, presentCharacters: [] },
  { id: "beach", name: "海边", type: "nature", presentCharacters: [] },
  { id: "forest", name: "森林", type: "nature", presentCharacters: [] },
  { id: "farm", name: "农田", type: "nature", presentCharacters: [] },
  { id: "library", name: "图书馆", type: "public", openHours: { open: 9, close: 18 }, presentCharacters: [] },
];

export function createTestWorld(options?: { tick?: number }): World {
  const world = new World(TEST_LOCATIONS, options?.tick ?? 0);
  return world;
}

export function createTestWorldWithCharacters(options?: { tick?: number }): World {
  const world = createTestWorld(options);
  world.addCharacter("alice", "Alice Chen", "home_alice");
  world.addCharacter("bob", "Bob Wang", "home_bob");
  return world;
}
