/**
 * Save/Load 集成测试 — 生活主线状态的存档往返
 *
 * 回归锁：晨间打算 / 短期意图 / 信箱 / 约定曾经不落库，读档即蒸发（P0）。
 * 这里跑真实的 saveGame → loadGame 路径，确认它们能完整往返。
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

const TEST_DB = join(tmpdir(), `anima-saveload-${Date.now()}.db`);

describe("save-load 生活主线状态往返", () => {
  afterEach(() => {
    for (const ext of ["", "-wal", "-shm"]) {
      const p = TEST_DB + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it("晨间打算 / 短期意图 / 信箱 / 约定 读档后不蒸发", () => {
    const sim = buildSim(40);

    // 埋入生活主线状态
    const tomori = sim.world.getCharacter("tomori")!;
    tomori.todayPlan = { day: 1, items: ["给爸爸烤一次完美的面包", "傍晚去海边听海浪"] };
    tomori.currentIntent = {
      kind: "follow_up", summary: "答应爱音要还她的笔记本", source: "message",
      targetId: "anon", createdTick: 38, expiresAt: 200,
    };
    sim.world.sendMessage("tomori", { fromId: "anon", fromName: "千早爱音", content: "记得明天中午一起吃饭", tick: 39 });

    const appt: Appointment = {
      id: "appt-1", proposerId: "tomori", targetId: "anon", locationId: "cafe",
      atTick: 88, activity: "一起吃午饭", status: "pending", createdTick: 40,
    };
    expect(sim.world.addAppointment(appt)).toBe(true);

    saveGame(sim, TEST_DB);

    // 全新一局读档
    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);

    const rt = restored.world.getCharacter("tomori")!;
    expect(rt.todayPlan).toEqual({ day: 1, items: ["给爸爸烤一次完美的面包", "傍晚去海边听海浪"] });
    expect(rt.currentIntent?.summary).toBe("答应爱音要还她的笔记本");
    expect(rt.currentIntent?.targetId).toBe("anon");
    expect(rt.inbox).toHaveLength(1);
    expect(rt.inbox[0]?.content).toBe("记得明天中午一起吃饭");

    const appts = restored.world.getAllAppointments();
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({
      id: "appt-1", proposerId: "tomori", targetId: "anon", locationId: "cafe",
      atTick: 88, activity: "一起吃午饭", status: "pending",
    });
    // 读档后约定仍可被正常检索到（结算链路依赖它）
    expect(restored.world.getUpcomingAppointments("anon", 40)).toHaveLength(1);
  });

  it("没有生活主线状态时读档不报错、字段为空", () => {
    const sim = buildSim(10);
    saveGame(sim, TEST_DB);

    const restored = buildSim(0);
    expect(loadGame(restored, TEST_DB)).toBe(true);

    const rt = restored.world.getCharacter("tomori")!;
    expect(rt.todayPlan).toBeUndefined();
    expect(rt.currentIntent).toBeUndefined();
    expect(rt.inbox).toEqual([]);
    expect(restored.world.getAllAppointments()).toHaveLength(0);
  });
});
