/**
 * Conversation System — 角色间真实多轮对话
 *
 * 流程：A 开场 → B 回复 → A 接话 → ... → 结束 → 双方存记忆
 */

import type { CharacterCard } from "../character/types.js";
import type { World } from "../world/world.js";
import type { GameTime } from "../core/tick-engine.js";
import type { LLMProvider, LLMRequest } from "../providers/types.js";
import { formatGameTime } from "../core/tick-engine.js";

export interface ConversationMessage {
  speakerId: string;
  speakerName: string;
  content: string;
  innerThought?: string;
}

export interface ConversationResult {
  initiatorId: string;
  targetId: string;
  locationId: string;
  startTick: number;
  messages: ConversationMessage[];
  summary: string;
  relationshipDelta: number;
}

function buildConversationSystemPrompt(card: CharacterCard, otherName: string, relationship: { level: number; type: string } | undefined): string {
  const relDesc = relationship
    ? `你和${otherName}的关系：${relationship.type}（亲密度 ${relationship.level}/100）`
    : `你和${otherName}还不太熟`;

  return `你是 ${card.name}，${card.age} 岁，${card.occupation}。

性格：${card.personality.traits.join("、")}
说话风格：${card.personality.speechStyle}
背景：${card.background.trim()}

${relDesc}

你正在和${otherName}对话。请用你的说话风格自然地回应。
- 只输出你说的话，不要加引号或角色名前缀
- 保持简短自然（1-3 句话）
- 如果觉得对话该结束了，在末尾加上 [END]
- 根据你的性格和与对方的关系来决定语气和内容`;
}

export async function runConversation(params: {
  initiator: CharacterCard;
  target: CharacterCard;
  intent: string;
  openingLine: string;
  provider: LLMProvider;
  modelId: string;
  world: World;
  gameTime: GameTime;
  maxTurns?: number;
}): Promise<ConversationResult> {
  const { initiator, target, provider, modelId, world, gameTime } = params;
  const maxTurns = params.maxTurns ?? 6;

  const initiatorState = world.getCharacter(initiator.id);
  const targetState = world.getCharacter(target.id);
  const locationId = initiatorState?.locationId ?? "unknown";

  // 获取双方关系
  const initiatorRel = initiator.relationships[target.id];
  const targetRel = target.relationships[initiator.id];

  // 根据关系深度决定对话轮次
  const relLevel = Math.max(initiatorRel?.level ?? 0, targetRel?.level ?? 0);
  const actualMaxTurns = relLevel > 6 ? maxTurns : Math.min(maxTurns, 4);

  const messages: ConversationMessage[] = [];

  // 开场白
  messages.push({
    speakerId: initiator.id,
    speakerName: initiator.name,
    content: params.openingLine,
  });

  // 对话历史（用于构建 LLM 消息）
  const chatHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  // 轮流对话
  let ended = false;
  for (let turn = 0; turn < actualMaxTurns && !ended; turn++) {
    // 确定本轮说话者
    const isInitiatorTurn = turn % 2 === 1; // turn 0 已经是开场白
    const speaker = isInitiatorTurn ? initiator : target;
    const listener = isInitiatorTurn ? target : initiator;
    const speakerRel = speaker.relationships[listener.id];

    const systemPrompt = buildConversationSystemPrompt(speaker, listener.name, speakerRel);

    // 构建对话上下文
    const contextMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // 加入时间和场景
    const sceneContext = `[场景: ${formatGameTime(gameTime)}，在${world.getLocation(locationId)?.name ?? locationId}]`;

    // 把之前的对话转成 LLM 消息格式
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.speakerId === speaker.id) {
        contextMessages.push({ role: "assistant", content: msg.content });
      } else {
        contextMessages.push({ role: "user", content: msg.content });
      }
    }

    // 如果最后一条不是 user，加一个空的提示
    if (contextMessages.length === 0 || contextMessages[contextMessages.length - 1]!.role === "assistant") {
      // 第一轮：target 收到 initiator 的开场白
      contextMessages.push({
        role: "user",
        content: `${sceneContext}\n${messages[messages.length - 1]!.speakerName}对你说: "${messages[messages.length - 1]!.content}"`,
      });
    }

    const request: LLMRequest = {
      system: systemPrompt,
      messages: contextMessages,
      temperature: 0.9,
      maxTokens: 256,
    };

    try {
      const response = await provider.chat(request, modelId);
      let content = response.content.trim();

      // 检查是否要结束对话
      if (content.includes("[END]")) {
        content = content.replace("[END]", "").trim();
        ended = true;
      }

      if (content) {
        messages.push({
          speakerId: speaker.id,
          speakerName: speaker.name,
          content,
        });
      }
    } catch {
      // LLM 失败，结束对话
      ended = true;
    }
  }

  // 计算关系变化（简单规则：对话越长关系越好）
  const relationshipDelta = Math.min(messages.length, 5);

  // 更新双方社交需求
  if (initiatorState) {
    world.modifyNeed(initiator.id, "social", 10 + messages.length * 3);
  }
  if (targetState) {
    world.modifyNeed(target.id, "social", 8 + messages.length * 2);
  }

  // 生成对话摘要
  const summary = `${initiator.name}和${target.name}在${world.getLocation(locationId)?.name ?? locationId}聊了${messages.length}轮。话题：${params.intent}`;

  return {
    initiatorId: initiator.id,
    targetId: target.id,
    locationId,
    startTick: gameTime.tick,
    messages,
    summary,
    relationshipDelta,
  };
}
