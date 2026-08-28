/**
 * 声部（voice）—— 用**减法**给角色的嘴设限
 *
 * 诊断（2026-08-21）：小镇里每个人都在说同一种话——克制、机锋、有留白、爱用比喻。
 * 连怯懦的碇真嗣道歉都是工整的排比。**这不是角色卡不够细，恰恰是加法加太多了**：
 * 人格描写/说话方式/例句/破线全是"你要怎么说"，而模型把所有人都拉平到它自己的文笔上。
 *
 * 动漫的乐趣有一大半来自**声部对比度**：话痨旁边站着闷葫芦，正因为质地不同，
 * 同一句话砸下去才有回声。所以这一层做的是相反的事——**给角色"说不好话"的能力**：
 * 句子有硬上限、某些修辞不许用、说不出口时允许什么都不说。
 *
 * 两条腿缺一不可：
 * - **提示词侧**（buildVoiceBlock）：进 system prompt 稳定区，per 角色恒定不抖前缀
 * - **机械侧**（enforceVoice）：台词定稿后按句边界硬截。历史教训是"可以生气"="从不"——
 *   光在 prompt 里写上限，模型照样超
 *
 * **不是所有人都设限**：L 与鲁鲁修故意留空当对照组。对比度本身就是目的，
 * 全员统一收紧只会得到另一种千人一面（也顺便当 A/B 对照）。
 *
 * `ANIMA_VOICE=0` 整层退场，逐字节回归（A/B 基线）；角色卡没写 voice 同样一个字符都不动。
 */

/** 可禁的修辞（固定词表：卡里写别的值静默丢弃，旧卡照跑） */
export type VoiceBan = "比喻" | "反问" | "排比" | "书面语" | "感叹";

const BAN_LINES: Record<VoiceBan, string> = {
  比喻: "不许打比方。不说「像…」「仿佛…」「如同…」，也不把人和东西拿来类比。",
  反问: "不许用反问句。「…不是吗」「难道…」这种话你说不出来，有话就直说。",
  排比: "不许把三个短句排开铺陈。想到一句说一句，说完就停。",
  书面语: "不用书面词。嘴里不会冒出来的词就不许写进台词。",
  感叹: "不许感叹。情绪不靠语气词和惊叹号漏出来。",
};

export function isVoiceBan(v: unknown): v is VoiceBan {
  return typeof v === "string" && v in BAN_LINES;
}

/** 角色卡 `voice:` 块（全部可选——只写想设限的那几项） */
export interface VoiceDef {
  /** 单次台词字数硬上限。提示词里明说，且台词定稿后按句边界硬截 */
  maxChars?: number;
  /** 禁用的修辞（见 BAN_LINES 词表） */
  bans?: VoiceBan[];
  /** 允许沉默：说不出口时宁可只给个动作，也别凑一句漂亮话 */
  silence?: boolean;
}

/**
 * YAML → VoiceDef 显式映射（snake/camel 双接受）。
 * **绝不整体 cast**：本项目最贵的一条教训是 seeds.yml 的 visible_to 因 snake→camel
 * 直接 cast 而永远读不到（scenario-loader.ts:333）。这里逐字段显式取。
 * 非法字段静默丢弃（宁缺毋滥），整块无有效项 → undefined（= 该角色不设限）。
 */
export function normalizeVoice(v: unknown): VoiceDef | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;

  const rawMax = o.max_chars ?? o.maxChars;
  const maxChars =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : undefined;

  const rawBans = o.bans;
  const bans = Array.isArray(rawBans) ? rawBans.filter(isVoiceBan) : [];

  const silence = o.silence === true;

  if (maxChars === undefined && bans.length === 0 && !silence) return undefined;
  return {
    ...(maxChars !== undefined ? { maxChars } : {}),
    ...(bans.length > 0 ? { bans } : {}),
    ...(silence ? { silence: true } : {}),
  };
}

/** 声部总闸：`ANIMA_VOICE=0` 整层退场（逐字节 A/B 基线）。每次现读 env，单测可 delete */
export function voiceEnabled(): boolean {
  return process.env.ANIMA_VOICE !== "0";
}

/**
 * system prompt 的声部块（per 角色恒定，稳定区不抖前缀）。
 * 未声明 voice 或整层关闭 → undefined（旧角色卡逐字节回归）。
 *
 * 位置在「表达准则」之后：那里有一条通用的「一两句到三四句就够了」，
 * 本块必须显式声明覆盖它，否则两条建议打架，模型取中间值 = 等于没说。
 */
export function buildVoiceBlock(voice?: VoiceDef): string | undefined {
  if (!voiceEnabled() || !voice) return undefined;
  const lines: string[] = [];
  if (voice.maxChars !== undefined) {
    lines.push(
      `你一次开口不超过 ${voice.maxChars} 个字。这条**覆盖**前面关于句数的一般建议——` +
        `到了就停，哪怕话没说完。说不完的部分就是说不完，不要压缩成一句更精炼的话。`,
    );
  }
  for (const b of voice.bans ?? []) lines.push(BAN_LINES[b]);
  if (voice.silence) {
    lines.push(
      "说不出口的时候就别说。给个动作、给一个「……」、干脆走开，都比凑一句漂亮话更像你。",
    );
  }
  if (lines.length === 0) return undefined;
  return `\n## 说话的限度
${lines.map((l) => `- ${l}`).join("\n")}
这是**嘴**的上限，不是心的上限——想得多、说得少，正是你这个人。别把它当成要写得更精炼的意思。`;
}

/**
 * 模型自撰台词的参数名（**按工具**）。talk 只是其中一条出口——
 * comfort/argue 的 `words`、share_secret 的 `secret` 同样原样进对方 inbox 被听见。
 *
 * **argue 还要收 `reason`**：它的 schema 里 words 是可选的、reason 才是必填，
 * handler 走 `words?.trim() || reason` 兜底——模型只填 reason 时，reason 就是那句台词
 * （对抗审查实测：rei 的 argue 因此吐出 48 字）。而 argue 正是 S1 升档链专门强开的工具。
 *
 * 不收的：`manner`（说话时的神态白描，走旁白通道不进对方耳朵）、
 * `activity`（"一起钓鱼"这种模板槽，不是一句话）、引擎自己拼的模板句。
 * 声部管的是**嘴**，不是旁白。
 */
export const SPEECH_ARGS_BY_TOOL: Record<string, readonly string[]> = {
  talk: ["message"],
  comfort: ["words"],
  argue: ["words", "reason"],
  share_secret: ["secret"],
};

/** 未知工具的兜底集合（新工具加台词参数时至少这三个名字会被接住） */
export const VOICE_SPEECH_ARGS = ["message", "words", "secret"] as const;

/** 原文留存：截断前的值。道歉判定等"角色本来想说什么"的判据要读它，不能读截断后的 */
const _originals = new WeakMap<object, Record<string, string>>();

/**
 * 取某个台词参数的**截断前原文**；没被截过就返回当前值。
 * 用途：中文道歉的关键词几乎总在句尾，正好落在硬顶外——
 * 拿截断后的文本跑 `/对不起|抱歉|…/` 会让声部角色的疙瘩**永远解不开**（对抗审查实测 5/5）。
 */
export function voiceOriginal(args: Record<string, unknown> | undefined, key: string): string {
  if (!args) return "";
  const kept = _originals.get(args)?.[key];
  if (typeof kept === "string") return kept;
  const cur = args[key];
  return typeof cur === "string" ? cur : "";
}

/**
 * 对一次工具调用的参数原地施加声部硬顶（按工具覆盖该工具的全部台词出口）。
 * 幂等：已经截过的文本再调一次直接原样返回，不重复计违规。
 */
export function enforceVoiceOnArgs(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  voice: VoiceDef | undefined,
  charId: string,
): void {
  if (!args) return;
  const keys = (toolName && SPEECH_ARGS_BY_TOOL[toolName]) ?? VOICE_SPEECH_ARGS;
  for (const key of keys) {
    const v = args[key];
    if (typeof v !== "string" || !v) continue;
    const out = enforceVoice(v, voice, charId);
    if (out !== v) {
      const bag = _originals.get(args) ?? {};
      if (bag[key] === undefined) bag[key] = v;   // 只记第一次的原文
      _originals.set(args, bag);
    }
    args[key] = out;
  }
}

/** 机械侧的违规计数（诊断用；live 里"提示词有没有被听进去"要可归因） */
const _overflowCount = new Map<string, number>();

export function getVoiceOverflowCounts(): Record<string, number> {
  return Object.fromEntries(_overflowCount);
}

/** 测试隔离用 */
export function resetVoiceOverflowCounts(): void {
  _overflowCount.clear();
}

/**
 * 机械侧硬顶：台词定稿后按句边界截断。
 * 未超顶 → 原样返回（逐字节不变）；整层关闭/未设 maxChars → 原样返回。
 *
 * 句边界语义与 agent-loop 的 truncateThought 一致：优先切在最后一个句末标点后；
 * 找不到（或太靠前，切了等于没说）才硬切补「…」。
 */
export function enforceVoice(
  message: string,
  voice: VoiceDef | undefined,
  charId: string,
): string {
  if (!voiceEnabled()) return message;
  const max = voice?.maxChars;
  if (max === undefined || typeof message !== "string" || message.length <= max) return message;

  _overflowCount.set(charId, (_overflowCount.get(charId) ?? 0) + 1);

  const slice = message.slice(0, max);
  const lastEnd = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
    slice.lastIndexOf("」"),
  );
  // 省略号必须**算进**上限内（slice(0,max) + "…" 会得到 max+1 字）：
  // 否则结果仍 > max，下一次调用又截一刀又计一次违规——这层现在在
  // 重复拦截前与分发前各调一次，不幂等就会每轮多啃一个字。
  const out = lastEnd > max * 0.4 ? slice.slice(0, lastEnd + 1) : `${message.slice(0, max - 1)}…`;
  console.log(`✂️ [声部] ${charId} 台词 ${message.length}→${out.length} 字（上限 ${max}）`);
  return out;
}
