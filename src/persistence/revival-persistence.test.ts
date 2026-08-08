/**
 * DESIGN-revival A 前置持久化回归：
 * - impressions.frictions 列 save/load 双向接通（此前 saveImpression 丢弃该字段——读档后压力图塌 0）
 * - 爽约记录 missedBy 随档（压力图派生计数的依据）
 * - narrative_state.beatLastTrigger 随档（tension 干旱项）
 * - 老档（无新列）ALTER 迁移
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AnimaDB } from "./database.js";
import { saveGame, loadGame } from "./save-load.js";
import { Simulation } from "../agent/simulation.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";
import type { Appointment } from "../world/types.js";

const tomoriCard: CharacterCard = {
  id: "tomori", name: "高松灯", age: 19, occupation: "面包店学徒", home: "home_tomori",
  personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多"], speechStyle: "微弱" },
  background: "面包店学徒", relationships: {},
};
const anonCard: CharacterCard = {
  id: "anon", name: "千早爱音", age: 19, occupation: "咖啡馆兼职", home: "home_anon",
  personality: { traits: ["开朗"], interests: ["社交"], dislikes: ["被忽视"], speechStyle: "活泼" },
  background: "咖啡馆兼职", relationships: {},
};

function buildSim(tick = 0): Simulation {
  const world = new World(TEST_LOCATIONS, tick);
  world.addCharacter("tomori", "高松灯", "home_tomori");
  world.addCharacter("anon", "千早爱音", "home_anon");
  return new Simulation(world, new EventBus(), {
    characters: [tomoriCard, anonCard],
    actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(),
    modelId: "test",
  });
}

const TEST_DB = join(tmpdir(), `anima-revival-${Date.now()}.db`);

function cleanup(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe("frictions 持久化", () => {
  afterEach(cleanup);

  it("saveImpression/loadImpressions frictions round-trip", () => {
    const db = new AnimaDB(TEST_DB);
    db.saveImpression("tomori", {
      characterId: "anon",
      summary: "最近有点针锋相对",
      observations: ["说话带刺"],
      mentalLabel: "难缠",
      unresolved: ["她到底在气什么"],
      frictions: ["上次放我鸽子", "又阴阳怪气"],
      lastUpdated: 48,
    });
    db.saveImpression("anon", {
      characterId: "tomori",
      summary: "普通印象",
      observations: [],
      mentalLabel: "待了解",
      unresolved: [],
      lastUpdated: 48,
    });

    const imps = db.loadImpressions();
    db.close();
    const withF = imps.find((i) => i.observerId === "tomori")!;
    expect(withF.impression.frictions).toEqual(["上次放我鸽子", "又阴阳怪气"]);
    const without = imps.find((i) => i.observerId === "anon")!;
    expect(without.impression.frictions).toBeUndefined();
  });

  it("saveGame → loadGame 后 frictions 不蒸发（压力图边不塌 0）", () => {
    const sim = buildSim(40);
    sim.impressions.set("tomori", {
      characterId: "anon",
      summary: "疙瘩越来越多",
      observations: [],
      mentalLabel: "难说",
      unresolved: [],
      frictions: ["第三次放我鸽子"],
      lastUpdated: 40,
    });
    saveGame(sim, TEST_DB);

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);
    expect(restored.impressions.get("tomori", "anon")?.frictions).toEqual(["第三次放我鸽子"]);

    // 读档后压力图立即能收到 friction 边
    const r = restored.pressureGraph.update({
      world: restored.world,
      relationships: restored.relationships,
      impressions: restored.impressions,
      tick: 40,
    });
    expect(r.pairs.some((p) => p.inputs.frictions > 0)).toBe(true);
  });

  it("老档（无 frictions 列）打开即迁移，读写不炸", () => {
    // 手工造一张 N2 时代的 impressions 表（无 frictions 列）
    const raw = new Database(TEST_DB);
    raw.exec(`
      CREATE TABLE impressions (
        observer_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        observations TEXT DEFAULT '[]',
        mental_label TEXT DEFAULT '',
        unresolved TEXT DEFAULT '[]',
        last_updated INTEGER DEFAULT 0,
        PRIMARY KEY (observer_id, target_id)
      );
      INSERT INTO impressions VALUES ('tomori', 'anon', '旧印象', '[]', '老实人', '[]', 10);
    `);
    raw.close();

    const db = new AnimaDB(TEST_DB); // _migrate 应补列
    const imps = db.loadImpressions();
    expect(imps[0]!.impression.summary).toBe("旧印象");
    expect(imps[0]!.impression.frictions).toBeUndefined();
    // 补列后可以带 frictions 写入
    db.saveImpression("tomori", {
      characterId: "anon", summary: "新印象", observations: [], mentalLabel: "x",
      unresolved: [], frictions: ["新疙瘩"], lastUpdated: 20,
    });
    expect(db.loadImpressions()[0]!.impression.frictions).toEqual(["新疙瘩"]);
    db.close();
  });
});

describe("C4 unresolvedCounts 随档", () => {
  afterEach(cleanup);

  it("unresolved_counts round-trip（Record 序列化往返不丢）", () => {
    const db = new AnimaDB(TEST_DB);
    db.saveImpression("tomori", {
      characterId: "anon",
      summary: "还看不透",
      observations: [],
      mentalLabel: "待了解",
      unresolved: ["她晚上都去哪了"],
      unresolvedCounts: { "她晚上都去哪了": 3 },
      lastUpdated: 48,
    });
    const imps = db.loadImpressions();
    db.close();
    expect(imps[0]!.impression.unresolvedCounts).toEqual({ "她晚上都去哪了": 3 });
  });

  it("saveGame → loadGame 后节流计数存活（首登记的疑惑仍处于未成熟态）", () => {
    const sim = buildSim(40);
    sim.impressions.set("tomori", {
      characterId: "anon",
      summary: "有点在意",
      observations: [],
      mentalLabel: "在意",
      unresolved: ["新冒出来的疑惑"],
      lastUpdated: 40,
    }); // set() 首登记 → 计数 1
    saveGame(sim, TEST_DB);

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);
    const imp = restored.impressions.get("tomori", "anon")!;
    expect(imp.unresolvedCounts).toEqual({ "新冒出来的疑惑": 1 });
    // 节流口径下读档后仍不注回（计数没有因 save/load 变成熟）
    expect(
      restored.impressions.formatForPrompt("tomori", "anon", { unresolvedMinCount: 2 }),
    ).not.toContain("新冒出来的疑惑");
  });

  it("老档（无 unresolved_counts 列）→ 迁移补列 + 旧疑惑 normalize 为成熟(2)，注入行为不回退", () => {
    const raw = new Database(TEST_DB);
    raw.exec(`
      CREATE TABLE impressions (
        observer_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        observations TEXT DEFAULT '[]',
        mental_label TEXT DEFAULT '',
        unresolved TEXT DEFAULT '[]',
        last_updated INTEGER DEFAULT 0,
        PRIMARY KEY (observer_id, target_id)
      );
      INSERT INTO impressions VALUES ('tomori', 'anon', '旧印象', '[]', '老实人', '["旧档里的疑惑"]', 10);
    `);
    raw.close();

    const db = new AnimaDB(TEST_DB); // _migrate 补 unresolved_counts 列
    const imps = db.loadImpressions();
    db.close();
    const imp = imps[0]!.impression;
    // 旧档疑惑本来就在被注入——normalize 成熟值 2，读档后不该突然消失
    expect(imp.unresolvedCounts).toEqual({ "旧档里的疑惑": 2 });
  });
});

describe("爽约 missedBy 随档", () => {
  afterEach(cleanup);

  it("单方爽约的 missedBy round-trip；双爽约仍无 missedBy", () => {
    const sim = buildSim(40);
    const mk = (id: string, atTick: number): Appointment => ({
      id, proposerId: "tomori", targetId: "anon", locationId: "cafe",
      atTick, status: "pending", createdTick: 40,
    });
    sim.world.addAppointment(mk("a-single", 50));
    sim.world.markAppointment("a-single", "missed", "anon");
    sim.world.restoreAppointments([
      ...sim.world.getAllAppointments(),
      { ...mk("a-double", 60), status: "missed" }, // 双爽约：无 missedBy
    ]);
    saveGame(sim, TEST_DB);

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);
    const appts = restored.world.getAllAppointments();
    expect(appts.find((a) => a.id === "a-single")?.missedBy).toBe("anon");
    expect(appts.find((a) => a.id === "a-double")?.missedBy).toBeUndefined();

    // 派生计数：读档后只有单方爽约计入压力
    const r = restored.pressureGraph.update({
      world: restored.world,
      relationships: restored.relationships,
      impressions: restored.impressions,
      tick: 70,
    });
    const pair = r.pairs.find((p) => p.a === "anon" && p.b === "tomori");
    expect(pair?.inputs.missedAppointments).toBe(1);
  });

  it("老档（无 missed_by 列）打开即迁移", () => {
    const raw = new Database(TEST_DB);
    raw.exec(`
      CREATE TABLE appointments (
        id TEXT PRIMARY KEY,
        proposer_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        at_tick INTEGER NOT NULL,
        activity TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_tick INTEGER NOT NULL
      );
      INSERT INTO appointments VALUES ('old-1', 'tomori', 'anon', 'cafe', 88, NULL, 'missed', 40);
    `);
    raw.close();

    const db = new AnimaDB(TEST_DB);
    const appts = db.loadAppointments();
    expect(appts[0]!.id).toBe("old-1");
    expect(appts[0]!.missedBy).toBeUndefined(); // 旧记录不知道缺席者 → 不计入压力
    db.close();
  });
});

describe("enqueueMutation flush（存档时序不丢载荷）", () => {
  afterEach(cleanup);

  it("enqueue 后不 tick 直接 save→load：载荷效果在档里，队列已清不二次结算", () => {
    const sim = buildSim(40);
    const goldBefore = sim.world.getCharacter("tomori")!.gold;
    // 模拟 beat auto_events 的入队载荷（罪案投放：掉钱 + 事件记忆）——
    // beat 触发标记在入队当刻已写随档，若 saveGame 不 flush 则载荷丢、代价已付
    sim.enqueueMutation(() => {
      sim.world.getCharacter("tomori")!.gold -= 25;
      sim.memory.add("tomori", { tick: 40, type: "event", content: "收着的货款被人偷了", importance: 8 });
    });
    saveGame(sim, TEST_DB);
    // flush 已执行且队列排空：下一 tick 的 drain 不会二次结算
    expect((sim as any)._pendingMutations).toHaveLength(0);
    expect(sim.world.getCharacter("tomori")!.gold).toBe(goldBefore - 25);

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);
    expect(restored.world.getCharacter("tomori")!.gold).toBe(goldBefore - 25);
    expect(
      restored.memory.getRecent("tomori", 30).some((m) => m.content.includes("货款被人偷了")),
    ).toBe(true);
  });
});

describe("beatLastTrigger 随档", () => {
  afterEach(cleanup);

  it("saveGame → loadGame 后触发 tick 存活，loadBeats 同步进引擎", () => {
    const sim = buildSim(200);
    sim.world.narrative.markBeatTriggered("beat_x");
    sim.world.narrative.recordBeatTrigger("beat_x", 180);
    saveGame(sim, TEST_DB);

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);
    expect(restored.world.narrative.getWorld().beatLastTrigger).toEqual({ beat_x: 180 });
    expect(restored.world.narrative.getTicksSinceLastBeat(200)).toBe(20);

    restored.loadBeats([{ id: "beat_x" }, { id: "beat_y" }]);
    expect(restored.beatEngine.getLastTriggerTick()).toBe(180);
    expect(restored.beatEngine.getTriggered()).toContain("beat_x");
  });

  it("旧档 narrative_state 无 beatLastTrigger → normalize 补空 Record", () => {
    const sim = buildSim(100);
    saveGame(sim, TEST_DB);
    // 手工把 narrative_state 改写成旧结构（无 beatLastTrigger）
    const raw = new Database(TEST_DB);
    const row = raw.prepare("SELECT value FROM world_state WHERE key = 'narrative_state'").get() as { value: string };
    const snap = JSON.parse(row.value);
    delete snap.world.beatLastTrigger;
    raw.prepare("UPDATE world_state SET value = ? WHERE key = 'narrative_state'").run(JSON.stringify(snap));
    raw.close();

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);
    expect(restored.world.narrative.getWorld().beatLastTrigger).toEqual({});
    expect(Number.isFinite(restored.world.narrative.getTicksSinceLastBeat(100))).toBe(true);
  });
});
