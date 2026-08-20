/**
 * Model Router — 按调用类型分层路由（省钱主杠杆）
 *
 * 此前所有调用共用一个 `modelId`：r3 那趟 900 次调用全走 deepseek-chat，烧 ≈¥7.9。
 * 但这 900 次的性质天差地别：
 *
 * | 类型 | r3 实测占比 | 缓存命中 | 性质 |
 * |---|---|---|---|
 * | decision | 56% | 70.9% | 选工具 + 一句独白，**行为质量的主战场** |
 * | conversation | 22% | 69.5% | 台词质地，**最吃模型水平** |
 * | observation | 10% | 24.8% | 小结构化推断 |
 * | impression | 6% | 63.1% | 打分 + 几个短语 |
 * | 三个抽取器 + reflection | 4% | **~0%** | 纯 JSON 抽取，几乎吃不到缓存＝每次全价 |
 *
 * 后四类加起来 21.7% 的调用量、几乎零缓存红利，**却和对话用同一个贵模型**。
 * 把它们甩给便宜模型，质量损失极小（判 JSON 对不对不需要文采），账单立刻下来。
 *
 * 纪律：
 * - **默认全 primary**：不配 cheap 就逐字节回退旧行为（A/B 基线）
 * - 分层是**每类固定**的，不随 tick 变——`(kind, 角色, 模型)` 的缓存前缀仍然稳定
 * - `decision` 默认留在 primary（56% 的量，动它要 A/B 验行为不退化），
 *   但**允许**用户手动下放：`ANIMA_CHEAP_KINDS=decision,...` 覆盖默认清单
 */

/** 默认走便宜档的调用类型：结构化小任务，不吃文采，且大多几乎无缓存红利 */
export const DEFAULT_CHEAP_KINDS = [
  "impression",
  "observation",
  "reflection",
  "morning-plan",
  "fact-extract",
  "stance-extract",
  "transaction-extract",
  "promise-extract",
] as const;

export type ModelTier = "primary" | "cheap";

/**
 * 解析便宜档的类型清单。
 * `ANIMA_CHEAP_KINDS` 覆盖默认（逗号分隔）；`ANIMA_CHEAP_KINDS=` 空串 = 全部走 primary。
 */
export function resolveCheapKinds(raw = process.env.ANIMA_CHEAP_KINDS): Set<string> {
  if (raw === undefined) return new Set(DEFAULT_CHEAP_KINDS);
  return new Set(
    raw.split(",").map((k) => k.trim()).filter((k) => k.length > 0),
  );
}

/** 这次调用该走哪一档。kind 缺省（未标注的调用）一律 primary——宁可贵，不可错。 */
export function tierFor(kind: string | undefined, cheapKinds: Set<string>): ModelTier {
  if (!kind) return "primary";
  return cheapKinds.has(kind) ? "cheap" : "primary";
}
