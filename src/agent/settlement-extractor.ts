/**
 * Settlement Extractor — 对话结算（对话结束管线第五兄弟）
 *
 * 诊断（2026-08-21）：**每一场戏都是平局。**
 * r1 日志里 L 追夜神月还书追了两个游戏小时、十个来回，收场是「嗯。那您忙您的。」——
 * 书没还、罚款没交、关系没碎、谁都没输，五个小时后从头再来一遍。
 * 这不是个例是通例：对话是**超时过期**的，不是被某个结果终结的。
 * 管线上已有的四个兄弟分别抽承诺/交易/立场/正典，**没有一个负责判胜负**。
 *
 * 动漫一场戏的公式是：有人要一个东西 → 有人挡着 → 试一次 →
 * 得手但付代价 / 被拒且处境更糟 → **下一场戏的起点变了**。
 * 平局是所有结果里最不好看的一种，也是一切下行通路的天敌：
 * 只要"再谈一次"永远可用，绝境阶梯就永远走不到第二级
 * （cast-culprit r1「steal 端上桌 28 次零采纳」的另一半解释）。
 *
 * 这里问的是一个**有明确指称**的窄问题，不是开放式的"谁赢了"：
 * 引擎本来就知道每一方进这场对话时心里压着什么（conversation-desire 的可寻址所求），
 * 结算器只判「这桩事，他开口了吗？着落了吗？」——指称已知 = 假阳性面小得多。
 *
 * 假阳性防线（照 B1 立场落账同等规格）：
 * ① 预过滤 AND：≥4 句 且 至少一方有登记在案的所求（没所求不烧 LLM）
 * ② 结果白名单 + 默认项「未果」+ evidence 逐字命中转录
 * ③ **归属反向校验**：得手/被拒/反将的原话必须是**对方**说的——
 *    答应你、回绝你、将你一军的都是对方；把自己的话当证据是抽取脑补
 * ④ 每对每天 ≤1 次结算（调用方按 settlementDayLog 判）
 * ⑤ 严重度阶梯：「反将」必须有明示反将原话，否则降档「被拒」
 *
 * 红线③（只造处境不写结果）不受影响：结算是**事后**判定已经发生的事，
 * 与 B1 立场落账同性质；它绝不告诉角色该怎么做。
 * off 档不启用；坏输出不落账不崩。
 */

import type { LLMProvider } from "../providers/types.js";
import type { ConversationExchange } from "./conversation-mode.js";
import { evidenceHits, evidenceSpokenBy } from "./stance-extractor.js";

/** 结算层总闸：`ANIMA_SETTLEMENT=0` 整层退场（逐字节 A/B 基线）。每次现读 env */
export function settlementEnabled(): boolean {
  return process.env.ANIMA_SETTLEMENT !== "0";
}

/** 一方所求的四种着落 */
export type SettlementOutcome = "得手" | "被拒" | "反将" | "拖延" | "未果";

const OUTCOMES: readonly string[] = ["得手", "被拒", "反将", "拖延", "未果"];

export interface ExtractedSettlement {
  /** 开口所求的那一方 */
  holderId: string;
  /** 另一方（答应/回绝/反将的人） */
  targetId: string;
  outcome: Exclude<SettlementOutcome, "未果">;
  /** 逐字摘自转录的原话——必须出自 targetId 之口（防线③） */
  evidence: string;
}

/** 结算器要判的一方（调用方从所求账本取） */
export interface SettlementSubject {
  charId: string;
  charName: string;
  /** 这场对话之前他心里想要的（AddressableDesire.want） */
  want: string;
  kind: string;
}

/**
 * 「反将」的明示原话（防线⑤）：不但没给，还回头将了一军。
 * 没有这些词的"反将"是抽取在加戏，降档为普通被拒。
 */
export const COUNTER_EXPLICIT =
  /反倒|倒是你|你自己|凭什么|有什么资格|轮不到你|轮得到你|少来|你也好不到|说得好像|先管好|管好你|你先/;

/**
 * 「得手」的明示应允原话（防线⑤b）。
 *
 * 得手是**唯一会删除持久状态**的结果（清拒绝账本 + 清执念 + 加关系），
 * 误判一次就把攒了几天的手段档位一笔勾销——它的判据必须比被拒**更严**，
 * 而不是像初版那样原样通过（对抗审查实证：单字「嗯」甚至一个逗号都能结算成功）。
 */
const CONSENT_TOKENS =
  /好吧|好的|行吧|答应|拿去|拿着吧|成交|依你|听你的|就这么办|没问题|算我的|我认栽|我服了|包在我身上|我照办|这就去|给你吧|收好|我还你|明天给你|去就是了/g;

/**
 * 否定感知：`不能答应你` / `我给不了` / `钱我不还你了` 里全都含着应允词的子串。
 * **纯子串词表判不出极性**——实测 14/14 条回绝句命中旧词表，
 * 连项目自带 fixture 里最硬的那句反将都能 certify 得手（对抗审查确认的 blocker）。
 * 这里对每个命中点检查前后小窗里有没有否定词，两侧都要看
 * （前：`不能答应`；后：`我给|不了`）。
 */
const NEGATION = /[不没别莫甭]|无法|难以|休想|不了|不成/;

/** 取一段文本里最后一个标点之后的部分（前窗用） */
function lastClause(t: string): string {
  const i = t.search(/[，。！？、；：,.!?;:]/g);
  return i < 0 ? t : t.slice(t.lastIndexOf(t.match(/[，。！？、；：,.!?;:]/g)!.pop()!) + 1);
}
/** 取一段文本里第一个标点之前的部分（后窗用） */
function firstClause(t: string): string {
  const m = t.match(/^[^，。！？、；：,.!?;:]*/);
  return m?.[0] ?? t;
}

export function hasExplicitConsent(evidence: string): boolean {
  CONSENT_TOKENS.lastIndex = 0;
  for (let m = CONSENT_TOKENS.exec(evidence); m; m = CONSENT_TOKENS.exec(evidence)) {
    // 否定窗口**不跨标点**：「拿着吧，别再提了」里的"别"属于下一个小句，不是在否定"拿着吧"
    const before = lastClause(evidence.slice(Math.max(0, m.index - 4), m.index));
    const after = firstClause(evidence.slice(m.index + m[0].length, m.index + m[0].length + 4));
    if (!NEGATION.test(before) && !NEGATION.test(after)) return true;
  }
  return false;
}

/** 保留导出供单测/诊断读（不要拿它直接判极性——用 hasExplicitConsent） */
export const CONSENT_EXPLICIT = CONSENT_TOKENS;

/**
 * 「拖延」的明示原话（防线⑤c）：答应了，但推到以后。
 * 这是结算的第四格——live 实证它才是真实冲突里最常见的那一格
 * （明日香追债十二个来回，真嗣自始至终既没给也没拒，他拖）。
 * 判它比判得手宽（不需要真的应允），但必须有**推后**的字面。
 */
export const DEFER_EXPLICIT =
  /等[到会一下打收明今，。]|等着|回头|以后|过两天|过几天|明天|改天|下次|下回|待会|一会儿?再|晚点|稍后|打烊|收工|下班|忙完|再说|宽限|给你个准数|容我|过后/;

/**
 * **当场**给出的字面（防线⑤c 的反向闸）。带这些字的应允压过 DEFER_EXPLICIT——
 * 「拿去，回头别再问我」是给了，不是拖。
 * 审查实测：不加这道闸，真实语料里约 20% 的当场应允被误降成拖延。
 */
export const IMMEDIATE_EXPLICIT = /这就|马上|现在就|拿去|收好|在这儿|在这里|你拿着|先拿着|喏/;

/** evidence 最小长度：短于此的"原话"（嗯、好、一个逗号）不足以支撑任何结算 */
export const MIN_EVIDENCE_CHARS = 4;

/**
 * 严重度阶梯（防线⑤）：
 * - 反将必须有明示反将原话，否则降档被拒
 * - **得手**必须有明示应允原话，否则降档「未果」（不是降档被拒——
 *   模型判了得手却拿不出应允原话，说明它读到的是"没明确表态"，那就是平局）；
 *   若原话里带着"推后"的字面（等打烊/回头/明天），那不是给了，是**拖延**
 * - **拖延**必须有明示推后原话
 * 返回 undefined = 判不出，丢弃。
 */
export function applyOutcomeLadder(
  outcome: Exclude<SettlementOutcome, "未果">,
  evidence: string,
): Exclude<SettlementOutcome, "未果"> | undefined {
  if (evidence.trim().length < MIN_EVIDENCE_CHARS) return undefined;
  if (outcome === "得手") {
    // 当场给的字面压过推后的字面（「拿去，回头别再问我」是给了）
    if (IMMEDIATE_EXPLICIT.test(evidence)) return hasExplicitConsent(evidence) ? "得手" : undefined;
    // 得手的原话里带着"推后"的字面 → 那不是给了，是答应了以后给：降档拖延
    if (DEFER_EXPLICIT.test(evidence)) return "拖延";
    return hasExplicitConsent(evidence) ? "得手" : undefined;
  }
  if (outcome === "拖延") return DEFER_EXPLICIT.test(evidence) ? "拖延" : undefined;
  if (outcome === "反将" && !COUNTER_EXPLICIT.test(evidence)) return "被拒";
  return outcome;
}

/**
 * 预过滤（防线①）：≥4 句 且 至少一方有所求。
 * 没所求的对话是寒暄底噪，本来就没有胜负可判——不烧 LLM。
 */
export function mightContainSettlement(
  history: ConversationExchange[],
  subjects: SettlementSubject[],
): boolean {
  if (history.length < 4) return false;
  return subjects.length > 0;
}

/**
 * 预过滤没过时的归因（诊断，不改行为）。
 * 项目纪律：跳过路径也要能归因——否则 live 里落账 0 时分不清是
 * "对话都太短"还是"根本没人带着所求进场"，只能重跑一趟才知道。
 */
export function settlementSkipReason(
  history: ConversationExchange[],
  subjects: SettlementSubject[],
): string | undefined {
  if (history.length < 4) return `对话只有 ${history.length} 句（<4）`;
  if (subjects.length === 0) return "双方都没有登记在案的所求";
  return undefined;
}

/** 剥掉可能的 markdown 代码围栏 */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

/**
 * 解析键值行块（不用 JSON：r3 实测模型偶发吐非法 JSON——中文值没加引号）。
 * 形如：
 *   角色: 明日香
 *   结果: 被拒
 *   原话: 这盘算我的，你坐下吃就完了
 */
function parseBlocks(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const rawLine of stripFences(text).split("\n")) {
    // 键行允许被 markdown 加粗包住（**结果**: 被拒），否则整份输出解析成 0 块
    const line = rawLine.trim().replace(/^\*\*\s*/, "").replace(/\s*\*\*\s*(?=[:：])/, "");
    if (!line || /^-{2,}$/.test(line)) {
      if (Object.keys(cur).length > 0) out.push(cur);
      cur = {};
      continue;
    }
    const m = line.match(/^(角色|结果|原话)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    // **任何**键重复出现都视为块边界（不只是"角色"）。
    // 模型漏写分隔线或漏写"角色"行时，后写的「结果」会覆盖前一块——
    // 于是「被拒」被翻成「得手」而 evidence 还是对方的回绝原话，防线③照样放行
    // （对抗审查实证的 blocker）。宁可多切一块（缺"角色"的块在下游被丢），也不许覆盖。
    if (cur[key] !== undefined) {
      out.push(cur);
      cur = {};
    }
    cur[key] = cleanEvidence(m[2]!);
  }
  if (Object.keys(cur).length > 0) out.push(cur);
  return out;
}

/**
 * 清洗抽取出的字段值。
 * 转录喂给模型时渲染成 `名字：「台词」`，模型"逐字摘抄"最自然的行为就是连发言人前缀
 * 一起抄回来——不剥的话 evidenceHits 必不命中，整条被静默丢弃（live 零落账的隐形杀手）。
 */
export function cleanEvidence(raw: string): string {
  let v = raw.trim();
  v = v.replace(/^\*+|\*+$/g, "").trim();          // markdown 加粗
  // 发言人前缀**只认转录那一种渲染形态**：`名字：「台词」`（必须带 「，收尾的 」 可缺）。
  // 放宽成"冒号前 12 字内都算名字"会误剥自带冒号的台词
  // （「我就说一句话：这钱我不还了」被砍成半句），存进记忆/编年史的引文就残了。
  const withSpeaker = v.match(/^[^：:「」"']{1,12}[：:]\s*「([\s\S]+?)」?$/);
  if (withSpeaker?.[1]) return withSpeaker[1].trim();
  v = v.replace(/^[「"']+/, "").replace(/[」"']+$/, "").trim();
  return v;
}

/**
 * 抽取一场对话的结算（LLM 一次小调用）。
 * 返回已通过结果白名单 + 归属反向校验 + evidence 逐字校验的条目；
 * 坏输出 / 解析失败 / 全「未果」→ []（不落账不崩）。
 */
export async function extractSettlements(params: {
  history: ConversationExchange[];
  subjects: SettlementSubject[];
  charAId: string;
  charAName: string;
  charBId: string;
  charBName: string;
  provider: LLMProvider;
  modelId: string;
}): Promise<ExtractedSettlement[]> {
  const { history, subjects, charAId, charAName, charBId, charBName, provider, modelId } = params;
  if (subjects.length === 0) return [];

  const dialogue = history.map((e) => `${e.speakerName}：「${e.message}」`).join("\n");
  const wants = subjects.map((s) => `- ${s.charName} 想要的是：${s.want}`).join("\n");

  const system = `你是对话结算员。下面这场对话里，有人心里带着所求进来。判断这桩事**有没有着落**。

这场对话里各自的所求：
${wants}

对每一个有所求的人，判定一个结果：
- 得手：他开口了，对方**当场**给了/答应了/让步了
- 拖延：他开口了，对方**答应了但推到以后**（"等打烊"/"回头"/"明天"/"给你个准数"）——
  注意这一格：既没给也没拒绝，是最常见的收场
- 被拒：他开口了，对方明确不给、推掉、拒绝
- 反将：他开口了，对方不但没给，还回头把他将了一军（倒打一耙、揭他的短、反问他凭什么）
- 未果：他压根没开口，或者说了但对方连推后都没说，纯粹岔开了话题

判定纪律：
- **只认说出口的**。心里想着没开口 = 未果；对方含糊过去、转移话题而没有明确回绝 = 未果。
- 拿不准就填未果。宁可漏判，不要凑一个结果。
- 「原话」必须是**对方**说的那一句（答应你、回绝你、将你一军的都是对方），必须**逐字**摘自上面的对话原文，不许改写、意译、拼接。结果为未果时「原话」留空。
- ⚠️ 最常见的错：引了所求方**自己**复述、接受或宣布结果的话（"行，就按你说的""咱们两清"）——那是他的嘴，不是对方的承诺。先往对话**前面**找到对方亲口说的那句；对方从头到尾没亲口说过，就按未果。

按下面的格式输出，每人一块，块之间用一行 --- 分隔。不要写别的：
角色: <名字>
结果: 得手/拖延/被拒/反将/未果
原话: <逐字原话，未果则留空>`;

  try {
    const response = await provider.chat(
      {
        system,
        messages: [{ role: "user", content: dialogue }],
        temperature: 0.2,
        maxTokens: 260,
        kind: "settlement-extract",
      },
      modelId,
    );

    const blocks = parseBlocks(response.content);
    if (blocks.length === 0) {
      console.log(`🧾 [结算] 输出不可解析（${charAName}↔${charBName}）`);
      return [];
    }

    const out: ExtractedSettlement[] = [];
    const seen = new Set<string>();
    for (const b of blocks) {
      const outcome = b["结果"];
      if (!outcome || !OUTCOMES.includes(outcome)) continue;
      if (outcome === "未果") {
        console.log(`🧾 [结算] ${b["角色"] ?? "?"} 判定未果（平局）`);
        continue;
      }

      // 名字 → id（精确优先、包含兜底；解析不出即丢）
      const who = (b["角色"] ?? "").trim();
      let holderId: string | undefined;
      if (who === charAName) holderId = charAId;
      else if (who === charBName) holderId = charBId;
      else if (who && (who.includes(charAName) || charAName.includes(who))) holderId = charAId;
      else if (who && (who.includes(charBName) || charBName.includes(who))) holderId = charBId;
      if (!holderId) continue;
      // 只结算真有所求登记的人（模型不许替没所求的一方也判一个结果）
      const subject = subjects.find((s) => s.charId === holderId);
      if (!subject) {
        console.log(`🧾 [结算] ${who} 没有登记在案的所求，丢弃`);
        continue;
      }
      if (seen.has(holderId)) continue;
      const targetId = holderId === charAId ? charBId : charAId;

      const evidence = cleanEvidence(b["原话"] ?? "");
      // 防线②：evidence 逐字命中转录
      if (!evidenceHits(history, evidence)) {
        console.log(`🧾 [结算] evidence 未逐字命中转录，丢弃：「${evidence.slice(0, 40)}…」`);
        continue;
      }
      // 防线③：归属**反向**校验——答应/回绝/反将的必须是对方
      if (!evidenceSpokenBy(history, evidence, targetId)) {
        console.log(
          `🧾 [结算] evidence 不是对方(${targetId})说的，归属错误丢弃：「${evidence.slice(0, 40)}…」`,
        );
        continue;
      }

      const laddered = applyOutcomeLadder(outcome as Exclude<SettlementOutcome, "未果">, evidence);
      if (!laddered) {
        console.log(`🧾 [结算] ${outcome} 拿不出够格的原话（严重度阶梯），退回未果：「${evidence.slice(0, 40)}」`);
        continue;
      }
      seen.add(holderId);
      out.push({ holderId, targetId, outcome: laddered, evidence });
      if (out.length >= 2) break; // 一场对话最多两方各一条
    }
    return out;
  } catch (err) {
    // 坏输出 / provider 失败：不落账不崩（诊断日志——live 零落账要可归因）
    console.log(
      `🧾 [结算] 输出不可解析或调用失败（${charAName}↔${charBName}）：${
        (err as Error)?.message?.slice(0, 60) ?? "unknown"
      }`,
    );
    return [];
  }
}
