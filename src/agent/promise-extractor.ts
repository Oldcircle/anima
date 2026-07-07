/**
 * Promise Extractor — 对话承诺抽取
 *
 * 「下次教你做咖啡」「明天中午在咖啡馆见」——此前这些话说完就蒸发
 * （147 次对话 0 个约定；arrange_meet 上线后真实运行产物仍 0 次使用）。
 * 现在对话结束时用一次小 LLM 调用抽取具体承诺，自动落成 appointment，
 * 复用现有的分级提醒 + 赴约/爽约结算管线——语言第一次编译成世界状态。
 *
 * 成本控制：只在对话 ≥4 句且文本含时间性关键词时才调用（预过滤），150 maxTokens。
 */

import type { LLMProvider } from "../providers/types.js";
import type { ConversationExchange } from "./conversation-mode.js";
import { parseAppointmentTime } from "../world/appointments.js";

export interface ExtractedPromise {
  proposerId: string;
  targetId: string;
  atTick: number;
  locationId: string;
  activity?: string;
  /** 用于记忆/日志的自然语言描述 */
  timeText: string;
  locationName: string;
}

/** 时间性关键词预过滤：没有这些词的对话不可能有具体约定，不烧 LLM */
const TIME_HINT = /明天|后天|今晚|晚上|中午|早上|下午|傍晚|下次|待会|回头|一起去|约|点半|[0-9一二三四五六七八九十]+点/;

export function mightContainPromise(history: ConversationExchange[]): boolean {
  if (history.length < 4) return false;
  return history.some((e) => TIME_HINT.test(e.message));
}

// ─────────────────────────────────────────────────────────────
// 口头交易落账（防幻觉·收编而不是禁止）
//
// 牛奶债案：对话里口头"给"了东西/"付"了钱，机制层什么都没发生，但双方记忆、
// 观察、印象各层把它固化成"事实"——机制账本和叙事账本从此对不上。
// 对话结束时抽取"当场完成交割"的金钱/物品转移并机械结算：嘴上成的交易，账本跟上。
// ─────────────────────────────────────────────────────────────

export interface ExtractedTransaction {
  fromId: string;
  toId: string;
  /** 金额（纯物品交割为 0） */
  gold: number;
  /** 物品名（纯金钱交割为 undefined），已去掉数量注释 */
  itemName?: string;
  /** 物品数量（从"（三个）"这类注释解析，1-5） */
  qty: number;
}

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };

/** 清洗抽取的物品名："可颂（三个）"→ name=可颂 qty=3；"三个可颂"同理 */
export function sanitizeItemName(raw: string): { name: string; qty: number } {
  let qty = 1;
  const qtyMatch = raw.match(/(\d+|[一两二三四五])\s*[个份块杯条盒串枚]/);
  if (qtyMatch?.[1]) {
    const n = /^\d+$/.test(qtyMatch[1]) ? parseInt(qtyMatch[1], 10) : CN_NUM[qtyMatch[1]] ?? 1;
    qty = Math.max(1, Math.min(5, n));
  }
  const name = raw
    .replace(/[（(][^）)]*[）)]/g, "")                       // 去括号注释
    .replace(/(\d+|[一两二三四五])\s*[个份块杯条盒串枚]的?/g, "") // 去前置数量
    .trim();
  return { name: name || raw.trim(), qty };
}

/** 交割关键词预过滤：没有这些词的对话不可能有当场交割，不烧 LLM */
const TRANSACTION_HINT = /金币|给你|还你|拿着|收下|付了|请你的|我请|赔你|找你|递给/;

export function mightContainTransaction(history: ConversationExchange[]): boolean {
  if (history.length < 2) return false;
  return history.some((e) => TRANSACTION_HINT.test(e.message));
}

export async function extractTransaction(params: {
  history: ConversationExchange[];
  charAId: string;
  charAName: string;
  charBId: string;
  charBName: string;
  provider: LLMProvider;
  modelId: string;
}): Promise<ExtractedTransaction | null> {
  const { history, charAId, charAName, charBId, charBName, provider, modelId } = params;

  const dialogue = history
    .map((e) => `${e.speakerName}：「${e.message}」`)
    .join("\n");

  const system = `你是对话审计员。判断下面的对话里，双方有没有**当场完成交割**的金钱或物品转移——
一方明确把钱或东西给出去（"给你，拿着"、"这是4金币"），另一方明确收下了（"收下了"、"谢谢"、接过）。
只认当场完成的：说"以后给"、"下次请你"、"先欠着"的不算；只是嘴上提到钱、讨价还价没成交的不算。
如果有多笔，只报最主要的一笔。

回复格式（严格遵守）：
交割: 有 / 没有
给的人: ${charAName} / ${charBName}
金额: （数字，纯物品交割填 0）
物品: （物品名，纯金钱交割填 无）`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: dialogue }], temperature: 0.2, maxTokens: 120, kind: "transaction-extract" },
      modelId,
    );
    const text = response.content;
    if (!/交割[:：]\s*有/.test(text)) return null;

    const giverName = text.match(/给的人[:：]\s*(.+)/)?.[1]?.trim();
    const goldText = text.match(/金额[:：]\s*(\d+)/)?.[1];
    const itemText = text.match(/物品[:：]\s*(.+)/)?.[1]?.trim();
    if (!giverName) return null;

    const gold = goldText ? parseInt(goldText, 10) : 0;
    const rawItem = itemText && itemText !== "无" && itemText !== "（无）" ? itemText : undefined;
    if (gold <= 0 && !rawItem) return null;
    if (gold > 100) return null; // 离谱金额当抽取失误丢弃（全镇最贵物品 80）

    const cleaned = rawItem ? sanitizeItemName(rawItem) : undefined;
    const fromId = giverName === charBName ? charBId : charAId;
    const toId = fromId === charAId ? charBId : charAId;
    return { fromId, toId, gold, itemName: cleaned?.name, qty: cleaned?.qty ?? 1 };
  } catch {
    return null;
  }
}

export async function extractPromise(params: {
  history: ConversationExchange[];
  charAId: string;
  charAName: string;
  charBId: string;
  charBName: string;
  locations: Array<{ id: string; name: string }>;
  currentTick: number;
  provider: LLMProvider;
  modelId: string;
}): Promise<ExtractedPromise | null> {
  const { history, charAId, charAName, charBId, charBName, provider, modelId } = params;

  const dialogue = history
    .map((e) => `${e.speakerName}：「${e.message}」`)
    .join("\n");
  const locationList = params.locations.map((l) => l.name).join("、");

  const system = `你是对话分析器。判断下面的对话里，双方有没有**说定**一个具体的见面/共同活动承诺。
只认"说定了"的：有大致时间（如"明天中午"、"今晚"、"下次周末"不算——必须能定位到某一天的某个时段）、
对方也应了（嗯/好/说定了/到时见）。单方面客套（"改天请你吃饭"）、没下文的提议都不算。

回复格式（严格遵守）：
承诺: 有 / 没有
提议人: ${charAName} / ${charBName}
时间: （用"今天18:00"、"明天12:00"、"明天中午"这样的说法）
地点: （从这些地点里选最接近的：${locationList}）
做什么: （一句话，可空）`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: dialogue }], temperature: 0.3, maxTokens: 150, kind: "promise-extract" },
      modelId,
    );
    const text = response.content;
    if (!/承诺[:：]\s*有/.test(text)) return null;

    const timeText = text.match(/时间[:：]\s*(.+)/)?.[1]?.trim();
    const locationName = text.match(/地点[:：]\s*(.+)/)?.[1]?.trim();
    const activity = text.match(/做什么[:：]\s*(.+)/)?.[1]?.trim() || undefined;
    const proposerName = text.match(/提议人[:：]\s*(.+)/)?.[1]?.trim();
    if (!timeText || !locationName) return null;

    const atTick = parseAppointmentTime(timeText, params.currentTick);
    if (atTick === undefined) return null;

    const loc = params.locations.find((l) => l.name === locationName)
      ?? params.locations.find((l) => locationName.includes(l.name) || l.name.includes(locationName));
    if (!loc) return null;

    const proposerId = proposerName === charBName ? charBId : charAId;
    const targetId = proposerId === charAId ? charBId : charAId;

    return {
      proposerId,
      targetId,
      atTick,
      locationId: loc.id,
      activity: activity && activity !== "空" ? activity : undefined,
      timeText,
      locationName: loc.name,
    };
  } catch {
    return null;
  }
}
