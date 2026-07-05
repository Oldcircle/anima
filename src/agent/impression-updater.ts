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
  /** 态度（valence）只评估最近 N 句——同一批台词不能在多轮印象更新中反复计分 */
  valenceOnLastN?: number;
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
export interface ImpressionWithValence {
  impression: CharacterImpression;
  /** 这次互动带来的好感增量（-3..+3），对话内容第一次对关系有真实分量 */
  valence: number;
}

export async function generateImpression(params: ImpressionUpdateParams): Promise<ImpressionWithValence | null> {
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

  const age = observerCard.life?.age ?? observerCard.age;
  const occupation = observerCard.life?.occupation ?? observerCard.occupation;
  const valenceScope = params.valenceOnLastN && params.valenceOnLastN < exchanges.length
    ? `只针对【最后 ${params.valenceOnLastN} 句】新交流评估`
    : "这次互动后";
  const system = `你是${observerCard.name}，${age}岁，${occupation}。
${observerCard.personality.coreTraits ?? observerCard.personality.traits.join("、")}

你刚才和${targetCard.name}进行了一段对话。请用你自己的视角回顾这次互动，更新你对对方的印象。

回复格式（严格遵守，每行一项）：
总结：（一句话概括对方给你的整体印象）
观察：（这次互动中你注意到的 1-2 个细节，用分号隔开）
标签：（你心中给对方的一个标签，2-4个字）
态度：（-3 到 +3 的整数。${valenceScope}你对TA的好感变化：被冒犯/被敷衍/失望给负数，真正被打动/被帮到才给正数，日常寒暄/客套/正常接话就是 0——不要出于礼貌给 +1）
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

    const parsed = parseImpressionResponse(response.content, targetCard.id, tick);
    if (parsed) {
      return { impression: parsed, valence: parseValence(response.content) };
    }
    return { impression: buildFallbackImpression(targetCard.id, targetCard.name, exchanges, existingImpression, tick), valence: 0 };
  } catch {
    return { impression: buildFallbackImpression(targetCard.id, targetCard.name, exchanges, existingImpression, tick), valence: 0 };
  }
}

/** 解析"态度: -3..+3"行；解析失败按 0（不动关系） */
function parseValence(text: string): number {
  const m = text.match(/态度[:：]\s*([+-]?\d+)/);
  if (!m) return 0;
  const v = parseInt(m[1]!, 10);
  if (Number.isNaN(v)) return 0;
  return Math.max(-3, Math.min(3, v));
}

/** 解析 LLM 返回的印象文本 */
function parseImpressionResponse(text: string, targetId: string, tick: number): CharacterImpression | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let summary = "";
  const observations: string[] = [];
  let mentalLabel = "";
  const unresolved: string[] = [];

  for (const line of lines) {
    if (matchesLabel(line, ["总结", "整体印象", "印象"])) {
      summary = stripLabel(line).trim();
    } else if (matchesLabel(line, ["观察", "细节"])) {
      const obs = stripLabel(line).trim();
      observations.push(...obs.split(/[；;]/).map((s) => s.trim()).filter(Boolean));
    } else if (matchesLabel(line, ["标签", "判断"])) {
      mentalLabel = stripLabel(line).trim();
    } else if (matchesLabel(line, ["疑惑", "好奇"])) {
      const q = stripLabel(line).trim();
      if (q !== "无" && q !== "暂无" && q.length > 0) {
        unresolved.push(...q.split(/[；;]/).map((s) => s.trim()).filter(Boolean));
      }
    }
  }

  // 如果模型没按格式回复，尝试把第一句当 summary
  if (!summary) {
    const candidate = lines.find((line) => line.length >= 8 && !line.includes("：") && !line.includes(":"));
    if (candidate) {
      summary = candidate.slice(0, 100);
    }
  }

  if (!summary) return null;

  return {
    characterId: targetId,
    summary,
    observations: observations.slice(0, 5),
    mentalLabel: mentalLabel || "待了解",
    unresolved: unresolved.slice(0, 3),
    lastUpdated: tick,
  };
}

function matchesLabel(line: string, labels: string[]): boolean {
  return labels.some((label) => line.startsWith(`${label}：`) || line.startsWith(`${label}:`));
}

function stripLabel(line: string): string {
  return line.replace(/^[^：:]+[：:]/, "");
}

function buildFallbackImpression(
  targetId: string,
  targetName: string,
  exchanges: ConversationExchange[],
  existingImpression: CharacterImpression | undefined,
  tick: number,
): CharacterImpression {
  const targetUtterances = exchanges
    .filter((e) => e.speakerId === targetId)
    .map((e) => e.message.trim())
    .filter(Boolean);

  const sample = targetUtterances[0] ?? exchanges[0]?.message ?? "";
  const observations = targetUtterances
    .slice(0, 2)
    .map((msg) => `你记得对方说过「${msg.slice(0, 24)}${msg.length > 24 ? "…" : ""}」`);

  const label = inferMentalLabel(targetUtterances, existingImpression?.mentalLabel);
  const summary = existingImpression?.summary
    ? `${existingImpression.summary} 这次接触让这个印象更具体了一些。`
    : `${targetName}给你的感觉是${label === "谨慎的人" ? "有些克制和谨慎" : label === "热情的人" ? "比你预想中更热情外放" : "还需要再接触才能看清"}。`;

  const unresolved = existingImpression?.unresolved?.slice(0, 2) ?? [];
  if (unresolved.length === 0 && targetUtterances.length <= 1) {
    unresolved.push("还不确定对方真正想和你保持什么距离");
  }

  return {
    characterId: targetId,
    summary,
    observations: observations.slice(0, 5),
    mentalLabel: label,
    unresolved: unresolved.slice(0, 3),
    lastUpdated: tick,
  };
}

function inferMentalLabel(messages: string[], previous?: string): string {
  const joined = messages.join(" ");
  if (/[!！]/.test(joined) || /hola|哈哈|当然|太好了/i.test(joined)) return "热情的人";
  if (/请|失礼|容我|抱歉|……|\.\.\./.test(joined)) return "谨慎的人";
  if (messages.every((m) => m.length <= 12) && messages.length > 0) return "话不多的人";
  return previous || "待了解";
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
  /** 传入时把双方"态度"增量落到关系上（对话内容不再对机制透明） */
  relationships?: import("../world/relationships.js").RelationshipManager;
  /** 态度只评最近 N 句（simulation 维护的水位线传入） */
  valenceOnLastN?: number;
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
      valenceOnLastN: params.valenceOnLastN,
    }),
    generateImpression({
      observerCard: cardB,
      targetCard: cardA,
      exchanges,
      existingImpression: impressions.get(cardB.id, cardA.id),
      provider, modelId, tick,
      valenceOnLastN: params.valenceOnLastN,
    }),
  ]);

  if (impAtoB) impressions.merge(cardA.id, impAtoB.impression);
  if (impBtoA) impressions.merge(cardB.id, impBtoA.impression);

  // 态度落地：双方 valence 求和作用于（对称的）关系值。
  // 辱骂性的"聊天"从此是净负资产：flat +1 压不过 -3 的态度。
  if (params.relationships && (impAtoB || impBtoA)) {
    const total = (impAtoB?.valence ?? 0) + (impBtoA?.valence ?? 0);
    if (total !== 0) {
      const summary = total <= -2
        ? `${cardA.name}和${cardB.name}这次谈话不欢而散`
        : total >= 2
          ? `${cardA.name}和${cardB.name}聊得很投缘`
          : undefined;
      params.relationships.modify(cardA.id, cardB.id, total, tick, summary);
      console.log(`💗 [态度] ${cardA.id}↔${cardB.id} 对话 valence ${total > 0 ? "+" : ""}${total}`);
    }
  }
}
