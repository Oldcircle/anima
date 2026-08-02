/**
 * B3 罪行供给器形状单测（DESIGN-revival §2 B3 / §4.5）：
 *
 * cast 放大器：
 * - 只监听真实灰行为：无候选空转（零 ledger/零风声/零记忆）
 * - steal 成功未被抓 → 补被发现链（物证入真凶包 + 目击窗口 + 延迟发现 + 风声晚于发现）
 * - 被抓的 steal 不重复补（当场后果链已存在）
 * - 幂等：同一桩灰行为只补一次（ledger 随档去重）
 * - **从不替 cast 写行为/塞"你偷了"记忆**（红线③）
 * - 赖账 2 天+ 起风声（每笔一次）
 * - off 档整体禁用（红线②）
 *
 * npc 模式：
 * - 静态 NPC 登记 narrative_state.world.npcs 随档 + addCharacter 落地 + isStatic 生存豁免
 *   （decayNeeds / 07:00 upkeep 跳过）
 * - 预热期后白天投放够格之罪（走 B2 applyTheftWithPerp 延迟发现链）+ visibleTo 情报
 * - 冷却/一次一案；ledger 随档
 * - 读档重建 addCharacter（save-load：悬空真凶不蒸发）
 * - 旧档 normalize（crimeSupplyLedger 缺失回填/脏值清理）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Simulation } from "../agent/simulation.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { setBreakLevel } from "../agent/break-config.js";
import { saveGame, loadGame } from "../persistence/save-load.js";
import { hasItem } from "../world/item-registry.js";
import {
  runCrimeSupply,
  ensureCrimeNpc,
  CRIME_NPC,
  NPC_CRIME_FIRST_DELAY_TICKS,
  DEBT_AMPLIFY_OVERDUE_TICKS,
} from "./crime-supply.js";
import { STOLEN_EVIDENCE_ITEM, processPendingDiscoveries } from "./world-events.js";
import { normalizeNarrativeSnapshot, type NarrativeStateSnapshot } from "./narrative-state.js";
import type { CharacterCard } from "../character/types.js";
import type { WorldEvent } from "../core/event-bus.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
    background: "", relationships: {},
  };
}

function makeSim(tick = 100): { world: World; sim: Simulation; eventBus: EventBus } {
  const world = new World(TEST_LOCATIONS, tick);
  world.addCharacter("alice", "爱丽丝", "plaza");
  world.addCharacter("bob", "鲍勃", "plaza");
  world.addCharacter("carol", "卡罗尔", "plaza");
  const eventBus = new EventBus();
  const sim = new Simulation(world, eventBus, {
    characters: [makeCard("alice", "爱丽丝"), makeCard("bob", "鲍勃"), makeCard("carol", "卡罗尔")],
    actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(),
    modelId: "test",
  });
  return { world, sim, eventBus };
}

function stealEvent(tick: number, actorId: string, targetId: string, caught = false): WorldEvent {
  return {
    id: `ev_${tick}_${actorId}`,
    tick,
    type: "action.steal",
    actorId,
    targetId,
    locationId: "plaza",
    description: caught ? `试图偷${targetId}的钱，但被当场抓住了！` : "悄悄偷了30金币",
    effects: [],
    witnesses: [],
  };
}

beforeEach(() => setBreakLevel("mild"));
afterEach(() => setBreakLevel("mild"));

describe("B3 cast 放大器", () => {
  it("无候选空转：不动 ledger/风声/记忆", () => {
    const { world, sim, eventBus } = makeSim();
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "cast");
    expect(Object.keys(world.narrative.getCrimeSupplyLedger())).toHaveLength(0);
    expect(world.narrative.getWorld().rumors).toHaveLength(0);
    expect(sim.memory.getRecent("alice", 10)).toHaveLength(0);
  });

  it("off 档整体禁用（红线②）", async () => {
    setBreakLevel("off");
    const { world, sim, eventBus } = makeSim();
    await eventBus.emit(stealEvent(98, "bob", "alice"));
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "cast");
    expect(Object.keys(world.narrative.getCrimeSupplyLedger())).toHaveLength(0);
    expect(hasItem(world.getCharacter("bob")!.inventory, STOLEN_EVIDENCE_ITEM)).toBe(false);
  });

  it("mode 未配置/off 不启用", async () => {
    const { world, sim, eventBus } = makeSim();
    await eventBus.emit(stealEvent(98, "bob", "alice"));
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, undefined);
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "off");
    expect(Object.keys(world.narrative.getCrimeSupplyLedger())).toHaveLength(0);
  });

  it("steal 成功未被抓 → 物证+目击+延迟发现+嫌疑执念；幂等不重复", async () => {
    const { world, sim, eventBus } = makeSim();
    await eventBus.emit(stealEvent(98, "bob", "alice"));
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "cast");

    const bob = world.getCharacter("bob")!;
    // 物证入真凶背包
    expect(hasItem(bob.inventory, STOLEN_EVIDENCE_ITEM)).toBe(true);
    // 目击窗口：旁观者 carol 收到观察记忆（不含判词"偷"的指控式结论也行，落"看见了什么"）
    const carolMem = sim.memory.getRecent("carol", 5);
    expect(carolMem.some((m) => m.content.includes("瞥见") && m.relatedCharacterId === "bob")).toBe(true);
    // 延迟发现挂上（受害者到场才落发现记忆——此刻 alice 还没有记忆）
    const pending = world.narrative.getPendingDiscoveries();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.victimId).toBe("alice");
    expect(pending[0]!.rumor).toBeTruthy();
    expect(sim.memory.getRecent("alice", 5)).toHaveLength(0);
    // 嫌疑方执念（B5 罪案嫌疑）
    const bobObs = world.narrative.getActiveObsessions("bob", Math.floor(100 / 96), 6);
    expect(bobObs.some((o) => o.source === "crime")).toBe(true);
    // 红线③：从不塞"你偷了"记忆——真凶的记忆流干净
    expect(sim.memory.getRecent("bob", 10)).toHaveLength(0);

    // 幂等：再跑一遍不重复补链
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 101 }, "cast");
    expect(world.narrative.getPendingDiscoveries()).toHaveLength(1);
    expect(bob.inventory.filter((i) => i.defId === STOLEN_EVIDENCE_ITEM).reduce((s, i) => s + i.quantity, 0)).toBe(1);
  });

  it("发现落账：受害者到场 → 发现记忆 + unresolvedEvent(fresh) + 受害执念；风声晚于发现", async () => {
    const { world, sim, eventBus } = makeSim();
    await eventBus.emit(stealEvent(98, "bob", "alice"));
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "cast");

    // 受害者仍在原地 → 下一 tick sweep 即发现
    processPendingDiscoveries(world, sim.memory, 101);
    const aliceMem = sim.memory.getRecent("alice", 5);
    expect(aliceMem.some((m) => m.content.includes("有人动过你的钱袋"))).toBe(true);
    const event = world.narrative.getWorld().unresolvedEvents.find((e) => e.id.startsWith("steal_"));
    expect(event).toBeTruthy();
    expect(event!.status).toBe("fresh");
    expect(event!.involved).toContain("bob");
    expect(event!.visibleTo).toEqual(["alice"]);
    // B5 受害执念（relatedId 关联，settled 即清的钩子路径）
    const aliceObs = world.narrative.getActiveObsessions("alice", Math.floor(101 / 96), 6);
    expect(aliceObs.some((o) => o.source === "crime" && o.relatedId === event!.id)).toBe(true);
    // 风声晚于发现：发现当刻还没起风声
    expect(world.narrative.getWorld().rumors).toHaveLength(0);
    processPendingDiscoveries(world, sim.memory, 101 + 8);
    expect(world.narrative.getWorld().rumors.length).toBe(1);
  });

  it("被抓的 steal 不放大（当场后果链已存在）", async () => {
    const { world, sim, eventBus } = makeSim();
    await eventBus.emit(stealEvent(98, "bob", "alice", true));
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "cast");
    expect(Object.keys(world.narrative.getCrimeSupplyLedger())).toHaveLength(0);
    expect(hasItem(world.getCharacter("bob")!.inventory, STOLEN_EVIDENCE_ITEM)).toBe(false);
  });

  it("赖账 2 天+ 起风声，每笔只一次", () => {
    const { world, sim, eventBus } = makeSim(500);
    const alice = world.getCharacter("alice")!;
    alice.debts = [{ lenderId: "bob", amount: 30, borrowedTick: 500 - DEBT_AMPLIFY_OVERDUE_TICKS - 10 }];
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 500 }, "cast");
    const rumors = world.narrative.getWorld().rumors;
    expect(rumors.some((r) => r.content.includes("欠着") && r.content.includes("爱丽丝"))).toBe(true);
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 501 }, "cast");
    expect(world.narrative.getWorld().rumors).toHaveLength(1);
  });

  it("未到期的账不起风声（空转）", () => {
    const { world, sim, eventBus } = makeSim(500);
    world.getCharacter("alice")!.debts = [{ lenderId: "bob", amount: 30, borrowedTick: 480 }];
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 500 }, "cast");
    expect(world.narrative.getWorld().rumors).toHaveLength(0);
  });
});

describe("B3 npc 模式", () => {
  it("静态 NPC 登记随档 + 落地世界 + isStatic 生存豁免（decayNeeds/upkeep 跳过）", () => {
    const { world, sim } = makeSim(100);
    ensureCrimeNpc(world);
    expect(world.narrative.isNpc(CRIME_NPC.id)).toBe(true);
    expect(world.narrative.isStaticNpc(CRIME_NPC.id)).toBe(true);
    const npc = world.getCharacter(CRIME_NPC.id);
    expect(npc).toBeTruthy();

    // decayNeeds 跳过静态 NPC，cast 正常衰减
    npc!.needs.hunger = 50;
    const aliceHungerBefore = world.getCharacter("alice")!.needs.hunger!;
    world.decayNeeds();
    expect(npc!.needs.hunger).toBe(50);
    expect(world.getCharacter("alice")!.needs.hunger!).toBeLessThan(aliceHungerBefore);

    // 07:00 upkeep 跳过静态 NPC（tick 28 = D1 07:00）
    const npcGold = npc!.gold;
    const aliceGoldBefore = world.getCharacter("alice")!.gold;
    (sim as any)._applyDailyEnvironment(tickToGameTime(28));
    expect(npc!.gold).toBe(npcGold);
    expect(world.getCharacter("alice")!.gold).toBeLessThan(aliceGoldBefore);
  });

  it("预热期内不投放；预热后白天投放够格之罪（延迟发现链+visibleTo 情报+冷却）", () => {
    const { world, sim, eventBus } = makeSim(100);
    world.getCharacter("alice")!.gold = 200; // 最有钱 → 受害者
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 100 }, "npc");
    expect(world.narrative.isNpc(CRIME_NPC.id)).toBe(true);
    expect(world.narrative.getPendingDiscoveries()).toHaveLength(0); // 预热期

    const injectTick = 100 + NPC_CRIME_FIRST_DELAY_TICKS; // 148 → 13:00，白天
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: injectTick }, "npc");

    const ledger = world.narrative.getCrimeSupplyLedger();
    expect(ledger["npc_last_crime"]).toBe(injectTick);
    // 真金转移 + 赃物入 NPC 包（B2 theft 结算）
    const npc = world.getCharacter(CRIME_NPC.id)!;
    expect(world.getCharacter("alice")!.gold).toBeLessThan(200);
    expect(hasItem(npc.inventory, STOLEN_EVIDENCE_ITEM)).toBe(true);
    // 延迟发现挂上（受害者到场才发现）
    const pending = world.narrative.getPendingDiscoveries();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.victimId).toBe("alice");
    // visibleTo 情报：非受害镇民收到指向 NPC 的观察（sorted 首位 = bob）
    const bobMem = sim.memory.getRecent("bob", 5);
    expect(bobMem.some((m) => m.relatedCharacterId === CRIME_NPC.id)).toBe(true);

    // 冷却/一次一案：紧接着再跑不投第二桩
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: injectTick + 1 }, "npc");
    expect(world.narrative.getPendingDiscoveries()).toHaveLength(1);
    expect(ledger["npc_last_crime"]).toBe(injectTick);
  });

  it("夜里顺延：预热已过但深夜不投放", () => {
    const { world, sim, eventBus } = makeSim(0);
    world.getCharacter("alice")!.gold = 200;
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: 0 }, "npc"); // 播种
    const nightTick = 96; // D2 00:00
    runCrimeSupply({ world, memory: sim.memory, eventBus, tick: nightTick }, "npc");
    expect(world.narrative.getCrimeSupplyLedger()["npc_last_crime"]).toBeUndefined();
  });
});

describe("B3 NPC 读档重建（save-load）", () => {
  const TEST_DB = join(tmpdir(), `anima-crime-supply-${Date.now()}.db`);
  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = TEST_DB + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("narrative.npcs 登记的静态 NPC 读档后重建 addCharacter（金币/位置随档恢复）", () => {
    const simA = makeSim(100);
    ensureCrimeNpc(simA.world);
    const npc = simA.world.getCharacter(CRIME_NPC.id)!;
    npc.gold = 77;
    simA.world.moveCharacter(CRIME_NPC.id, "plaza");
    saveGame(simA.sim, TEST_DB, "test-scenario");

    const simB = makeSim(0); // 新世界：无 NPC
    expect(simB.world.getCharacter(CRIME_NPC.id)).toBeUndefined();
    const ok = loadGame(simB.sim, TEST_DB, "test-scenario");
    expect(ok).toBe(true);
    const rebuilt = simB.world.getCharacter(CRIME_NPC.id);
    expect(rebuilt).toBeTruthy();
    expect(rebuilt!.gold).toBe(77);
    expect(rebuilt!.locationId).toBe("plaza");
    expect(simB.world.narrative.isStaticNpc(CRIME_NPC.id)).toBe(true);
  });
});

describe("B3 旧档 normalize", () => {
  it("crimeSupplyLedger 缺失回填空 Record；脏值清理", () => {
    const raw = {
      world: { unresolvedEvents: [], triggeredBeats: [], rumors: [] },
      characters: {},
      locations: {},
    } as unknown as NarrativeStateSnapshot;
    const snap = normalizeNarrativeSnapshot(raw);
    expect(snap.world.crimeSupplyLedger).toEqual({});

    const dirty = normalizeNarrativeSnapshot({
      world: { crimeSupplyLedger: { good: 5, bad: "x" as unknown as number, nan: NaN } },
      characters: {},
      locations: {},
    } as unknown as NarrativeStateSnapshot);
    expect(dirty.world.crimeSupplyLedger).toEqual({ good: 5 });
  });

  it("JSON 序列化往返存活（Record 不用 Map）", () => {
    const { world } = makeSim(100);
    world.narrative.getCrimeSupplyLedger()["steal_98_bob"] = 100;
    const roundTrip = normalizeNarrativeSnapshot(JSON.parse(JSON.stringify(world.narrative.getSnapshot())));
    expect(roundTrip.world.crimeSupplyLedger["steal_98_bob"]).toBe(100);
  });
});
