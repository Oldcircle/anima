/**
 * kira-incident 诅咒应验回归：
 * 夜里写下的名字 → 次日 06:00 怪病倒下（collapse_cursed + 怪病 moodlet + 三层记忆 + 计数）
 * → 苏醒结算（虚弱 + "这病不对劲" intent）。引擎侧不点名调查者（七反转⑦）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Simulation } from "./simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import type { CharacterCard } from "../character/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 19, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

describe("诅咒应验（_resolveKiraStrikes）", () => {
  let world: World;
  let sim: Simulation;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS, 24); // tick 24 = D1 06:00
    world.addCharacter("light", "夜神月", "cafe");
    world.addCharacter("shinji", "碇真嗣", "cafe");
    world.addCharacter("rei", "绫波丽", "home_tomori");
    sim = new Simulation(world, new EventBus(), {
      characters: [makeCard("light", "夜神月"), makeCard("shinji", "碇真嗣"), makeCard("rei", "绫波丽")],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
  });

  it("pending 名字晨间应验：倒下 + 怪病 moodlet + 计数 + 本人/目击/风声三层记忆", () => {
    world.kira.pending.push({ by: "light", target: "shinji", judgment: "试验", writtenDay: 0 });
    (sim as any)._resolveKiraStrikes(tickToGameTime(24));

    const victim = world.getCharacter("shinji")!;
    expect(victim.currentAction?.name).toBe("collapse_cursed");
    expect(victim.moodlets.some((m) => m.reason.includes("怪病"))).toBe(true);
    expect(world.kira.total).toBe(1);
    expect(world.kira.victims).toContain("shinji");
    expect(world.kira.pending.length).toBe(0);

    // 本人 importance-9 记忆
    const own = sim.memory.getRecent("shinji", 5);
    expect(own.some((m) => m.importance === 9 && m.content.includes("攥住"))).toBe(true);
    // 同地点目击（light 在 cafe）
    const witness = sim.memory.getRecent("light", 5);
    expect(witness.some((m) => m.content.includes("亲眼看见"))).toBe(true);
    // 不在场者只有风声（rei 在家）
    const rumor = sim.memory.getRecent("rei", 5);
    expect(rumor.some((m) => m.content.includes("传开") || m.content.includes("倒下"))).toBe(true);
    expect(rumor.some((m) => m.content.includes("亲眼"))).toBe(false);
  });

  it("第 2 例起风声里带模式（'一模一样''第 N 个'）", () => {
    world.kira.victims.push("someone");
    world.kira.total = 1;
    world.kira.pending.push({ by: "light", target: "shinji", judgment: "", writtenDay: 1 });
    (sim as any)._resolveKiraStrikes(tickToGameTime(24 + 96));

    const rumor = sim.memory.getRecent("rei", 5);
    expect(rumor.some((m) => m.content.includes("一模一样") && m.content.includes("第 2 个"))).toBe(true);
  });

  it("苏醒结算：最后一 tick 带虚弱 moodlet + '这病不对劲' intent", () => {
    const victim = world.getCharacter("shinji")!;
    victim.currentAction = { name: "collapse_cursed", remainingTicks: 1 };
    (sim as any)._applyCursedCollapseRecovery(tickToGameTime(32));

    expect(victim.moodlets.some((m) => m.reason.includes("发虚"))).toBe(true);
    expect(victim.currentIntent?.summary).toContain("不是普通的病");
  });

  it("无剧本时零开销：pending 恒空直接返回", () => {
    (sim as any)._resolveKiraStrikes(tickToGameTime(24));
    expect(world.kira.total).toBe(0);
  });
});
