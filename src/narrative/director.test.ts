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

  it("only first 2 tool calls per step are applied (D1: write/step cap)", async () => {
    mockLLM.enqueueResponse("一次做太多事", [
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
      { name: "do_nothing", arguments: {} },
    ]);
    const log = await director.handleBeatReady(fakeBeatReady, world);
    // do_nothing 是 terminal，命中后 break；一步只取前 2 个
    expect(log!.toolCalls.length).toBe(2);
  });

  it("D1: tool loop runs read → write across multiple steps", async () => {
    // Step 1: director 调 read_character
    mockLLM.enqueueResponse("先看看 alice 在干嘛", [
      { name: "read_character", arguments: { character_id: "alice" } },
    ]);
    // Step 2: 看完之后调 inject_intent
    mockLLM.enqueueResponse("alice 现在没事干，给她注入念头", [
      { name: "inject_intent", arguments: { character_id: "alice", summary: "想找 bob 聊聊", target_character_id: "bob" } },
    ]);
    // Step 3: do_nothing 收尾
    mockLLM.enqueueResponse("够了", [{ name: "do_nothing", arguments: {} }]);

    const log = await director.handleBeatReady(fakeBeatReady, world);
    expect(log).not.toBeNull();
    const names = log!.toolCalls.map((c) => c.name);
    expect(names).toContain("read_character");
    expect(names).toContain("inject_intent");
    // mock LLM 至少被调用 2 次（多步）
    expect(mockLLM.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("D2: pulse store auto-records successful write tool calls", async () => {
    mockLLM.enqueueResponse("", [
      { name: "read_character", arguments: { character_id: "alice" } },
    ]);
    mockLLM.enqueueResponse("", [
      {
        name: "inject_intent",
        arguments: {
          character_id: "alice",
          summary: "想找 bob 谈谈",
          target_character_id: "bob",
          expected: "alice 下一 tick 主动 talk(bob)",
        },
      },
    ]);
    mockLLM.enqueueResponse("", [{ name: "do_nothing", arguments: {} }]);

    await director.handleBeatReady(fakeBeatReady, world);

    const store = director.getPulseStore()!;
    expect(store).toBeDefined();
    const pulses = store.list();
    expect(pulses.length).toBe(1);
    expect(pulses[0]!.toolName).toBe("inject_intent");
    expect(pulses[0]!.targetChar).toBe("alice");
    expect(pulses[0]!.expected).toBe("alice 下一 tick 主动 talk(bob)");
    expect(pulses[0]!.observed).toBeUndefined(); // 还没到窗口
  });

  it("D2: do_nothing 和 mark_beat_resolved 不记 pulse", async () => {
    mockLLM.enqueueResponse("", [{ name: "do_nothing", arguments: {} }]);
    await director.handleBeatReady(fakeBeatReady, world);
    expect(director.getPulseStore()!.size()).toBe(0);
  });

  it("D2: usePulseFeedback=false 时禁用 pulse store", async () => {
    director = new Director({ provider: mockLLM, modelId: "test", usePulseFeedback: false });
    expect(director.getPulseStore()).toBeUndefined();
  });

  it("D4: create_arc 工具创建 arc 进 agenda store", async () => {
    mockLLM.enqueueResponse("", [
      {
        name: "create_arc",
        arguments: {
          beat_id: "test_beat",
          goal: "推进真相揭露",
          target_day: 3,
          watch_chars: ["alice", "bob"],
        },
      },
    ]);
    mockLLM.enqueueResponse("", [{ name: "do_nothing", arguments: {} }]);
    await director.handleBeatReady(fakeBeatReady, world);
    const store = director.getAgendaStore()!;
    expect(store.size()).toBe(1);
    expect(store.active()[0]!.goal).toBe("推进真相揭露");
  });

  it("D4: update_agenda 标记 resolved 后归档", async () => {
    const agenda = director.getAgendaStore()!;
    const created = agenda.create(
      { beatId: "b1", goal: "g", targetDay: 3, watchChars: [] },
      100,
      1,
    );
    if (!created.ok) throw new Error("setup failed");
    const arcId = created.arc.id;

    mockLLM.enqueueResponse("", [
      { name: "update_agenda", arguments: { arc_id: arcId, status: "resolved" } },
    ]);
    mockLLM.enqueueResponse("", [{ name: "do_nothing", arguments: {} }]);
    await director.handleBeatReady(fakeBeatReady, world);
    expect(agenda.size()).toBe(0); // 已归档
    expect(agenda.get(arcId)?.status).toBe("resolved");
  });

  it("D4: agenda 摘要会注入到 prompt 用户消息里", async () => {
    const agenda = director.getAgendaStore()!;
    agenda.create({ beatId: "b1", goal: "推进真相揭露", targetDay: 3, watchChars: ["alice"] }, 100, 1);

    mockLLM.enqueueResponse("", [{ name: "do_nothing", arguments: {} }]);
    await director.handleBeatReady(fakeBeatReady, world);

    const lastCall = mockLLM.calls[mockLLM.calls.length - 1]!;
    const userMsg = lastCall.request.messages[0]!.content;
    expect(userMsg).toContain("当前 agenda");
    expect(userMsg).toContain("推进真相揭露");
    expect(userMsg).toContain("[beat:b1]");
  });

  it("D4: handleBeatReady 触发 maintenance（abandon 过期 freelance）", async () => {
    const agenda = director.getAgendaStore()!;
    agenda.create({ beatId: "freelance", goal: "g", targetDay: 5, watchChars: [] }, 100, 1);
    expect(agenda.size()).toBe(1);

    mockLLM.enqueueResponse("", [{ name: "do_nothing", arguments: {} }]);
    // fake event 在 day 5（>1+2=3）
    await director.handleBeatReady(
      { beatId: "tb", reason: "preconditions_met", triggeredDay: 5, triggeredTick: 480 },
      world,
    );
    expect(agenda.size()).toBe(0); // freelance 被 maintenance 自动 abandon
  });

  it("D4: useAgenda=false 时禁用 agenda store", async () => {
    director = new Director({ provider: mockLLM, modelId: "test", useAgenda: false });
    expect(director.getAgendaStore()).toBeUndefined();
  });

  it("D1: write call cap (3) blocks excessive writes across steps", async () => {
    // Step 1: 读一下
    mockLLM.enqueueResponse("", [
      { name: "read_character", arguments: { character_id: "alice" } },
    ]);
    // Step 2: 塞 2 个写（累计 2）
    mockLLM.enqueueResponse("", [
      { name: "inject_intent", arguments: { character_id: "alice", summary: "x", target_character_id: "bob" } },
      { name: "inject_intent", arguments: { character_id: "bob", summary: "y", target_character_id: "alice" } },
    ]);
    // Step 3: 再塞 1 个写（累计 3，达上限）
    mockLLM.enqueueResponse("", [
      { name: "inject_observation", arguments: { observer_id: "alice", observation: "z" } },
    ]);
    // Step 4: 不应被触发
    mockLLM.enqueueResponse("", [
      { name: "inject_intent", arguments: { character_id: "alice", summary: "overflow", target_character_id: "bob" } },
    ]);

    const log = await director.handleBeatReady(fakeBeatReady, world);
    const writeCalls = log!.toolCalls.filter((c) =>
      c.name.startsWith("inject_") && c.result.ok,
    );
    expect(writeCalls.length).toBe(3); // cap=3
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
