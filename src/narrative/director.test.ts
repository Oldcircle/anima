/**
 * Director Agent 单测（mock LLM）
 *
 * 验证：
 *  - beat_ready 触发 → director 调 LLM → 应用工具
 *  - 预算上限：第 6 次同日调用被拒
 *  - 日志记录
 *  - 越权工具被拒（防御性测试）
 *  - LLM 失败时 graceful degrade
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Director } from "./director.js";
import { World } from "../world/world.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { BeatReadyEvent } from "./beat-engine.js";
import type { Location } from "../world/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
];

function makeWorld(): World {
  const w = new World(fakeLocations);
  w.addCharacter("alice", "Alice", "park");
  w.addCharacter("bob", "Bob", "park");
  return w;
}

const fakeBeatReady: BeatReadyEvent = {
  beatId: "test_beat",
  reason: "preconditions_met",
  triggeredDay: 2,
  triggeredTick: 184,
};

describe("Director", () => {
  let world: World;
  let mockLLM: MockLLMProvider;
  let director: Director;

  beforeEach(() => {
    world = makeWorld();
    mockLLM = new MockLLMProvider();
    director = new Director({ provider: mockLLM, modelId: "test", dailyBudget: 5 });
  });

  it("calls LLM and applies a single tool", async () => {
    mockLLM.enqueueResponse("我决定让 alice 去找 bob 谈谈。", [
      { name: "inject_intent", arguments: { character_id: "alice", summary: "想去找 bob 谈谈", target_character_id: "bob" } },
    ]);

    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log).not.toBeNull();
    expect(log!.toolCalls.length).toBe(1);
    expect(log!.toolCalls[0]!.name).toBe("inject_intent");
    expect(log!.toolCalls[0]!.result.ok).toBe(true);
    expect(world.getCurrentIntent("alice", 184)?.summary).toContain("谈谈");
  });

  it("respects daily budget", async () => {
    director = new Director({ provider: mockLLM, modelId: "test", dailyBudget: 2 });
    mockLLM.setDefaultResponse("noop", [{ name: "do_nothing", arguments: {} }]);

    const log1 = await director.handleBeatReady(fakeBeatReady, world);
    const log2 = await director.handleBeatReady({ ...fakeBeatReady, beatId: "b2" }, world);
    const log3 = await director.handleBeatReady({ ...fakeBeatReady, beatId: "b3" }, world);

    expect(log1).not.toBeNull();
    expect(log2).not.toBeNull();
    expect(log3).toBeNull(); // 预算耗尽
    expect(director.getBudgetRemaining(2)).toBe(0);
  });

  it("budget is per-day", async () => {
    director = new Director({ provider: mockLLM, modelId: "test", dailyBudget: 1 });
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    await director.handleBeatReady({ ...fakeBeatReady, triggeredDay: 1 }, world);
    const log = await director.handleBeatReady({ ...fakeBeatReady, triggeredDay: 2 }, world);
    expect(log).not.toBeNull(); // day 2 重新有预算
  });

  it("rejects forbidden tool calls (talk/say/etc)", async () => {
    mockLLM.enqueueResponse("我让 alice 说话", [
      { name: "talk", arguments: { target: "bob", message: "hi" } },
    ]);
    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log!.toolCalls[0]!.result.ok).toBe(false);
    expect(log!.toolCalls[0]!.result.error).toBe("forbidden_tool");
  });

  it("handles unknown tool gracefully", async () => {
    mockLLM.enqueueResponse("", [{ name: "fly_to_moon", arguments: {} }]);
    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log!.toolCalls[0]!.result.ok).toBe(false);
    expect(log!.toolCalls[0]!.result.error).toBe("unknown_tool");
  });

  it("returns null when LLM throws", async () => {
    const brokenLLM = new MockLLMProvider();
    brokenLLM.failNext("provider down");
    director = new Director({ provider: brokenLLM, modelId: "test" });
    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log).toBeNull();
  });

  it("returns null when disabled", async () => {
    director.setEnabled(false);
    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log).toBeNull();
  });

  it("daily pacing check works without beat", async () => {
    mockLLM.enqueueResponse("世界平静，无需介入", [
      { name: "do_nothing", arguments: { reason: "tension is fine" } },
    ]);
    const log = await director.handleDailyPacing(world, 96);
    expect(log).not.toBeNull();
    expect(log!.trigger).toBe("daily_pacing");
    expect(log!.toolCalls[0]!.name).toBe("do_nothing");
  });

  it("only first 3 tool calls are applied", async () => {
    mockLLM.enqueueResponse("一次做太多事", [
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
    ]);
    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log!.toolCalls.length).toBe(3);
  });

  it("logs are capped at 50 entries", async () => {
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);
    director = new Director({ provider: mockLLM, modelId: "test", dailyBudget: 999 });
    for (let i = 0; i < 60; i++) {
      await director.handleBeatReady({ ...fakeBeatReady, beatId: `b${i}` }, world);
    }
    expect(director.getCallLogs().length).toBe(50);
  });
});
