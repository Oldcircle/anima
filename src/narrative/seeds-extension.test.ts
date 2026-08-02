/**
 * Seeds 扩展单测（DESIGN-revival §4 / §6 步骤 5）：
 * 1. loadSeeds 手工映射回归（visible_to 泄漏教训——snake_case 逐字段显式映射，非法条目丢弃）
 * 2. manifest crime_supply 字段解析（S7 实现模块，本阶段字段先解析存好）
 * 3. applySeeds：frictions 预热 / debts（borrowedTick 可设过去）/ openStance 预热
 * 4. off 档红线：敌对预热（疙瘩/立场）不注入；债（中性经济状态）照常
 * 5. 压力标定：验收剧本形状的预热落在阈值(45)下方（~40）
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenario, loadScenarioManifest } from "./scenario-loader.js";
import { Simulation } from "../agent/simulation.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { getBreakLevel, setBreakLevel } from "../agent/break-config.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

// ────────── 1+2. loader 映射回归（临时剧本目录） ──────────

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "anima-seeds-ext-test-"));
  mkdirSync(join(root, "data", "characters"), { recursive: true });
  mkdirSync(join(root, "data", "locations"), { recursive: true });
  mkdirSync(join(root, "data", "scenarios", "ext"), { recursive: true });
  mkdirSync(join(root, "data", "scenarios", "cs-obj"), { recursive: true });
  mkdirSync(join(root, "data", "scenarios", "cs-bad"), { recursive: true });

  writeFileSync(join(root, "data", "characters", "alice.yml"), 'id: "alice"\nname: "Alice"\n');
  writeFileSync(join(root, "data", "characters", "bob.yml"), 'id: "bob"\nname: "Bob"\n');
  writeFileSync(
    join(root, "data", "locations", "park.yml"),
    'id: "park"\nname: "Park"\ntype: "outdoor"\n',
  );

  // crime_supply 简写 + 全部 seeds 扩展字段（snake_case）
  writeFileSync(
    join(root, "data", "scenarios", "ext", "manifest.yml"),
    'id: ext\ncharacters: "*"\nlocations: "*"\ncrime_supply: cast\n',
  );
  writeFileSync(
    join(root, "data", "scenarios", "ext", "seeds.yml"),
    `
frictions:
  - observer: alice
    target: bob
    summary: "总迟到的邻居"
    mental_label: "不守时的人"
    entries:
      - "说好九点，他十点半才来"
      - 42
  - observer: alice          # 缺 entries → 整条丢弃
    target: bob
  - target: bob              # 缺 observer → 丢弃
    entries: ["x"]
debts:
  - debtor: bob
    lender: alice
    amount: 20
    borrowed_days_ago: 3
  - debtor: bob
    lender: alice
    amount: "abc"            # amount 非数字 → 丢弃
open_stances:
  - kind: accuse
    holder: alice
    target: bob
    summary: "当面质问他钱的去向"
    evidence: "钱呢？"
    days_ago: 1
    witnesses: [carol]
  - kind: nonsense           # 非法 kind → 丢弃
    holder: alice
    target: bob
    summary: "x"
  - kind: vow                # 缺 summary → 丢弃
    holder: alice
    target: bob
`,
  );

  writeFileSync(
    join(root, "data", "scenarios", "cs-obj", "manifest.yml"),
    'id: cs-obj\ncharacters: "*"\nlocations: "*"\ncrime_supply:\n  mode: npc\n',
  );
  writeFileSync(
    join(root, "data", "scenarios", "cs-bad", "manifest.yml"),
    'id: cs-bad\ncharacters: "*"\nlocations: "*"\ncrime_supply: banana\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("seeds 扩展：loadSeeds 手工映射回归", () => {
  it("frictions：snake_case 逐字段映射，非字符串 entry 与非法条目丢弃", () => {
    const s = loadScenario("ext", { projectRoot: root });
    expect(s.seeds?.frictions).toEqual([
      {
        observer: "alice",
        target: "bob",
        entries: ["说好九点，他十点半才来"],
        summary: "总迟到的邻居",
        mentalLabel: "不守时的人",
      },
    ]);
  });

  it("debts：borrowed_days_ago → borrowedDaysAgo，amount 非数字丢弃", () => {
    const s = loadScenario("ext", { projectRoot: root });
    expect(s.seeds?.debts).toEqual([
      { debtor: "bob", lender: "alice", amount: 20, borrowedDaysAgo: 3 },
    ]);
  });

  it("open_stances：days_ago/witnesses 映射，非法 kind 与缺 summary 丢弃", () => {
    const s = loadScenario("ext", { projectRoot: root });
    expect(s.seeds?.openStances).toEqual([
      {
        id: undefined,
        kind: "accuse",
        holder: "alice",
        target: "bob",
        summary: "当面质问他钱的去向",
        evidence: "钱呢？",
        daysAgo: 1,
        witnesses: ["carol"],
      },
    ]);
  });

  it("crime_supply：简写字符串 / 对象 mode / 非法值", () => {
    const scenariosRoot = join(root, "data", "scenarios");
    expect(loadScenarioManifest("ext", scenariosRoot).crimeSupply).toEqual({ mode: "cast" });
    expect(loadScenarioManifest("cs-obj", scenariosRoot).crimeSupply).toEqual({ mode: "npc" });
    expect(loadScenarioManifest("cs-bad", scenariosRoot).crimeSupply).toBeUndefined();
  });
});

// ────────── 3-5. applySeeds 行为 ──────────

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "public", openHours: null, presentCharacters: [] } as Location,
];

function makeCard(id: string, name: string): CharacterCard {
  return {
    id,
    name,
    age: 20,
    gender: "female",
    occupation: "tester",
    home: "park",
    personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
    background: "",
    relationships: {},
  };
}

function makeSim(charIds: string[], startTick = 24): { world: World; sim: Simulation } {
  const world = new World(fakeLocations, startTick);
  for (const id of charIds) world.addCharacter(id, id.toUpperCase(), "park");
  const mock = new MockLLMProvider();
  mock.setDefaultResponse("", []);
  const sim = new Simulation(world, new EventBus(), {
    characters: charIds.map((id) => makeCard(id, id.toUpperCase())),
    actions: ALL_BASIC_ACTIONS,
    provider: mock,
    modelId: "test",
  });
  return { world, sim };
}

describe("applySeeds：frictions / debts / openStance 预热", () => {
  it("frictions：无既有印象时创建带疙瘩的印象；未知角色跳过", () => {
    const { sim } = makeSim(["alice", "bob"]);
    sim.applySeeds({
      frictions: [
        { observer: "alice", target: "bob", entries: ["第三次放我鸽子"], summary: "鸽子精", mentalLabel: "不可靠" },
        { observer: "ghost", target: "bob", entries: ["x"] },
      ],
    });
    const imp = sim.impressions.get("alice", "bob");
    expect(imp).toBeDefined();
    expect(imp!.frictions).toEqual(["第三次放我鸽子"]);
    expect(imp!.summary).toBe("鸽子精");
    expect(imp!.mentalLabel).toBe("不可靠");
    expect(sim.impressions.get("ghost", "bob")).toBeUndefined();
  });

  it("frictions：已有印象时走 merge 追加，不覆盖旧观察", () => {
    const { sim, world } = makeSim(["alice", "bob"]);
    sim.impressions.set("alice", {
      characterId: "bob",
      summary: "老邻居",
      observations: ["爱种花"],
      mentalLabel: "普通人",
      unresolved: [],
      frictions: ["借伞没还"],
      lastUpdated: world.tick,
    });
    sim.applySeeds({
      frictions: [{ observer: "alice", target: "bob", entries: ["又迟到"] }],
    });
    const imp = sim.impressions.get("alice", "bob")!;
    expect(imp.frictions).toEqual(["借伞没还", "又迟到"]);
    expect(imp.observations).toEqual(["爱种花"]);
  });

  it("debts：borrowedTick 设到过去；同债主累加取更早 borrowedTick；未知角色跳过", () => {
    const { sim, world } = makeSim(["alice", "bob"], 24);
    sim.applySeeds({
      debts: [
        { debtor: "bob", lender: "alice", amount: 15, borrowedDaysAgo: 4 },
        { debtor: "bob", lender: "alice", amount: 5, borrowedDaysAgo: 1 },
        { debtor: "ghost", lender: "alice", amount: 10 },
      ],
    });
    const debts = world.getCharacter("bob")!.debts!;
    expect(debts).toHaveLength(1);
    expect(debts[0]!.lenderId).toBe("alice");
    expect(debts[0]!.amount).toBe(20);
    expect(debts[0]!.borrowedTick).toBe(24 - 4 * 96); // 允许为负——消费方只算差值
  });

  it("openStance：落成 active 立场，createdTick 可设过去", () => {
    const { sim, world } = makeSim(["alice", "bob"], 24);
    sim.applySeeds({
      openStances: [
        {
          kind: "accuse",
          holder: "alice",
          target: "bob",
          summary: "当面质问",
          evidence: "钱呢？",
          daysAgo: 1,
          witnesses: ["carol"],
        },
      ],
    });
    const stances = world.narrative.getActiveOpenStances("alice", "bob");
    expect(stances).toHaveLength(1);
    expect(stances[0]!.kind).toBe("accuse");
    expect(stances[0]!.createdTick).toBe(24 - 96);
    expect(stances[0]!.lastRefreshTick).toBe(24 - 96);
    expect(stances[0]!.witnesses).toEqual(["carol"]);
    expect(stances[0]!.evidence).toBe("钱呢？");
  });

  it("off 档红线：疙瘩/立场预热跳过（治愈系基线不带火药），债照常", () => {
    const prev = getBreakLevel();
    try {
      setBreakLevel("off");
      const { sim, world } = makeSim(["alice", "bob"]);
      sim.applySeeds({
        frictions: [{ observer: "alice", target: "bob", entries: ["疙瘩"] }],
        openStances: [{ kind: "accuse", holder: "alice", target: "bob", summary: "x" }],
        debts: [{ debtor: "bob", lender: "alice", amount: 10, borrowedDaysAgo: 3 }],
      });
      expect(sim.impressions.get("alice", "bob")).toBeUndefined();
      expect(world.narrative.getActiveOpenStances("alice", "bob")).toHaveLength(0);
      expect(world.getCharacter("bob")!.debts).toHaveLength(1);
    } finally {
      setBreakLevel(prev);
    }
  });

  it("压力标定：验收剧本形状的预热 = pair 40（阈值 45 下方）", () => {
    const { sim, world } = makeSim(["alice", "bob"], 24);
    sim.applySeeds({
      characterRelationships: [{ a: "alice", b: "bob", level: -3, type: "rival" }],
      frictions: [
        { observer: "alice", target: "bob", entries: ["疙瘩一"] },
        { observer: "bob", target: "alice", entries: ["疙瘩二"] },
      ],
      debts: [{ debtor: "bob", lender: "alice", amount: 15, borrowedDaysAgo: 4 }],
    });
    const result = sim.pressureGraph.update({
      world,
      relationships: sim.relationships,
      impressions: sim.impressions,
      tick: world.tick,
    });
    // 8*2 疙瘩 + 6*2 逾期 + 4*3 负 level = 40
    const pair = sim.pressureGraph.getPairPressure("alice", "bob");
    expect(pair).toBeDefined();
    expect(pair!.pressure).toBe(40);
    expect(pair!.pressure).toBeLessThan(45);
    expect(result.charPressures.alice).toBeGreaterThan(0);
  });
});
