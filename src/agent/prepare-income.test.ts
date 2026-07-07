/**
 * prepare 计件工钱回归测试（经济通缩调参）
 *
 * prepare 是全镇最高频的工作行为（7 天基线 205 次），此前收入为 0——
 * 员工整天补货架却颗粒无收，是全员赤贫的主根。现在按件给工钱，
 * 但货架满（≥8）不给，防止原地刷钱。
 */

import { describe, it, expect } from "vitest";
import { buildToolList } from "./tool-builder.js";
import { World } from "../world/world.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

function makeEmployeeCard(): CharacterCard {
  return {
    id: "tomori", name: "高松灯", age: 19, occupation: "咖啡馆店员", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
    life: { workplace: "cafe" } as any,
  };
}

function buildPrepareCtx() {
  const world = new World(TEST_LOCATIONS, 40);
  world.addCharacter("tomori", "高松灯", "cafe");
  const state = world.getCharacter("tomori")!;
  state.life = { ...(state.life as any), workplace: "cafe" } as any;
  const location = world.getLocation("cafe")!;
  const tools = buildToolList({
    state, card: makeEmployeeCard(), location,
    nearbyCharacters: [], allLocations: world.getAllLocations(), gold: state.gold,
  });
  const prepare = tools.find(t => t.tool.name === "prepare");
  expect(prepare).toBeDefined();
  const firstItem = location.shop![0]!;
  return { prepare: prepare!, location, firstItem };
}

describe("prepare 计件工钱", () => {
  it("货架未满：做一件给 3 金币工钱 + 产出进货架", () => {
    const { prepare, firstItem } = buildPrepareCtx();
    const result = prepare.handler({ item: firstItem.name }, { characterId: "tomori", workSkill: "barista" } as any) as any;
    expect(result.success).not.toBe(false);
    expect(result._workerIncome).toBe(3);
    expect(result._stockItem?.defId).toBe(firstItem.id);
  });

  it("货架已满（≥8）：照样能做但没有工钱，描述说明老板不付钱", () => {
    const { prepare, location, firstItem } = buildPrepareCtx();
    location.stock = { [firstItem.id]: 8 };
    const result = prepare.handler({ item: firstItem.name }, { characterId: "tomori", workSkill: "barista" } as any) as any;
    expect(result._workerIncome).toBeUndefined();
    expect(result.description).toContain("工钱");
    // 产出仍进货架（agent-loop 侧 Math.min(8) 封顶）
    expect(result._stockItem?.defId).toBe(firstItem.id);
  });

  it("体力不足（<15）执行期拒绝", () => {
    const { firstItem } = buildPrepareCtx();
    const world = new World(TEST_LOCATIONS, 40);
    world.addCharacter("tomori", "高松灯", "cafe");
    const state = world.getCharacter("tomori")!;
    state.life = { ...(state.life as any), workplace: "cafe" } as any;
    state.needs.energy = 5;
    const tools = buildToolList({
      state, card: makeEmployeeCard(), location: world.getLocation("cafe")!,
      nearbyCharacters: [], allLocations: world.getAllLocations(), gold: state.gold,
    });
    const lowEnergyPrepare = tools.find(t => t.tool.name === "prepare")!;
    const result = lowEnergyPrepare.handler({ item: firstItem.name }, { characterId: "tomori" } as any) as any;
    expect(result.success).toBe(false);
    expect(result._workerIncome).toBeUndefined();
  });
});
