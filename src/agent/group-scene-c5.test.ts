/**
 * C5 群聊 v1 形状单测（DESIGN-revival §3 修订版 / §4.5）：
 *
 * - 实验开关 ANIMA_GROUP_SCENE=1 默认关（活人感验收基线在 C5=off 下测）
 * - "pendingInbox"实现：conversationRequest 构建时读 char.inbox 过滤——
 *   发信者 ≠ 对话对象、发信者当前同地点（Tracker 无地点字段的近似）、近 3 tick 窗
 * - 时间线块**只进尾部此刻区**（『## 你现在的状态』之后）——插对话记录前会砸对话桶前缀
 * - simulation 接线：开关开启才注入；默认关时 prompt 无时间线块
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  filterGroupInbox,
  buildConversationRequest,
  GROUP_SCENE_WINDOW_TICKS,
  type ConversationExchange,
  type GroupSceneLine,
} from "./conversation-mode.js";
import { isGroupSceneEnabled, setBreakLevel } from "./break-config.js";
import { Simulation } from "./simulation.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试", relationships: {},
  };
}

function mkState(id: string, name: string): CharacterState {
  return {
    id, name, locationId: "cafe",
    needs: { hunger: 80, energy: 70, social: 70, fun: 60, hygiene: 80, bladder: 90 },
    gold: 50, moodlets: [], inbox: [], inventory: [], recentActions: [],
  };
}

function ex(speakerId: string, speakerName: string, message: string, tick: number): ConversationExchange {
  return { speakerId, speakerName, message, tick };
}

afterEach(() => {
  delete process.env.ANIMA_GROUP_SCENE;
  setBreakLevel("mild");
});

describe("C5 实验开关", () => {
  it("默认关；ANIMA_GROUP_SCENE=1 才开", () => {
    delete process.env.ANIMA_GROUP_SCENE;
    expect(isGroupSceneEnabled()).toBe(false);
    process.env.ANIMA_GROUP_SCENE = "1";
    expect(isGroupSceneEnabled()).toBe(true);
    process.env.ANIMA_GROUP_SCENE = "0";
    expect(isGroupSceneEnabled()).toBe(false);
  });
});

describe("C5 filterGroupInbox（pendingInbox 过滤）", () => {
  const inbox: GroupSceneLine[] = [
    { fromId: "bob", fromName: "鲍勃", content: "对话对象的话", tick: 100 },
    { fromId: "carol", fromName: "卡罗尔", content: "同地点近窗插话", tick: 100 },
    { fromId: "carol", fromName: "卡罗尔", content: "过窗旧话", tick: 100 - GROUP_SCENE_WINDOW_TICKS - 1 },
    { fromId: "dave", fromName: "戴夫", content: "异地点的话", tick: 100 },
  ];
  const sameLocation = (id: string) => id !== "dave";

  it("排除对话对象/过窗/异地点，保留同地点近窗第三方", () => {
    const out = filterGroupInbox({ inbox, partnerId: "bob", currentTick: 101, sameLocation });
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("同地点近窗插话");
  });

  it("空 inbox → 空结果", () => {
    expect(filterGroupInbox({ inbox: [], partnerId: "bob", currentTick: 101, sameLocation })).toEqual([]);
  });
});

describe("C5 prompt 渲染（只进尾部此刻区）", () => {
  const selfCard = makeCard("alice", "爱丽丝");
  const partnerCard = makeCard("bob", "鲍勃");
  const history = [
    ex("alice", "爱丽丝", "你昨天去哪了？", 99),
    ex("bob", "鲍勃", "就在店里啊。", 100),
  ];

  function mk(groupTimeline?: GroupSceneLine[]) {
    return buildConversationRequest({
      card: selfCard,
      state: mkState("alice", "爱丽丝"),
      partnerCard,
      partnerState: mkState("bob", "鲍勃"),
      history,
      gameTime: tickToGameTime(101),
      locationName: "咖啡馆",
      actions: ALL_BASIC_ACTIONS,
      groupTimeline,
    });
  }

  it("时间线块渲染在『## 你现在的状态』与『## 对话记录』之后（尾部此刻区）", () => {
    const r = mk([{ fromId: "carol", fromName: "卡罗尔", content: "你们在聊什么？", tick: 100 }]);
    const u = r.messages[0]!.content as string;
    const blockIdx = u.indexOf("## 同一处还有人插话");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(u.indexOf("## 对话记录"));
    expect(blockIdx).toBeGreaterThan(u.indexOf("## 你现在的状态"));
    expect(u).toContain("卡罗尔(ID:carol) 对你说：「你们在聊什么？」");
  });

  it("无 groupTimeline / 空数组 → 无时间线块", () => {
    expect(mk(undefined).messages[0]!.content as string).not.toContain("同一处还有人插话");
    expect(mk([]).messages[0]!.content as string).not.toContain("同一处还有人插话");
  });
});

describe("C5 simulation 接线", () => {
  function makeSim(): { world: World; sim: Simulation; mock: MockLLMProvider } {
    const world = new World(TEST_LOCATIONS, 100);
    world.addCharacter("alice", "爱丽丝", "cafe");
    world.addCharacter("bob", "鲍勃", "cafe");
    world.addCharacter("carol", "卡罗尔", "cafe");
    const mock = new MockLLMProvider();
    const sim = new Simulation(world, new EventBus(), {
      characters: [makeCard("alice", "爱丽丝"), makeCard("bob", "鲍勃"), makeCard("carol", "卡罗尔")],
      actions: ALL_BASIC_ACTIONS,
      provider: mock,
      modelId: "test",
    });
    // 活跃对话：近 3 tick 内 2+ 条交换
    sim.conversations.recordTalk("alice", "爱丽丝", "bob", "你昨天去哪了？", 99);
    sim.conversations.recordTalk("bob", "鲍勃", "alice", "就在店里啊。", 100);
    // 第三方插话进 inbox
    world.sendMessage("alice", { fromId: "carol", fromName: "卡罗尔", content: "你们在聊什么？", tick: 100 });
    return { world, sim, mock };
  }

  it("开关开启：对话请求含第三方插话块", async () => {
    process.env.ANIMA_GROUP_SCENE = "1";
    const { sim, mock } = makeSim();
    await (sim as any)._gatherAgentDecisions(tickToGameTime(101));
    const aliceConv = mock.calls.find((c) => {
      const u = c.request.messages[0]!.content as string;
      return u.includes("## 对话记录") && u.includes("就在店里啊");
    });
    expect(aliceConv).toBeTruthy();
    expect(aliceConv!.request.messages[0]!.content as string).toContain("## 同一处还有人插话");
    expect(aliceConv!.request.messages[0]!.content as string).toContain("卡罗尔(ID:carol)");
  });

  it("默认关：同一场景不注入时间线块（验收基线回归面）", async () => {
    delete process.env.ANIMA_GROUP_SCENE;
    const { sim, mock } = makeSim();
    await (sim as any)._gatherAgentDecisions(tickToGameTime(101));
    const aliceConv = mock.calls.find((c) => {
      const u = c.request.messages[0]!.content as string;
      return u.includes("## 对话记录") && u.includes("就在店里啊");
    });
    expect(aliceConv).toBeTruthy();
    expect(aliceConv!.request.messages[0]!.content as string).not.toContain("同一处还有人插话");
  });
});
