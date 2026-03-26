/**
 * Test World Factory — 创建测试用的小镇
 */

import type { Location } from "../../src/world/types.js";
import { World } from "../../src/world/world.js";

const HOME_TOOLS = [
  { name: "sleep", description: "睡觉", effects: { energy: 100 }, duration: 32, condition: "energy < 80" },
  { name: "wash", description: "洗澡", effects: { hygiene: 100 }, duration: 2 },
  { name: "cook", description: "做饭", effects: { hunger: 60, fun: 5, energy: -8, hygiene: -5 }, duration: 3 },
  { name: "use_toilet", description: "上厕所", effects: { bladder: 100 }, duration: 1 },
  { name: "nap", description: "小睡一会儿", effects: { energy: 25, fun: -5 }, duration: 4, condition: "energy < 60" },
];

export const TEST_LOCATIONS: Location[] = [
  { id: "home_tomori", name: "灯的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "home_anon", name: "爱音的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "cafe", name: "咖啡馆", type: "commercial", summary: "喝咖啡、吃东西", openHours: { open: 7, close: 22 }, presentCharacters: [], tools: [
    { name: "eat", description: "吃东西（15金币）", effects: { hunger: 50, energy: 10 }, cost: 15, duration: 2 },
    { name: "drink", description: "喝咖啡（8金币）", effects: { energy: 5, fun: 8 }, cost: 8, duration: 2 },
  ] },
  { id: "plaza", name: "广场", type: "public", presentCharacters: [] },
  { id: "shop", name: "杂货店", type: "commercial", openHours: { open: 8, close: 20 }, presentCharacters: [] },
  { id: "flower_shop", name: "潮声花店", type: "commercial", openHours: { open: 8, close: 18 }, presentCharacters: [] },
  { id: "dock", name: "码头", type: "nature", presentCharacters: [] },
  { id: "bar", name: "酒吧", type: "commercial", openHours: { open: 17, close: 2 }, presentCharacters: [] },
  { id: "beach", name: "海边", type: "nature", presentCharacters: [], tools: [
    { name: "swim", description: "游泳", effects: { energy: -10, fun: 15 }, duration: 4 },
  ] },
  { id: "forest", name: "森林", type: "nature", presentCharacters: [] },
  { id: "farm", name: "农田", type: "nature", presentCharacters: [] },
  { id: "library", name: "图书馆", type: "public", openHours: { open: 9, close: 18 }, presentCharacters: [], tools: [
    { name: "read", description: "看书", effects: { fun: 10 }, duration: 4 },
  ] },
];

export function createTestWorld(options?: { tick?: number }): World {
  const world = new World(TEST_LOCATIONS, options?.tick ?? 0);
  return world;
}

export function createTestWorldWithCharacters(options?: { tick?: number }): World {
  const world = createTestWorld(options);
  world.addCharacter("tomori", "高松灯", "home_tomori");
  world.addCharacter("anon", "千早爱音", "home_anon");
  return world;
}
