/**
 * C2 对话所求单测（DESIGN-revival §8 C2 行）：
 * - ≤1 行（任何来源都不含换行）
 * - off 档关（红线 2）
 * - 敌对所求限额：只对自己压力 top-1 的对注入，且 pair ≥ 阈值
 * - 来源含正向/中性项（临近约定→期待、bond 高→分享/邀约、aspiration→请教/炫耀）
 * - 正向项按天轮换，保留无所求底噪（不是每场对话都带目的）
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  computeConversationDesire,
  HOSTILE_DESIRE_THRESHOLD,
  APPOINTMENT_DESIRE_WINDOW_TICKS,
  BOND_HIGH_LEVEL,
  type ConversationDesireParams,
} from "./conversation-desire.js";
import { setBreakLevel } from "./break-config.js";
import type { PairPressure } from "../narrative/pressure-graph.js";
import type { CharacterCard } from "../character/types.js";
import type { Appointment } from "../world/types.js";

function makeCard(id: string, aspiration?: string): CharacterCard {
  return {
    id, name: id, age: 19, occupation: "学徒", home: `home_${id}`,
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试", relationships: {},
    life: aspiration
      ? { occupation: "学徒", workplace: "bakery", age: 19, income: 5, skills: {}, aspiration }
      : undefined,
  };
}

function makePair(a: string, b: string, pressure: number, inputs?: Partial<PairPressure["inputs"]>): PairPressure {
  const [x, y] = a < b ? [a, b] : [b, a];
  return {
    a: x, b: y, pressure,
    inputs: {
      frictions: 0, grudge: false, debtOverdueDays: 0,
      missedAppointments: 0, level: 0, activeOpenStances: 0, ...inputs,
    },
  };
}

function baseParams(over?: Partial<ConversationDesireParams>): ConversationDesireParams {
  return {
    selfId: "tomori",
    selfCard: makeCard("tomori"),
    partnerId: "anon",
    partnerName: "千早爱音",
    relationship: { level: 0, type: "stranger" },
    upcomingAppointments: [],
    tick: 48,
    day: 2,
    ...over,
  };
}

function appointment(a: string, b: string, atTick: number): Appointment {
  return {
    id: "ap1", proposerId: a, targetId: b, locationId: "cafe",
    atTick, status: "pending", createdTick: 0,
  };
}

afterEach(() => setBreakLevel("mild"));

describe("C2 对话所求", () => {
  it("off 档整体关闭：即便敌对/约定/bond 条件全满足也不注入", () => {
    setBreakLevel("off");
    const r = computeConversationDesire(baseParams({
      relationship: { level: 90, type: "best_friend" },
      upcomingAppointments: [appointment("tomori", "anon", 52)],
      pressureGraph: { getTopPairFor: () => makePair("tomori", "anon", 80, { grudge: true }) },
    }));
    expect(r).toBeUndefined();
  });

  it("任何来源的所求都是单行（不含换行）", () => {
    const scenarios: ConversationDesireParams[] = [
      // 敌对
      baseParams({ pressureGraph: { getTopPairFor: () => makePair("tomori", "anon", 60, { grudge: true }) } }),
      // 约定
      baseParams({ upcomingAppointments: [appointment("anon", "tomori", 50)] }),
    ];
    // 正向轮换：扫一段日子把 bond/aspiration 行都收进来
    for (let day = 1; day <= 30; day++) {
      scenarios.push(baseParams({ day, relationship: { level: 80, type: "close_friend" } }));
      scenarios.push(baseParams({
        day,
        selfCard: makeCard("tomori", "写出一本自己的书"),
        relationship: { level: 40, type: "friend" },
      }));
    }
    const lines = scenarios.map((s) => computeConversationDesire(s)).filter((x): x is string => !!x);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
  });

  it("敌对所求：对压力 top-1 的对且 pair ≥ 阈值时注入", () => {
    const r = computeConversationDesire(baseParams({
      pressureGraph: { getTopPairFor: () => makePair("tomori", "anon", HOSTILE_DESIRE_THRESHOLD, { grudge: true }) },
    }));
    expect(r).toContain("压着事");
    expect(r).toContain("千早爱音");
  });

  it("敌对限额 top-1：对话对象不是自己的 top-1 对时不注敌对（保留底噪）", () => {
    // tomori 的 top-1 是 (tomori, soyo)——与 anon 的对话拿不到敌对所求
    const r = computeConversationDesire(baseParams({
      pressureGraph: { getTopPairFor: () => makePair("tomori", "soyo", 90, { grudge: true }) },
    }));
    expect(r).toBeUndefined();
  });

  it("pair 压力低于阈值不注敌对", () => {
    const r = computeConversationDesire(baseParams({
      pressureGraph: { getTopPairFor: () => makePair("tomori", "anon", HOSTILE_DESIRE_THRESHOLD - 1, { grudge: true }) },
    }));
    expect(r).toBeUndefined();
  });

  it("临近约定 → 期待（只认和这位对话对象的约）", () => {
    const withPartner = computeConversationDesire(baseParams({
      upcomingAppointments: [appointment("anon", "tomori", 48 + 8)],
    }));
    expect(withPartner).toContain("约好");

    const withOther = computeConversationDesire(baseParams({
      upcomingAppointments: [appointment("soyo", "tomori", 48 + 8)],
    }));
    expect(withOther).toBeUndefined();

    const tooFar = computeConversationDesire(baseParams({
      upcomingAppointments: [appointment("anon", "tomori", 48 + APPOINTMENT_DESIRE_WINDOW_TICKS + 1)],
    }));
    expect(tooFar).toBeUndefined();
  });

  it("bond 高 → 分享/邀约，按天轮换且保留无所求底噪", () => {
    const results: Array<string | undefined> = [];
    for (let day = 1; day <= 30; day++) {
      results.push(computeConversationDesire(baseParams({ day, relationship: { level: BOND_HIGH_LEVEL + 10, type: "close_friend" } })));
    }
    expect(results.some((r) => r?.includes("分享"))).toBe(true);
    expect(results.some((r) => r === undefined)).toBe(true); // 底噪保留
  });

  it("aspiration → 请教/炫耀（需已是熟人）", () => {
    const results: Array<string | undefined> = [];
    for (let day = 1; day <= 30; day++) {
      results.push(computeConversationDesire(baseParams({
        day,
        selfCard: makeCard("tomori", "写出一本自己的书"),
        relationship: { level: 40, type: "friend" },
      })));
    }
    expect(results.some((r) => r?.includes("写出一本自己的书"))).toBe(true);
    // 不熟（level < 30）拿不到 aspiration 所求
    for (let day = 1; day <= 30; day++) {
      const r = computeConversationDesire(baseParams({
        day,
        selfCard: makeCard("tomori", "写出一本自己的书"),
        relationship: { level: 10, type: "stranger" },
      }));
      expect(r ?? "").not.toContain("写出一本自己的书");
    }
  });

  it("敌对优先于正向来源（压着事时不假装松快）", () => {
    const r = computeConversationDesire(baseParams({
      relationship: { level: 80, type: "close_friend" },
      upcomingAppointments: [appointment("anon", "tomori", 52)],
      pressureGraph: { getTopPairFor: () => makePair("tomori", "anon", 70, { activeOpenStances: 1 }) },
    }));
    expect(r).toContain("压着事");
  });
});
