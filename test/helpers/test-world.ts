/**
 * Test World Factory — 创建测试用的小镇
 */

import type { Location } from "../../src/world/types.js";
import { World } from "../../src/world/world.js";

const HOME_TOOLS = [
  { name: "sleep", description: "睡觉", effects: { energy: 100 }, duration: 32, condition: "energy < 80" },
  { name: "wash", description: "洗澡", effects: { hygiene: 100 }, duration: 2 },
  { name: "use_toilet", description: "上厕所", effects: { bladder: 100 }, duration: 1 },
  { name: "nap", description: "小睡一会儿", effects: { energy: 25, fun: -5 }, duration: 4, condition: "energy < 60" },
];

export const TEST_LOCATIONS: Location[] = [
  { id: "home_tomori", name: "灯的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "home_anon", name: "爱音的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "cafe", name: "咖啡馆", type: "commercial", summary: "喝咖啡、吃东西", openHours: { open: 7, close: 22 }, presentCharacters: [],
    tools: [{ name: "use_toilet", description: "上厕所", effects: { bladder: 100 }, duration: 1 }],
    shop: [
      { id: "coffee_latte", name: "拿铁", price: 8 },
      { id: "sandwich", name: "三明治", price: 12 },
    ],
  },
  { id: "plaza", name: "广场", type: "public", presentCharacters: [] },
  { id: "shop", name: "杂货店", type: "commercial", openHours: { open: 8, close: 20 }, presentCharacters: [],
    shop: [
      { id: "ingredients", name: "食材", price: 5 },
      { id: "notebook", name: "笔记本", price: 10 },
      { id: "bento", name: "便当", price: 10 },
    ],
  },
  { id: "flower_shop", name: "潮声花店", type: "commercial", openHours: { open: 8, close: 18 }, presentCharacters: [],
    shop: [{ id: "flower_bouquet", name: "花束", price: 15 }],
  },
  { id: "dock", name: "码头", type: "nature", presentCharacters: [],
    tools: [{ name: "explore", description: "在码头逛逛", effects: { fun: 5, energy: -2 }, duration: 2 }],
  },
  { id: "bar", name: "酒吧", type: "commercial", openHours: { open: 17, close: 2 }, presentCharacters: [],
    shop: [{ id: "beer", name: "啤酒", price: 10 }],
  },
  { id: "beach", name: "海边", type: "nature", presentCharacters: [], tools: [
    { name: "swim", description: "游泳", effects: { energy: -10, fun: 25, hygiene: -15 }, duration: 3 },
  ] },
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
  world.addCharacter("tomori", "高松灯", "home_tomori");
  world.addCharacter("anon", "千早爱音", "home_anon");
  return world;
}
