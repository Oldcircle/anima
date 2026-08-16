/**
 * 罪案→器物落痕（PLAN-grounding M0 任务3）单测
 *
 * 锁形状：applyTheftWithPerp 在发现地点的钱盒类器物上留撬痕 trace——
 * examine 查得到、重访 diff 认得出；发现地点没有钱盒类器物则静默跳过（增强不是硬依赖）。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { World } from "../world/world.js";
import type { Location } from "../world/types.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { applyTheftWithPerp } from "./world-events.js";
import { setBreakLevel } from "../agent/break-config.js";

const LOCATIONS: Location[] = [
  { id: "park", name: "公园", type: "public", openHours: null, presentCharacters: [] } as Location,
  {
    id: "bakery",
    name: "面包店",
    type: "commercial",
    openHours: null,
    presentCharacters: [],
    objects: [
      {
        id: "register",
        name: "收银台",
        summary: "柜台一角的收银台",
        keywords: ["收银", "钱盒", "货款"],
        tamperable: true,
      },
    ],
  } as Location,
];

function makeWorld(withTillObject = true): World {
  const locs = withTillObject
    ? LOCATIONS
    : LOCATIONS.map((l) => ({ ...l, objects: undefined }));
  const w = new World(locs.map((l) => ({ ...l, presentCharacters: [] })));
  w.addCharacter("victim", "小美", "park");
  w.getCharacter("victim")!.gold = 100;
  w.addCharacter("npc_drifter", "外乡流浪汉", "park");
  w.narrative.registerNpc("npc_drifter", "外乡流浪汉");
  return w;
}

beforeEach(() => {
  setBreakLevel("mild");
});

function doTheft(world: World) {
  return applyTheftWithPerp(
    { world, memory: new ShortTermMemory(), tick: 40 },
    {
      perpId: "npc_drifter",
      victimId: "victim",
      amount: 50,
      discoveryLocationId: "bakery",
      cause: "月底要结货款，钱一直收在店里",
    },
  );
}

describe("theft → 器物落痕", () => {
  it("发现地点的钱盒类器物落撬痕：examine 查得到，作案即存在（早于发现）", () => {
    const world = makeWorld();
    const outcome = doTheft(world);
    expect(outcome.ok).toBe(true);
    const till = world.objects.get("bakery.register")!;
    expect(till.traces).toHaveLength(1);
    expect(till.traces[0]!.text).toContain("撬痕");
    expect(world.objects.examine("bakery.register", "l", 41)).toContain("撬痕");
  });

  it("发现地点无钱盒类器物：静默跳过，theft 本体照常成立", () => {
    const world = makeWorld(false);
    const outcome = doTheft(world);
    expect(outcome.ok).toBe(true);
    expect(world.getCharacter("victim")!.gold).toBe(50);
    expect(world.objects.getAtLocation("bakery")).toEqual([]);
  });
});
