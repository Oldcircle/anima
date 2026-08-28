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
import { buildTavernRequest } from "../preset/anima-bridge.js";
import { formatGameTime } from "../core/tick-engine.js";
import { weatherDescription } from "../world/weather.js";
import { getAtmosphereText } from "../world/location-loader.js";
import { formatBodyFeelings } from "../world/need-definitions.js";
import { formatMoodlets } from "../world/moodlets.js";
import { formatInventory } from "../world/item-registry.js";
import { conversationSelfCheck, foodTopicHedge } from "./break-config.js";

// ── 对话追踪 ──

export interface ConversationExchange {
  speakerId: string;
  speakerName: string;
  message: string;
  tick: number;
  /** 说话时的动作/表情/语气（白描） */
  manner?: string;
  /**
   * B1 witnesses 机械化（§2/§4.5）：说这句话的当刻，同地点在场者（不含双方）。
   * talk 结算处由引擎写入；公开性由引擎按 witnesses 机械判定，抽取 LLM 不判公开性
   * （对话结束后 9+ tick 无法回溯在场者）。
   */
  witnesses?: string[];
  /** 说话时所在地点（§4.5 二轮评审顺手补上） */
  locationId?: string;
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

  /** 记录一次 talk（extras：B1 witnesses 机械化——在场者 + 地点由 talk 结算处传入） */
  recordTalk(speakerId: string, speakerName: string, targetId: string, message: string, tick: number, manner?: string, extras?: { witnesses?: string[]; locationId?: string }): void {
    const name = speakerName?.trim() || speakerId; // 防御空名字
    const key = this._pairKey(speakerId, targetId);
    if (!this._exchanges.has(key)) {
      this._exchanges.set(key, []);
    }
    this._exchanges.get(key)!.push({
      speakerId, speakerName: name, message, tick, manner,
      witnesses: extras?.witnesses, locationId: extras?.locationId,
    });
    this._lastTick.set(key, tick);
  }

  /** 获取两个角色之间的完整对话历史 */
  getHistory(charA: string, charB: string): ConversationExchange[] {
    const key = this._pairKey(charA, charB);
    return this._exchanges.get(key) ?? [];
  }

  /**
   * 判断是否应该进入对话模式。
   * 条件：在最近 3 tick 内，双方之间有 2+ 条交换记录。
   * 不再要求双方都说过话（单向追问也应进入对话模式以获得完整历史）。
   */
  isActiveConversation(charA: string, charB: string, currentTick: number): boolean {
    const history = this.getHistory(charA, charB);
    if (history.length < 2) return false;

    // 看最近 3 tick 内的交换（放宽窗口，允许因 work 中断的对话恢复）
    const recentExchanges = history.filter((e) => currentTick - e.tick <= 3);
    return recentExchanges.length >= 2;
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

  /**
   * 找出即将过期（本 tick 会被 cleanup 清掉）的对话——这是"对话结束"的时刻，
   * 承诺抽取在这里触发（对话完整、且只触发一次）。
   */
  getEndingConversations(currentTick: number): Array<{ charA: string; charB: string; history: ConversationExchange[] }> {
    const out: Array<{ charA: string; charB: string; history: ConversationExchange[] }> = [];
    for (const [key, lastTick] of this._lastTick) {
      if (currentTick - lastTick > 8) {
        const [a, b] = key.split(":") as [string, string];
        const history = this._exchanges.get(key) ?? [];
        if (history.length > 0) out.push({ charA: a, charB: b, history: [...history] });
      }
    }
    return out;
  }

  /** 对话结束时清除记录 */
  clear(charA: string, charB: string): void {
    const key = this._pairKey(charA, charB);
    this._exchanges.delete(key);
    this._lastTick.delete(key);
  }
}

// ── C5 群聊 v1（实验开关 ANIMA_GROUP_SCENE=1，DESIGN-revival §3 修订版）──

/** 第三方插话（"pendingInbox"实现：conversationRequest 构建时读 char.inbox 过滤而来） */
export interface GroupSceneLine {
  fromId: string;
  fromName: string;
  content: string;
  tick: number;
}

/** C5 同地点近似窗：插话须发生在近 3 tick 内（Tracker 无地点字段，用"当前同地点"近似） */
export const GROUP_SCENE_WINDOW_TICKS = 3;

/**
 * 从 inbox 过滤出"群聊时间线"该收的第三方插话：
 * 发信者 ≠ 当前对话对象、发信者**当前**与本人同地点、近 GROUP_SCENE_WINDOW_TICKS tick 内。
 * 纯函数（地点判定注入），simulation 在实验开关开启时调用。
 */
export function filterGroupInbox(params: {
  inbox: ReadonlyArray<GroupSceneLine>;
  partnerId: string;
  currentTick: number;
  sameLocation: (charId: string) => boolean;
  windowTicks?: number;
}): GroupSceneLine[] {
  const window = params.windowTicks ?? GROUP_SCENE_WINDOW_TICKS;
  return params.inbox.filter(
    (m) =>
      m.fromId !== params.partnerId &&
      params.currentTick - m.tick <= window &&
      params.sameLocation(m.fromId),
  );
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
  relationship?: { level: number; type: string; grudge?: { reason: string; instigatorId: string; sinceTick: number } };
  /** 已有的印象 */
  impressionText?: string;
  /** 角色最近记忆 */
  recentMemories?: string;
  /** 你和对方之间实际发生过的事（长期记忆 + 关系史），防编造共同历史 */
  sharedHistory?: string;
  /** D3: director 注入的"想聊的话题" */
  wantToDiscuss?: Array<{ topic: string; urgency: "low" | "med" | "high"; targetChar?: string }>;
  /**
   * C2 对话所求（conversation-desire.computeConversationDesire 算出的 1 行）。
   * off 档与来源判定收敛在 conversation-desire.ts；此处只负责渲染在尾部此刻区
   * （对话记录之后 = 缓存分歧点之后，不砸对话桶前缀）。
   */
  conversationDesire?: string;
  /**
   * C5 群聊 v1（实验开关默认关）：同地点第三方的插话时间线。
   * **只允许渲染在『## 你现在的状态』之后的尾部此刻区**——插对话记录前会砸对话桶
   * 68.5% 的前缀命中（评审 blocker）。
   */
  groupTimeline?: GroupSceneLine[];
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
  // 缓存纪律：时间/天气/身体状态每 tick 都变，挪到 append-only 的对话记录之后，
  // 让"场景+对象+共同经历+已有对话"这段前缀在对话内逐轮累积命中。
  const atmosphereText = getAtmosphereText(params.atmosphere, gameTime.hour, params.weather ?? "sunny");
  if (atmosphereText) {
    parts.push(`## 场景\n${locationName}。\n${atmosphereText}`);
  } else {
    parts.push(`## 场景\n${locationName}。`);
  }

  // 2. 对话对象描述（有印象时用印象，否则用基本信息）
  parts.push(`\n## 你的对话对象`);
  if (params.impressionText) {
    parts.push(`**${partnerCard.name}**(ID:${partnerCard.id})`);
    parts.push(params.impressionText);
  } else {
    const partnerAge = partnerCard.life?.age ?? partnerCard.age;
    const partnerOccupation = partnerCard.life?.occupation ?? partnerCard.occupation;
    parts.push(`${partnerCard.name}，${partnerAge} 岁，${partnerOccupation}。`);
    if (partnerCard.appearance) {
      const shortAppearance = partnerCard.appearance.trim().split("\n")[0];
      parts.push(shortAppearance!);
    }
    // 用主观感觉描述关系，不暴露数值
    const relType = params.relationship?.type;
    let relDesc: string;
    if (relType === "best_friend") relDesc = "你和这个人已经非常亲近了";
    else if (relType === "close_friend") relDesc = "你对这个人有明显的亲近感";
    else if (relType === "friend") relDesc = "你和这个人已经算熟悉了";
    else if (relType === "acquaintance") relDesc = "你对这个人有些印象";
    else if (relType === "rival") relDesc = "你看这个人不顺眼。说话可以带刺、可以敷衍、可以不给面子——你没有对他友善的义务";
    else relDesc = "你们还不太熟";
    parts.push(relDesc);
  }

  // 你们之间实际发生过的事（长期记忆 + 关系史）——真历史进对话，假"上周"出局
  if (params.sharedHistory) {
    parts.push(`\n## 你和${partnerCard.name}之间实际发生过的\n${params.sharedHistory}\n（可以自然地提起这些真实发生过的事。）`);
  } else {
    parts.push(`\n（你和${partnerCard.name}之间还没有什么值得一提的共同经历。）`);
  }
  parts.push(`⚠️ 不要编造上面没有列出的具体共同经历——不存在的"上周我们…"、"你每次都…"、"平时你总是…"。刚认识就是刚认识。`);

  // 未解开的疙瘩：对话的底色是僵的
  if (params.relationship?.grudge) {
    const g = params.relationship.grudge;
    const mine = g.instigatorId === card.id;
    parts.push(`\n⚡ 你和${partnerCard.name}之间有没解开的疙瘩（${g.reason}）。${mine ? "是你先发的火。想和好就得先低头（道歉/递个台阶），装没事人只会更僵。" : "对方冲你发过火还没道歉。你可以冷淡、敷衍、阴阳怪气，或者等一句道歉——不必假装热络。"}`);
  }

  // 随身物品（对话中可能会给对方东西）
  if (state.inventory && state.inventory.length > 0) {
    const invText = formatInventory(state.inventory);
    if (invText) parts.push(`\n${invText}`);
  }

  // 动态 backstory 注入（对话中可能触发相关回忆）
  if (card.backstory && card.backstory.length > 0) {
    const backstoryHint = selectConversationBackstory(card, partnerCard.name, locationName, state.needs);
    if (backstoryHint) {
      parts.push(`\n*你突然想起：${backstoryHint}*`);
    }
  }

  // 3b. 行动指令模板（Tier1 缓存手术：模板逐字不变且 partner 在对话内固定，
  // 从尾部前移到 append-only 的对话记录之前，随前缀一起逐轮命中；
  // 动态的 continuityHint / 轮次提示留在尾部"现在轮到你"）
  parts.push(`\n## 你要做什么
${conversationSelfCheck(partnerCard.name)}先用2-3句话写出你的内心活动（简短即可，不会被对方听到）：你注意到了什么、你真实的想法、你要不要继续聊。

然后调用 talk 工具。参数说明：
- target: "${partnerCard.id}"
- message: 只写你说出口的台词。像正常人说话一样，一两句到三四句就够了。可以很短（"嗯。"、"...是吗"），可以改口、犹豫、词不达意。不要写心理描写，不要长篇大论。回应对方最后说的话，不要跳回之前的话题。
- manner: 你说话时的身体语言，用白描写法，一句话。比如"低头搅着杯子里的咖啡"、"视线移向窗外，过了一会儿才回过头"、"嘴角动了动，像是想笑又忍住了"。

如果你不想说话：
- 可以调用 go_to 离开（"抱歉我得去..."）
- 可以调用 eat/drink/work 等做别的事
- 也可以 talk 一句简短的告别然后下个 tick 离开
- 如果聊得投缘但差不多该各忙各的了，可以用 arrange_meet 约个具体时间地点下次见
  （"明天中午在咖啡馆见？"）——说定了就是承诺，到时候不去对方会记住的

重要的创作原则：
- **白描**：写动作本身，不写"她紧张地"这种解释。"手指搓着围裙"比"紧张地搓着围裙"好。
- **台词要像说话**：可以有"嗯"、"啊"、说到一半停住、重复自己说过的话、答非所问。不要每句话都是完整的诗意比喻。
- **节奏感**：真实对话有快有慢。有时候一句话能聊很久，有时候话题会突然断掉。允许尴尬的沉默。
- **做自己**：不要为了有趣而说话。如果你的角色此刻没什么想说的，那就不说。
- **不要重复**：看看下面的 ## 对话记录，**严禁**说你已经说过的话或问你已经问过的问题。如果对方一直在重复同样的追问，你也不能用同样的话回应——要么换个角度（认错/反问/讲细节），要么沉默/离开。如果你发现自己又想说之前那句话，请改用 sit / journal / go_to 等行为代替。`);

  // C7 食物话题对冲：餐饮类地点的对话别被菜单占满（地点在对话内不变，不抖前缀缓存；off = ""）
  const hedge = foodTopicHedge(locationName);
  if (hedge) parts.push(`\n${hedge}`);

  // 4. 完整对话历史（含身体语言）
  if (history.length > 0) {
    parts.push(`\n## 对话记录`);
    for (const exchange of history) {
      const isMe = exchange.speakerId === card.id;
      const label = isMe ? "你" : exchange.speakerName;
      if (exchange.manner) {
        parts.push(`${label}：（${exchange.manner}）「${exchange.message}」`);
      } else {
        parts.push(`${label}：「${exchange.message}」`);
      }
    }
  }

  // 4a. 你现在的状态（每 tick 更新，放在 append-only 的对话记录之后保前缀）
  const weatherStr = params.weather ? weatherDescription(params.weather) : "";
  const bodyFeelings = formatBodyFeelings(state.needs, state.gold, gameTime.hour);
  const moodletText = formatMoodlets(state);

  parts.push(`\n## 你现在的状态`);
  parts.push(`时间：${formatGameTime(gameTime)}${weatherStr ? `。天气：${weatherStr}` : ""}`);
  parts.push(bodyFeelings);
  if (moodletText) parts.push(moodletText);

  // 身体状态压进对话方式（复制 financeFeeling 的成功路子）：
  // 精力 6 还在妙语连珠 = 数值和行为脱节的"过家家感"重灾区
  const energy = state.needs.energy ?? 100;
  const hunger = state.needs.hunger ?? 100;
  if (energy <= 15) {
    parts.push(`⚠️ 你现在困得快睁不开眼了。回话必须短（几个字也行），可以心不在焉、可以失礼、可以直接说"我先回去睡了"。妙语连珠是不可能的。`);
  } else if (energy <= 30) {
    parts.push(`你挺累的。回话别太长，也没力气接新话题。`);
  }
  if (hunger <= 15) {
    parts.push(`⚠️ 你饿得胃在抽。满脑子都是吃的，聊什么都心不在焉，可以直接打断话题去找吃的。`);
  }
  if (params.recentMemories) parts.push(`最近的经历：\n${params.recentMemories}`);

  // C2 对话所求：此刻区 1 行（位于 append-only 对话记录=缓存分歧点之后）
  if (params.conversationDesire) {
    parts.push(`\n${params.conversationDesire}`);
  }

  // C5 群聊时间线（实验开关）：只进尾部此刻区——对话记录之后、绝不插进前缀
  if (params.groupTimeline && params.groupTimeline.length > 0) {
    const lines = params.groupTimeline.map(
      (g) => `- ${g.fromName}(ID:${g.fromId}) 对你说：「${g.content}」`,
    );
    parts.push(`\n## 同一处还有人插话\n${lines.join("\n")}\n（你正在和${partnerCard.name}说话，第三个人也在场开了口。你可以回应插话的人——talk 的 target 填TA的 ID——把TA自然带进当前话题，或先跟${partnerCard.name}把话说完，都由你。）`);
  }

  // 4b. D3: seed_topic 注入的"你心里有些话想说"
  if (params.wantToDiscuss && params.wantToDiscuss.length > 0) {
    const urgencyLabel = { high: "【必须说】", med: "【找机会说】", low: "【有空就说】" };
    const topicLines = params.wantToDiscuss
      .filter((w) => !w.targetChar || w.targetChar === partnerCard.id)
      .map((w) => `- ${urgencyLabel[w.urgency]} ${w.topic}`);
    if (topicLines.length > 0) {
      parts.push(`\n## 你心里有些话想说\n${topicLines.join("\n")}\n（请围绕这些话题展开对话。【必须说】的话题必须在这次对话中提到。）`);
    }
  }

  // 5. 对话轮次提示
  const exchangeCount = history.length;
  if (exchangeCount >= 8) {
    parts.push(`\n⚠️ 你们已经聊了很久了（${exchangeCount} 轮）。现实中人不会一直聊下去。也许该做点别的了——去吃饭、回去工作、或者只是安静地待一会儿。你不一定非要继续说话。`);
  } else if (exchangeCount >= 4) {
    parts.push(`\n你们已经聊了 ${exchangeCount} 轮。注意对话的自然节奏——不需要每轮都说很多，有时候一个"嗯"、一个沉默、一个动作就够了。`);
  }

  // 6. 叙事指引 + 行动指令
  const lastExchange = history.length > 0 ? history[history.length - 1] : undefined;
  const lastSpeakerIsMe = lastExchange?.speakerId === card.id;
  const continuityHint = lastExchange && !lastSpeakerIsMe
    ? `\n对方刚刚说的是：「${lastExchange.message}」\n请回应这句话，不要跳回之前的话题。`
    : "";

  parts.push(`\n## 现在轮到你${continuityHint}
按上面「你要做什么」的方式：先写内心活动（含态度自检），再调用一个工具。`);

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
  relationship?: { level: number; type: string; grudge?: { reason: string; instigatorId: string; sinceTick: number } };
  impressionText?: string;
  recentMemories?: string;
  sharedHistory?: string;
  actions: ActionDefinition[];
  workplaceName?: string;
  colleagueNames?: string[];
  /** D3: director 注入的"想聊的话题" */
  wantToDiscuss?: Array<{ topic: string; urgency: "low" | "med" | "high"; targetChar?: string }>;
  /** C2 对话所求（此刻区 1 行） */
  conversationDesire?: string;
  /** C5 群聊时间线（实验开关默认关；只进尾部此刻区） */
  groupTimeline?: GroupSceneLine[];
  /** S3 已被击穿的信念 id（与决策路共用同一份 system 顶块，两条路都要传） */
  brokenBeliefs?: string[];
}): LLMRequest {
  const systemPrompt = buildSystemPrompt(params.card, params.workplaceName, params.colleagueNames, {
    brokenBeliefs: params.brokenBeliefs,
  });
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
    sharedHistory: params.sharedHistory,
    wantToDiscuss: params.wantToDiscuss,
    conversationDesire: params.conversationDesire,
    groupTimeline: params.groupTimeline,
  });

  const prefill = `好的，我已理解${params.card.name}这个角色。我将完全以这个角色的性格和说话方式来回应：\n`;

  // 提示词引擎：tavern = 对话也走 ST 破限预设栈（与 agent-loop 决策路径同款分叉），
  // 让亲密/露骨对话获得与决策一致的破限层——否则最该覆盖破限的对话正文反而漏掉。
  // 默认 legacy 不变（不设 ANIMA_PROMPT_ENGINE 或非 tavern）。
  if (process.env.ANIMA_PROMPT_ENGINE === "tavern") {
    return buildTavernRequest({
      characterName: params.card.name,
      characterDefinition: systemPrompt, // 角色定义 → charDescription（稳定前缀）
      worldSnapshot: userPrompt, // 此刻对话情境 → postHistory（易变殿后）
      tools: params.actions.map((a) => a.tool),
      maxTokensCap: 1024,
      prefill,
      kind: "conversation",
      tag: params.card.id,
    });
  }

  return {
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: params.actions.map((a) => a.tool),
    temperature: 1.0, // 对话模式温度更高，增加自然感
    maxTokens: 1024,  // 对话模式：思考精简 + 消息自然长度
    prefill,
    kind: "conversation",
    tag: params.card.id,
  };
}

/**
 * 在对话场景中选择可能被触发的 backstory。
 * 对话对象的名字、地点、情绪状态都可能唤起回忆。
 */
function selectConversationBackstory(
  card: CharacterCard,
  partnerName: string,
  locationName: string,
  needs: Record<string, number>,
): string | undefined {
  if (!card.backstory || card.backstory.length === 0) return undefined;

  const keywords: string[] = [locationName, partnerName];
  if ((needs.social ?? 100) < 25) keywords.push("独", "一个人", "没有朋友");
  if (locationName.includes("面包")) keywords.push("面包", "揉面");
  if (locationName.includes("海") || locationName.includes("沙滩")) keywords.push("海", "海浪");

  let bestScore = 0;
  let bestEntry: { event: string; impact: string } | undefined;

  for (const entry of card.backstory) {
    const text = `${entry.event} ${entry.impact}`;
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (bestScore < 1 || !bestEntry) return undefined;
  return `${bestEntry.event}——${bestEntry.impact}`;
}
