/**
 * Employment — 会丢的工作（给世界装上第一个「输」）
 *
 * 诊断：这个世界此前**没有任何不可逆的终局状态**——没有死亡、没有离镇、
 * 没有永久失业；关系会 decay 回中性、饥饿会回来、钱会赚回来、moodlet 会过期。
 * 每一天都可以重来。
 *
 * 后果是：**等待永远是最优解**。cast-culprit r1 实测 steal 被端上桌 28 次、
 * 一次没被拿——不是角色有道德，是**不偷的代价只是继续饿着，而明天需求会刷新**。
 * 没有可能失去的东西，就没有一个选择是真的选择。
 *
 * 这一层不加剧情，只加一件会**永久失去**的东西：工作。
 *
 * 设计要点：
 * - **必须有预警**：突然被辞退是"世界惩罚你"，提前捎话才是"你做了选择"。
 *   缺勤第 2 天带话到信箱 + 挂执念，第 3 天才辞退。**没有预警的不可逆是不公平的。**
 * - **出勤判定宽松**：工作时段内在工作地点出现过就算——严格判定（必须调用 worker tool）
 *   会误伤"去了但被同事拉着说了一天话"，那不该丢工作
 * - **辞退是真的丢**：workplace 清空、income 归零、worker 工具从菜单消失。
 *   本期**不做重新就业**——先把"输"做完整，"赢回来"是另一件事
 * - 连锁是设计意图不是副作用：失业 → 断收入 → financeBand 下滑 → 绝境阶梯打开。
 *   上一趟"没人偷"的根就在这条链断着
 * - `ANIMA_JOB_LOSS=0` 整层关闭（治愈系小镇不辞退人）
 */

import type { CharacterState } from "./types.js";

/** 缺勤到第几天带话警告（老板/同事捎口信） */
export const ABSENCE_WARN_DAYS = 2;
/** 缺勤到第几天辞退 */
export const ABSENCE_FIRE_DAYS = 3;
/** 算作"上工了"的时段（含头不含尾） */
export const WORK_HOURS = { start: 8, end: 18 };

export function jobLossEnabled(): boolean {
  return process.env.ANIMA_JOB_LOSS !== "0";
}

/**
 * 每 tick 记一笔出勤：在工作时段、人在自己工作地点 → 今天算来过了。
 * 只写 `life.attendedToday`，日结算时才消费——避免每 tick 判定日边界。
 */
export function noteAttendance(state: CharacterState, hour: number): void {
  const life = state.life;
  if (!life?.workplace) return;
  if (hour < WORK_HOURS.start || hour >= WORK_HOURS.end) return;
  if (state.locationId !== life.workplace) return;
  life.attendedToday = true;
}

export type AttendanceOutcome =
  | { kind: "present" }
  | { kind: "absent"; days: number }
  | { kind: "warn"; days: number }
  | { kind: "fired"; days: number; formerWorkplace: string; formerOccupation: string };

/**
 * 日结算（每天 06:00 调一次）：把昨天的出勤记成账，返回该给这个人什么后果。
 * **有副作用**：会改 `life.absentDays` / 清 `attendedToday`；`fired` 时清空 workplace 与 income。
 */
export function settleAttendance(state: CharacterState): AttendanceOutcome | undefined {
  const life = state.life;
  if (!jobLossEnabled() || !life?.workplace) return undefined;

  const attended = life.attendedToday === true;
  life.attendedToday = false;

  if (attended) {
    life.absentDays = 0;
    return { kind: "present" };
  }

  const days = (life.absentDays ?? 0) + 1;
  life.absentDays = days;

  if (days >= ABSENCE_FIRE_DAYS) {
    const formerWorkplace = life.workplace;
    const formerOccupation = life.occupation;
    // 真的丢了：worker 工具随之从菜单消失，收入断掉
    life.workplace = "";
    life.income = 0;
    life.absentDays = 0;
    return { kind: "fired", days, formerWorkplace, formerOccupation };
  }
  if (days >= ABSENCE_WARN_DAYS) return { kind: "warn", days };
  return { kind: "absent", days };
}
