/**
 * Reflection — 每日反思机制
 *
 * 一天结束时（23:00），每个角色回顾当天经历，生成高层洞察。
 * 洞察存入长期记忆（当前用 ShortTermMemory，importance 高）。
 */

import type { CharacterCard, LifeState } from "../character/types.js";
import type { LLMProvider, LLMRequest } from "../providers/types.js";
import type { ShortTermMemory, MemoryEntry } from "../memory/short-term.js";
import type { RelationshipManager } from "../world/relationships.js";
import { personaDeepeningLines } from "./prompt-builder.js";

export interface ReflectionResult {
  characterId: string;
  insights: string[];
  mood: string;
  /** 从今天经历中涌现的短期愿望 */
  wish?: string;
  /** 从今天经历中涌现的担忧 */
  concern?: string;
}

export async function runReflection(params: {
  card: CharacterCard;
  memory: ShortTermMemory;
  relationships: RelationshipManager;
  provider: LLMProvider;
  modelId: string;
  dayStartTick: number;
  dayEndTick: number;
  /** 今天早上的打算（晨间计划），反思时回顾完成情况 */
  todayPlan?: string[];
  /** B5 多日执念（≤2 条摘要）：反思时回顾"还压着吗" */
  obsessions?: string[];
}): Promise<ReflectionResult> {
  const { card, memory, relationships, provider, modelId } = params;

  const dayMemories = memory.getDayMemories(card.id, params.dayStartTick, params.dayEndTick);

  if (dayMemories.length === 0) {
    return { characterId: card.id, insights: [], mood: "平静" };
  }

  const memorySummary = dayMemories
    .map((m) => `- ${m.content}`)
    .join("\n");

  const rels = relationships.getRelationshipsOf(card.id);
  const relTypeLabels: Record<string, string> = {
    best_friend: "最好的朋友",
    close_friend: "亲密的朋友",
    friend: "朋友",
    acquaintance: "认识的人",
    rival: "关系紧张",
    stranger: "不太熟",
  };
  const relSummary = rels
    .filter((r) => r.relationship.type !== "stranger")
    .map((r) => `${r.otherId}: ${relTypeLabels[r.relationship.type] ?? r.relationship.type}`)
    .join(", ");

  const life = card.life;
  const occupation = life?.occupation ?? card.occupation;
  const aspirationHint = life?.aspiration ? `\n你一直想：${life.aspiration}` : "";

  const system = `你是 ${card.name}，${occupation}。
性格：${card.personality.traits.join("、")}${aspirationHint}${personaDeepeningLines(card)}

现在是晚上，你在回顾今天发生的事。请：
1. 总结今天最重要的 2-3 件事（每条一句话）
2. 今天最不顺的一件事是什么？谁让你不舒服了？（必答。真没有才写"没有"，别硬找温馨结论）
3. 说说你现在的心情（一个词或短语）
4. 基于今天的经历，你现在最想做的一件事是什么？（一句话）
5. 有什么让你担心的事吗？（一句话，没有就说"没有"）

用第一人称，保持你的性格和说话风格。写实的日子不是日记美文——
允许委屈、后悔、烦躁、看谁不顺眼；禁止"虽然…但也是温暖的一天"式强行升华。回复格式：
洞察1: ...
洞察2: ...
不顺: ...
心情: ...
愿望: ...
担忧: ...`;

  const planReview = params.todayPlan && params.todayPlan.length > 0
    ? `\n\n## 今天早上你的打算\n${params.todayPlan.map((p) => `- ${p}`).join("\n")}\n（回顾一下：做成了吗？没做成的还想做吗？想做的可以体现在"愿望"里。）`
    : "";
  // B5 执念回顾：今天有进展吗、还压着吗——压着的自然流进"担忧/愿望"
  const obsessionReview = params.obsessions && params.obsessions.length > 0
    ? `\n\n## 这几天一直压在你心里的\n${params.obsessions.map((o) => `- ${o}`).join("\n")}\n（今天这些事有进展吗？还压着的，可以体现在"担忧"或"愿望"里。）`
    : "";
  const user = `## 今天发生的事\n${memorySummary}${planReview}${obsessionReview}\n\n## 我的人际关系\n${relSummary || "暂无特别关系"}`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: user }], temperature: 0.7, maxTokens: 300, kind: "reflection", tag: params.card.id },
      modelId,
    );

    const lines = response.content.split("\n").filter((l) => l.trim());
    const insights: string[] = [];
    let mood = "平静";
    let wish: string | undefined;
    let concern: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("洞察") || trimmed.startsWith("- ")) {
        insights.push(trimmed.replace(/^洞察\d+[:：]\s*/, "").replace(/^-\s*/, ""));
      } else if (trimmed.startsWith("不顺")) {
        const raw = trimmed.replace(/^不顺[:：]\s*/, "");
        if (raw && raw !== "没有" && raw !== "无") insights.push(raw);
      } else if (trimmed.startsWith("心情")) {
        mood = trimmed.replace(/^心情[:：]\s*/, "");
      } else if (trimmed.startsWith("愿望")) {
        const raw = trimmed.replace(/^愿望[:：]\s*/, "");
        if (raw && raw !== "没有" && raw !== "无") wish = raw;
      } else if (trimmed.startsWith("担忧")) {
        const raw = trimmed.replace(/^担忧[:：]\s*/, "");
        if (raw && raw !== "没有" && raw !== "无") concern = raw;
      }
    }

    // 存入记忆（高 importance）。用独立的 reflection 类型：
    // thought 会被 formatForPrompt 过滤（已单独成段），反思必须进主记忆流参与检索重排
    for (const insight of insights) {
      memory.add(card.id, {
        tick: params.dayEndTick,
        type: "reflection",
        content: `[反思] ${insight}`,
        importance: 9,
      });
    }

    // 愿望存入记忆（中等 importance）
    if (wish) {
      memory.add(card.id, {
        tick: params.dayEndTick,
        type: "reflection",
        content: `[愿望] ${wish}`,
        importance: 7,
      });
    }

    return { characterId: card.id, insights, mood, wish, concern };
  } catch (err) {
    console.warn(`[反思] ${card.id} 反思失败:`, (err as Error)?.message ?? err);
    return { characterId: card.id, insights: [], mood: "平静" };
  }
}
