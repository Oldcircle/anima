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
      { system, messages: [{ role: "user", content: dialogue }], temperature: 0.3, maxTokens: 150 },
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
