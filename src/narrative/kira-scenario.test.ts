/** kira-incident 剧本包完整性：manifest 新字段解析 + 信息图 visible_to + 开局道具应用。 */
import { describe, it, expect } from "vitest";
import { loadScenario, applyInitialItems, applyKiraProtections } from "./scenario-loader.js";
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

  it("beats：5 个到期日节拍 + 3 个后续幕状态节拍（应验后/第二例后/拆穿后）", () => {
    const ids = scenario.beats.map((b) => b.id);
    expect(ids).toEqual([
      "kira_d1_night_book_calls",
      "kira_d2_first_crime",
      "kira_d2_client_checkin",
      "kira_d4_client_pressure",
      "kira_d6_typhoon_closes_in",
      "kira_aftermath_first_victim",
      "kira_aftermath_pattern_talk",
      "kira_after_expose_showdown",
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

  it("真名保护：manifest 解析 + applyKiraProtections 写进 world", () => {
    expect(scenario.manifest.kiraAliasProtected).toEqual(["l_lawliet"]);
    const world = new World(TEST_LOCATIONS, 24);
    applyKiraProtections(world, scenario.manifest);
    expect(world.kira.aliasProtected.has("l_lawliet")).toBe(true);
  });

  it("议程种子带正典浓度：无例外项 + 真名规则进规则卡", () => {
    const seeds = scenario.seeds!;
    const byId = Object.fromEntries(seeds.unresolvedEvents.map((e) => [e.id, e]));
    expect(byId.kira_worldview!.summary).toContain("没有例外项");
    expect(byId.kira_notebook_found!.summary).toContain("真名");
  });
});
