/**
 * 饿倒机制回归测试（needs 归零后果 · 对称力竭昏睡）
 *
 * 7 天基线终局全员 hunger=0 却谈笑风生——挨饿必须咬人。
 * hunger ≤ 2 持续 8 tick → 倒下 6 tick 叫不醒 → 结束勉强缓过来（+15 hunger + 虚弱 + 觅食 intent）。
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

describe("饿倒机制", () => {
  let world: World;
  let sim: Simulation;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS, 40);
    world.addCharacter("tomori", "高松灯", "cafe");
    world.addCharacter("anon", "千早爱音", "cafe");
    sim = new Simulation(world, new EventBus(), {
      characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
  });

  it("饿 8 tick 后倒下：高重要性记忆 + 在场者目击 + observableState", () => {
    const t = world.getCharacter("tomori")!;
    t.needs.hunger = 0;

    (sim as any)._applyStarvationCollapse(tickToGameTime(40)); // 开始计时
    expect(t.currentAction).toBeUndefined();
    (sim as any)._applyStarvationCollapse(tickToGameTime(47)); // 7 tick，还差
    expect(t.currentAction).toBeUndefined();
    (sim as any)._applyStarvationCollapse(tickToGameTime(48)); // 满 8 tick → 倒

    expect(t.currentAction?.name).toBe("collapse_starving");
    const mem = sim.memory.getRecent("tomori", 5).map((e) => e.content).join("");
    expect(mem).toContain("眼前发黑");
    // 同地点的 anon 目击
    const seen = sim.memory.getRecent("anon", 5).map((e) => e.content).join("");
    expect(seen).toContain("饿晕倒");
  });

  it("中途吃上饭：计时清零，不倒", () => {
    const t = world.getCharacter("tomori")!;
    t.needs.hunger = 0;

    (sim as any)._applyStarvationCollapse(tickToGameTime(40));
    t.needs.hunger = 50; // 吃上饭了
    (sim as any)._applyStarvationCollapse(tickToGameTime(44));
    t.needs.hunger = 0;  // 又饿回去，重新计时
    (sim as any)._applyStarvationCollapse(tickToGameTime(45));
    (sim as any)._applyStarvationCollapse(tickToGameTime(52)); // 距 45 只有 7 tick

    expect(t.currentAction).toBeUndefined();
  });

  it("睡着/昏睡中不触发饿倒", () => {
    const t = world.getCharacter("tomori")!;
    t.needs.hunger = 0;
    t.currentAction = { name: "collapse_asleep", remainingTicks: 5 };

    (sim as any)._applyStarvationCollapse(tickToGameTime(40));
    (sim as any)._applyStarvationCollapse(tickToGameTime(50));

    expect(t.currentAction?.name).toBe("collapse_asleep");
  });

  it("倒下结束时勉强缓过来：+hunger、虚弱 moodlet、觅食 intent（只结算一次）", () => {
    const t = world.getCharacter("tomori")!;
    t.needs.hunger = 0;
    t.currentAction = { name: "collapse_starving", remainingTicks: 1 };

    (sim as any)._applyStarvationCollapse(tickToGameTime(60));

    expect(t.needs.hunger).toBe(15);
    expect(t.moodlets.some((m) => m.reason.includes("饿倒"))).toBe(true);
    expect(world.getCurrentIntent("tomori", 60)?.summary).toContain("弄到吃的");

    // remainingTicks 不是 1 时不重复结算
    t.currentAction = { name: "collapse_starving", remainingTicks: 0 };
    (sim as any)._applyStarvationCollapse(tickToGameTime(61));
    expect(t.needs.hunger).toBe(15);
  });

  it("饿倒优先：饿倒期间 energy 跌破 3 不被力竭昏睡覆盖", () => {
    const t = world.getCharacter("tomori")!;
    t.currentAction = { name: "collapse_starving", remainingTicks: 4 };
    t.needs.energy = 1;

    (sim as any)._applyExhaustionCollapse(tickToGameTime(40));

    expect(t.currentAction?.name).toBe("collapse_starving");
  });
});
