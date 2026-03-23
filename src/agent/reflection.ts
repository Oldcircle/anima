/**
 * Reflection — 每日反思机制
 *
 * 一天结束时（23:00），每个角色回顾当天经历，生成高层洞察。
 * 洞察存入长期记忆（当前用 ShortTermMemory，importance 高）。
 */

import type { CharacterCard } from "../character/types.js";
import type { LLMProvider, LLMRequest } from "../providers/types.js";
import type { ShortTermMemory, MemoryEntry } from "../memory/short-term.js";
import type { RelationshipManager } from "../world/relationships.js";

export interface ReflectionResult {
  characterId: string;
  insights: string[];
  mood: string;
}

export async function runReflection(params: {
  card: CharacterCard;
  memory: ShortTermMemory;
  relationships: RelationshipManager;
  provider: LLMProvider;
  modelId: string;
  dayStartTick: number;
  dayEndTick: number;
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
  const relSummary = rels
    .map((r) => `${r.otherId}: ${r.relationship.type} (亲密度:${r.relationship.level})`)
    .join(", ");

  const system = `你是 ${card.name}，${card.occupation}。
性格：${card.personality.traits.join("、")}

现在是晚上，你在回顾今天发生的事。请：
1. 总结今天最重要的 2-3 件事（每条一句话）
2. 说说你现在的心情（一个词或短语）
3. 如果有什么想法或计划，也说一下

用第一人称，保持你的性格和说话风格。回复格式：
洞察1: ...
洞察2: ...
洞察3: ...
心情: ...`;

  const user = `## 今天发生的事\n${memorySummary}\n\n## 我的人际关系\n${relSummary || "暂无特别关系"}`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: user }], temperature: 0.7, maxTokens: 300 },
      modelId,
    );

    const lines = response.content.split("\n").filter((l) => l.trim());
    const insights: string[] = [];
    let mood = "平静";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("洞察") || trimmed.startsWith("- ")) {
        insights.push(trimmed.replace(/^洞察\d+[:：]\s*/, "").replace(/^-\s*/, ""));
      } else if (trimmed.startsWith("心情")) {
        mood = trimmed.replace(/^心情[:：]\s*/, "");
      }
    }

    // 存入记忆（高 importance）
    for (const insight of insights) {
      memory.add(card.id, {
        tick: params.dayEndTick,
        type: "thought",
        content: `[反思] ${insight}`,
        importance: 9,
      });
    }

    return { characterId: card.id, insights, mood };
  } catch {
    return { characterId: card.id, insights: [], mood: "平静" };
  }
}
