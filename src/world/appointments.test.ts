import { describe, it, expect } from "vitest";
import {
  parseAppointmentTime,
  describeAppointmentTime,
  formatAppointmentReminder,
} from "./appointments.js";
import { World } from "./world.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { Appointment } from "./types.js";

describe("parseAppointmentTime", () => {
  // 当前 tick 48 = day 0, 12:00

  it("今天18:00 → 当天 72", () => {
    expect(parseAppointmentTime("今天18:00", 48)).toBe(72);
  });

  it("裸 18:00 → 当天 72", () => {
    expect(parseAppointmentTime("18:00", 48)).toBe(72);
  });

  it("明天12:00 → 144", () => {
    expect(parseAppointmentTime("明天12:00", 48)).toBe(144);
  });

  it("模糊词：中午（还没到）→ 当天 48", () => {
    expect(parseAppointmentTime("中午", 20)).toBe(48);
  });

  it("模糊词：明天傍晚 → 明天 18:00", () => {
    expect(parseAppointmentTime("明天傍晚", 48)).toBe(96 + 72);
  });

  it("已经过去的时间自动滚到明天：12:00 时说'早上' → 明天 08:00", () => {
    expect(parseAppointmentTime("早上", 48)).toBe(96 + 32);
  });

  it("18点半 → 当天 18:30", () => {
    expect(parseAppointmentTime("18点半", 48)).toBe(74);
  });

  it("解析不了 → undefined", () => {
    expect(parseAppointmentTime("回头见", 48)).toBeUndefined();
    expect(parseAppointmentTime("", 48)).toBeUndefined();
  });
});

describe("describeAppointmentTime", () => {
  it("当天 → 今天HH:MM", () => {
    expect(describeAppointmentTime(72, 48)).toBe("今天18:00");
  });
  it("次日 → 明天HH:MM", () => {
    expect(describeAppointmentTime(144, 48)).toBe("明天12:00");
  });
});

function makeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "ap1",
    proposerId: "tomori",
    targetId: "anon",
    locationId: "cafe",
    atTick: 72,
    status: "pending",
    createdTick: 48,
    ...overrides,
  };
}

describe("formatAppointmentReminder", () => {
  const base = { otherName: "千早爱音", locationName: "咖啡馆", atLocation: false };

  it("远期（>2小时）：平静提醒", () => {
    const text = formatAppointmentReminder({ appointment: makeAppointment(), currentTick: 48, ...base });
    expect(text).toContain("约好了今天18:00在咖啡馆见面");
  });

  it("临近（≤2小时）且不在场：催促出发", () => {
    const text = formatAppointmentReminder({ appointment: makeAppointment(), currentTick: 66, ...base });
    expect(text).toContain("别迟到");
  });

  it("到点且不在场：紧急提醒", () => {
    const text = formatAppointmentReminder({ appointment: makeAppointment(), currentTick: 72, ...base });
    expect(text).toContain("时间到了");
  });

  it("到点且在场：等对方", () => {
    const text = formatAppointmentReminder({
      appointment: makeAppointment(), currentTick: 72, ...base, atLocation: true,
    });
    expect(text).toContain("看看对方来了没有");
  });

  it("超过一天的约定不打扰", () => {
    const text = formatAppointmentReminder({
      appointment: makeAppointment({ atTick: 48 + 200 }), currentTick: 48, ...base,
    });
    expect(text).toBeUndefined();
  });
});

describe("World 约定存储", () => {
  it("添加 + 查询本人参与的约定", () => {
    const world = new World(TEST_LOCATIONS, 48);
    expect(world.addAppointment(makeAppointment())).toBe(true);
    expect(world.getUpcomingAppointments("tomori", 48)).toHaveLength(1);
    expect(world.getUpcomingAppointments("anon", 48)).toHaveLength(1);
    expect(world.getUpcomingAppointments("rana", 48)).toHaveLength(0);
  });

  it("同一对角色的新约替换旧约", () => {
    const world = new World(TEST_LOCATIONS, 48);
    world.addAppointment(makeAppointment({ id: "a1", atTick: 72 }));
    world.addAppointment(makeAppointment({ id: "a2", atTick: 80, proposerId: "anon", targetId: "tomori" }));
    const upcoming = world.getUpcomingAppointments("tomori", 48);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]!.id).toBe("a2");
  });

  it("每人最多 3 个 pending", () => {
    const world = new World(TEST_LOCATIONS, 48);
    expect(world.addAppointment(makeAppointment({ id: "a1", targetId: "b1" }))).toBe(true);
    expect(world.addAppointment(makeAppointment({ id: "a2", targetId: "b2" }))).toBe(true);
    expect(world.addAppointment(makeAppointment({ id: "a3", targetId: "b3" }))).toBe(true);
    expect(world.addAppointment(makeAppointment({ id: "a4", targetId: "b4" }))).toBe(false);
  });

  it("getDueAppointments 只返回到点的 pending", () => {
    const world = new World(TEST_LOCATIONS, 48);
    world.addAppointment(makeAppointment({ id: "due", atTick: 48 }));
    world.addAppointment(makeAppointment({ id: "future", atTick: 90, proposerId: "x", targetId: "y" }));
    const due = world.getDueAppointments(48);
    expect(due.map((a) => a.id)).toEqual(["due"]);

    world.markAppointment("due", "kept");
    expect(world.getDueAppointments(48)).toHaveLength(0);
  });
});
