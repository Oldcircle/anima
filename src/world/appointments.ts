/**
 * Appointments — 约定系统的纯函数部分
 *
 * 时间解析：把 LLM 说的"明天中午"/"今天18:00"确定性地翻译成 tick。
 * 提醒文案：按临近程度分级生成 prompt 注入文本。
 * 结算判定在 World/Simulation（需要世界状态）。
 */

import { tickToGameTime, TICKS_PER_DAY } from "../core/tick-engine.js";
import type { Appointment } from "./types.js";

/** 模糊时间词 → 小时 */
/**
 * 模糊时间词 → 小时。**事件锚定的时间排在前面**（"打烊前"比"晚上"更具体，
 * 而且 includes 是先命中先赢）——这类才是镇上人真正会说的话：
 * live 实测「打烊前给你个准数」这种承诺此前整条解析不出来，约定落不了地，
 * 于是"答应了"说完就蒸发（见 logs/sim-s1-voice-live-VERDICT.md §3）。
 */
/**
 * 事件锚定词的**假朋友**：这些短语里含时间词，但根本不是在说时间。
 * 不剔掉的话，「开门见山地说吧」会被静默解析成早上八点的约定——
 * 旧行为是解析不出来（工具会回一句"没说清什么时候"让角色重说），
 * 现在变成一个自信的错时刻，比解析失败更毒。
 */
const FALSE_FRIENDS = /开门见山|下班车|下班机|上下班高峰|上下班|天黑路滑|天亮之前就|收工不/g;

const FUZZY_HOURS: Array<[string, number]> = [
  // 打烊=18 是**店铺无关的近似**：真实 openHours 面包店 17 / 图书馆·花店 18 /
  // 杂货 20 / 咖啡 22 / 酒吧 02，而这里拿不到说话人的 workplace。
  // 取中位数少错一点；要精确得把 workplace 传进来（未做）
  ["打烊", 18],
  ["收工", 18],
  ["下班", 18],
  ["天黑", 19],
  ["开门", 8],
  ["上工", 8],
  ["天亮", 6],
  ["早上", 8],
  ["清晨", 7],
  ["上午", 10],
  ["中午", 12],
  ["下午", 15],
  ["傍晚", 18],
  ["晚上", 20],
  ["夜里", 21],
  ["深夜", 23],
];

/**
 * 解析约定时间字符串 → 绝对 tick。
 * 支持："今天18:00"、"明天12:00"、"18:00"、"明天中午"、"傍晚"、"18点"。
 * 规则：没写"明天"默认今天；算出来的时间已经过了就自动滚到明天。
 * 解析失败返回 undefined（工具报失败让 LLM 重试）。
 */
export function parseAppointmentTime(when: string, currentTick: number): number | undefined {
  const text = when.trim();
  if (!text) return undefined;

  const tomorrow = /明天|明日/.test(text);

  // 1. HH:MM 或 HH点[半]
  let hour: number | undefined;
  let minute = 0;
  const hhmm = text.match(/(\d{1,2})[:：点](\d{2})?/);
  if (hhmm) {
    hour = parseInt(hhmm[1]!, 10);
    if (hhmm[2]) minute = parseInt(hhmm[2], 10);
    else if (text.includes("点半")) minute = 30;
  } else {
    // 2. 模糊时间词（先剔掉假朋友短语，见 FALSE_FRIENDS）
    const cleaned = text.replace(FALSE_FRIENDS, "");
    for (const [word, h] of FUZZY_HOURS) {
      if (cleaned.includes(word)) {
        hour = h;
        break;
      }
    }
  }

  if (hour === undefined || hour < 0 || hour > 23) return undefined;

  const dayStart = Math.floor(currentTick / TICKS_PER_DAY) * TICKS_PER_DAY;
  let atTick = dayStart + hour * 4 + Math.floor(minute / 15);
  if (tomorrow) {
    atTick += TICKS_PER_DAY;
  } else if (atTick <= currentTick) {
    // 说的是已经过去的时间 → 自然理解为明天
    atTick += TICKS_PER_DAY;
  }
  return atTick;
}

/** tick → "今天18:00" / "明天12:00" 的口语表述 */
export function describeAppointmentTime(atTick: number, currentTick: number): string {
  const at = tickToGameTime(atTick);
  const now = tickToGameTime(currentTick);
  const dayDiff = at.day - now.day;
  const hhmm = `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`;
  if (dayDiff <= 0) return `今天${hhmm}`;
  if (dayDiff === 1) return `明天${hhmm}`;
  return `${dayDiff}天后${hhmm}`;
}

/** 约定结算的宽限窗：到点后再等 2 tick（30 分钟） */
export const APPOINTMENT_GRACE_TICKS = 2;

/**
 * 提前兑现窗：到点前 4 tick（1 小时）内，双方已在约定地点碰上且聊上了，
 * 就算兑现——7 天基线里 3 次"爽约"有 2 次其实是提前/换时段履行了被误判。
 */
export const APPOINTMENT_EARLY_TICKS = 4;

/**
 * 为 prompt 生成一条约定提醒，按临近程度分级。
 * 返回 undefined 表示还太远（> 1 天），不打扰。
 */
export function formatAppointmentReminder(params: {
  appointment: Appointment;
  currentTick: number;
  /** 当事人视角：对方的显示名 */
  otherName: string;
  /** 约定地点显示名 */
  locationName: string;
  /** 当事人当前是否已在约定地点 */
  atLocation: boolean;
}): string | undefined {
  const { appointment: a, currentTick, otherName, locationName, atLocation } = params;
  const ticksLeft = a.atTick - currentTick;
  if (ticksLeft > TICKS_PER_DAY) return undefined;

  const timeText = describeAppointmentTime(a.atTick, currentTick);
  const activityText = a.activity ? `（${a.activity}）` : "";

  if (ticksLeft > 8) {
    return `你和${otherName}约好了${timeText}在${locationName}见面${activityText}。`;
  }
  if (ticksLeft > 0) {
    return atLocation
      ? `你和${otherName}约好了${timeText}在${locationName}见面${activityText}，你已经到了，等对方来。`
      : `你和${otherName}约好了${timeText}在${locationName}见面${activityText}——快到时间了，从这里过去要留点时间，别迟到。`;
  }
  // 到点了（宽限窗内）
  return atLocation
    ? `你和${otherName}约的就是现在，在${locationName}${activityText}。你到了，看看对方来了没有。`
    : `你和${otherName}约的时间到了！你现在应该在${locationName}${activityText}，对方可能正在等你。`;
}
