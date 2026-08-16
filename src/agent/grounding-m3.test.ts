/**
 * M3 tamper + PbtA 世界侧骰子（PLAN-grounding）单测
 *
 * 锁形状：
 * - rollPbta 三段映射（rng 注入钉死：10+/7-9/≤6）
 * - tamper 浮现：可下手器物+非 off 档才上架；off 档/无 tamperable/ANIMA_GROUNDING=0 不上架
 * - 三段结算：success=毁证成立（旧痕迹真消失）+细微二级痕迹；cost=得手+明显痕迹+目击后门；
 *   complication=没得手（旧痕迹保留）+乱痕+目击后门
 * - 必留二级痕迹 → 此前 examine 过的人重访 diff 触发（"和记忆里不一样"）
 * - 冷却：per 角色半游戏天；快照往返
 * - 非 tamperable 目标拒绝
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rollPbta } from "../world/pbta.js";
import { buildToolList, type ToolBuildContext } from "./tool-builder.js";
import { World } from "../world/world.js";
import { TAMPER_COOLDOWN_TICKS } from "../world/world-objects.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";
import { setBreakLevel } from "./break-config.js";

const LOCATIONS: Location[] = [
  {
    id: "library",
    name: "图书馆",
    type: "public",
    openHours: null,
    presentCharacters: [],
    objects: [
      {
        id: "ledger", name: "借阅台账", summary: "前台那本厚台账",
        keywords: ["台账", "借阅"], canon: ["台账按月换页"], tamperable: true,
      },
      { id: "desk", name: "阅览桌", keywords: ["阅览桌"] }, // 不可下手
    ],
  } as Location,
  { id: "plaza", name: "广场", type: "public", openHours: null, presentCharacters: [] } as Location,
];

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, occupation: "学生", home: "library",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function makeWorld(): World {
  const world = new World(LOCATIONS.map((l) => ({ ...l, presentCharacters: [] })), 40);
  world.addCharacter("light", "夜神月", "library");
  world.addCharacter("l", "L", "library");
  return world;
}

/** rng 序列：依次吐出定值（两骰一次 roll 消费两个） */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

function ctxFor(world: World, id: string, rng?: () => number): ToolBuildContext {
  const state = world.getCharacter(id)!;
  return {
    state,
    card: makeCard(id, state.name),
    location: world.getLocation(state.locationId)!,
    nearbyCharacters: [],
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: 22,
    tick: 40,
    objects: world.objects,
    rng,
  };
}

const actionCtx = (nearby: string[] = []) => ({
  characterId: "light", locationId: "library", locationType: "public",
  tick: 50, nearbyCharacters: nearby, gold: 100, needs: {},
});

function tamperTool(world: World, rng?: () => number) {
  return buildToolList(ctxFor(world, "light", rng)).find((t) => t.tool.name === "tamper");
}

beforeEach(() => {
  setBreakLevel("mild");
  delete process.env.ANIMA_GROUNDING;
});
afterEach(() => {
  setBreakLevel("mild");
  delete process.env.ANIMA_GROUNDING;
});

describe("rollPbta 三段", () => {
  it("rng 钉死：双 6=success / 4+4=cost / 双 1=complication", () => {
    expect(rollPbta(seqRng([0.99, 0.99])).outcome).toBe("success"); // 6+6=12
    expect(rollPbta(seqRng([0.5, 0.5])).outcome).toBe("cost"); // 4+4=8
    expect(rollPbta(seqRng([0.0, 0.0])).outcome).toBe("complication"); // 1+1=2
    expect(rollPbta(seqRng([0.99, 0.5])).outcome).toBe("success"); // 6+4=10 边界
    expect(rollPbta(seqRng([0.5, 0.34])).outcome).toBe("cost"); // 4+3=7 边界
    expect(rollPbta(seqRng([0.34, 0.34])).outcome).toBe("complication"); // 3+3=6 边界
  });
});

describe("tamper 浮现门", () => {
  it("可下手器物+mild 档 → 上架；off 档 / 无 tamperable 地点 / GROUNDING=0 → 不上架", () => {
    const world = makeWorld();
    expect(tamperTool(world)).toBeDefined();
    expect(tamperTool(world)!.tool.description).toContain("借阅台账");
    expect(tamperTool(world)!.tool.description).not.toContain("阅览桌"); // 只列可下手的

    setBreakLevel("off");
    expect(tamperTool(world)).toBeUndefined();
    setBreakLevel("mild");

    world.moveCharacter("light", "plaza");
    expect(tamperTool(world)).toBeUndefined();
    world.moveCharacter("light", "library");

    process.env.ANIMA_GROUNDING = "0";
    expect(tamperTool(world)).toBeUndefined();
  });
});

describe("tamper 三段结算", () => {
  it("success：旧痕迹真消失（毁证）+细微二级痕迹 + 此前查过的人 diff 触发", () => {
    const world = makeWorld();
    // 案发现场：台账有撬痕类旧痕迹，L 查过（diff 基线）
    world.objects.addTrace("library.ledger", { id: "pried", text: "锁扣上有新鲜的撬痕", addedTick: 30, source: "event" });
    world.objects.examine("library.ledger", "l", 35);

    const result = tamperTool(world, seqRng([0.99, 0.99]))!.handler(
      { thought: "毁掉它", target: "台账", goal: "抹掉撬痕" }, actionCtx(),
    );
    expect(result.success).not.toBe(false);
    expect(result.description).toContain("得手");
    const obj = world.objects.get("library.ledger")!;
    expect(obj.traces.some((t) => t.id === "pried")).toBe(false); // 撬痕真没了——L 再查查不到
    expect(obj.traces.some((t) => t.id.includes("subtle"))).toBe(true); // 必留二级痕迹
    expect(obj.flags.tampered).toBe(true);
    // L 重访 diff："和记忆里不一样"
    expect(world.objects.diffForCharacter("library", "l")[0]).toContain("不太一样");
  });

  it("cost：得手+明显痕迹；有旁观者 → 目击后门带观察内容", () => {
    const world = makeWorld();
    const result = tamperTool(world, seqRng([0.5, 0.5]))!.handler(
      { thought: "试试", target: "台账", goal: "撕掉一页" }, actionCtx(["l"]),
    ) as any;
    expect(result.description).toContain("毛边");
    expect(world.objects.get("library.ledger")!.traces.some((t) => t.id.includes("obvious"))).toBe(true);
    expect(result._tamperWitness?.observerId).toBe("l");
    expect(result._tamperWitness?.content).toContain("夜神月");
  });

  it("complication：没得手（旧痕迹保留）+乱痕+目击后门", () => {
    const world = makeWorld();
    world.objects.addTrace("library.ledger", { id: "pried", text: "撬痕", addedTick: 30, source: "event" });
    const result = tamperTool(world, seqRng([0.0, 0.0]))!.handler(
      { thought: "干", target: "台账", goal: "抹掉撬痕" }, actionCtx(["l"]),
    ) as any;
    expect(result.description).toContain("乱了阵脚");
    const obj = world.objects.get("library.ledger")!;
    expect(obj.traces.some((t) => t.id === "pried")).toBe(true); // 没毁成——撬痕还在
    expect(obj.traces.some((t) => t.id.includes("botched"))).toBe(true); // fail forward 乱痕
    expect(result._tamperWitness?.content).toContain("亲眼");
  });

  it("非 tamperable 目标拒绝；冷却窗内二连拒绝；冷却随档", () => {
    const world = makeWorld();
    const tool = tamperTool(world, seqRng([0.99, 0.99]))!;
    expect(tool.handler({ thought: "x", target: "阅览桌", goal: "y" }, actionCtx()).success).toBe(false);

    tool.handler({ thought: "x", target: "台账", goal: "y" }, actionCtx()); // 第一票成
    const second = tool.handler({ thought: "x", target: "台账", goal: "y" }, actionCtx());
    expect(second.success).toBe(false);
    expect(second.description).toContain("太冒险");
    expect(world.objects.isTamperOnCooldown("light", 50 + TAMPER_COOLDOWN_TICKS)).toBe(false); // 过窗解锁

    // 冷却随档
    const snap = JSON.parse(JSON.stringify(world.objects.getSnapshot()));
    const world2 = makeWorld();
    world2.objects.replaceSnapshot(snap);
    expect(world2.objects.isTamperOnCooldown("light", 51)).toBe(true);
  });
});
