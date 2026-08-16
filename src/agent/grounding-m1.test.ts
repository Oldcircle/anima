/**
 * 器物层 M1 注入与触发（PLAN-grounding）单测
 *
 * 锁形状：
 * - examine 工具浮现：地点有器物才上架；ANIMA_GROUNDING=0 不上架（off 档 A/B）
 * - examine 工具描述随地点静态（相邻 tick 需求/金币抖动下逐字节一致——缓存纪律）
 * - examine 执行：命中返回 ground truth 进 description；命不中自然语言反馈 success:false
 * - 环境快照：意图指路 + 重访 diff 进此刻区；off 档零输出
 * - buildUserPrompt：骨架行跟在「你现在看到的」氛围块；无骨架时该块不含器物字样
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildToolList, buildEnvironmentSnapshot, type ToolBuildContext } from "./tool-builder.js";
import { buildUserPrompt } from "./prompt-builder.js";
import { World } from "../world/world.js";
import { WorldObjectStore } from "../world/world-objects.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";
import { tickToGameTime } from "../core/tick-engine.js";

const LOCATIONS: Location[] = [
  {
    id: "library",
    name: "图书馆",
    type: "public",
    openHours: null,
    presentCharacters: [],
    objects: [
      {
        id: "ledger",
        name: "借阅台账",
        summary: "前台那本厚台账",
        keywords: ["台账", "借阅", "记录"],
        canon: ["台账按月换页"],
        tamperable: true,
      },
      { id: "shelves", name: "书架", summary: "一排排高书架", keywords: ["书架"] },
    ],
  } as Location,
  { id: "beach", name: "海滩", type: "nature", openHours: null, presentCharacters: [] } as Location,
];

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 24, occupation: "侦探", home: "library",
    personality: { traits: ["观察"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function makeWorld(at = "library"): World {
  const world = new World(LOCATIONS.map((l) => ({ ...l, presentCharacters: [] })), 40);
  world.addCharacter("l", "L", at);
  return world;
}

function ctxFor(world: World, id: string, opts: { tick?: number; intentTexts?: string[] } = {}): ToolBuildContext {
  const state = world.getCharacter(id)!;
  const location = world.getLocation(state.locationId)!;
  return {
    state,
    card: makeCard(id, state.name),
    location,
    nearbyCharacters: [],
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: 10,
    tick: opts.tick ?? 40,
    objects: world.objects,
    intentTexts: opts.intentTexts,
  };
}

beforeEach(() => {
  delete process.env.ANIMA_GROUNDING;
});
afterEach(() => {
  delete process.env.ANIMA_GROUNDING;
});

describe("examine 工具浮现", () => {
  it("地点有器物才上架；无器物地点不上架", () => {
    const world = makeWorld("library");
    expect(buildToolList(ctxFor(world, "l")).map((t) => t.tool.name)).toContain("examine");
    world.moveCharacter("l", "beach");
    expect(buildToolList(ctxFor(world, "l")).map((t) => t.tool.name)).not.toContain("examine");
  });

  it("ANIMA_GROUNDING=0：工具不上架、快照零器物行、骨架 undefined（off 档 A/B）", () => {
    process.env.ANIMA_GROUNDING = "0";
    const world = makeWorld("library");
    const ctx = ctxFor(world, "l", { intentTexts: ["查借阅记录"] });
    expect(buildToolList(ctx).map((t) => t.tool.name)).not.toContain("examine");
    expect(buildEnvironmentSnapshot(ctx)).not.toContain("借阅台账");
  });

  it("工具描述随地点静态：需求/金币/tick 抖动下逐字节一致（缓存纪律）", () => {
    const world = makeWorld("library");
    const d1 = buildToolList(ctxFor(world, "l", { tick: 40 })).find((t) => t.tool.name === "examine")!.tool.description;
    const state = world.getCharacter("l")!;
    state.gold = 3;
    state.needs.hunger = 5;
    world.objects.addTrace("library.ledger", { id: "t", text: "被撕了一页", addedTick: 41, source: "event" });
    const d2 = buildToolList(ctxFor(world, "l", { tick: 41 })).find((t) => t.tool.name === "examine")!.tool.description;
    expect(d2).toBe(d1);
    expect(d1).toContain("借阅台账、书架");
  });
});

describe("examine 执行", () => {
  const actionCtx = { characterId: "l", locationId: "library", locationType: "public", tick: 50, nearbyCharacters: [], gold: 100, needs: {} };

  it("命中：返回 ground truth（骨架+正典+痕迹）并落 lastSeen", () => {
    const world = makeWorld("library");
    world.objects.addTrace("library.ledger", { id: "torn", text: "最新一页被撕掉了", addedTick: 45, source: "event" });
    const examine = buildToolList(ctxFor(world, "l")).find((t) => t.tool.name === "examine")!;
    const result = examine.handler({ thought: "查记录", target: "借阅记录" }, actionCtx);
    expect(result.success).not.toBe(false);
    expect(result.description).toContain("借阅台账");
    expect(result.description).toContain("台账按月换页");
    expect(result.description).toContain("最新一页被撕掉了");
    expect(world.objects.get("library.ledger")!.lastSeen["l"]!.tick).toBe(50);
  });

  it("命不中：自然语言反馈 + success:false（tool-feedback 纠偏）", () => {
    const world = makeWorld("library");
    const examine = buildToolList(ctxFor(world, "l")).find((t) => t.tool.name === "examine")!;
    const result = examine.handler({ thought: "看看", target: "烤炉" }, actionCtx);
    expect(result.success).toBe(false);
    expect(result.description).toContain("借阅台账");
  });
});

describe("环境快照触发线", () => {
  it("意图指路进此刻区；看过后不刷屏；改动后 diff 行出现", () => {
    const world = makeWorld("library");
    const snap1 = buildEnvironmentSnapshot(ctxFor(world, "l", { intentTexts: ["把借阅记录调出来"] }));
    expect(snap1).toContain("借阅台账");
    expect(snap1).toContain("凑近仔细看看");

    world.objects.examine("library.ledger", "l", 50);
    const snap2 = buildEnvironmentSnapshot(ctxFor(world, "l", { intentTexts: ["把借阅记录调出来"] }));
    expect(snap2).not.toContain("借阅台账");

    world.objects.addTrace("library.ledger", { id: "torn", text: "x", addedTick: 60, source: "interaction" });
    const snap3 = buildEnvironmentSnapshot(ctxFor(world, "l"));
    expect(snap3).toContain("不太一样");
  });
});

describe("user prompt 骨架行", () => {
  function promptFor(world: World, skeleton?: string): string {
    return buildUserPrompt({
      card: makeCard("l", "L"),
      state: world.getCharacter("l")!,
      gameTime: tickToGameTime(40),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "图书馆",
      allLocationNames: [],
      objectSkeleton: skeleton,
    });
  }

  it("骨架行跟在「你现在看到的」块；无骨架时不含器物字样", () => {
    const world = makeWorld("library");
    const withSkeleton = promptFor(world, world.objects.describeSkeleton("library"));
    expect(withSkeleton).toContain("这里值得留意的有：借阅台账、书架。");
    const seeIdx = withSkeleton.indexOf("## 你现在看到的");
    const timeIdx = withSkeleton.indexOf("\n时间: ");
    const skelIdx = withSkeleton.indexOf("这里值得留意的有");
    expect(seeIdx).toBeGreaterThanOrEqual(0);
    expect(skelIdx).toBeGreaterThan(seeIdx);
    expect(skelIdx).toBeLessThan(timeIdx); // 稳定区，不在此刻区之后

    const without = promptFor(world, undefined);
    expect(without).not.toContain("值得留意");
  });
});
