/**
 * Moodlet System Tests — 情绪叠加系统
 */

import { describe, it, expect } from "vitest";
import { addMoodlet, tickMoodlets, getDominantMood, formatMoodlets, generateNeedMoodlets } from "./moodlets.js";
import type { CharacterState } from "./types.js";

function makeState(overrides: Partial<CharacterState> = {}): CharacterState {
  return {
    id: "tomori", name: "高松灯", locationId: "home_tomori",
    needs: { hunger: 80, energy: 70, social: 60, fun: 70, hygiene: 80, bladder: 90 },
    gold: 100, moodlets: [], inbox: [],
    ...overrides,
  };
}

describe("Moodlet 基础", () => {
  it("addMoodlet 添加情绪", () => {
    const state = makeState();
    addMoodlet(state, "happy", 3, "和人聊了天", 8, "social", 100);
    expect(state.moodlets).toHaveLength(1);
    expect(state.moodlets[0]!.emotion).toBe("happy");
    expect(state.moodlets[0]!.intensity).toBe(3);
    expect(state.moodlets[0]!.reason).toBe("和人聊了天");
    expect(state.moodlets[0]!.expiresAtTick).toBe(108);
  });

  it("同 reason 的 moodlet 不叠加，刷新时间和强度", () => {
    const state = makeState();
    addMoodlet(state, "happy", 2, "和人聊了天", 8, "social", 100);
    addMoodlet(state, "happy", 4, "和人聊了天", 12, "social", 110);
    expect(state.moodlets).toHaveLength(1);
    expect(state.moodlets[0]!.intensity).toBe(4);
    expect(state.moodlets[0]!.expiresAtTick).toBe(122);
  });

  it("intensity clamp 在 1-5", () => {
    const state = makeState();
    addMoodlet(state, "happy", 10, "超级开心", 8, "social", 100);
    expect(state.moodlets[0]!.intensity).toBe(5);
    addMoodlet(state, "sad", -1, "微微不开心", 8, "social", 100);
    expect(state.moodlets[1]!.intensity).toBe(1);
  });

  it("上限 10 个，超出时移除最弱的", () => {
    const state = makeState();
    for (let i = 0; i < 12; i++) {
      addMoodlet(state, "happy", i + 1, `原因${i}`, 100, "social", 100);
    }
    expect(state.moodlets.length).toBeLessThanOrEqual(10);
  });
});

describe("tickMoodlets", () => {
  it("清理过期的 moodlet", () => {
    const state = makeState();
    addMoodlet(state, "happy", 3, "开心", 8, "social", 100);
    addMoodlet(state, "sad", 2, "难过", 4, "event", 100);
    expect(state.moodlets).toHaveLength(2);

    tickMoodlets(state, 103);
    expect(state.moodlets).toHaveLength(2); // 都还没过期

    tickMoodlets(state, 105);
    expect(state.moodlets).toHaveLength(1); // sad 过期了
    expect(state.moodlets[0]!.emotion).toBe("happy");

    tickMoodlets(state, 109);
    expect(state.moodlets).toHaveLength(0); // 都过期了
  });
});

describe("getDominantMood", () => {
  it("返回最高 intensity 的 moodlet", () => {
    const state = makeState();
    addMoodlet(state, "happy", 2, "聊天", 8, "social", 100);
    addMoodlet(state, "anxious", 4, "饿了", 8, "need", 100);
    addMoodlet(state, "confident", 3, "升职了", 8, "work", 100);

    const dominant = getDominantMood(state);
    expect(dominant).toBeDefined();
    expect(dominant!.emotion).toBe("anxious");
  });

  it("没有 moodlet 时返回 null", () => {
    const state = makeState();
    expect(getDominantMood(state)).toBeNull();
  });
});

describe("formatMoodlets", () => {
  it("空列表返回空字符串", () => {
    const state = makeState();
    expect(formatMoodlets(state)).toBe("");
  });

  it("格式化包含情绪和原因", () => {
    const state = makeState();
    addMoodlet(state, "happy", 3, "和爱音聊天", 8, "social", 100);
    addMoodlet(state, "anxious", 1, "肚子有点饿", 4, "need", 100);
    const text = formatMoodlets(state);
    expect(text).toContain("开心");
    expect(text).toContain("和爱音聊天");
    expect(text).toContain("焦虑");
    expect(text).toContain("情绪偏向");
  });

  it("高强度用'很'，低强度用'隐隐'", () => {
    const state = makeState();
    addMoodlet(state, "happy", 5, "极度开心", 8, "social", 100);
    addMoodlet(state, "sad", 1, "微微不开心", 8, "event", 100);
    const text = formatMoodlets(state);
    expect(text).toContain("很开心");
    expect(text).toContain("隐隐难过");
  });
});

describe("generateNeedMoodlets", () => {
  it("社交极低时产生 lonely moodlet", () => {
    const state = makeState({ needs: { hunger: 80, energy: 70, social: 10, fun: 70, hygiene: 80, bladder: 90 } });
    generateNeedMoodlets(state, 100);
    expect(state.moodlets.some((m) => m.emotion === "lonely")).toBe(true);
    expect(state.moodlets.find((m) => m.emotion === "lonely")!.intensity).toBe(4);
  });

  it("饥饿极低时产生 anxious moodlet", () => {
    const state = makeState({ needs: { hunger: 10, energy: 70, social: 60, fun: 70, hygiene: 80, bladder: 90 } });
    generateNeedMoodlets(state, 100);
    expect(state.moodlets.some((m) => m.emotion === "anxious")).toBe(true);
  });

  it("需求正常时不产生 moodlet", () => {
    const state = makeState();
    generateNeedMoodlets(state, 100);
    expect(state.moodlets).toHaveLength(0);
  });
});
