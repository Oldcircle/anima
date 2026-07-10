/**
 * 私有通道（七反转④双通道）：third 档决策输出末尾的两层动机行
 *
 *   【表面】我…（角色对自己的说法，第一人称）｜【真心】…（作者说破的、他不肯承认的那层）
 *
 * 解析成结构化字段后走两条路：
 * - 表面层：回流角色自己的短期记忆（这就是"他记得自己想过什么"）——自欺的自我叙事
 * - 真心层：只进观看者通道（WS tick payload / 🎭 控制台日志）——角色互不可见、
 *   也不回流本人记忆（七反转③：角色对自己不透明，自欺不因记忆回流而坍塌）
 *
 * 「与表面一致」是诚实豁免：不强迫每个决策都有第二层（防止像旧「疑惑」槽位那样
 * 自激成全员谍战腔）。twoLayer=false 的行照样解析，供 7 天复验统计真实分层比例。
 */

export interface MotiveChannel {
  /** 他对自己的说法（第一人称自我叙事） */
  surface: string;
  /** 他不肯承认的那层（作者视角），可能与表面一致 */
  hidden: string;
  /** 真心与表面是否真的分层（"与表面一致"类 → false） */
  twoLayer: boolean;
}

/** 判定真心层是否只是"与表面一致"的诚实豁免（非真分层）。 */
function isSameAsSurface(hidden: string): boolean {
  const normalized = hidden.replace(/[。．.，,\s"'「」『』]/g, "");
  if (normalized.length === 0) return true;
  if (normalized.length <= 12 && /与?表面(基本|完全)?一致|同表面|没有第二层|无第二层|就是这样/.test(normalized)) {
    return true;
  }
  return normalized === "一致" || normalized === "无";
}

const MOTIVE_LINE_RE = /【表面】([\s\S]*?)[｜|]\s*【真心】([^\n]*)/;

/**
 * 从决策输出里解析两层动机行。找不到或残缺返回 undefined（降级为 legacy 行为）。
 * 容错：全角｜/半角| 分隔；【真心】取到行尾（防止把后续正文吞进来）。
 */
export function parseMotiveChannel(text: string): MotiveChannel | undefined {
  const m = text.match(MOTIVE_LINE_RE);
  if (!m) return undefined;
  const surface = m[1]!.trim();
  const hidden = m[2]!.trim();
  if (!surface || !hidden) return undefined;
  return { surface, hidden, twoLayer: !isSameAsSurface(hidden) };
}
