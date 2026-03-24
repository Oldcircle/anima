/**
 * Conversation Mode — 对话模式
 *
 * 当两个角色在同一地点持续交谈时，切换到更丰富的叙事 prompt。
 * 不违反第一性原理：每轮仍是独立 LLM 调用，角色仍可选择不回应。
 * 不引入 Conversation 对象——只是在反应轮中使用更好的 prompt。
 *
 * 核心改进：
 * - 注入完整对话历史（非摘要）
 * - 注入环境感官描写
 * - 叙事风格指引（白描、微动作、内心戏）
 * - 更高的 token 预算 (1536)
 */

import type { CharacterCard } from "../character/types.js";
import type { CharacterState, Weather, LocationAtmosphere } from "../world/types.js";
import type { GameTime } from "../core/tick-engine.js";
import type { ActionDefinition } from "../actions/types.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { formatGameTime } from "../core/tick-engine.js";
import { weatherDescription } from "../world/weather.js";
import { getAtmosphereText } from "../world/location-loader.js";

// ── 对话追踪 ──

export interface ConversationExchange {
  speakerId: string;
  speakerName: string;
  message: string;
  tick: number;
}

/**
 * 追踪活跃对话。每个 key 是排序后的 "charA:charB" 对，
 * value 是该对最近的完整对话记录。
 */
export class ConversationTracker {
  private _exchanges: Map<string, ConversationExchange[]> = new Map();
  private _lastTick: Map<string, number> = new Map();

  private _pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  /** 记录一次 talk */
  recordTalk(speakerId: string, speakerName: string, targetId: string, message: string, tick: number): void {
    const name = speakerName?.trim() || speakerId; // 防御空名字
    const key = this._pairKey(speakerId, targetId);
    if (!this._exchanges.has(key)) {
      this._exchanges.set(key, []);
    }
    this._exchanges.get(key)!.push({ speakerId, speakerName: name, message, tick });
    this._lastTick.set(key, tick);
  }

  /** 获取两个角色之间的完整对话历史 */
  getHistory(charA: string, charB: string): ConversationExchange[] {
    const key = this._pairKey(charA, charB);
    return this._exchanges.get(key) ?? [];
  }

  /**
   * 判断是否应该进入对话模式。
   * 条件：在最近 2 tick 内，双方各至少说了 1 句（有来有回）
   */
  isActiveConversation(charA: string, charB: string, currentTick: number): boolean {
    const history = this.getHistory(charA, charB);
    if (history.length < 2) return false;

    // 只看最近 2 tick 内的交换
    const recentExchanges = history.filter((e) => currentTick - e.tick <= 2);
    if (recentExchanges.length < 2) return false;

    // 必须双方都说过话（有来有回）
    const speakers = new Set(recentExchanges.map((e) => e.speakerId));
    return speakers.size >= 2;
  }

  /** 清理过期对话（超过 8 tick 没有新消息的） */
  cleanup(currentTick: number): void {
    for (const [key, lastTick] of this._lastTick) {
      if (currentTick - lastTick > 8) {
        this._exchanges.delete(key);
        this._lastTick.delete(key);
      }
    }
  }

  /** 对话结束时清除记录 */
  clear(charA: string, charB: string): void {
    const key = this._pairKey(charA, charB);
    this._exchanges.delete(key);
    this._lastTick.delete(key);
  }
}

// ── 对话模式 Prompt ──

export interface ConversationPromptParams {
  /** 当前说话的角色 */
  card: CharacterCard;
  state: CharacterState;
  /** 对话对象 */
  partnerCard: CharacterCard;
  partnerState: CharacterState;
  /** 完整对话历史 */
  history: ConversationExchange[];
  /** 游戏时间 */
  gameTime: GameTime;
  /** 地点名 */
  locationName: string;
  /** 地点感官描写 */
  atmosphere?: LocationAtmosphere;
  /** 天气 */
  weather?: Weather;
  /** 关系信息 */
  relationship?: { level: number; type: string };
  /** 已有的印象 */
  impressionText?: string;
  /** 角色最近记忆 */
  recentMemories?: string;
}

/**
 * 构建对话模式的 user prompt。
 * System prompt 复用 buildSystemPrompt（角色身份不变），
 * 但 user prompt 完全不同：注入完整对话流 + 叙事指引。
 */
export function buildConversationPrompt(params: ConversationPromptParams): string {
  const { card, state, partnerCard, partnerState, history, gameTime, locationName } = params;

  const parts: string[] = [];

  // 1. 场景描写
  const atmosphereText = getAtmosphereText(params.atmosphere, gameTime.hour, params.weather ?? "sunny");
  if (atmosphereText) {
    parts.push(`## 场景\n${locationName}，${formatGameTime(gameTime)}。\n${atmosphereText}`);
  } else {
    parts.push(`## 场景\n${locationName}，${formatGameTime(gameTime)}。`);
  }

  const weatherStr = params.weather ? weatherDescription(params.weather) : "";
  if (weatherStr) parts.push(`天气：${weatherStr}`);

  // 2. 对话对象描述（有印象时用印象，否则用基本信息）
  parts.push(`\n## 你的对话对象`);
  if (params.impressionText) {
    parts.push(`**${partnerCard.name}**(ID:${partnerCard.id})`);
    parts.push(params.impressionText);
  } else {
    parts.push(`${partnerCard.name}，${partnerCard.age} 岁，${partnerCard.occupation}。`);
    if (partnerCard.appearance) {
      const shortAppearance = partnerCard.appearance.trim().split("\n")[0];
      parts.push(shortAppearance!);
    }
    const relDesc = params.relationship
      ? `你们的关系：${params.relationship.type}（亲密度 ${params.relationship.level}）`
      : "你们还不太熟";
    parts.push(relDesc);
  }

  // 3. 你当前的状态
  const moodHints: string[] = [];
  if (state.needs.social < 30) moodHints.push("有点渴望交流");
  if (state.needs.happiness < 30) moodHints.push("心情不太好");
  if (state.needs.hunger < 30) moodHints.push("肚子有点饿");
  if (state.needs.energy < 30) moodHints.push("有些疲惫");
  const moodStr = moodHints.length > 0 ? `你现在${moodHints.join("，")}。` : "";

  if (moodStr || params.recentMemories) {
    parts.push(`\n## 你现在的状态`);
    if (moodStr) parts.push(moodStr);
    if (params.recentMemories) parts.push(`最近的经历：\n${params.recentMemories}`);
  }

  // 4. 完整对话历史
  if (history.length > 0) {
    parts.push(`\n## 对话记录`);
    for (const exchange of history) {
      const isMe = exchange.speakerId === card.id;
      const label = isMe ? "你" : exchange.speakerName;
      parts.push(`${label}：「${exchange.message}」`);
    }
  }

  // 5. 叙事指引 + 行动指令
  parts.push(`\n## 你要做什么
继续这段对话。先写出你的内心活动和观察：
- 你注意到了什么（对方的表情、动作、语气）
- 你在想什么（真实的想法，可能和你说出口的不一样）
- 你打算怎么回应，为什么

然后调用 talk 工具说出你的话。你的 message 应该只包含你说出口的话。

创作风格：
- 通过动作和语言本身传递情绪，不要解释（"她的手指搓着围裙"而非"她紧张地搓着围裙，显示出内心的不安"）
- 你可以犹豫、改口、词不达意、欲言又止
- 如果你不想继续聊了，可以找借口离开（调用 go_to）或做别的事

注意：target 参数填 "${partnerCard.id}"。`);

  return parts.join("\n");
}

// ── 对话模式 LLM Request 构建 ──

import type { LLMRequest } from "../providers/types.js";

/**
 * 构建对话模式的 LLMRequest。
 * 传给 runAgentTick 的 conversationRequest 参数，
 * 替代标准 prompt 构建，但复用所有 action 执行逻辑。
 */
export function buildConversationRequest(params: {
  card: CharacterCard;
  state: CharacterState;
  partnerCard: CharacterCard;
  partnerState: CharacterState;
  history: ConversationExchange[];
  gameTime: GameTime;
  locationName: string;
  atmosphere?: LocationAtmosphere;
  weather?: Weather;
  relationship?: { level: number; type: string };
  impressionText?: string;
  recentMemories?: string;
  actions: ActionDefinition[];
}): LLMRequest {
  const systemPrompt = buildSystemPrompt(params.card);
  const userPrompt = buildConversationPrompt({
    card: params.card,
    state: params.state,
    partnerCard: params.partnerCard,
    partnerState: params.partnerState,
    history: params.history,
    gameTime: params.gameTime,
    locationName: params.locationName,
    atmosphere: params.atmosphere,
    weather: params.weather,
    relationship: params.relationship,
    impressionText: params.impressionText,
    recentMemories: params.recentMemories,
  });

  return {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: params.actions.map((a) => a.tool),
    temperature: 1.0, // 对话模式温度更高，增加自然感
    maxTokens: 1536,  // 更大的思考和表达空间
  };
}
