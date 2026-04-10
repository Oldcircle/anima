/**
 * BeatEngine × Simulation 端到端测试（无真实 LLM）
 *
 * 验证：
 *  - simulation 在 22:00 时刻自动调 runBeatScan
 *  - 触发的 beats 写回 narrative_state.triggeredBeats
 *  - eventBus 收到 beat.ready 事件
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Simulation } from "../agent/simulation.js";
import { EventBus, type WorldEvent } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
];

const aliceCard: CharacterCard = {
  id: "alice",
  name: "Alice",
  age: 20,
  gender: "female",
  occupation: "tester",
  home: "park",
  personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
  background: "",
  relationships: {},
};

describe("BeatEngine + Simulation integration", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let sim: Simulation;
  let beatEvents: WorldEvent[];

  beforeEach(() => {
    world = new World(fakeLocations);
    world.addCharacter("alice", "Alice", "park");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();
    mockLLM.setDefaultResponse("", []); // 角色每 tick 不做事

    sim = new Simulation(world, eventBus, {
      characters: [aliceCard],
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test",
    });

    beatEvents = [];
    eventBus.on((e) => {
      if (e.type === "beat.ready") beatEvents.push(e);
    });
  });

  it("loadBeats + runOneTick 自动触发 scan", async () => {
    sim.loadBeats([
      { id: "always_fire", preconditions: ["true"] },
    ]);

    // 任意 4 的倍数 tick 都会触发 scan
    await sim.runOneTick(tickToGameTime(88));

    expect(beatEvents.length).toBe(1);
    expect(beatEvents[0]!.description).toContain("always_fire");
    expect(world.narrative.getWorld().triggeredBeats).toContain("always_fire");
  });

  it("scan 每 4 tick（每游戏小时）触发一次", async () => {
    sim.loadBeats([{ id: "x", preconditions: ["true"] }]);
    // tick 40 是 4 的倍数，会触发 scan
    await sim.runOneTick(tickToGameTime(40)); // 10:00
    expect(beatEvents.length).toBe(1);
    expect(world.narrative.getWorld().triggeredBeats).toContain("x");
  });

  it("一个 beat 不会跨天重复触发", async () => {
    sim.loadBeats([{ id: "once", preconditions: ["true"] }]);
    await sim.runOneTick(tickToGameTime(88));   // day 1 22:00
    await sim.runOneTick(tickToGameTime(184));  // day 2 22:00
    expect(beatEvents.length).toBe(1);
  });

  it("不同 day 的 beats 各自触发", async () => {
    sim.loadBeats([
      { id: "day1", preconditions: ["world.day == 1"] },
      { id: "day2", preconditions: ["world.day == 2"] },
    ]);
    await sim.runOneTick(tickToGameTime(88));   // day 1
    await sim.runOneTick(tickToGameTime(184));  // day 2
    expect(beatEvents.map((e) => e.description)).toEqual([
      expect.stringContaining("day1"),
      expect.stringContaining("day2"),
    ]);
  });

  it("fallback_deadline 在第 N 天兜底触发", async () => {
    sim.loadBeats([
      { id: "must_fire_by_3", preconditions: ["false"], fallback_deadline_day: 3 },
    ]);
    await sim.runOneTick(tickToGameTime(88));   // day 1: nope
    await sim.runOneTick(tickToGameTime(184));  // day 2: nope
    await sim.runOneTick(tickToGameTime(280));  // day 3: fallback fires
    expect(beatEvents.length).toBe(1);
    expect(beatEvents[0]!.description).toContain("fallback_deadline");
  });

  it("triggered set 在重复 scan 间保持", async () => {
    sim.loadBeats([{ id: "x", preconditions: ["true"] }]);
    await sim.runOneTick(tickToGameTime(88));
    expect(sim.beatEngine.getTriggered()).toContain("x");
  });
});
