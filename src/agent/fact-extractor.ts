/**
 * Fact Extractor — 对话世界断言抽取（PLAN-grounding M2，对话结束管线第四兄弟）
 *
 * halfday r1 实锤：器物真了，翻开后的**内容细节**仍是编的（L 的"借书十七笔归还十五笔"）。
 * 懒实体化正典裁决把编造收编成世界状态：对话结束时抽取对已知器物说出的具体断言，三规裁决——
 *
 * ① 无主细节首述即正典：器物本身的中性可感细节 → 挂 canonFacts(source=canonized)，
 *    从此 examine 查得到、后续叙事必须认账（TTRPG 主持人：细节长在剧情注意力所到之处）
 * ② 隐藏真相世界裁决：涉及"谁做过什么/东西在谁手上"的宣称 → v1 史料推导只做**持有**
 *    （断言的人+物品都解析得出 → 查背包：真=verified / 伪=false 与世界不符）；
 *    推不出=rumor（真死胡同）。断言者说了不算——世界是裁判
 * ③ 既成正典不可嘴改：与已知正典矛盾的说法 → contradict 挂账，正典一个字不动
 *
 * 假阳性防线（对齐 stance-extractor 纪律）：
 * - 预过滤：对话 ≥4 句 且 词面命中某件已知器物的名字/关键词，才烧 LLM（每对话 ≤1 调用）
 * - evidence 逐字命中转录 + 归属校验（复用 stance 的两道闸）
 * - **人名升档**：detail 断言里出现任何 cast 人名 → 机械强制升 hidden（防"顺嘴给自己
 *   编有利细节"钻首述即正典的空子——关于人的细节不是器物细节）
 * - contradict 必须给出有效正典行号，给不出降档 hidden
 * - detail 与既有正典去重（substring 双向），重复不落
 * - 坏 JSON / 解析失败 → []（不落账不崩）
 *
 * off：groundingEnabled()=false 时调用方不接线（器物层整层退场）。
 */

import type { LLMProvider } from "../providers/types.js";
import type { ConversationExchange } from "./conversation-mode.js";
import type { WorldObjectStore, WorldObjectState, WorldClaim } from "../world/world-objects.js";
import { evidenceHits, evidenceSpokenBy } from "./stance-extractor.js";
import { resolveItem, hasItem } from "../world/item-registry.js";

export type FactKind = "detail" | "hidden" | "contradict";

export interface ExtractedFact {
  kind: FactKind;
  speakerId: string;
  objectKey: string;
  claim: string;
  evidence: string;
  /** hidden：断言涉及的角色 id（人名解析成功才有） */
  aboutCharacterId?: string;
  /** hidden：断言涉及的物品词（史料推导的持有检查用） */
  aboutItem?: string;
  /** contradict：顶撞的正典行（抽取时已校验有效） */
  contradictText?: string;
}

/** 每场对话最多抽取的断言数 */
export const MAX_FACTS_PER_CONVERSATION = 2;

/**
 * 预过滤（防线①）：转录词面命中哪些已知器物（全镇范围——跨地点断言也要认，
 * "船屋的锁一拽就开"可能在广场说出口）。名字撞车时优先对话所在地点的那件。
 * 返回 ≤3 件供抽取 prompt 使用；空 = 不烧 LLM。
 */
export function mentionedObjects(
  history: ConversationExchange[],
  store: WorldObjectStore,
  conversationLocationId?: string,
  allLocationIds?: string[],
): WorldObjectState[] {
  if (history.length < 4) return [];
  const text = history.map((e) => e.message).join("\n");
  const hits: WorldObjectState[] = [];
  const seenNames = new Set<string>();
  const locations = allLocationIds ?? [];
  // 对话所在地点的器物排最前（名字撞车时先到先得）
  const ordered = [
    ...(conversationLocationId ? store.getAtLocation(conversationLocationId) : []),
    ...locations.filter((l) => l !== conversationLocationId).flatMap((l) => store.getAtLocation(l)),
  ];
  for (const obj of ordered) {
    if (hits.length >= 3) break;
    if (seenNames.has(obj.name)) continue;
    const needles = [obj.name, ...obj.keywords].filter((n) => n.length >= 2);
    if (needles.some((n) => text.includes(n))) {
      hits.push(obj);
      seenNames.add(obj.name);
    }
  }
  return hits;
}

/** 剥掉可能的 markdown 代码围栏，取出 JSON 文本 */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

/**
 * 抽取一场对话里对已知器物的世界断言（LLM 一次小调用 + 机械防线）。
 */
export async function extractFacts(params: {
  history: ConversationExchange[];
  /** 预过滤命中的器物（≤3，含正典供矛盾判定） */
  objects: WorldObjectState[];
  /** 对话双方 id→名字 */
  speakers: Array<{ id: string; name: string }>;
  /** 全 cast 名字→id（人名升档防线 + about_character 解析） */
  castNames: Map<string, string>;
  provider: LLMProvider;
  modelId: string;
}): Promise<ExtractedFact[]> {
  const { history, objects, speakers, castNames, provider, modelId } = params;
  if (objects.length === 0) return [];

  const dialogue = history.map((e) => `${e.speakerName}：「${e.message}」`).join("\n");

  // 已知器物与正典（行号供 contradict 引用）
  const objectLines: string[] = [];
  const canonIndex: Array<{ objectKey: string; text: string }> = [];
  for (const obj of objects) {
    const facts = obj.canonFacts.map((f) => {
      canonIndex.push({ objectKey: obj.key, text: f.text });
      return `  [${canonIndex.length - 1}] ${f.text}`;
    });
    objectLines.push(`- ${obj.name}${obj.summary ? `：${obj.summary}` : ""}${facts.length > 0 ? `\n${facts.join("\n")}` : ""}`);
  }

  const system = `你是对话事实审计员。判断下面这场对话里，有没有人对**已知器物**说出了具体的世界断言。

已知器物与已确证的事实：
${objectLines.join("\n")}

断言只分三类：
- detail: 关于器物本身、说话人当场可观察的中性细节（"阅览桌下有刻字"）。不涉及任何人、与说话人利害无关
- hidden: 关于器物但涉及"谁做过什么/里面记着什么内容/东西在谁手上"的宣称——说话人未必能知道真假
- contradict: 与上面某条已确证事实**直接矛盾**的说法（必须填矛盾事实的编号 contradict_index）
- no_claim: 没有上述断言

不算断言：情绪评价（"这机器真吵"）、比喻、玩笑、疑问句、对未来的猜测。
evidence 必须**逐字**摘自对话原文，不许改写。claim 用一句话陈述式概括断言内容。
hidden 类若断言涉及具体的人和具体物品，填 about_character（人名）与 about_item（物品名），否则留空。
最多报 ${MAX_FACTS_PER_CONVERSATION} 条最主要的。

严格输出 JSON（不要 markdown 代码块）：
{"claims":[{"kind":"detail","object":"器物名","speaker":"说话人名","claim":"一句话断言","evidence":"逐字原话","about_character":"","about_item":"","contradict_index":-1}]}
没有断言时输出：{"claims":[{"kind":"no_claim"}]}`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: dialogue }], temperature: 0.2, maxTokens: 400, kind: "fact-extract" },
      modelId,
    );
    const parsed: unknown = JSON.parse(stripFences(response.content));
    const rawList = (parsed as { claims?: unknown })?.claims;
    if (!Array.isArray(rawList)) return [];

    const out: ExtractedFact[] = [];
    for (const raw of rawList) {
      if (out.length >= MAX_FACTS_PER_CONVERSATION) break;
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      if (c.kind === "no_claim") {
        console.log(`📜 [正典] LLM 判定无断言`);
        continue;
      }
      if (c.kind !== "detail" && c.kind !== "hidden" && c.kind !== "contradict") continue;
      if (typeof c.object !== "string" || typeof c.speaker !== "string") continue;
      if (typeof c.claim !== "string" || !c.claim.trim()) continue;
      if (typeof c.evidence !== "string") continue;

      // 器物解析：只认预过滤给出的清单（名字全等或包含）
      const objName = c.object.trim();
      const obj =
        objects.find((o) => o.name === objName) ??
        objects.find((o) => o.name.includes(objName) || objName.includes(o.name));
      if (!obj) continue;

      // 说话人解析
      const spName = c.speaker.trim();
      const speaker =
        speakers.find((s) => s.name === spName) ??
        speakers.find((s) => s.name.includes(spName) || spName.includes(s.name));
      if (!speaker) continue;

      // 防线：evidence 逐字命中 + 归属校验（复用 stance 两道闸）
      if (!evidenceHits(history, c.evidence)) {
        console.log(`📜 [正典] evidence 未逐字命中转录，丢弃:「${c.evidence.slice(0, 40)}…」`);
        continue;
      }
      if (!evidenceSpokenBy(history, c.evidence, speaker.id)) {
        console.log(`📜 [正典] evidence 不是 ${spName} 说的，归属错误丢弃`);
        continue;
      }

      let kind = c.kind as FactKind;
      const claim = c.claim.trim().slice(0, 100);

      // 人名升档防线：detail 断言里出现任何 cast 人名 → 强制 hidden
      // （关于人的细节不是器物细节；防说话人给自己编有利"事实"钻首述即正典）
      if (kind === "detail") {
        for (const name of castNames.keys()) {
          if (name.length >= 2 && claim.includes(name)) {
            kind = "hidden";
            break;
          }
        }
      }

      // contradict 行号校验：无效行号降档 hidden（不许空口"这跟事实矛盾"）
      let contradictText: string | undefined;
      if (kind === "contradict") {
        const idx = typeof c.contradict_index === "number" ? c.contradict_index : -1;
        const entry = canonIndex[idx];
        if (entry && entry.objectKey === obj.key) {
          contradictText = entry.text;
        } else {
          kind = "hidden";
        }
      }

      // hidden 的 about 字段解析（史料推导的输入）
      let aboutCharacterId: string | undefined;
      let aboutItem: string | undefined;
      if (kind === "hidden") {
        const acName = typeof c.about_character === "string" ? c.about_character.trim() : "";
        if (acName) {
          for (const [name, id] of castNames) {
            if (name === acName || name.includes(acName) || acName.includes(name)) {
              aboutCharacterId = id;
              break;
            }
          }
        }
        const ai = typeof c.about_item === "string" ? c.about_item.trim() : "";
        if (ai) aboutItem = ai;
      }

      out.push({ kind, speakerId: speaker.id, objectKey: obj.key, claim, evidence: c.evidence.trim(), aboutCharacterId, aboutItem, contradictText });
    }
    return out;
  } catch (err) {
    console.log(`📜 [正典] 输出不可解析或调用失败：${(err as Error)?.message?.slice(0, 60) ?? "unknown"}`);
    return [];
  }
}

/** 史料推导的依赖（结构性满足即可，不反向依赖 World 类） */
export interface FactSettleDeps {
  store: WorldObjectStore;
  getCharacter: (id: string) => { inventory: import("../world/item-types.js").ItemInstance[]; name: string } | undefined;
  tick: number;
  witnesses?: string[];
}

/**
 * 三规裁决落账。返回落账的 claims（测试与日志用）。
 * - detail → addCanonFact(canonized)（与既有正典 substring 双向去重）
 * - hidden → 持有推导（人+物都解析得出才判 verified/false），推不出 rumor
 * - contradict → 挂账不动正典
 */
export function settleExtractedFacts(deps: FactSettleDeps, facts: ExtractedFact[]): WorldClaim[] {
  const { store, tick } = deps;
  const settled: WorldClaim[] = [];
  for (const f of facts) {
    const obj = store.get(f.objectKey);
    if (!obj) continue;
    // id 编入断言文本：同 tick 同人同器物的不同断言不撞车；同文才被 addClaim 去重
    const id = `claim_${tick}_${f.speakerId}_${f.objectKey}_${f.claim}`;
    let verdict: WorldClaim["verdict"];

    if (f.kind === "detail") {
      // 与既有正典去重：已是正典的复述不重复落
      const dup = obj.canonFacts.some((cf) => cf.text.includes(f.claim) || f.claim.includes(cf.text));
      if (dup) continue;
      const added = store.addCanonFact(f.objectKey, f.claim, tick, "canonized");
      if (!added) continue;
      verdict = "canonized";
      console.log(`📜 [正典] 首述即正典：${obj.name} ←「${f.claim}」（${f.speakerId}）`);
    } else if (f.kind === "contradict") {
      verdict = "contradict";
      console.log(`📜 [正典] 顶撞正典挂账：${f.speakerId} 称「${f.claim}」× 既成「${f.contradictText}」——正典不动`);
    } else {
      // hidden：v1 史料推导只做持有（人+物都解析得出才可判）
      const holder = f.aboutCharacterId ? deps.getCharacter(f.aboutCharacterId) : undefined;
      const itemDef = f.aboutItem ? resolveItem(f.aboutItem) : undefined;
      if (holder && itemDef) {
        const holds = hasItem(holder.inventory, itemDef.id);
        verdict = holds ? "verified" : "false";
        console.log(
          `📜 [正典] 持有推导：「${f.claim}」→ 查${holder.name}的随身物品 → ${holds ? "属实(verified)" : "与世界不符(false)"}`,
        );
      } else {
        verdict = "rumor";
        console.log(`📜 [正典] 推不出（传闻挂账）：「${f.claim}」（${f.speakerId}）`);
      }
    }

    const claim: WorldClaim = {
      id, tick, speakerId: f.speakerId, objectKey: f.objectKey,
      claim: f.claim, verdict,
      witnesses: deps.witnesses && deps.witnesses.length > 0 ? deps.witnesses : undefined,
    };
    if (store.addClaim(claim)) settled.push(claim);
  }
  return settled;
}
