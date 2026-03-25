/**
 * Prompt Builder — 为 Agent 构建 LLM 提示词
 *
 * System prompt: 完整的角色身份描写（不变）
 * User prompt: 当前世界状态 + 约束预提醒（每 tick 变化）
 */

import type { CharacterCard } from "../character/types.js";
import type { CharacterState, CharacterNeeds, Weather, InboxMessage, LocationAtmosphere } from "../world/types.js";
import type { GameTime } from "../core/tick-engine.js";
import { formatGameTime } from "../core/tick-engine.js";
import type { WorldEvent } from "../core/event-bus.js";
import { weatherDescription, weatherHint } from "../world/weather.js";
import { getAtmosphereText } from "../world/location-loader.js";
import type { ImpressionStore } from "../memory/impressions.js";

export function buildSystemPrompt(card: CharacterCard): string {
  const parts: string[] = [];

  parts.push(`你是 ${card.name}，${card.age} 岁，${card.occupation}。`);

  // 外貌
  if (card.appearance) {
    parts.push(`\n## 你的外貌\n${card.appearance.trim()}`);
  }

  // 性格 — 优先使用深度描写
  parts.push("\n## 你的性格");
  if (card.personality.coreTraits) {
    parts.push(card.personality.coreTraits.trim());
  } else {
    parts.push(`性格特点：${card.personality.traits.join("、")}`);
  }

  if (card.personality.psychology) {
    parts.push(`\n## 你的内心\n${card.personality.psychology.trim()}`);
  }

  if (card.personality.stressResponse) {
    parts.push(`\n## 你在压力下\n${card.personality.stressResponse.trim()}`);
  }

  // 说话风格
  parts.push("\n## 你的说话方式");
  if (card.personality.speech) {
    parts.push(card.personality.speech.style);
    if (card.personality.speech.habits.length > 0) {
      parts.push(`口癖：${card.personality.speech.habits.join("、")}`);
    }
    if (card.personality.speech.examples.length > 0) {
      parts.push("你说话的例子：");
      for (const ex of card.personality.speech.examples) {
        parts.push(`- 「${ex}」`);
      }
    }
  } else {
    parts.push(card.personality.speechStyle);
  }

  // 兴趣/厌恶
  parts.push(`\n兴趣爱好：${card.personality.interests.join("、")}`);
  parts.push(`不喜欢的：${card.personality.dislikes.join("、")}`);

  // 背景 — 优先使用结构化经历
  parts.push("\n## 你的过去");
  if (card.backstory && card.backstory.length > 0) {
    for (const b of card.backstory) {
      parts.push(`- ${b.event} → ${b.impact}`);
    }
  } else {
    parts.push(card.background.trim());
  }

  // 行为规则
  parts.push(`\n## 行为规则
- 你是一个生活在海边小镇上的真实人物，有自己的需求、情感和经济状况
- 根据当前的时间、位置、需求值、金币和周围的人来决定下一步做什么
- 调用一个工具来执行你的行为
- 注意工具的前置条件（在家才能睡觉/洗澡，需要金币才能在外面消费）
- 如果需求值很低（<30），优先满足该需求
- 如果"有人对你说"里有消息，优先考虑用 talk 回应（也可以选择不回应）
- 如果你身无分文又饥肠辘辘，你可能需要做一些不太体面的事（乞讨、偷窃）——生存是第一位的
- talk 发出的消息不会阻塞，对方会在下一轮看到
- 说话像正常人一样自然，一两句到三四句都可以，不要长篇大论
- 不要重复你刚才做过的事或说过的话。如果记忆里显示你刚对某人说了某句话，就不要再说同样的内容
- 你的内心想法用普通文本表达，行为用工具调用表达
- 保持角色一致性，用你的说话风格和性格特点来决定行为

## 社交行为指引
- 说话时考虑你和对方的关系、你当前的心情、以及你想达到什么目的
- 你可以选择说什么、不说什么、怎么说——不是每次都要直来直去
- 你可以犹豫、改口、词不达意、言不由衷——这些都是真实的表达
- 如果对方让你不舒服，你可以转移话题、找借口离开、或者沉默不语
- 注意观察周围的环境和其他人的状态，这些会影响你的感受和决定
- 想说话时，考虑当前场景和气氛是否适合——有些话不是什么时候都能说的

## 说话风格
- 说话要像正常人说话，不是写诗。少用比喻，多用大白话
- 可以说"我饿了"，不需要说"我的胃像干涸的河床"
- 如果你的角色本身不是文艺青年，就不要每句话都用意象和隐喻
- talk 工具有可选的 manner 参数——用一句白描写你说话时在做什么（"搓着手"、"看向窗外"）`);

  return parts.join("\n");
}

/**
 * 将需求数值转化为自然语言身体感受。
 * 满的不提，偏低用身体感受，极低用紧急措辞。
 */
function formatBodyFeelings(needs: CharacterNeeds, gold: number): string {
  const feelings: string[] = [];

  // 饥饿
  if (needs.hunger < 15) feelings.push("饿到胃在抽痛，必须马上吃点东西。");
  else if (needs.hunger < 30) feelings.push("饿得有点发晕，得找地方吃饭了。");
  else if (needs.hunger < 60) feelings.push("肚子有点饿了。");

  // 精力
  if (needs.energy < 15) feelings.push("累到站不稳，眼睛都快睁不开了。");
  else if (needs.energy < 30) feelings.push("眼皮很重，脑子转得慢，很想躺下来。");
  else if (needs.energy < 60) feelings.push("有点累了，打了个哈欠。");

  // 社交
  if (needs.social > 85) feelings.push("今天和人聊了不少，想安静待一会儿。");
  else if (needs.social < 15) feelings.push("一个人待太久了，心里空荡荡的，很想找人说说话。");
  else if (needs.social < 30) feelings.push("有点寂寞，想找人聊聊。");

  // 快乐
  if (needs.happiness < 20) feelings.push("什么都提不起劲，心里闷闷的。");
  else if (needs.happiness < 40) feelings.push("心情有点低落。");
  else if (needs.happiness > 80) feelings.push("心情挺好的。");

  // 卫生
  if (needs.hygiene < 30) feelings.push("身上黏糊糊的，该洗个澡了。");
  else if (needs.hygiene < 50) feelings.push("身上不太清爽。");

  // 金币
  if (gold === 0) feelings.push("口袋空空的，一个硬币都没有。");
  else if (gold < 10) feelings.push(`口袋里只剩 ${gold} 金币，得省着花。`);

  // 极端组合
  if (gold === 0 && needs.hunger < 20) {
    feelings.push("又穷又饿，处境很危险。");
  }

  if (feelings.length === 0) return "";
  return feelings.join("");
}

function formatPreferencesHint(card: CharacterCard): string {
  if (!card.preferences || Object.keys(card.preferences).length === 0) {
    return "";
  }
  const lines = Object.entries(card.preferences)
    .map(([key, desc]) => `- ${key}: ${desc}`);
  return `## 你的生活习惯\n${lines.join("\n")}`;
}

function describeRelationshipFeel(type?: string): string {
  switch (type) {
    case "best_friend":
      return "你和这个人已经非常亲近，相处时会自然放松下来。";
    case "close_friend":
      return "你对这个人有明显的亲近感，愿意多停留一会儿。";
    case "friend":
      return "你和这个人已经算熟悉了，说话不会太拘谨。";
    case "acquaintance":
      return "你对这个人有些印象，算是点头之交。";
    case "rival":
      return "你和这个人之间有些紧绷，最好留意自己的分寸。";
    case "romantic":
      return "这个人会牵动你的情绪，你很难完全当作普通朋友。";
    default:
      return "你对这个人还不算熟，只能凭眼前的举止慢慢判断。";
  }
}

export function buildUserPrompt(params: {
  card: CharacterCard;
  state: CharacterState;
  gameTime: GameTime;
  nearbyCharacters: Array<{
    id: string;
    name: string;
    relationship?: { level: number; type: string };
    /** 当前正在做什么（可观察状态） */
    currentAction?: string;
  }>;
  recentEvents: WorldEvent[];
  locationName: string;
  locationType?: string;
  allLocationNames: Array<{ id: string; name: string }>;
  recentMemories?: string;
  weather?: Weather;
  festivalHint?: string;
  inboxMessages?: InboxMessage[];
  /** 地点的感官描述 */
  atmosphere?: LocationAtmosphere;
  /** 印象系统（如有） */
  impressions?: ImpressionStore;
  /** 角色 ID → 显示名映射（用于回忆中的人名解析） */
  characterNames?: Map<string, string>;
}): string {
  const { card, state, gameTime, nearbyCharacters, recentEvents, locationName, allLocationNames } = params;
  const locationType = params.locationType ?? "public";
  const weatherStr = params.weather ? `  天气: ${weatherDescription(params.weather)}` : "";

  const parts: string[] = [];

  // 环境感知：优先用 atmosphere 描写，否则回退到原来的格式
  const atmosphereText = getAtmosphereText(params.atmosphere, gameTime.hour, params.weather ?? "sunny");
  if (atmosphereText) {
    parts.push(`## 你现在看到的\n${locationName}——${atmosphereText}`);
    parts.push(`时间: ${formatGameTime(gameTime)}${weatherStr}`);
  } else {
    parts.push(`## 你现在看到的\n${locationName}，${formatGameTime(gameTime)}。${weatherStr}`);
  }

  const hint = params.weather ? weatherHint(params.weather) : "";
  if (hint) parts.push(hint);

  if (params.festivalHint) parts.push(`\n🎉 **${params.festivalHint}**`);

  // 身体感受（替代数值面板和约束警告）
  const bodyFeelings = formatBodyFeelings(state.needs, state.gold);
  if (bodyFeelings) {
    parts.push(`\n## 你的身体感受\n${bodyFeelings}`);
  }

  // 附近的人：先写可见事实，再写主观感觉/印象
  if (nearbyCharacters.length > 0) {
    const visiblePeople = nearbyCharacters.map((c) => {
      const actionDesc = c.currentAction ? `——${c.currentAction}` : "——此刻没有明显动作";
      return `- ${c.name}(ID:${c.id}) ${actionDesc}`;
    }).join("\n");
    parts.push(`\n## 你现在看见了谁\n${visiblePeople}`);
    parts.push("你只能根据对方此刻的表情、动作、语气和过往记忆来判断他们，不要把猜测当成事实。");

    const hasAnyImpression = params.impressions && nearbyCharacters.some((c) =>
      params.impressions!.get(card.id, c.id),
    );

    if (hasAnyImpression) {
      parts.push(`\n## 你对他们的主观感觉`);
      const curiosities: string[] = [];
      for (const c of nearbyCharacters) {
        const impText = params.impressions!.formatForPrompt(card.id, c.id);
        if (impText) {
          parts.push(`**${c.name}**(ID:${c.id})\n${impText}`);
          // 收集未解疑惑，作为对话驱动力
          const imp = params.impressions!.get(card.id, c.id);
          if (imp && imp.unresolved.length > 0) {
            curiosities.push(`关于${c.name}：${imp.unresolved[0]}`);
          }
        } else {
          parts.push(`- ${c.name}(ID:${c.id})：${describeRelationshipFeel(c.relationship?.type)}`);
        }
      }
      // 注入未解疑惑作为对话方向提示
      if (curiosities.length > 0) {
        parts.push(`\n你心里有些好奇的事：${curiosities.join("；")}。如果有合适的时机，也许可以自然地聊到这些话题——但不要突兀地追问。`);
      }
    } else {
      const people = nearbyCharacters.map((c) => {
        return `- ${c.name}(ID:${c.id})：${describeRelationshipFeel(c.relationship?.type)}`;
      }).join("\n");
      parts.push(`\n## 你对他们的主观感觉\n${people}`);
    }
    parts.push(`注意：使用 talk 工具时，target 参数必须填角色 ID（如 "${nearbyCharacters[0]!.id}"），不要填名字。talk 是在当前地点当面开口说话，在场的人也可能注意到。`);
  } else {
    // 独处时，如果有记忆中的人，提供回忆线索帮助决策
    const remembered = params.impressions?.getAllFor(card.id) ?? [];
    if (remembered.length > 0 && state.needs.social < 35) {
      const resolveName = (id: string) => params.characterNames?.get(id) ?? id;
      const hints = remembered.slice(0, 3).map((imp) =>
        `${resolveName(imp.characterId)}: ${imp.summary.slice(0, 40)}`
      ).join("；");
      parts.push(`\n附近没有其他人。你想起一些人：${hints}。也许可以去找他们聊聊。`);
    } else if (state.needs.social < 20) {
      parts.push("\n附近没有其他人。你已经很久没和人说话了，感到非常孤独。也许应该去广场、咖啡馆或酒吧等有人的地方看看。");
    } else {
      parts.push("\n附近没有其他人。");
    }
  }

  // 信箱消息
  if (params.inboxMessages && params.inboxMessages.length > 0) {
    const msgs = params.inboxMessages
      .map((m) => `- ${m.fromName}(ID:${m.fromId}) 对你说：「${m.content}」`)
      .join("\n");
    parts.push(`\n## 有人对你说\n${msgs}\n（这些话刚刚在你耳边发生。你可以用 talk 回应，也可以无视或转身离开。）`);
  }

  const prefsHint = formatPreferencesHint(card);
  if (prefsHint) parts.push(`\n${prefsHint}`);

  if (params.recentMemories) {
    parts.push(`\n## 你的记忆（最近经历）\n${params.recentMemories}`);
  }

  if (recentEvents.length > 0) {
    parts.push("\n## 最近发生的事");
    for (const e of recentEvents.slice(-5)) {
      parts.push(`- ${e.description}`);
    }
  }

  // 思考指令：社交场景更详细，独处场景简短
  const isSocialScene = nearbyCharacters.length > 0 || (params.inboxMessages && params.inboxMessages.length > 0);
  if (isSocialScene) {
    parts.push("\n请根据以上信息，决定你现在要做什么。先用2-3句话说说你的想法，然后调用一个工具。");
  } else {
    parts.push("\n请根据以上信息，决定你现在要做什么。先简短说说你的想法（1-2句），然后调用一个工具。");
  }
  parts.push("注意：如果你已经在目标地点了，不需要再 go_to 那里，直接做想做的事。");

  return parts.join("\n");
}
