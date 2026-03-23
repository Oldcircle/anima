/**
 * Prompt Builder — 为 Agent 构建 LLM 提示词
 */

import type { CharacterCard } from "../character/types.js";
import type { CharacterState, CharacterNeeds, Weather } from "../world/types.js";
import type { GameTime } from "../core/tick-engine.js";
import { formatGameTime } from "../core/tick-engine.js";
import type { WorldEvent } from "../core/event-bus.js";
import { weatherDescription, weatherHint } from "../world/weather.js";

export function buildSystemPrompt(card: CharacterCard): string {
  return `你是 ${card.name}，${card.age} 岁，${card.occupation}。

## 你的性格
- 性格特点：${card.personality.traits.join("、")}
- 兴趣爱好：${card.personality.interests.join("、")}
- 不喜欢的：${card.personality.dislikes.join("、")}
- 说话风格：${card.personality.speechStyle}

## 你的背景
${card.background.trim()}

## 行为规则
- 你是一个生活在小镇上的真实人物，有自己的需求和情感
- 根据当前的时间、位置、需求值和周围的人来决定下一步做什么
- 调用一个工具来执行你的行为
- 如果需求值很低（<30），优先满足该需求
- 你的内心想法用普通文本表达，行为用工具调用表达
- 保持角色一致性，用你的说话风格`;
}

function formatNeeds(needs: CharacterNeeds): string {
  const bar = (v: number) => {
    if (v >= 70) return "充足";
    if (v >= 40) return "一般";
    if (v >= 20) return "偏低";
    return "⚠️ 很低";
  };
  return [
    `饥饿: ${needs.hunger}/100 (${bar(needs.hunger)})`,
    `精力: ${needs.energy}/100 (${bar(needs.energy)})`,
    `社交: ${needs.social}/100 (${bar(needs.social)})`,
    `快乐: ${needs.happiness}/100 (${bar(needs.happiness)})`,
    `卫生: ${needs.hygiene}/100 (${bar(needs.hygiene)})`,
  ].join("\n");
}

function formatRoutineHint(card: CharacterCard, hour: number): string {
  const times = Object.keys(card.dailyRoutine)
    .map((t) => ({ hour: parseInt(t.split(":")[0]!, 10), desc: card.dailyRoutine[t]! }))
    .sort((a, b) => a.hour - b.hour);

  // 找到当前时间段的日程
  let current = times[times.length - 1]!;
  for (const t of times) {
    if (t.hour <= hour) current = t;
  }

  const next = times.find((t) => t.hour > hour) ?? times[0]!;
  return `日程参考：现在通常是「${current.desc}」，接下来是「${next.desc}」`;
}

export function buildUserPrompt(params: {
  card: CharacterCard;
  state: CharacterState;
  gameTime: GameTime;
  nearbyCharacters: Array<{ id: string; name: string; relationship?: { level: number; type: string } }>;
  recentEvents: WorldEvent[];
  locationName: string;
  allLocationNames: Array<{ id: string; name: string }>;
  recentMemories?: string;
  weather?: Weather;
  festivalHint?: string;
}): string {
  const { card, state, gameTime, nearbyCharacters, recentEvents, locationName, allLocationNames } = params;

  const parts: string[] = [];

  const weatherStr = params.weather ? `  天气: ${weatherDescription(params.weather)}` : "";
  parts.push(`## 当前状态\n时间: ${formatGameTime(gameTime)}${weatherStr}\n位置: ${locationName}（你已经在这里了）`);

  const hint = params.weather ? weatherHint(params.weather) : "";
  if (hint) parts.push(hint);

  if (params.festivalHint) parts.push(`\n🎉 **${params.festivalHint}**`);

  if (nearbyCharacters.length > 0) {
    const people = nearbyCharacters.map((c) => {
      const rel = c.relationship;
      const relInfo = rel ? ` [${rel.type}, 亲密度:${rel.level}]` : " [陌生人]";
      return `${c.name}(ID:${c.id})${relInfo}`;
    }).join("\n  ");
    parts.push(`附近的人:\n  ${people}\n注意：使用 talk 工具时，target 参数必须填角色 ID（如 "${nearbyCharacters[0]!.id}"），不要填名字。`);
  } else {
    parts.push("附近没有其他人（无法使用 talk 工具）");
  }

  parts.push(`\n## 你的需求\n${formatNeeds(state.needs)}`);

  parts.push(`\n## ${formatRoutineHint(card, gameTime.hour)}`);

  if (params.recentMemories) {
    parts.push(`\n## 你的记忆（最近经历）\n${params.recentMemories}`);
  }

  if (recentEvents.length > 0) {
    parts.push("\n## 最近发生的事");
    for (const e of recentEvents.slice(-5)) {
      parts.push(`- ${e.description}`);
    }
  }

  // 可用地点列表
  const otherLocations = allLocationNames
    .filter((l) => l.id !== state.locationId)
    .map((l) => `${l.id}(${l.name})`)
    .join("、");
  parts.push(`\n## 可前往的地点\n${otherLocations}`);

  parts.push("\n请根据以上信息，决定你现在要做什么。先简短说说你的想法（1-2句），然后调用一个工具。注意：如果你已经在目标地点了，不需要再 go_to 那里，直接做想做的事。");

  return parts.join("\n");
}
