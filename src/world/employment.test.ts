/**
 * 失业机制单测 —— 世界的第一个「输」。
 *
 * 锁四件：
 * ①**先警告后辞退**（没有预警的不可逆是惩罚，有预警的才是选择）
 * ②出勤判定宽松（工作时段到过工作地点就算，不要求真干活）
 * ③辞退是**真的丢**：workplace 清空 + income 归零（worker 工具随之从菜单消失）
 * ④off 开关整层退场；没工作的人不进这套账
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  noteAttendance, settleAttendance, jobLossEnabled,
  ABSENCE_WARN_DAYS, ABSENCE_FIRE_DAYS, WORK_HOURS,
} from "./employment.js";
import type { CharacterState } from "./types.js";

function worker(over: Partial<CharacterState["life"]> = {}, locationId = "bakery"): CharacterState {
  return {
    id: "shinji", name: "碇真嗣", locationId, gold: 100,
    needs: { hunger: 80, energy: 80, social: 80, fun: 80, hygiene: 80 },
    life: { occupation: "面包店学徒", workplace: "bakery", age: 14, income: 12, skills: {}, aspiration: "", ...over },
  } as unknown as CharacterState;
}

afterEach(() => { delete process.env.ANIMA_JOB_LOSS; });

describe("出勤记账", () => {
  it("工作时段在工作地点 → 算来过了", () => {
    const s = worker();
    noteAttendance(s, WORK_HOURS.start);
    expect(s.life!.attendedToday).toBe(true);
  });

  it("人在别处 / 不在工作时段 → 不算", () => {
    const away = worker({}, "cafe");
    noteAttendance(away, 12);
    expect(away.life!.attendedToday).toBeUndefined();

    const early = worker();
    noteAttendance(early, WORK_HOURS.start - 1);
    noteAttendance(early, WORK_HOURS.end);   // 含头不含尾
    expect(early.life!.attendedToday).toBeUndefined();
  });

  it("判定宽松：到场就算，不要求真干活（被同事拉着聊了一天不该丢工作）", () => {
    const s = worker();
    noteAttendance(s, 12);   // 只是"在店里"，没调用任何 worker 工具
    expect(settleAttendance(s)!.kind).toBe("present");
  });

  it("没有工作的人不进这套账", () => {
    const jobless = worker({ workplace: "" });
    noteAttendance(jobless, 12);
    expect(settleAttendance(jobless)).toBeUndefined();
  });
});

describe("缺勤升级：警告 → 辞退", () => {
  it("第 1 天只记账，第 2 天警告，第 3 天才辞退", () => {
    const s = worker();
    expect(settleAttendance(s)).toEqual({ kind: "absent", days: 1 });
    expect(settleAttendance(s)).toEqual({ kind: "warn", days: ABSENCE_WARN_DAYS });

    const fired = settleAttendance(s)!;
    expect(fired.kind).toBe("fired");
    expect((fired as { days: number }).days).toBe(ABSENCE_FIRE_DAYS);
  });

  it("辞退是真的丢：workplace 清空 + income 归零，且带得走原来的身份信息", () => {
    const s = worker();
    settleAttendance(s); settleAttendance(s);
    const out = settleAttendance(s) as { kind: string; formerWorkplace: string; formerOccupation: string };
    expect(out.kind).toBe("fired");
    expect(out.formerWorkplace).toBe("bakery");     // 编年史/记忆要写清楚丢的是什么
    expect(out.formerOccupation).toBe("面包店学徒");
    expect(s.life!.workplace).toBe("");             // worker 工具随之从菜单消失
    expect(s.life!.income).toBe(0);                 // 收入断掉 → financeBand 下滑 → 绝境阶梯打开
  });

  it("中途去了一次就清零——缺勤必须是**连续**的", () => {
    const s = worker();
    settleAttendance(s);
    expect(s.life!.absentDays).toBe(1);
    noteAttendance(s, 12);
    expect(settleAttendance(s)!.kind).toBe("present");
    expect(s.life!.absentDays).toBe(0);
    // 从头再数，不会因为之前缺过就提前被辞
    expect(settleAttendance(s)).toEqual({ kind: "absent", days: 1 });
  });

  it("被辞之后不再重复辞退（没工作了就不进账）", () => {
    const s = worker();
    settleAttendance(s); settleAttendance(s); settleAttendance(s);
    expect(settleAttendance(s)).toBeUndefined();
  });
});

describe("开关", () => {
  it("ANIMA_JOB_LOSS=0 整层退场（治愈系小镇不辞退人）", () => {
    process.env.ANIMA_JOB_LOSS = "0";
    expect(jobLossEnabled()).toBe(false);
    const s = worker();
    expect(settleAttendance(s)).toBeUndefined();
    expect(s.life!.workplace).toBe("bakery");
  });
});
