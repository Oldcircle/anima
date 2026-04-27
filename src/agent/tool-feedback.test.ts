/**
 * Tool Feedback Loop（Layer D）单元测试
 *
 * 覆盖：buildToolFailureHint 各模式 + agent-loop 失败重试行为
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildToolFailureHint } from "./tool-feedback.js";
import { Simulation } from "./simulation.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const tomoriCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多的场合"], speechStyle: "声音微弱" },
  background: "面包店学徒",
  relationships: {},
};

const anonCard: CharacterCard = {
  id: "anon",
  name: "千早爱音",
  age: 19,
  occupation: "咖啡馆兼职",
  home: "home_anon",
  personality: { traits: ["开朗"], interests: ["社交"], dislikes: ["被忽视"], speechStyle: "活泼外向" },
  background: "咖啡馆兼职",
  relationships: {},
};

describe("buildToolFailureHint", () => {
  it("不存在的工具 → 列出可用工具，警告别再调", () => {
    const hint = buildToolFailureHint({
      toolName: "talk",
      args: {},
      description: '工具 "talk" 不在当前可用列表里',
      availableTools: ["go_to", "do_nothing"],
    });
    expect(hint).toContain("用不了");
    expect(hint).toContain("go_to");
    expect(hint).toContain("do_nothing");
    expect(hint).toContain("不要再调用");
  });

  it("不存在的工具 + 没有其他工具 → 提示 do_nothing", () => {
    const hint = buildToolFailureHint({
      toolName: "talk",
      args: {},
      description: "工具 talk 不在当前可用列表里",
      availableTools: [],
    });
    expect(hint).toContain("do_nothing");
  });

  it("go_to 当前位置 → 提示换其他工具或 do_nothing", () => {
    const hint = buildToolFailureHint({
      toolName: "go_to",
      args: { location: "cafe" },
      description: "你已经在咖啡馆了，不用再特地过去",
      availableTools: ["go_to", "talk", "eat", "do_nothing"],
      currentLocationName: "咖啡馆",
    });
    expect(hint).toContain("不需要再 go_to");
    expect(hint).toMatch(/talk|eat/);
    expect(hint).toContain("do_nothing");
  });

  it("go_to 当前位置 + 没其他工具 → 提示 do_nothing", () => {
    const hint = buildToolFailureHint({
      toolName: "go_to",
      args: { location: "home" },
      description: "你已经在家了",
      availableTools: ["go_to", "do_nothing"],
    });
    expect(hint).toContain("do_nothing");
  });

  it("go_to 不存在的地方 → 提示看 description", () => {
    const hint = buildToolFailureHint({
      toolName: "go_to",
      args: { location: "异世界" },
      description: "想去异世界，但你知道镇上并没有这个地方",
      availableTools: ["go_to", "do_nothing"],
    });
    expect(hint).toContain("不存在");
  });

  it("eat 没指定食物 → 提示填 item_id", () => {
    const hint = buildToolFailureHint({
      toolName: "eat",
      args: {},
      description: "想吃东西但没想好吃什么",
      availableTools: ["eat", "buy", "go_to"],
    });
    expect(hint).toContain("item_id");
  });

  it("通用兜底列出可换的工具", () => {
    const hint = buildToolFailureHint({
      toolName: "talk",
      args: {},
      description: "未知错误",
      availableTools: ["talk", "go_to", "eat"],
      currentLocationName: "广场",
    });
    expect(hint).toContain("广场");
    expect(hint).toMatch(/go_to|eat/);
  });
});

describe("agent-loop tick 内 retry（Layer D）", () => {
  let world: World;
  let sim: Simulation;
  let mockLLM: MockLLMProvider;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    const eventBus = new EventBus();
    mockLLM = new MockLLMProvider();
    sim = new Simulation(world, eventBus, {
      characters: [tomoriCard, anonCard],
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "mock",
    });
  });

  it("失败的 go_to 触发重试，第二次 do_nothing 成功", async () => {
    // tomori 在自家
    world.moveCharacter("tomori", "home_tomori");
    world.moveCharacter("anon", "home_anon");
    // tomori 第 1 次：go_to "家"（在家应失败 - Layer C）
    mockLLM.enqueueResponse("回家", [
      { name: "go_to", arguments: { location: "家", thought: "我要回家" } },
    ]);
    // tomori 重试：do_nothing（成功）
    mockLLM.enqueueResponse("发会儿呆", [
      { name: "do_nothing", arguments: { thought: "已经在家了，那就发呆吧" } },
    ]);
    // anon 默认 do_nothing
    mockLLM.setDefaultResponse("发呆", [
      { name: "do_nothing", arguments: { thought: "无所事事" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));

    // 应该至少调用 LLM 3 次（tomori×2 + anon×1）
    expect(mockLLM.calls.length).toBeGreaterThanOrEqual(3);
    // tomori 的最终行动应是 do_nothing（重试成功）
    const tomoriResult = summary.results.find((r) => r.characterId === "tomori");
    expect(tomoriResult?.action?.name).toBe("do_nothing");
  });

  it("MAX_TOOL_RETRY=1：重试也失败时不无限循环", async () => {
    world.moveCharacter("tomori", "home_tomori");
    world.moveCharacter("anon", "home_anon");
    mockLLM.enqueueResponse("回家", [
      { name: "go_to", arguments: { location: "家", thought: "回家" } },
    ]);
    // 重试也给个失败的（不存在的地方）
    mockLLM.enqueueResponse("再去别的", [
      { name: "go_to", arguments: { location: "异世界", thought: "" } },
    ]);
    mockLLM.setDefaultResponse("默认", [
      { name: "do_nothing", arguments: { thought: "" } },
    ]);

    await sim.runOneTick(tickToGameTime(48));
    // 单 tick 内 LLM 调用应该被限制：每个角色最多 2 次（原 + 1 重试）
    // 加上反应轮等容差，不应超过 6 次
    expect(mockLLM.calls.length).toBeLessThan(8);
  });

  it("重试给完全相同的工具+参数 → 跳过，不死循环", async () => {
    world.moveCharacter("tomori", "home_tomori");
    world.moveCharacter("anon", "home_anon");
    mockLLM.enqueueResponse("回家", [
      { name: "go_to", arguments: { location: "家", thought: "回家" } },
    ]);
    // 重试给完全一样的调用 → 应被 dedup 检测拦截
    mockLLM.enqueueResponse("还是回家", [
      { name: "go_to", arguments: { location: "家", thought: "回家" } },
    ]);
    mockLLM.setDefaultResponse("默认", [
      { name: "do_nothing", arguments: { thought: "" } },
    ]);

    await sim.runOneTick(tickToGameTime(48));
    expect(mockLLM.calls.length).toBeLessThan(10);
  });

  it("不存在的工具触发 retry，第二次给合法工具成功", async () => {
    world.moveCharacter("tomori", "plaza");
    world.moveCharacter("anon", "plaza");
    // 第 1 次：调一个不存在的工具
    mockLLM.enqueueResponse("乱叫", [
      { name: "fly", arguments: { thought: "我要飞" } },
    ]);
    // 重试：do_nothing
    mockLLM.enqueueResponse("发会儿呆", [
      { name: "do_nothing", arguments: { thought: "飞不了，发呆吧" } },
    ]);
    mockLLM.setDefaultResponse("默认", [
      { name: "do_nothing", arguments: { thought: "" } },
    ]);
    const summary = await sim.runOneTick(tickToGameTime(48));
    const tomoriResult = summary.results.find((r) => r.characterId === "tomori");
    // 重试成功：最终行动是 do_nothing
    expect(tomoriResult?.action?.name).toBe("do_nothing");
  });

  it("成功的工具不触发重试（最常见路径）", async () => {
    mockLLM.setDefaultResponse("发呆", [
      { name: "do_nothing", arguments: { thought: "" } },
    ]);
    await sim.runOneTick(tickToGameTime(48));
    // 2 角色 × 1 调用 = 2，加反应轮容差 ≤ 4
    expect(mockLLM.calls.length).toBeLessThanOrEqual(4);
  });
});
