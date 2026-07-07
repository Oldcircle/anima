/**
 * 缓存纪律回归测试（prompt caching is everything）：
 * DeepSeek 自动前缀缓存是逐字节匹配——同一角色同地点相邻 tick 的请求，
 * tools + system 必须逐字节一致，user prompt 分歧点必须落在"此刻区"（时间行）之后。
 * 若此测试失败，说明有人把每 tick 抖动的状态（在场者/营业/金币/库存/需求值）
 * 塞回了工具描述或 user prompt 头部——那会把前缀缓存命中率打回 2%。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { runAgentTick, type AgentConfig } from "./agent-loop.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
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
  personality: {
    traits: ["内向", "纯真"],
    interests: ["写东西", "捡石头"],
    dislikes: ["人多的场合"],
    speechStyle: "声音微弱，断断续续",
  },
  background: "从城市来的安静女孩，在面包店当学徒。",
  relationships: {},
};

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

describe("前缀稳定性自检", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let config: AgentConfig;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "cafe");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();
    config = {
      card: tomoriCard,
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test-model",
    };
  });

  it("同角色同地点相邻 tick：tools+system 逐字节一致，user prompt 分歧点在时间行之后", async () => {
    mockLLM.enqueueResponse("待着", [{ name: "do_nothing", arguments: {} }]);
    mockLLM.enqueueResponse("待着", [{ name: "do_nothing", arguments: {} }]);

    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(48) });
    // 模拟需求衰减 + 另一个角色移动（此前这两件事都会把工具表/描述搅乱）
    const tomori = world.getCharacter("tomori")!;
    tomori.needs.energy = (tomori.needs.energy ?? 100) - 3;
    tomori.needs.hunger = (tomori.needs.hunger ?? 100) - 5;
    world.moveCharacter("anon", "plaza");
    await runAgentTick({ config, world, eventBus, gameTime: tickToGameTime(49) });

    expect(mockLLM.calls.length).toBe(2);
    const [r1, r2] = [mockLLM.calls[0]!.request, mockLLM.calls[1]!.request];

    // 1) 工具表逐字节一致（含另一角色移动后——人物分布不再进工具描述）
    const tools1 = JSON.stringify(r1.tools);
    const tools2 = JSON.stringify(r2.tools);
    expect(tools2).toBe(tools1);

    // 2) system prompt 逐字节一致
    expect(r2.system).toBe(r1.system);

    // 3) user prompt 的分歧点必须出现在"此刻区"（时间行）之后
    const u1 = r1.messages[0]!.content as string;
    const u2 = r2.messages[0]!.content as string;
    const divergeAt = commonPrefixLen(u1, u2);
    const momentZoneStart = u1.indexOf("\n时间: ");
    expect(momentZoneStart).toBeGreaterThan(-1);
    expect(divergeAt).toBeGreaterThanOrEqual(momentZoneStart);

    // 可视化输出：前缀覆盖率
    const stablePart = momentZoneStart + JSON.stringify(r1.tools).length + r1.system.length;
    const total = u1.length + JSON.stringify(r1.tools).length + r1.system.length;
    console.log(`[前缀自检] tools=${tools1.length} 字符 + system=${r1.system.length} 字符 全部稳定`);
    console.log(`[前缀自检] user prompt 共同前缀 ${divergeAt}/${u1.length} 字符（时间行位于 ${momentZoneStart}）`);
    console.log(`[前缀自检] 请求级稳定前缀占比 ≈ ${((stablePart / total) * 100).toFixed(1)}%`);
  });
});
