/**
 * M4 案件收束（PLAN-grounding）单测
 *
 * 锁形状：
 * - 案件账本：立案不覆盖/每人每案一发/close 幂等/冷案候选/快照往返（normalize 保留+脏条目丢弃）
 * - theft_with_perp 自动立案（真凶 ground truth 只进引擎账本）
 * - accuse 浮现：有 open 案件+非 off 档才上架；结案后消失
 * - 三路裁决：破案（人赃俱获→结案+退赃后门+风声）/ 指对无证 / 冤案
 * - **信息隔离**：无证对峙两路对指控者的 description 完全一致（引擎不泄露指没指对）；
 *   差别只落被指者记忆（真凶"钱袋必须处理"/无辜"百口莫辩"）
 * - 立场/疙瘩/执念复用 B1 机器落账；被指者必须在场
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { World } from "../world/world.js";
import { buildToolList, type ToolBuildContext } from "./tool-builder.js";
import { normalizeNarrativeSnapshot, COLD_CASE_TICKS } from "../narrative/narrative-state.js";
import { applyTheftWithPerp, STOLEN_EVIDENCE_ITEM } from "../narrative/world-events.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { RelationshipManager } from "../world/relationships.js";
import { addToInventory, hasItem } from "../world/item-registry.js";
import { setBreakLevel } from "./break-config.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

const LOCATIONS: Location[] = [
  { id: "plaza", name: "广场", type: "public", openHours: null, presentCharacters: [] } as Location,
  { id: "bakery", name: "面包店", type: "commercial", openHours: null, presentCharacters: [] } as Location,
];

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, occupation: "镇民", home: "plaza",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

/** 立好案的世界：npc_drifter 偷了 victim 50 金币（赃物在身） */
function makeWorldWithCase(): World {
  const w = new World(LOCATIONS.map((l) => ({ ...l, presentCharacters: [] })), 40);
  w.addCharacter("victim", "小美", "plaza");
  w.getCharacter("victim")!.gold = 100;
  w.addCharacter("accuser", "L", "plaza");
  w.addCharacter("npc_drifter", "外乡流浪汉", "plaza");
  w.addCharacter("innocent", "碇真嗣", "plaza");
  w.narrative.registerNpc("npc_drifter", "外乡流浪汉");
  const outcome = applyTheftWithPerp(
    { world: w, memory: new ShortTermMemory(), tick: 40 },
    { perpId: "npc_drifter", victimId: "victim", amount: 50, discoveryLocationId: "bakery", cause: "月底要结货款" },
  );
  expect(outcome.ok).toBe(true);
  return w;
}

function ctxFor(world: World, id: string): ToolBuildContext {
  const state = world.getCharacter(id)!;
  return {
    state,
    card: makeCard(id, state.name),
    location: world.getLocation(state.locationId)!,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId)
      .filter((c) => c !== id)
      .map((c) => ({ id: c, name: world.getCharacter(c)!.name })),
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: 12,
    tick: 50,
    objects: world.objects,
    narrative: world.narrative,
    relationships: new RelationshipManager(),
    getCharacterById: (cid) => world.getCharacter(cid),
  };
}

const actionCtx = (world: World, actorId: string) => ({
  characterId: actorId,
  locationId: "plaza",
  locationType: "public",
  tick: 50,
  nearbyCharacters: world.getCharactersAtLocation("plaza").filter((c) => c !== actorId),
  gold: 100,
  needs: {},
});

function accuseTool(world: World, id = "accuser") {
  return buildToolList(ctxFor(world, id)).find((t) => t.tool.name === "accuse");
}

beforeEach(() => {
  setBreakLevel("mild");
  delete process.env.ANIMA_GROUNDING;
});
afterEach(() => {
  setBreakLevel("mild");
  delete process.env.ANIMA_GROUNDING;
});

describe("案件账本", () => {
  it("theft 自动立案；立案不覆盖；快照往返 normalize 保留、脏条目丢弃", () => {
    const world = makeWorldWithCase();
    const case_ = world.narrative.getLatestOpenCase()!;
    expect(case_.perpId).toBe("npc_drifter");
    expect(case_.amount).toBe(50);
    // 不覆盖
    expect(world.narrative.registerCase({ ...case_, perpId: "victim" })).toBe(false);
    expect(world.narrative.getCase(case_.id)!.perpId).toBe("npc_drifter");
    // 往返
    const snap = normalizeNarrativeSnapshot(JSON.parse(JSON.stringify(world.narrative.getSnapshot())));
    expect(snap.world.cases[case_.id]!.perpId).toBe("npc_drifter");
    // 脏条目
    const dirty = normalizeNarrativeSnapshot({
      world: { ...snap.world, cases: { bad: { id: "bad" } as any, [case_.id]: snap.world.cases[case_.id]! } },
    } as any);
    expect(dirty.world.cases["bad"]).toBeUndefined();
    expect(dirty.world.cases[case_.id]).toBeDefined();
  });

  it("每人每案一发；close 幂等；冷案候选按窗口", () => {
    const world = makeWorldWithCase();
    const ns = world.narrative;
    const id = ns.getLatestOpenCase()!.id;
    expect(ns.recordAccusation(id, "accuser", "innocent")).toBe(true);
    expect(ns.recordAccusation(id, "accuser", "npc_drifter")).toBe(false); // 一发用掉了
    expect(ns.recordAccusation(id, "victim", "npc_drifter")).toBe(true); // 别人还有
    expect(ns.getStaleCases(40 + COLD_CASE_TICKS, COLD_CASE_TICKS)).toHaveLength(0); // 刚好在窗内
    expect(ns.getStaleCases(41 + COLD_CASE_TICKS, COLD_CASE_TICKS)).toHaveLength(1);
    expect(ns.closeCase(id, "cold", 100)).toBe(true);
    expect(ns.closeCase(id, "solved", 101)).toBe(false); // 已结不能再结
    expect(ns.getOpenCases()).toHaveLength(0);
  });
});

describe("accuse 浮现门", () => {
  it("有 open 案件+mild 上架；off 档/无案件/GROUNDING=0 不上架；结案后消失", () => {
    const world = makeWorldWithCase();
    expect(accuseTool(world)).toBeDefined();
    setBreakLevel("off");
    expect(accuseTool(world)).toBeUndefined();
    setBreakLevel("mild");
    process.env.ANIMA_GROUNDING = "0";
    expect(accuseTool(world)).toBeUndefined();
    delete process.env.ANIMA_GROUNDING;
    world.narrative.closeCase(world.narrative.getLatestOpenCase()!.id, "cold", 60);
    expect(accuseTool(world)).toBeUndefined();
  });
});

describe("accuse 三路裁决", () => {
  it("破案：人赃俱获→结案+退赃后门+风声+被指者记忆", () => {
    const world = makeWorldWithCase();
    expect(hasItem(world.getCharacter("npc_drifter")!.inventory, STOLEN_EVIDENCE_ITEM)).toBe(true);
    const result = accuseTool(world)!.handler(
      { thought: "证据链闭合了", target: "外乡流浪汉", accusation: "货款就是你偷的" },
      actionCtx(world, "accuser"),
    ) as any;
    expect(result.success).not.toBe(false);
    expect(result.description).toContain("人赃俱获");
    expect(world.narrative.getLatestOpenCase()).toBeUndefined(); // 案结
    expect(world.narrative.getCase(`theft_40_victim`)!.status).toBe("solved");
    expect(result._accuseSettle).toEqual({ caseId: "theft_40_victim", perpId: "npc_drifter", victimId: "victim", amount: 50 });
    expect(result._accuseMemories.some((m: any) => m.observerId === "npc_drifter" && m.content.includes("赖不掉"))).toBe(true);
    expect(world.narrative.getWorld().rumors.some((r) => r.content.includes("人赃俱获"))).toBe(true);
  });

  it("信息隔离：指对无证 vs 冤案——指控者看到的反馈逐字一致，差别只在被指者记忆", () => {
    // 指对无证：真凶把赃物丢了
    const worldA = makeWorldWithCase();
    const perp = worldA.getCharacter("npc_drifter")!;
    perp.inventory = perp.inventory.filter((i) => i.defId !== STOLEN_EVIDENCE_ITEM);
    const rightNoProof = accuseTool(worldA)!.handler(
      { thought: "是他", target: "外乡流浪汉", accusation: "就是你干的" },
      actionCtx(worldA, "accuser"),
    ) as any;

    // 冤案：指了无辜者
    const worldB = makeWorldWithCase();
    const wrongful = accuseTool(worldB)!.handler(
      { thought: "是他", target: "碇真嗣", accusation: "就是你干的" },
      actionCtx(worldB, "accuser"),
    ) as any;

    // 引擎不向指控者泄露真相：两路 description 除被指者名字外逐字一致
    const normalize = (s: string) => s.replaceAll("外乡流浪汉", "X").replaceAll("碇真嗣", "X");
    expect(normalize(rightNoProof.description)).toBe(normalize(wrongful.description));
    expect(rightNoProof.description).not.toContain("指对");
    expect(wrongful.description).not.toContain("冤");

    // 差别落在被指者自己的记忆里
    const perpMemory = rightNoProof._accuseMemories.find((m: any) => m.observerId === "npc_drifter");
    expect(perpMemory.content).toContain("钱袋不能再留在身上"); // 真凶知道自己被盯上
    const innocentMemory = wrongful._accuseMemories.find((m: any) => m.observerId === "innocent");
    expect(innocentMemory.content).toContain("百口莫辩"); // 无辜者纯冤仇

    // 两路案件都还开着 + 立场/疙瘩落账
    expect(worldA.narrative.getOpenCases()).toHaveLength(1);
    expect(worldB.narrative.getOpenCases()).toHaveLength(1);
    expect(worldB.narrative.getActiveOpenStances("accuser", "innocent").some((s) => s.kind === "accuse")).toBe(true);
  });

  it("执行期校验：不在场拒绝/自指拒绝/二连发拒绝", () => {
    const world = makeWorldWithCase();
    const tool = accuseTool(world)!;
    world.moveCharacter("innocent", "bakery");
    expect(tool.handler({ thought: "x", target: "碇真嗣", accusation: "y" }, actionCtx(world, "accuser")).success).toBe(false);
    expect(tool.handler({ thought: "x", target: "L", accusation: "y" }, actionCtx(world, "accuser")).success).toBe(false);
    // 第一发（无证）用掉后二连发被拒
    const perp = world.getCharacter("npc_drifter")!;
    perp.inventory = perp.inventory.filter((i) => i.defId !== STOLEN_EVIDENCE_ITEM);
    tool.handler({ thought: "x", target: "外乡流浪汉", accusation: "y" }, actionCtx(world, "accuser"));
    const second = tool.handler({ thought: "x", target: "外乡流浪汉", accusation: "y" }, actionCtx(world, "accuser"));
    expect(second.success).toBe(false);
    expect(second.description).toContain("泼脏水");
  });
});
