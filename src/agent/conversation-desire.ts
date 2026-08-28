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
import { pursuitsEnabled } from "../world/pursuit.js";

/** 债务所求：欠满这么多 tick 才成为"心里压着的事"（2 游戏天，与讨债提醒同口径） */
export const DEBT_DESIRE_OVERDUE_TICKS = 192;

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
  /**
   * 自己欠谁的账（`character.debts`）与对方欠自己的账。
   * 债务是这个世界里**现成就有、且最经典的场景目标**——「我的钱什么时候还」。
   * 不传 = 无债务所求（逐字节回归）。
   */
  myDebts?: Array<{ lenderId: string; amount: number; borrowedTick: number }>;
  /** 运行期追求状态（`character.pursuit`，带 status）。不传 = 无追求向所求 */
  selfPursuit?: import("../world/pursuit.js").PursuitState;
  partnerDebts?: Array<{ lenderId: string; amount: number; borrowedTick: number }>;

  /**
   * 拒绝账本读口（narrative.getRefusal(selfId, partnerId)）：同类所求上次被回绝过，
   * 这一行就写得更硬（手段升档）。不传 = 无升档，行文逐字节回归。
   */
  refusal?: { kind: string; count: number; tier: number; brokenPromises?: number };
  /** 对方欠着的那张到期欠条（未到期）——见着他这事就压在嘴边 */
  pendingDeferral?: { kind: string; evidence: string; dueTick: number };
}

/** 所求的四类来源。结算器据此判定"他要的这桩事，到底有没有着落" */
export type DesireKind = "hostile" | "debt" | "appointment" | "pursuit" | "bond" | "aspiration";

/**
 * 可寻址的所求：比注入用的那一行多带 kind/id/want。
 * **want 只喂给结算器，绝不进角色 prompt**——告诉角色"你要什么"是写结果，红线③。
 */
export interface AddressableDesire {
  kind: DesireKind;
  /** 稳定 id：同一桩所求跨 tick 不变，供结算与拒绝账本寻址 */
  id: string;
  /** 一句白描的"他这次想要的是什么"（结算器 prompt 用） */
  want: string;
  /** 注入此刻区的那一行（≤1 行，不含换行，💭 开头） */
  line: string;
}

/** 手段升档封顶：3 = 这条路走到头了 */
export const MAX_REFUSAL_TIER = 3;

/**
 * 升档小尾巴（同类所求上次被回绝过才追加）。
 * 红线③只造处境不写结果：**只说上次碰了钉子这个事实**，
 * 这回改口气、换手段、还是干脆闭嘴，仍然归角色自己。
 */
function escalationTail(
  tier: number,
  partnerName: string,
  brokenPromises = 0,
): string {
  // 爽约优先说：**被回绝和"答应了却没做"不是一回事**，后者是这套系统里最锋利的一句
  if (brokenPromises >= 2) {
    return `（他答应过你 ${brokenPromises} 回了，回回到点什么都没有。）`;
  }
  if (brokenPromises === 1) return `（上回他答应得好好的，到点什么都没有。）`;
  if (tier <= 0) return "";
  if (tier === 1) return `（上一回你开口，${partnerName}没接住。）`;
  if (tier === 2) return `（同样的事，你已经碰过两回钉子了。）`;
  return `（这条路你走到头了：照老样子再问一次，多半还是一样的答复。）`;
}

/** 欠条还没到期：不是碰壁，是"他说了会办，还没到点"——语气该是等着，不是硬 */
function pendingTail(evidence: string): string {
  return `（他答应过「${evidence.slice(0, 20)}」，还没到点。）`;
}

/** 确定性字符串哈希（正向项按天轮换用，非加密） */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 敌对所求行文：按压力边的主导来源挑"压着的事"，只造处境不写结果 */
function hostileDesireLine(p: PairPressure, partnerName: string, isCreditor: boolean): string {
  const i = p.inputs;
  let matter: string;
  if (i.activeOpenStances > 0) matter = "上次撂下的话到现在还没了结";
  else if (i.grudge) matter = "那口没消的气还压在心里";
  // debtOverdueDays 是**无向标量**（pressure-graph 按 pair 聚合）——不加这道方向闸，
  // 欠钱的那个会拿到债主的怨气，被推着去向债主"要一个说法"（对抗审查实证）
  else if (i.debtOverdueDays > 0 && isCreditor) matter = "欠账拖了这么久还没个说法";
  else if (i.missedAppointments > 0) matter = "被放鸽子的事你还记着";
  else if (i.frictions > 0) matter = "这阵子积下的疙瘩越想越不是滋味";
  else matter = "积下的旧账还堵在心里";
  return `💭 面对${partnerName}，你心里其实压着事——${matter}。这次要不要挑明、怎么开口，由你，但别装没事人。`;
}

/**
 * 算这次对话的所求（≤1 行，不含换行）。返回 undefined = 无所求底噪（保留寒暄自由）。
 * 薄包装：真正的来源判定在 computeAddressableDesire，这里只取那一行，保住旧调用点逐字节。
 */
export function computeConversationDesire(params: ConversationDesireParams): string | undefined {
  return computeAddressableDesire(params)?.line;
}

/**
 * 可寻址版：多带 kind/id/want，供对话结算器事后判定"要到了没有"。
 * 判定顺序与旧版逐字一致（敌对 → 临近约定 → 正向轮换），line 也逐字一致，
 * 只在同类所求有拒绝账本时追加升档尾巴。
 */
export function computeAddressableDesire(
  params: ConversationDesireParams,
): AddressableDesire | undefined {
  if (getBreakLevel() === "off") return undefined;
  const { selfId, partnerId, partnerName, tick } = params;
  // 升档只对**同类**所求生效：借钱碰过钉子，不该把"想分享近况"也写硬
  const tailFor = (kind: DesireKind): string => {
    // 有未到期的欠条 → 说"还没到点"，不说"碰壁"（这时候硬起来是不讲理）
    if (params.pendingDeferral?.kind === kind && tick < params.pendingDeferral.dueTick) {
      return pendingTail(params.pendingDeferral.evidence);
    }
    if (params.refusal?.kind !== kind) return "";
    return escalationTail(params.refusal.tier, partnerName, params.refusal.brokenPromises ?? 0);
  };

  // 1) 债务（世界里现成的场景目标）：先看对方欠我的（债主向），再看我欠对方的（欠债人向）。
  //    **必须排在 hostile 之前**：逾期欠账本身给 pair 压力贡献 6/天，很容易把这一对顶过
  //    hostile 的 40 分线——于是同一桩「要钱」被贴上 kind="hostile"，而 hostile 是
  //    **无向且不可机械核验**的：欠条到期 baseline=undefined 静默过期，爽约永远落不了账；
  //    压力跨线那一刻 kind 一翻，recordRefusal 还会按"换了所求类型"把攒了几天的阶梯清零。
  //    （对抗审查用真 seeds 实证：default-verify 的 asuka:shinji 压力恰好 =40，全中）
  //    hostile 只认「压力 top-1 的那一对」，七个陌生人的世界里几乎永远不命中；
  //    而欠账是机械存在的、有方向的、可以被"要到/要不到"的——正是结算判得动的那种所求。
  const owedToMe = (params.partnerDebts ?? []).find(
    (d) => d.lenderId === selfId && tick - d.borrowedTick >= DEBT_DESIRE_OVERDUE_TICKS,
  );
  if (owedToMe) {
    const days = Math.floor((tick - owedToMe.borrowedTick) / 96);
    return {
      kind: "debt",
      id: `desire_debt_${partnerId}_${selfId}`,
      want: `想把${partnerName}欠的 ${owedToMe.amount} 金要回来`,
      line:
        `💭 ${partnerName}欠你的那 ${owedToMe.amount} 金，拖了${days}天了——` +
        `提不提、怎么提，由你，但这事你心里记着。` + tailFor("debt"),
    };
  }
  const iOwe = (params.myDebts ?? []).find(
    (d) => d.lenderId === partnerId && tick - d.borrowedTick >= DEBT_DESIRE_OVERDUE_TICKS,
  );
  if (iOwe) {
    const days = Math.floor((tick - iOwe.borrowedTick) / 96);
    return {
      kind: "debt",
      id: `desire_debt_${selfId}_${partnerId}`,
      want: `想跟${partnerName}把欠的 ${iOwe.amount} 金拖一拖，或者给个说法`,
      line:
        `💭 你还欠着${partnerName} ${iOwe.amount} 金，${days}天了没还——` +
        `见着他这事就硌得慌。` + tailFor("debt"),
    };
  }

  // 2) 敌对所求限额：只对自己压力 top-1 的对注入，且 pair 压力 ≥ 阈值
  const top = params.pressureGraph?.getTopPairFor(selfId);
  if (
    top &&
    top.pressure >= HOSTILE_DESIRE_THRESHOLD &&
    ((top.a === selfId && top.b === partnerId) || (top.a === partnerId && top.b === selfId))
  ) {
    return {
      kind: "hostile",
      id: `desire_hostile_${[selfId, partnerId].sort().join(":")}`,
      want: `想把和${partnerName}之间那笔压着的旧账挑明，要一个说法`,
      line:
        hostileDesireLine(
          top,
          partnerName,
          // 走到这里说明没有"逾期够格"的债（debt 分支已先返回），但压力图的
          // debtOverdueDays 口径更松，仍可能非零——所以还要判一次方向
          (params.partnerDebts ?? []).some((d) => d.lenderId === selfId),
        ) + tailFor("hostile"),
    };
  }

  // 3) 临近约定 → 期待
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
    return {
      kind: "appointment",
      id: `desire_appt_${appt.id}`,
      want: `想坐实和${partnerName}的这个约（${what}）`,
      line:
        `💭 你和${partnerName}约好了${what}，${when}——这个约你心里记着，有点期待，聊起来自然会想到它。` +
        tailFor("appointment"),
    };
  }

  // 4) 追求向：我的追求就绑在这个人身上（pursuit metric = relationship 且 target 是他）。
  //    这是**作者预埋**的方向，比"亲密度 ≥60"这种要靠时间长出来的门更早可用。
  // 读**运行期** pursuit（带 status），不是角色卡上的静态声明——
  // 卡片那份永远是 active，会让已达成/已永久失败的追求继续催人（对抗审查确认）。
  // 同时吃 ANIMA_PURSUIT 总闸：整层关了就不该有追求向所求。
  const pursuit = pursuitsEnabled() ? params.selfPursuit : undefined;
  if (pursuit?.status === "active" && pursuit.metric.kind === "relationship" && pursuit.metric.target === partnerId) {
    return {
      kind: "pursuit",
      id: `desire_pursuit_${pursuit.id}_${partnerId}`,
      want: `想跟${partnerName}再近一步（${pursuit.summary}）`,
      line:
        `💭 「${pursuit.summary}」——这事绕不开${partnerName}。` +
        `今天要不要往前推一步，看你自己。` + tailFor("pursuit"),
    };
  }

  // 5) 正向项按 (day, pair) 确定性轮换；约 1/3 的日子留白 = 无所求底噪
  const h = hashStr(`${params.day}:${selfId}:${partnerId}`) % 3;
  const level = params.relationship?.level ?? 0;
  if (h === 0 && level >= BOND_HIGH_LEVEL) {
    return {
      kind: "bond",
      id: `desire_bond_${params.day}_${selfId}_${partnerId}`,
      want: `想跟${partnerName}说说近况，或者约TA一起做点什么`,
      line:
        `💭 见到${partnerName}你心里是松快的——最近的事想跟TA分享两句，或者干脆约TA一起做点什么。` +
        tailFor("bond"),
    };
  }
  const aspiration = params.selfCard.life?.aspiration;
  if (h === 1 && aspiration && level >= ASPIRATION_MIN_LEVEL) {
    return {
      kind: "aspiration",
      id: `desire_asp_${params.day}_${selfId}_${partnerId}`,
      want: `想跟${partnerName}聊「${aspiration}」——请教，或者说说自己的进展`,
      line:
        `💭 你心里一直惦记着「${aspiration}」——跟${partnerName}也许聊得来这个：请教也好，说说自己的进展也好。` +
        tailFor("aspiration"),
    };
  }

  return undefined; // 无所求底噪：不是每场对话都得带着目的
}
