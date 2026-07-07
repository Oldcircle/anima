/**
 * Morning Plan — 晨间打算
 *
 * 每天早上（06:00），角色基于昨日反思、今日约定、天气给自己定 1-3 件"今天想做的事"。
 * 这是把"反应式生存"推向"有主线的生活"的关键层：
 *   反思(昨晚) → 今日打算(早上) → 全天 prompt 注入 → 反思回顾(今晚) → 循环
 *
 * 设计原则：打算是"心里有数"不是任务清单——prompt 措辞刻意松弛（"顺其自然"），
 * 避免角色变成 todo 执行机器。生成失败不阻塞（没打算的一天也是正常的一天）。
 */

import type { CharacterCard } from "../character/types.js";
import type { CharacterState, Weather } from "../world/types.js";
import type { LLMProvider } from "../providers/types.js";
import { weatherDescription } from "../world/weather.js";

export interface MorningPlanResult {
  characterId: string;
  items: string[];
}

export async function generateMorningPlan(params: {
  card: CharacterCard;
  state: CharacterState;
  provider: LLMProvider;
  modelId: string;
  /** 昨晚反思的产出（愿望/担忧/洞察），没有就凭性格和日常 */
  yesterdayWish?: string;
  yesterdayConcern?: string;
  yesterdayInsights?: string[];
  /** 今天已有的约定（文字描述，如"今天12:00在咖啡馆和X见面"） */
  todayAppointments?: string[];
  weather?: Weather;
  workplaceName?: string;
  /** 镇上真实存在的地点名（可供性锚：打算只能安排真去得了的地方） */
  townLocations?: string[];
  /** 镇上真实存在的其他居民名（可供性锚：打算只能安排真见得到的人） */
  townPeople?: string[];
  /** 是不是模拟第一天（首日没有"昨天"，防编造"昨天那批可颂"类往事） */
  isFirstDay?: boolean;
}): Promise<MorningPlanResult> {
  const { card, provider, modelId } = params;
  const life = params.state.life ?? card.life;
  const occupation = life?.occupation ?? card.occupation;

  // 可供性锚（防幻觉）：AUDIT 实锤——打算里出现过 C.C./地下室/证件系统等世界里不存在的实体，
  // 然后指挥一整天的行为。把真实地点/居民清单放进 prompt，打算只许在这个世界里落脚。
  const affordanceAnchor = params.townLocations && params.townLocations.length > 0
    ? `\n这个镇就这么大——你今天能去的地方：${params.townLocations.join("、")}。${
      params.townPeople && params.townPeople.length > 0 ? `镇上你可能碰到的人：${params.townPeople.join("、")}。` : ""
    }
打算只安排真实存在的地点和人。你过去认识的人不在镇上也联系不上，可以在心里惦记，但别把"见他/找他/等他消息"排进今天。`
    : "";

  const system = `你是 ${card.name}，${occupation}。
性格：${card.personality.traits.join("、")}${life?.aspiration ? `\n你内心深处一直想：${life.aspiration}` : ""}

现在是清晨，你刚醒，躺在床上想今天要做什么。
用第一人称，按你的性格随意想 1-3 件今天想做的事（不是任务清单，就是心里有个数）。
每行一件，以"- "开头，一句话一件。别写套话，写具体的事。${affordanceAnchor}`;

  const userParts: string[] = [];
  if (params.yesterdayInsights && params.yesterdayInsights.length > 0) {
    userParts.push(`昨晚睡前你想过：${params.yesterdayInsights.join("；")}`);
  }
  if (params.yesterdayWish) userParts.push(`你昨天就想着：${params.yesterdayWish}`);
  if (params.yesterdayConcern) userParts.push(`你有点担心：${params.yesterdayConcern}`);
  if (params.todayAppointments && params.todayAppointments.length > 0) {
    userParts.push(`今天已经说定的约：${params.todayAppointments.join("；")}（这个不用列进打算，你记得就行）`);
  }
  if (params.weather) userParts.push(`今天天气：${weatherDescription(params.weather)}`);
  if (params.workplaceName) userParts.push(`你在${workplaceHint(params.workplaceName, occupation)}`);
  if (params.isFirstDay) {
    // 半日实测实锤：D1 清晨就编"昨天那批可颂发酵不够""昨天打翻的摩卡"——首日没有昨天
    userParts.push("这是你在这个镇上新生活的头一个清晨，还没有'昨天'——打算里别提及昨天发生过的具体事。");
  } else if (userParts.length === 0) {
    userParts.push("昨天是平平常常的一天。");
  }

  try {
    const response = await provider.chat(
      {
        system,
        messages: [{ role: "user", content: userParts.join("\n") }],
        temperature: 0.9,
        maxTokens: 150,
        kind: "morning-plan",
        tag: card.id,
      },
      modelId,
    );

    const items = response.content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- ") || l.startsWith("-"))
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter((l) => l.length > 1)
      .slice(0, 3);

    return { characterId: card.id, items };
  } catch (err) {
    console.warn(`[晨间打算] ${card.id} 生成失败:`, (err as Error)?.message ?? err);
    return { characterId: card.id, items: [] };
  }
}

function workplaceHint(workplaceName: string, occupation?: string): string {
  return occupation ? `${workplaceName}当${occupation}，今天照常有活儿` : `${workplaceName}干活`;
}
