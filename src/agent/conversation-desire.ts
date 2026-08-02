/**
 * C2 对话所求注入（DESIGN-revival §3 C2 / §8 C2 行）
 *
 * 确定性、零 LLM：给活跃对话的一方算出「这次对话你心里的所求」——此刻区 1 行，
 * 注入位置在对话 prompt 的缓存分歧点（对话记录）之后（conversation-mode 尾部此刻区）。
 *
 * 来源含正向/中性项（评审：全敌对来源 = 谍战腔制度化）：
 * - 敌对：仅当对话对象是自己压力 top-1 的对，且 pair 压力 ≥ 阈值——其余对话保留无所求底噪
 * - 临近约定 → 期待
 * - bond 高（close_friend 起）→ 想分享/邀约
 * - aspiration → 请教/炫耀（需已是熟人）
 *
 * 正向项按 (day, pair) 确定性哈希轮换：天内稳定（对话中途不抖行文），
 * 且约 1/3 的日子留白 = 无所求底噪。off 档整体关闭（红线 2 + 验收「off 档逐字节回归」）。
 * 红线 3：只配注意力不写结果——行文只说"心里压着/惦记着"，要不要说、怎么说归角色。
 */

import type { CharacterCard } from "../character/types.js";
import type { Appointment } from "../world/types.js";
import type { PairPressure } from "../narrative/pressure-graph.js";
import { getBreakLevel } from "./break-config.js";

/** 敌对所求的 pair 压力阈值（§8：单测锁形状不锁数值） */
export const HOSTILE_DESIRE_THRESHOLD = 40;
/** 临近约定窗口：约定在未来 12 tick（3 游戏小时）内算"临近" */
export const APPOINTMENT_DESIRE_WINDOW_TICKS = 12;
/** bond 高的门槛（close_friend 起点，见 relationships.typeFromLevel） */
export const BOND_HIGH_LEVEL = 60;
/** aspiration 所求需要的最低熟悉度（friend 起点） */
export const ASPIRATION_MIN_LEVEL = 30;

export interface ConversationDesireParams {
  selfId: string;
  selfCard: CharacterCard;
  partnerId: string;
  partnerName: string;
  relationship?: { level: number; type: string };
  /** 自己参与的未结算约定（world.getUpcomingAppointments(selfId)） */
  upcomingAppointments?: Appointment[];
  /** 压力图读口（simulation.pressureGraph）；不传 = 无敌对所求 */
  pressureGraph?: { getTopPairFor(charId: string): PairPressure | undefined };
  tick: number;
  day: number;
}

/** 确定性字符串哈希（正向项按天轮换用，非加密） */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 敌对所求行文：按压力边的主导来源挑"压着的事"，只造处境不写结果 */
function hostileDesireLine(p: PairPressure, partnerName: string): string {
  const i = p.inputs;
  let matter: string;
  if (i.activeOpenStances > 0) matter = "上次撂下的话到现在还没了结";
  else if (i.grudge) matter = "那口没消的气还压在心里";
  else if (i.debtOverdueDays > 0) matter = "欠账拖了这么久还没个说法";
  else if (i.missedAppointments > 0) matter = "被放鸽子的事你还记着";
  else if (i.frictions > 0) matter = "这阵子积下的疙瘩越想越不是滋味";
  else matter = "积下的旧账还堵在心里";
  return `💭 面对${partnerName}，你心里其实压着事——${matter}。这次要不要挑明、怎么开口，由你，但别装没事人。`;
}

/**
 * 算这次对话的所求（≤1 行，不含换行）。返回 undefined = 无所求底噪（保留寒暄自由）。
 */
export function computeConversationDesire(params: ConversationDesireParams): string | undefined {
  if (getBreakLevel() === "off") return undefined;
  const { selfId, partnerId, partnerName, tick } = params;

  // 1) 敌对所求限额：只对自己压力 top-1 的对注入，且 pair 压力 ≥ 阈值
  const top = params.pressureGraph?.getTopPairFor(selfId);
  if (
    top &&
    top.pressure >= HOSTILE_DESIRE_THRESHOLD &&
    ((top.a === selfId && top.b === partnerId) || (top.a === partnerId && top.b === selfId))
  ) {
    return hostileDesireLine(top, partnerName);
  }

  // 2) 临近约定 → 期待
  const appt = (params.upcomingAppointments ?? []).find(
    (a) =>
      a.status === "pending" &&
      (a.proposerId === partnerId || a.targetId === partnerId) &&
      (a.proposerId === selfId || a.targetId === selfId) &&
      a.atTick - tick <= APPOINTMENT_DESIRE_WINDOW_TICKS &&
      a.atTick + 2 >= tick,
  );
  if (appt) {
    const diff = appt.atTick - tick;
    const when = diff <= 0 ? "现在就到点了" : diff <= 4 ? "马上就到点" : "待会儿就到点";
    const what = appt.activity ? `一起${appt.activity}` : "见面";
    return `💭 你和${partnerName}约好了${what}，${when}——这个约你心里记着，有点期待，聊起来自然会想到它。`;
  }

  // 3) 正向项按 (day, pair) 确定性轮换；约 1/3 的日子留白 = 无所求底噪
  const h = hashStr(`${params.day}:${selfId}:${partnerId}`) % 3;
  const level = params.relationship?.level ?? 0;
  if (h === 0 && level >= BOND_HIGH_LEVEL) {
    return `💭 见到${partnerName}你心里是松快的——最近的事想跟TA分享两句，或者干脆约TA一起做点什么。`;
  }
  const aspiration = params.selfCard.life?.aspiration;
  if (h === 1 && aspiration && level >= ASPIRATION_MIN_LEVEL) {
    return `💭 你心里一直惦记着「${aspiration}」——跟${partnerName}也许聊得来这个：请教也好，说说自己的进展也好。`;
  }

  return undefined; // 无所求底噪：不是每场对话都得带着目的
}
