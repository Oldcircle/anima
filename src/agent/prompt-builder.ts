/**
 * Prompt Builder — 为 Agent 构建 LLM 提示词
 *
 * System prompt: 完整的角色身份描写（不变）
 * User prompt: 当前世界状态 + 约束预提醒（每 tick 变化）
 */

import type { CharacterCard, LifeState } from "../character/types.js";
import type { CharacterState, CharacterNeeds, Weather, InboxMessage, LocationAtmosphere } from "../world/types.js";
import type { GameTime } from "../core/tick-engine.js";
import { formatGameTime } from "../core/tick-engine.js";
import type { WorldEvent } from "../core/event-bus.js";
import { weatherDescription, weatherHint } from "../world/weather.js";
import { formatMoodlets } from "../world/moodlets.js";
import { getAtmosphereText } from "../world/location-loader.js";
import type { ImpressionStore } from "../memory/impressions.js";
import { formatBodyFeelings } from "../world/need-definitions.js";
import { formatInventory as _formatInventory } from "../world/item-registry.js";

/**
 * 格式化技能认知：将技能数值转为自然语言描述
 */
const SKILL_NAMES: Record<string, string> = {
  baking: "烘焙",
  social: "社交",
  barista: "咖啡调制",
  piano: "钢琴",
  etiquette: "礼仪",
  botany: "植物学",
  guitar: "吉他",
  organizing: "整理收纳",
  observation: "观察力",
  writing: "写作",
  knowledge: "知识",
};

function formatSkillLevel(skill: string, level: number): string {
  const name = SKILL_NAMES[skill] ?? skill;
  if (level >= 8) return `${name}（精通）`;
  if (level >= 5) return `${name}（熟练）`;
  if (level >= 3) return `${name}（有基础）`;
  if (level >= 1) return `${name}（在学习）`;
  return `${name}（刚入门）`;
}

/**
 * 格式化生活状态注入 system prompt
 */
function formatLifeContext(life: LifeState, workplaceName?: string): string {
  const parts: string[] = [];

  // 工作认知
  const wpName = workplaceName ?? life.workplace;
  parts.push(`你在${wpName}当${life.occupation}。`);

  // 技能认知
  const skillEntries = Object.entries(life.skills).filter(([, v]) => v > 0);
  if (skillEntries.length > 0) {
    const skillDescs = skillEntries.map(([k, v]) => formatSkillLevel(k, v));
    parts.push(`你的技能：${skillDescs.join("、")}。`);
  }

  // 长期抱负
  if (life.aspiration) {
    parts.push(`你内心深处一直想：${life.aspiration}。`);
  }

  return parts.join("\n");
}

export function buildSystemPrompt(card: CharacterCard, workplaceName?: string, colleagueNames?: string[]): string {
  const parts: string[] = [];

  const life = card.life;
  const age = life?.age ?? card.age;
  const occupation = life?.occupation ?? card.occupation;

  parts.push(`你是 ${card.name}，${age} 岁，${occupation}。`);

  // 生活状态认知
  if (life) {
    let lifeText = formatLifeContext(life, workplaceName);
    if (colleagueNames && colleagueNames.length > 0) {
      lifeText += `\n你的同事：${colleagueNames.join("、")}。你们在同一个地方工作。`;
    }
    parts.push(`\n## 你的生活\n${lifeText}`);
  }

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
- 你能做什么取决于你在哪里、身边有谁。看看你现在有哪些工具可用，然后选一个
- 如果当前地点没有你想做的事，可以用 go_to 去其他地方——go_to 的参数里列出了每个地方能做什么
- 感受你的身体在告诉你什么（饿了？累了？想找人聊天？），然后自然地做出反应
- 有人对你说话时，考虑要不要回应
- 先简短写出你的想法，然后调用一个工具
- 不要重复你刚才做过的事或说过的话
- 保持角色一致性，用你的说话风格和性格特点来决定行为

## 世界的常识
- 做任何事都要花时间和力气。累了做什么都提不起劲
- 在外面吃饭方便但花钱，在家做饭便宜但费事
- 和别人一起做事的时候，做什么不重要，重要的是在一起
- 一个人待久了会闷，但社交多了也会累
- 有些快乐是要付代价的。喝酒明天会头疼，熬夜后天会困

## 社交行为指引
- 说话时考虑你和对方的关系、你当前的心情、以及你想达到什么目的
- 你可以选择说什么、不说什么、怎么说——不是每次都要直来直去
- 你可以犹豫、改口、词不达意、言不由衷——这些都是真实的表达
- 如果对方让你不舒服，你可以转移话题、找借口离开、或者沉默不语
- 注意观察周围的环境和其他人的状态，这些会影响你的感受和决定
- 想说话时，考虑当前场景和气氛是否适合——有些话不是什么时候都能说的

## 说话风格
- 说话要像正常人说话，不是写诗。少用比喻，多用大白话
- 说话像正常人一样自然，一两句到三四句就够了
- 如果你的角色本身不是文艺青年，就不要每句话都用意象和隐喻`);

  return parts.join("\n");
}

// formatBodyFeelings 已移至 need-definitions.ts（数据驱动）

function formatPreferencesHint(card: CharacterCard): string {
  if (!card.preferences || Object.keys(card.preferences).length === 0) {
    return "";
  }
  const lines = Object.entries(card.preferences)
    .map(([key, desc]) => `- ${key}: ${desc}`);
  return `## 你的生活习惯\n${lines.join("\n")}`;
}

function describeBond(bond?: string): string {
  switch (bond) {
    case "colleague": return "你们是同事。";
    case "roommate": return "你们是室友。";
    case "partner": return "这是你最重要的人。";
    case "ex": return "你们曾经在一起过。";
    case "mentor": return "你们是师徒关系。";
    case "rival": return "你和这个人之间有解不开的结。";
    default: return "";
  }
}

function describeRelationshipFeel(type?: string, bond?: string): string {
  const bondDesc = describeBond(bond);
  let relDesc: string;
  switch (type) {
    case "best_friend":
      relDesc = "你和这个人已经非常亲近，相处时会自然放松下来。";
      break;
    case "close_friend":
      relDesc = "你对这个人有明显的亲近感，愿意多停留一会儿。";
      break;
    case "friend":
      relDesc = "你和这个人已经算熟悉了，说话不会太拘谨。";
      break;
    case "acquaintance":
      relDesc = "你对这个人有些印象，算是点头之交。";
      break;
    case "rival":
      relDesc = "你和这个人之间有些紧绷，最好留意自己的分寸。";
      break;
    case "romantic":
      relDesc = "这个人会牵动你的情绪，你很难完全当作普通朋友。";
      break;
    default:
      relDesc = "你对这个人还不算熟，只能凭眼前的举止慢慢判断。";
  }
  return bondDesc ? `${bondDesc}${relDesc}` : relDesc;
}

export function buildUserPrompt(params: {
  card: CharacterCard;
  state: CharacterState;
  gameTime: GameTime;
  nearbyCharacters: Array<{
    id: string;
    name: string;
    relationship?: { level: number; type: string; bond?: string };
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
  const bodyFeelings = formatBodyFeelings(state.needs, state.gold, gameTime.hour);
  parts.push(`\n## 你的身体感受\n${bodyFeelings}`);

  // 情绪状态（Moodlet 系统）
  const moodletText = formatMoodlets(state);
  if (moodletText) parts.push(`\n${moodletText}`);

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
          const bondNote = c.relationship?.bond ? describeBond(c.relationship.bond) : "";
          parts.push(`**${c.name}**(ID:${c.id})${bondNote ? " " + bondNote : ""}\n${impText}`);
          // 收集未解疑惑，作为对话驱动力
          const imp = params.impressions!.get(card.id, c.id);
          if (imp && imp.unresolved.length > 0) {
            curiosities.push(`关于${c.name}：${imp.unresolved[0]}`);
          }
        } else {
          parts.push(`- ${c.name}(ID:${c.id})：${describeRelationshipFeel(c.relationship?.type, c.relationship?.bond)}`);
        }
      }
      // 注入未解疑惑作为对话方向提示
      if (curiosities.length > 0) {
        parts.push(`\n你心里有些好奇的事：${curiosities.join("；")}。如果有合适的时机，也许可以自然地聊到这些话题——但不要突兀地追问。`);
      }
    } else {
      const people = nearbyCharacters.map((c) => {
        return `- ${c.name}(ID:${c.id})：${describeRelationshipFeel(c.relationship?.type, c.relationship?.bond)}`;
      }).join("\n");
      parts.push(`\n## 你对他们的主观感觉\n${people}`);
    }
    parts.push(`注意：使用 talk 工具时，target 参数必须填角色 ID（如 "${nearbyCharacters[0]!.id}"），不要填名字。talk 是在当前地点当面开口说话，在场的人也可能注意到。`);
  } else {
    // 独处时，根据社交需求提供不同程度的引导
    const remembered = params.impressions?.getAllFor(card.id) ?? [];
    if (remembered.length > 0 && state.needs.social < 40) {
      const resolveName = (id: string) => params.characterNames?.get(id) ?? id;
      const hints = remembered.slice(0, 3).map((imp) =>
        `${resolveName(imp.characterId)}: ${imp.summary.slice(0, 40)}`
      ).join("；");
      parts.push(`\n附近没有其他人。你想起一些人：${hints}。也许可以去找他们聊聊。`);
    } else if (state.needs.social < 30) {
      parts.push("\n附近没有其他人。你有一阵子没和人说话了。也许可以去咖啡馆、广场或其他地方走走，看看能不能遇到认识的人。");
    } else if (state.needs.social < 50) {
      parts.push("\n附近没有其他人。");
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

  // 生活目标/担忧（从反思涌现的内在驱动力）
  const life = state.life ?? card.life;
  if (life) {
    const lifeHints: string[] = [];
    if (life.currentGoal) lifeHints.push(`你最近想做的事：${life.currentGoal}`);
    if (life.currentConcern) lifeHints.push(`你有点担心的事：${life.currentConcern}`);
    if (lifeHints.length > 0) {
      parts.push(`\n## 你心里挂着的事\n${lifeHints.join("\n")}`);
    }
  }

  // 随身物品
  if (state.inventory && state.inventory.length > 0) {
    const invText = _formatInventory(state.inventory);
    if (invText) parts.push(`\n${invText}`);
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
