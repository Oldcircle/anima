/** kira-incident 剧本包完整性：manifest 新字段解析 + 信息图 visible_to + 开局道具应用。 */
import { describe, it, expect } from "vitest";
import { loadScenario, applyInitialItems } from "./scenario-loader.js";
import { World } from "../world/world.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { hasItem } from "../world/item-registry.js";

describe("kira-incident 剧本包", () => {
  const scenario = loadScenario("kira-incident");

  it("manifest：7 人阵容 + strong + third + 开局道具", () => {
    expect(scenario.characters.length).toBe(7);
    expect(scenario.manifest.breakLevel).toBe("strong");
    expect(scenario.manifest.decisionPov).toBe("third");
    expect(scenario.manifest.initialItems).toEqual({ light: ["cursed_notebook"] });
  });

  it("信息图：light 独知册子与议程，L 独知委托，互不可见", () => {
    const seeds = scenario.seeds!;
    expect(seeds.activePhase).toBe("kira");
    const byId = Object.fromEntries(seeds.unresolvedEvents.map((e) => [e.id, e]));
    expect(byId.kira_notebook_found!.visibleTo).toEqual(["light"]);
    expect(byId.kira_worldview!.visibleTo).toEqual(["light"]);
    expect(byId.kira_client_letter!.visibleTo).toEqual(["l_lawliet"]);
  });

  it("beats：4 个到期日节拍，D1 夜 / D2 晨 / D4 催函 / D6 台风", () => {
    const ids = scenario.beats.map((b) => b.id);
    expect(ids).toEqual([
      "kira_d1_night_book_calls",
      "kira_d2_client_checkin",
      "kira_d4_client_pressure",
      "kira_d6_typhoon_closes_in",
    ]);
  });

  it("applyInitialItems：册子进 light 背包，其他人没有", () => {
    const world = new World(TEST_LOCATIONS, 24);
    world.addCharacter("light", "夜神月", "cafe");
    world.addCharacter("shinji", "碇真嗣", "cafe");
    applyInitialItems(world, scenario.manifest);
    expect(hasItem(world.getCharacter("light")!.inventory, "cursed_notebook")).toBe(true);
    expect(hasItem(world.getCharacter("shinji")!.inventory, "cursed_notebook")).toBe(false);
  });
});
