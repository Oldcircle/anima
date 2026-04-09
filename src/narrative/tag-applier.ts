/**
 * Tag Applier — 把工具调用的语义标签翻译成 narrative_state 写入
 *
 * 调用时机：agent-loop 中工具 handler 成功执行之后。
 * 设计原则：标签全部可选，缺失/无效标签不抛错（向后兼容现有 prompt）。
 */

import type { World } from "../world/world.js";

export interface NarrativeToolTags {
  topic_tags?: string[];
  intent?: string;
  reveals?: string[];          // 揭示的秘密 id
  references_event?: string;   // 引用的 unresolved_event id
}

export function extractTagsFromArgs(args: Record<string, unknown>): NarrativeToolTags {
  const out: NarrativeToolTags = {};
  if (Array.isArray(args.topic_tags)) {
    out.topic_tags = (args.topic_tags as unknown[]).filter((s) => typeof s === "string") as string[];
  }
  if (typeof args.intent === "string") out.intent = args.intent;
  if (Array.isArray(args.reveals)) {
    out.reveals = (args.reveals as unknown[]).filter((s) => typeof s === "string") as string[];
  }
  if (typeof args.references_event === "string") out.references_event = args.references_event;
  return out;
}

export function hasAnyTags(tags: NarrativeToolTags): boolean {
  return Boolean(
    (tags.topic_tags && tags.topic_tags.length > 0) ||
      tags.intent ||
      (tags.reveals && tags.reveals.length > 0) ||
      tags.references_event,
  );
}

/**
 * 把工具调用的标签应用到 narrative_state。
 *
 * 当前实现的语义：
 * - reveals：每个 secret id 加入 actor 的 disclosedSecrets，加入 target 的 knownFacts
 *   ("disclosed" 是行为；listener 把它存为 "fact" 类的已知事实)
 * - references_event：在 actor 与 target 之间记一条 unresolvedWith（标记"这事还没说完"）
 * - topic_tags / intent：当前不直接落字段，仅记录到事件流（N3 时供 director 读）
 *
 * 返回值用于日志打印 / 测试断言。
 */
export interface AppliedTagsLog {
  disclosedSecrets: string[];
  knownFactsAdded: string[];
  unresolvedWithAdded: string[];
  tags: NarrativeToolTags;
}

export function applyNarrativeTags(
  world: World,
  actorId: string,
  targetId: string | undefined,
  tags: NarrativeToolTags,
): AppliedTagsLog {
  const log: AppliedTagsLog = {
    disclosedSecrets: [],
    knownFactsAdded: [],
    unresolvedWithAdded: [],
    tags,
  };

  if (!hasAnyTags(tags)) return log;

  const ns = world.narrative;

  if (tags.reveals && tags.reveals.length > 0) {
    for (const secretId of tags.reveals) {
      if (ns.addDisclosedSecret(actorId, secretId)) {
        log.disclosedSecrets.push(secretId);
      }
      if (targetId) {
        const factId = `${actorId}_${secretId}`;
        if (ns.addKnownFact(targetId, factId)) {
          log.knownFactsAdded.push(factId);
        }
      }
    }
  }

  if (tags.references_event && targetId) {
    ns.addUnresolvedWith(actorId, targetId, tags.references_event);
    log.unresolvedWithAdded.push(tags.references_event);
  }

  return log;
}
