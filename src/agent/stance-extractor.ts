/**
 * Stance Extractor — 对话立场抽取（DESIGN-revival §2 B1，对话结束管线第三兄弟）
 *
 * 交锋之后的账：拆穿/指控/威胁/绝交这类"亮明立场"的时刻此前说完就蒸发——
 * 拆穿零代价退场、grudge 3 天自动清，系统是均值回归设计。现在对话结束时抽取
 * 当面亮出的立场，落进 narrative_state.openStances（+ unresolvedWith + 双方 LTM +
 * 有 witnesses 才进流言 + 疙瘩计分），让"闹翻"从此有账可查。
 *
 * 假阳性防线（§2 B1 全条采纳）：
 * ① 预过滤 AND：摊牌类词 且 近窗负 valence ≤ -2（调用方用 pressureGraph.windowValence 判）
 * ② schema 强制 no_stance 默认项 + evidence 逐字命中转录（代码 substring 校验，不命中即丢）
 *    + 归属校验：evidence 所在句的 speaker 必须是 holder（归错方即丢弃该条）
 * ③ 严重度阶梯：break/threaten 必须有明示原话，否则降档 accuse
 * ④ 每对每天 ≤1 条（调用方按 stanceDayLog 判）
 * ⑤ break/threaten 需双边印象佐证（调用方判）
 *
 * 双向账本：敌对（expose/accuse/threaten/vow/break/side_with）落账；
 * 和解（apologize/reconcile/clarify）命中即清对应 openStance。
 * off 档不启用；坏 JSON 不落账不崩。
 */

import type { LLMProvider } from "../providers/types.js";
import type { ConversationExchange } from "./conversation-mode.js";
import type { OpenStanceKind } from "../narrative/narrative-state.js";

export type ReconcileStanceKind = "apologize" | "reconcile" | "clarify";
export type ExtractedStanceKind = OpenStanceKind | ReconcileStanceKind;

export const RECONCILE_STANCE_KINDS: readonly ReconcileStanceKind[] = ["apologize", "reconcile", "clarify"];

const ALL_KINDS: readonly string[] = [
  "expose", "accuse", "threaten", "vow", "break", "side_with",
  "apologize", "reconcile", "clarify",
];

export function isReconcileKind(kind: ExtractedStanceKind): kind is ReconcileStanceKind {
  return (RECONCILE_STANCE_KINDS as readonly string[]).includes(kind);
}

export interface ExtractedStance {
  kind: ExtractedStanceKind;
  /** 亮立场的一方 */
  holderId: string;
  targetId: string;
  summary: string;
  /** 逐字摘自转录的原话（extractStances 内已做 substring 校验，不命中即丢） */
  evidence: string;
}

/**
 * 摊牌类词预过滤（防线①第一臂）：没有这些词的对话不可能有摊牌，不烧 LLM。
 * 含和解词（对不起/原谅/误会）——和解发生在负 valence 窗口内，同样要过第二臂。
 */
const SHOWDOWN_HINT = /摊牌|说清楚|说个明白|讲清楚|解释清楚|凭什么|你敢|受够了|别装|装傻|撒谎|骗我|骗子|你偷|偷了|承认|老实交代|绝交|一刀两断|断绝|再也别|再也不|走着瞧|你等着|后果|付出代价|说出去|告诉大家|恨你|失望透|没完|算账|对不起|道歉|原谅|误会|和好|是我不对/;

export function mightContainShowdown(history: ConversationExchange[]): boolean {
  if (history.length < 4) return false;
  return history.some((e) => SHOWDOWN_HINT.test(e.message));
}

/**
 * 和解词（预过滤分叉）：该 pair 有 activeOpenStance 且对话含这些词时，
 * 调用方跳过负 valence 门直接进抽取——摊牌次日的道歉对话 valence 窗口是空的，
 * AND 门会把和解通路整个闸死（清账动作只减不增，放行安全）。
 */
export const RECONCILE_HINT = /对不起|道歉|原谅|误会|和好|是我不对|我错了|不怪你|把话说开|说开了|解释清楚|别往心里去/;

export function mightContainReconcile(history: ConversationExchange[]): boolean {
  if (history.length < 4) return false;
  return history.some((e) => RECONCILE_HINT.test(e.message));
}

/** 防线②：evidence 必须逐字命中转录（substring），不命中即丢 */
export function evidenceHits(history: ConversationExchange[], evidence: string): boolean {
  const ev = evidence?.trim();
  if (!ev) return false;
  return history.some((e) => e.message.includes(ev));
}

/**
 * 防线②b 归属校验：evidence 所在句必须真的出自 holder 之口。
 * 只命中"任意一句"会放过归错方的立场（把 B 的台词记成 A 亮的立场），
 * 落账方向一错，unresolvedWith/疙瘩/流言全跟着错。
 */
export function evidenceSpokenBy(history: ConversationExchange[], evidence: string, speakerId: string): boolean {
  const ev = evidence?.trim();
  if (!ev) return false;
  return history.some((e) => e.speakerId === speakerId && e.message.includes(ev));
}

/** break 的明示原话（防线③）：没有这些词的"绝交"是抽取脑补 */
export const BREAK_EXPLICIT = /绝交|一刀两断|断绝|再也别|再也不想|我们完了|别再来找我|不想再见|到此为止|从此/;
/** threaten 的明示原话（防线③） */
export const THREATEN_EXPLICIT = /否则|不然|走着瞧|你等着|让你好看|后果|付出代价|说出去|告诉大家|抖出来|你会后悔/;

/**
 * 严重度阶梯（防线③）：break/threaten 必须有明示原话，evidence 不含即降档 accuse。
 * 其余类型原样通过。
 */
export function applySeverityLadder(kind: OpenStanceKind, evidence: string): OpenStanceKind {
  if (kind === "break" && !BREAK_EXPLICIT.test(evidence)) return "accuse";
  if (kind === "threaten" && !THREATEN_EXPLICIT.test(evidence)) return "accuse";
  return kind;
}

/** 公开性引擎机械判定：整场对话的在场者并集（不含双方） */
export function computeConversationWitnesses(history: ConversationExchange[], a: string, b: string): string[] {
  const out: string[] = [];
  for (const e of history) {
    for (const w of e.witnesses ?? []) {
      if (w === a || w === b) continue;
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}

export function stanceVisibility(witnessCount: number): "private" | "overheard" | "public" {
  if (witnessCount <= 0) return "private";
  if (witnessCount <= 2) return "overheard";
  return "public";
}

/** 剥掉可能的 markdown 代码围栏，取出 JSON 文本 */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

/**
 * 抽取一场对话的立场（LLM 一次小调用）。
 * 返回已通过 kind 白名单 + holder/target 解析 + evidence substring 校验的立场；
 * 坏 JSON / 解析失败 / no_stance → []（不落账不崩）。
 */
export async function extractStances(params: {
  history: ConversationExchange[];
  charAId: string;
  charAName: string;
  charBId: string;
  charBName: string;
  provider: LLMProvider;
  modelId: string;
}): Promise<ExtractedStance[]> {
  const { history, charAId, charAName, charBId, charBName, provider, modelId } = params;

  const dialogue = history
    .map((e) => `${e.speakerName}：「${e.message}」`)
    .join("\n");

  const system = `你是对话立场审计员。判断下面这场对话里，有没有人**当面亮明立场**——摊牌、指控、揭穿、威胁、立誓、绝交、站队，或反向的道歉、和解、澄清。

kind 只能取以下值：
- expose: 当面揭穿对方隐瞒的事
- accuse: 当面指控对方做了某事
- threaten: 威胁对方（说出了具体后果）
- vow: 当面对对方立誓要做某事
- break: 宣告绝交/断绝关系
- side_with: 明确宣布站在第三方一边反对对方
- apologize: 为之前的冲突正式道歉
- reconcile: 双方把疙瘩说开、和解了
- clarify: 澄清误会（此前的指控/怀疑不成立）
- no_stance: 没有上述任何立场

只认**说出口**的立场：暗示、客套、抱怨两句不算。evidence 必须**逐字**摘自对话原文，不许改写/意译/拼接。
最多报 1 条最主要的立场。

严格输出 JSON（不要 markdown 代码块）：
{"stances":[{"kind":"accuse","holder":"${charAName}或${charBName}","target":"另一方","summary":"一句话概括","evidence":"逐字原话"}]}
没有立场时输出：{"stances":[{"kind":"no_stance"}]}`;

  try {
    const response = await provider.chat(
      { system, messages: [{ role: "user", content: dialogue }], temperature: 0.2, maxTokens: 250, kind: "stance-extract" },
      modelId,
    );
    const parsed: unknown = JSON.parse(stripFences(response.content));
    const rawList = (parsed as { stances?: unknown })?.stances;
    if (!Array.isArray(rawList)) return [];

    const out: ExtractedStance[] = [];
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (s.kind === "no_stance") continue;
      if (typeof s.kind !== "string" || !ALL_KINDS.includes(s.kind)) continue;
      if (typeof s.holder !== "string" || typeof s.evidence !== "string") continue;

      // holder/target 名字 → id（精确匹配优先，包含匹配兜底；解析不出即丢）
      const holderName = s.holder.trim();
      let holderId: string | undefined;
      if (holderName === charAName) holderId = charAId;
      else if (holderName === charBName) holderId = charBId;
      else if (holderName.includes(charAName) || charAName.includes(holderName)) holderId = charAId;
      else if (holderName.includes(charBName) || charBName.includes(holderName)) holderId = charBId;
      if (!holderId) continue;
      const targetId = holderId === charAId ? charBId : charAId;

      // 防线②：evidence 逐字命中转录，不命中即丢
      if (!evidenceHits(history, s.evidence)) {
        console.log(`⚖️ [立场抽取] evidence 未逐字命中转录，丢弃: 「${s.evidence.slice(0, 40)}…」`);
        continue;
      }
      // 防线②b：evidence 所在句的 speaker 必须是 holder（归错方即丢——方向错的账比没账更毒）
      if (!evidenceSpokenBy(history, s.evidence, holderId)) {
        console.log(`⚖️ [立场抽取] evidence 不是 holder(${holderName}) 说的，归属错误丢弃: 「${s.evidence.slice(0, 40)}…」`);
        continue;
      }

      out.push({
        kind: s.kind as ExtractedStanceKind,
        holderId,
        targetId,
        summary: typeof s.summary === "string" && s.summary.trim() ? s.summary.trim().slice(0, 80) : s.evidence.trim().slice(0, 80),
        evidence: s.evidence.trim(),
      });
      if (out.length >= 1) break; // 每场对话最多 1 条（防线④的对话内层）
    }
    return out;
  } catch {
    // 坏 JSON / provider 失败：不落账不崩
    return [];
  }
}
