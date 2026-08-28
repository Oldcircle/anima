/**
 * 可击穿的信念（beliefs）—— 让角色卡从**常量**变成**状态**
 *
 * 诊断第三条：角色卡每 tick 原样重新注入，跑七天，第七天的碇真嗣和第一天**逐字节一样**。
 * 而故事的定义就是人物改变。此前系统积累的全是**外部账本**（关系值、疙瘩、执念、案件、
 * 拒绝账、欠条），角色的**内部自我认知**一动不动——所以真嗣可以被点破一百次
 * 「你道歉的对象不是我」，他卡里还是那行「总在道歉」。
 *
 * 这一层给角色卡一组**可被世界击穿的信念**：
 *
 *   信念：「你是个累赘。有人对你好，只是因为还不知道你有多没用。」
 *   击穿条件：作为承诺方**兑现过 2 次**（机械计数）
 *   击穿后：「有人指望过你，你没搞砸——两回了。这事你还没想明白，但它硌在那儿。」
 *
 * 三条纪律：
 * 1. **击穿条件必须机械可测**——绑真实世界状态，绝不问 LLM「他成长了吗」（追求层同款红线）。
 *    证据源正是 S1/S2 建的账本：兑现/爽约/碰壁/要到，全是有方向、可计数的事实。
 * 2. **击穿不可逆**——想明白了就是想明白了。可逆的"成长"是均值回归，不是弧。
 * 3. **只换那一行字**——不新增 prompt 段落，不改人设其余部分。击穿那一刻会砸一次该角色的
 *    前缀缓存，这是预期成本（一局里最多发生几次）。
 *
 * `ANIMA_BELIEFS=0` 整层退场，逐字节回归；角色卡没写 `beliefs:` 同样一个字符都不动。
 */

/** 可作为击穿判据的机械指标（每一项都必须是引擎直接数得出来的） */
export type BeliefMetric =
  | "kept_promises"      // 作为承诺方，到点真办了几次（S2 拖延兑现）
  | "broken_promises"    // 作为承诺方，放了几次空话（S2 爽约）
  | "refused_by_others"  // 作为所求方，碰了几次壁（S1 被拒/反将）
  | "asks_landed"        // 作为所求方，要到过几次（S1 得手）
  | "closest_bond"       // 和任何人的最高关系值
  | "gold";              // 身上的钱

const METRICS: readonly BeliefMetric[] = [
  "kept_promises", "broken_promises", "refused_by_others", "asks_landed", "closest_bond", "gold",
];

export function isBeliefMetric(v: unknown): v is BeliefMetric {
  return typeof v === "string" && (METRICS as readonly string[]).includes(v);
}

export interface BeliefDef {
  id: string;
  /** 角色现在相信的那句话（进 system prompt） */
  text: string;
  /** 击穿判据：某个机械指标达到阈值 */
  brokenWhen: { metric: BeliefMetric; atLeast: number };
  /** 击穿之后他心里换成的那句话——**不是"他想通了"，是"这事硌在那儿"** */
  whenBroken: string;
}

/** 机械指标的当前读数（由引擎从账本与世界状态填） */
export interface BeliefStats {
  keptPromises: number;
  brokenPromises: number;
  refusedByOthers: number;
  asksLanded: number;
  closestBond: number;
  gold: number;
}

const METRIC_READERS: Record<BeliefMetric, (s: BeliefStats) => number> = {
  kept_promises: (s) => s.keptPromises,
  broken_promises: (s) => s.brokenPromises,
  refused_by_others: (s) => s.refusedByOthers,
  asks_landed: (s) => s.asksLanded,
  closest_bond: (s) => s.closestBond,
  gold: (s) => s.gold,
};

/**
 * YAML `beliefs:` 逐字段显式映射（snake/camel 双接受）。
 * **绝不整体 cast**（visible_to 泄漏教训）；单条非法就丢那一条，不拖累整组。
 */
export function normalizeBeliefs(v: unknown): BeliefDef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BeliefDef[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, any>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const whenBroken = typeof (o.when_broken ?? o.whenBroken) === "string"
      ? String(o.when_broken ?? o.whenBroken).trim() : "";
    const bw = (o.broken_when ?? o.brokenWhen) as Record<string, unknown> | undefined;
    if (!id || !text || !whenBroken || !bw || typeof bw !== "object") continue;
    const metric = bw.metric;
    const atLeastRaw = bw.at_least ?? bw.atLeast;
    if (!isBeliefMetric(metric)) continue;
    if (typeof atLeastRaw !== "number" || !Number.isFinite(atLeastRaw) || atLeastRaw <= 0) continue;
    if (out.some((b) => b.id === id)) continue;   // 同 id 只留第一条
    out.push({ id, text, brokenWhen: { metric, atLeast: Math.floor(atLeastRaw) }, whenBroken });
  }
  return out.length > 0 ? out : undefined;
}

/** BeliefDef[] → YAML 形态（snake_case）。管理面板回写角色卡时用，必须与 normalize 严格互逆 */
export function beliefsToYaml(beliefs: BeliefDef[]): Array<Record<string, unknown>> {
  return beliefs.map((b) => ({
    id: b.id,
    text: b.text,
    broken_when: { metric: b.brokenWhen.metric, at_least: b.brokenWhen.atLeast },
    when_broken: b.whenBroken,
  }));
}

/** 总闸：`ANIMA_BELIEFS=0` 整层退场（逐字节 A/B 基线）。每次现读 env */
export function beliefsEnabled(): boolean {
  return process.env.ANIMA_BELIEFS !== "0";
}

/**
 * 判定这一刻**新**被击穿的信念（已击穿的不重复报）。
 * 纯函数、零 LLM——判据全是机械读数。
 */
export function evaluateBeliefs(
  beliefs: BeliefDef[] | undefined,
  alreadyBroken: readonly string[],
  stats: BeliefStats,
): BeliefDef[] {
  if (!beliefsEnabled() || !beliefs) return [];
  return beliefs.filter(
    (b) =>
      !alreadyBroken.includes(b.id) &&
      METRIC_READERS[b.brokenWhen.metric](stats) >= b.brokenWhen.atLeast,
  );
}

/**
 * system prompt 的信念块（per 角色；**只在信念被击穿那一刻变一次**）。
 * 未声明 beliefs 或整层关闭 → undefined（旧角色卡逐字节回归）。
 */
export function buildBeliefBlock(
  beliefs?: BeliefDef[],
  broken: readonly string[] = [],
): string | undefined {
  if (!beliefsEnabled() || !beliefs || beliefs.length === 0) return undefined;
  const lines = beliefs.map((b) => (broken.includes(b.id) ? `- ${b.whenBroken}` : `- ${b.text}`));
  return `\n## 你心里认定的事
${lines.join("\n")}
这些不是道理，是你**当真的东西**——它们决定你怎么解释别人的举动。
你不会把它们挂在嘴上说，但它们一直在。`;
}
