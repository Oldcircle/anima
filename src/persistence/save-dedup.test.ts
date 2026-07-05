/**
 * 存档去重回归测试（活人感体检 P3）
 *
 * 回归锁：saveAll 曾对 memories/long_term_memories 裸 INSERT，
 * 每次自动存档全量追加一遍（生产存档实测短期 74%/长期 86% 是重复副本，
 * 读档后检索窗口被同一条记忆挤满，角色变复读机）。
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { saveGame, loadGame } from "./save-load.js";
import { Simulation } from "../agent/simulation.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const tomoriCard: CharacterCard = {
  id: "tomori", name: "高松灯", age: 19, occupation: "面包店学徒", home: "home_tomori",
  personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多"], speechStyle: "微弱" },
  background: "面包店学徒", relationships: {},
};

function buildSim(tick = 0): Simulation {
  const world = new World(TEST_LOCATIONS, tick);
  world.addCharacter("tomori", "高松灯", "home_tomori");
  return new Simulation(world, new EventBus(), {
    characters: [tomoriCard],
    actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(),
    modelId: "test",
  });
}

const TEST_DB = join(tmpdir(), `anima-savededup-${Date.now()}.db`);

afterEach(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
    if (existsSync(p)) unlinkSync(p);
  }
});

describe("存档去重与剧本护栏", () => {
  it("连续存档 3 次，记忆表行数不膨胀", () => {
    const sim = buildSim(10);
    sim.memory.add("tomori", { tick: 5, type: "event", content: "在店里揉了面团", importance: 4 });
    sim.memory.add("tomori", { tick: 6, type: "reflection", content: "[反思] 今天有点累", importance: 9 });
    sim.longTerm.add("tomori", { tick: 6, type: "reflection", content: "[反思] 今天有点累", importance: 9 });

    saveGame(sim, TEST_DB, "default");
    saveGame(sim, TEST_DB, "default");
    saveGame(sim, TEST_DB, "default");

    const db = new Database(TEST_DB, { readonly: true });
    const memCount = (db.prepare("SELECT COUNT(*) as n FROM memories").get() as any).n;
    const ltmCount = (db.prepare("SELECT COUNT(*) as n FROM long_term_memories").get() as any).n;
    db.close();

    expect(memCount).toBe(2);  // 不是 6
    expect(ltmCount).toBe(1);  // 不是 3
  });

  it("剧本不匹配时拒绝读档（跨剧本污染护栏）", () => {
    const sim = buildSim(10);
    saveGame(sim, TEST_DB, "last-ferry");

    const sim2 = buildSim(0);
    const loaded = loadGame(sim2, TEST_DB, "default");
    expect(loaded).toBe(false);

    // 同剧本正常读
    const sim3 = buildSim(0);
    expect(loadGame(sim3, TEST_DB, "last-ferry")).toBe(true);
  });

  it("LTM store 与 lastReflection 随档往返", () => {
    const sim = buildSim(10);
    sim.longTerm.add("tomori", { tick: 6, type: "event", content: "你和爱音大吵了一架", importance: 8, relatedCharacterId: "anon" });
    sim.world.getCharacter("tomori")!.lastReflection = { day: 1, insights: ["今天不顺"], mood: "低落", concern: "和爱音的关系" };

    saveGame(sim, TEST_DB, "default");
    const sim2 = buildSim(0);
    expect(loadGame(sim2, TEST_DB, "default")).toBe(true);

    expect(sim2.longTerm.getAbout("tomori", "anon")[0]!.content).toContain("大吵");
    expect(sim2.world.getCharacter("tomori")!.lastReflection?.mood).toBe("低落");
  });
});
