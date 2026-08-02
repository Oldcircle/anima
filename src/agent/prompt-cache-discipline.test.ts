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
import { buildConversationRequest, type ConversationExchange } from "./conversation-mode.js";
import type { CharacterState } from "../world/types.js";

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

// ── 对话路径前缀稳定性（DESIGN-revival §5 红线 1 / §8 C2 行）──
// 对话模式的 append-only 前缀 = 场景+对象+指令+对话记录；每 tick 抖动的状态（时间/身体/
// C2 所求）必须全部落在对话记录之后。若分歧点跑进对话记录之前，说明有人把动态内容
// 塞回了对话桶前缀——68.5% 的对话桶命中率会塌掉。

describe("对话路径前缀稳定性", () => {
  const selfCard: CharacterCard = {
    id: "tomori", name: "高松灯", age: 19, occupation: "面包店学徒", home: "home_tomori",
    personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多"], speechStyle: "微弱" },
    background: "面包店学徒", relationships: {},
  };
  const partnerCard: CharacterCard = {
    id: "anon", name: "千早爱音", age: 19, occupation: "咖啡馆兼职", home: "home_anon",
    personality: { traits: ["开朗"], interests: ["社交"], dislikes: ["被忽视"], speechStyle: "活泼" },
    background: "咖啡馆兼职", relationships: {},
  };

  function mkState(id: string, name: string, energy: number): CharacterState {
    return {
      id, name, locationId: "cafe",
      needs: { hunger: 80, energy, social: 70, fun: 60, hygiene: 80, bladder: 90 },
      gold: 50, moodlets: [], inbox: [], inventory: [], recentActions: [],
    };
  }

  function ex(speakerId: string, speakerName: string, message: string, tick: number): ConversationExchange {
    return { speakerId, speakerName, message, tick };
  }

  it("相邻两轮对话请求：tools+system 逐字节一致，分歧点在对话记录之后；C2 所求在状态区之后", () => {
    const desire = "💭 见到千早爱音你心里是松快的——最近的事想跟TA分享两句，或者干脆约TA一起做点什么。";
    const historyT1 = [
      ex("tomori", "高松灯", "那个……这本书，你看过吗", 46),
      ex("anon", "千早爱音", "哪本？给我看看封面", 47),
    ];
    const historyT2 = [...historyT1, ex("tomori", "高松灯", "就是这本，讲海的", 48)];

    const mk = (tick: number, history: ConversationExchange[], energy: number) =>
      buildConversationRequest({
        card: selfCard,
        state: mkState("tomori", "高松灯", energy),
        partnerCard,
        partnerState: mkState("anon", "千早爱音", 80),
        history,
        gameTime: tickToGameTime(tick),
        locationName: "海风咖啡馆",
        relationship: { level: 20, type: "acquaintance" },
        actions: ALL_BASIC_ACTIONS,
        conversationDesire: desire,
      });

    const r1 = mk(48, historyT1, 70);
    const r2 = mk(49, historyT2, 67); // 下一 tick：多一条对话、需求衰减

    // tools + system 逐字节一致
    expect(JSON.stringify(r2.tools)).toBe(JSON.stringify(r1.tools));
    expect(r2.system).toBe(r1.system);

    const u1 = r1.messages[0]!.content as string;
    const u2 = r2.messages[0]!.content as string;
    const divergeAt = commonPrefixLen(u1, u2);

    // 分歧点必须在 append-only 的对话记录之后（历史只增不改）
    const historyIdx = u1.indexOf("## 对话记录");
    expect(historyIdx).toBeGreaterThan(-1);
    expect(divergeAt).toBeGreaterThanOrEqual(historyIdx);

    // C2 所求：≤1 行，且位于"你现在的状态"（缓存分歧点）之后
    expect(desire).not.toContain("\n");
    const stateIdx = u2.indexOf("## 你现在的状态");
    const desireIdx = u2.indexOf(desire);
    expect(stateIdx).toBeGreaterThan(historyIdx);
    expect(desireIdx).toBeGreaterThan(stateIdx);

    console.log(`[对话路径自检] 共同前缀 ${divergeAt}/${u1.length} 字符（对话记录位于 ${historyIdx}）`);
  });

  it("C2 所求不注入时（off/底噪）prompt 不出现所求行", () => {
    const r = buildConversationRequest({
      card: selfCard,
      state: mkState("tomori", "高松灯", 70),
      partnerCard,
      partnerState: mkState("anon", "千早爱音", 80),
      history: [ex("anon", "千早爱音", "早。", 47)],
      gameTime: tickToGameTime(48),
      locationName: "海风咖啡馆",
      actions: ALL_BASIC_ACTIONS,
    });
    expect(r.messages[0]!.content as string).not.toContain("💭");
  });
});
