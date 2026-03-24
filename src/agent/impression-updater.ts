/**
 * Impression Updater — 互动后印象生成/更新
 *
 * 当两个角色完成一段对话后，用轻量 LLM 调用为双方各生成一份印象。
 * 不阻塞主循环——在反应轮结束后异步执行。
 */

import type { CharacterCard } from "../character/types.js";
import type { LLMProvider, LLMRequest } from "../providers/types.js";
import type { CharacterImpression, ImpressionStore } from "../memory/impressions.js";
import type { ConversationExchange } from "./conversation-mode.js";

export interface ImpressionUpdateParams {
  /** 生成印象的角色（观察者） */
  observerCard: CharacterCard;
  /** 被观察的角色 */
  targetCard: CharacterCard;
  /** 这次互动的对话记录 */
  exchanges: ConversationExchange[];
  /** 已有的印象（如有） */
  existingImpression?: CharacterImpression;
  /** LLM */
  provider: LLMProvider;
  modelId: string;
  /** 当前 tick */
  tick: number;
}

/**
 * 为一个角色生成/更新对另一个角色的印象。
 * 返回新的 CharacterImpression，调用者负责存入 ImpressionStore。
 */
export async function generateImpression(params: ImpressionUpdateParams): Promise<CharacterImpression | null> {
  const { observerCard, targetCard, exchanges, existingImpression, provider, modelId, tick } = params;

  if (exchanges.length === 0) return null;

  // 格式化对话记录
  const dialogueLines = exchanges.map((e) => {
    const name = e.speakerId === observerCard.id ? "你" : e.speakerName;
    return `${name}：「${e.message}」`;
  }).join("\n");

  // 已有印象上下文
  const existingCtx = existingImpression
    ? `你之前对${targetCard.name}的印象：${existingImpression.summary}（标签：${existingImpression.mentalLabel}）`
    : `这是你第一次和${targetCard.name}深入交流。`;

  const system = `你是${observerCard.name}，${observerCard.age}岁，${observerCard.occupation}。
${observerCard.personality.coreTraits ?? observerCard.personality.traits.join("、")}

你刚才和${targetCard.name}进行了一段对话。请用你自己的视角回顾这次互动，更新你对对方的印象。

回复格式（严格遵守，每行一项）：
总结：（一句话概括对方给你的整体印象）
观察：（这次互动中你注意到的 1-2 个细节，用分号隔开）
标签：（你心中给对方的一个标签，2-4个字）
疑惑：（如果有的话，对方让你好奇或不解的地方，没有就写"无"）`;

  const user = `${existingCtx}

## 刚才的对话
${dialogueLines}

请更新你对${targetCard.name}的印象。`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: user }], temperature: 0.7, maxTokens: 256 },
      modelId,
    );

    return parseImpressionResponse(response.content, targetCard.id, tick);
  } catch {
    return null;
  }
}

/** 解析 LLM 返回的印象文本 */
function parseImpressionResponse(text: string, targetId: string, tick: number): CharacterImpression {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let summary = "";
  const observations: string[] = [];
  let mentalLabel = "";
  const unresolved: string[] = [];

  for (const line of lines) {
    if (line.startsWith("总结：") || line.startsWith("总结:")) {
      summary = line.replace(/^总结[：:]/, "").trim();
    } else if (line.startsWith("观察：") || line.startsWith("观察:")) {
      const obs = line.replace(/^观察[：:]/, "").trim();
      observations.push(...obs.split(/[；;]/).map((s) => s.trim()).filter(Boolean));
    } else if (line.startsWith("标签：") || line.startsWith("标签:")) {
      mentalLabel = line.replace(/^标签[：:]/, "").trim();
    } else if (line.startsWith("疑惑：") || line.startsWith("疑惑:")) {
      const q = line.replace(/^疑惑[：:]/, "").trim();
      if (q !== "无" && q !== "暂无" && q.length > 0) {
        unresolved.push(...q.split(/[；;]/).map((s) => s.trim()).filter(Boolean));
      }
    }
  }

  // 如果解析失败，用整段文本作为 summary
  if (!summary && lines.length > 0) {
    summary = lines[0]!.slice(0, 100);
  }

  return {
    characterId: targetId,
    summary,
    observations: observations.slice(0, 5),
    mentalLabel: mentalLabel || "待了解",
    unresolved: unresolved.slice(0, 3),
    lastUpdated: tick,
  };
}

/**
 * 批量更新双方印象。
 * 在一段对话结束后调用——为双方各生成一份。
 */
export async function updateImpressionsBidirectional(params: {
  cardA: CharacterCard;
  cardB: CharacterCard;
  exchanges: ConversationExchange[];
  impressions: ImpressionStore;
  provider: LLMProvider;
  modelId: string;
  tick: number;
}): Promise<void> {
  const { cardA, cardB, exchanges, impressions, provider, modelId, tick } = params;

  // 并行生成双方印象
  const [impAtoB, impBtoA] = await Promise.all([
    generateImpression({
      observerCard: cardA,
      targetCard: cardB,
      exchanges,
      existingImpression: impressions.get(cardA.id, cardB.id),
      provider, modelId, tick,
    }),
    generateImpression({
      observerCard: cardB,
      targetCard: cardA,
      exchanges,
      existingImpression: impressions.get(cardB.id, cardA.id),
      provider, modelId, tick,
    }),
  ]);

  if (impAtoB) impressions.merge(cardA.id, impAtoB);
  if (impBtoA) impressions.merge(cardB.id, impBtoA);
}
