/**
 * Observation Reasoning — 角色观察与社会推理（P2）
 *
 * 角色在场时不只"看到"别人，还会解读行为。
 * 例如：角色在咖啡馆工作时注意到另一个人看了两小时书、咖啡凉了，
 * 推理"她可能心情不好"→ 下次见面时默默换杯热咖啡。
 *
 * 触发条件：角色空闲（无多 tick 行为）+ 同地点有其他角色有可观察行为 + 冷却期
 * 成本控制：maxTokens 128，每角色每 4 tick 最多 1 次
 */

import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";
import type { LLMProvider } from "../providers/types.js";
import type { ShortTermMemory } from "../memory/short-term.js";
import type { ImpressionStore } from "../memory/impressions.js";
import { observationJudgmentPermission } from "./break-config.js";
import { personaDeepeningLines } from "./prompt-builder.js";

export interface ObservationContext {
  /** 观察者的角色卡 */
  observerCard: CharacterCard;
  /** 观察者的当前状态 */
  observerState: CharacterState;
  /** 同地点的其他角色及其可观察行为 */
  visibleCharacters: Array<{
    id: string;
    name: string;
    /** 当前正在做的事（可观察状态描述） */
    action: string;
    /** 已在此地点停留的 tick 数 */
    stayDuration?: number;
  }>;
  /** 地点名 */
  locationName: string;
  /** 当前 tick */
  tick: number;
}

export interface ObservationResult {
  /** 观察者 ID */
  observerId: string;
  /** 被观察的角色 ID */
  targetId: string;
  /** 观察推理结果（一句话） */
  reasoning: string;
  /** 当前 tick */
  tick: number;
}

/**
 * 判断某角色是否应该触发观察推理。
 * 条件：空闲 + 同地点有人 + 冷却期（每 4 tick 一次）
 */
export function shouldObserve(
  state: CharacterState,
  lastObservationTick: number | undefined,
  currentTick: number,
  visibleCount: number,
): boolean {
  // 正在执行多 tick 行为（工作/睡觉等）→ 不观察
  if (state.currentAction && state.currentAction.remainingTicks > 1) return false;
  // 没有可观察的人
  if (visibleCount === 0) return false;
  // 冷却期：每 4 tick（1 小时）最多观察 1 次
  if (lastObservationTick !== undefined && (currentTick - lastObservationTick) < 4) return false;
  return true;
}

/**
 * 为一个角色生成对在场他人的观察推理。
 * 轻量级 LLM 调用，maxTokens 128。
 */
export async function generateObservation(
  ctx: ObservationContext,
  provider: LLMProvider,
  modelId: string,
  impressions?: ImpressionStore,
): Promise<ObservationResult | null> {
  if (ctx.visibleCharacters.length === 0) return null;

  // 选择最值得观察的人：优先有具体动作的、有已有印象（已建立关系的更值得深入观察）
  const target = pickObservationTarget(ctx, impressions);
  if (!target) return null;

  const existingImp = impressions?.get(ctx.observerCard.id, target.id);
  const impHint = existingImp
    ? `你之前的印象：${existingImp.summary}（标签：「${existingImp.mentalLabel}」）`
    : `你和${target.name}不太熟。`;

  const stayHint = target.stayDuration && target.stayDuration > 2
    ? `已经在这里待了${target.stayDuration * 15}分钟了。`
    : "";

  const occupation = ctx.observerCard.life?.occupation ?? ctx.observerCard.occupation;
  const judgePermission = observationJudgmentPermission();
  // C3 人设加深：speech.style + psychology 前两行——观察是最高频推理面，
  // 不锚人设就千人一腔（off 档返回 ""，逐字节回归）
  const persona = personaDeepeningLines(ctx.observerCard);
  const system = `你是${ctx.observerCard.name}，${occupation}。你正在${ctx.locationName}。${persona}${persona ? "\n用你自己的口吻和眼光去看，不是中立旁白。" : ""}
请用一句话描述你对${target.name}此刻状态的观察和推测。
不要展开，不要对话，只用一句自然的内心想法。
只解读你真看到的动作神态，不要虚构没看到的具体事件或物品交割。${judgePermission ? "\n" + judgePermission : ""}`;

  const user = `${impHint}
你注意到${target.name}${target.action}。${stayHint}
你觉得怎么回事？（一句话内心想法）`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: user }], temperature: 0.7, maxTokens: 128, kind: "observation", tag: ctx.observerCard.id },
      modelId,
    );

    const reasoning = response.content.trim().replace(/^["「]|["」]$/g, "").slice(0, 150);
    if (reasoning.length < 4) return null;

    return {
      observerId: ctx.observerCard.id,
      targetId: target.id,
      reasoning,
      tick: ctx.tick,
    };
  } catch {
    return null;
  }
}

/**
 * 选择最值得观察的目标。
 * 优先级：有具体动作 > 有已有印象（能深化） > 随机
 */
function pickObservationTarget(
  ctx: ObservationContext,
  impressions?: ImpressionStore,
): ObservationContext["visibleCharacters"][number] | null {
  const candidates = ctx.visibleCharacters.filter((c) => c.action && c.action.length > 2);
  if (candidates.length === 0) return null;

  // 有已有印象的优先（能深化印象）
  if (impressions) {
    const withImpression = candidates.filter((c) =>
      impressions.get(ctx.observerCard.id, c.id),
    );
    if (withImpression.length > 0) {
      return withImpression[Math.floor(Math.random() * withImpression.length)]!;
    }
  }

  return candidates[Math.floor(Math.random() * candidates.length)]!;
}
