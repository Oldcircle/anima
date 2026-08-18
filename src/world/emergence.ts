/**
 * Emergence Detectors — 涌现探测器（编年史的第二类来源）
 *
 * 「涌现」是这个项目唯一真正的产出：没人编排，却因为世界机制自己咬合而发生的事。
 * 但"有意思"不是判据——每条探测器都必须能指着世界状态说清楚**凭什么**，
 * 落进编年史时带上 `evidence`。判据说不清的，宁可不报。
 *
 * 探测器直接对齐 PLAN-grounding §3 的验收信号：以前要跑完长跑人肉翻 log 才知道
 * 「验收信号②篡改痕迹被重访者发现」有没有出现，现在世界自己举手。
 *
 * 实现纪律：
 * - **每 tick 全量重跑，靠 id 幂等去重**（不维护"上次跑到哪"的游标——游标会在读档时错位）
 * - **零 LLM、零额外状态**：判据全部读现成的世界状态
 * - 便宜：全是小集合上的循环，没有 O(n²) 大扫描
 */

import type { Chronicle, ChronicleEntry } from "./chronicle.js";
import type { WorldObjectStore } from "./world-objects.js";
import type { NarrativeState } from "../narrative/narrative-state.js";

/** 一天多少 tick（96 = 24h × 4） */
const TICKS_PER_DAY = 96;

export interface EmergenceDeps {
  chronicle: Chronicle;
  objects: WorldObjectStore;
  narrative: NarrativeState;
  tick: number;
  /** 角色 id → 名字（标题里用名字，id 只留在 actors） */
  names: Map<string, string>;
  /** 关系读取：返回 level（正负号用于反转探测），无关系返回 undefined */
  getRelationLevel: (a: string, b: string) => number | undefined;
  /** 参与探测的角色 id（排除静态 NPC） */
  characterIds: string[];
}

const nameOf = (deps: EmergenceDeps, id: string) => deps.names.get(id) ?? id;

/**
 * 跑一轮全部探测器，把新发现的涌现落进编年史，返回本轮新增的条目。
 * 每 tick 调一次；重复发现靠 chronicle 的 id 幂等挡掉。
 */
export function detectEmergence(deps: EmergenceDeps): ChronicleEntry[] {
  const found: ChronicleEntry[] = [];
  const push = (e: ChronicleEntry) => {
    if (deps.chronicle.record(e)) found.push(e);
  };

  detectEvidenceRace(deps, push);
  detectCanonBecameShared(deps, push);
  detectTamperTraceFound(deps, push);
  detectRumorSpread(deps, push);
  detectLongObsession(deps, push);
  detectRelationshipFlip(deps, push);

  return found;
}

const day = (tick: number) => Math.floor(tick / TICKS_PER_DAY);

/**
 * ①**证据竞赛**：同一天里 ≥2 个人各自查了同一件器物。
 * 判据 = 器物的 lastSeen 里有 ≥2 个角色落在同一天。
 * 这正是 default-verify 那场"L 查借阅台账 × light 同晨追同一本书"的机械形状——
 * 当时是人肉从 log 里认出来的。
 */
function detectEvidenceRace(deps: EmergenceDeps, push: (e: ChronicleEntry) => void): void {
  const today = day(deps.tick);
  for (const obj of deps.objects.all()) {
    const sameDay = Object.entries(obj.lastSeen)
      .filter(([, seen]) => day((seen as { tick: number }).tick) === today)
      .map(([charId]) => charId);
    if (sameDay.length < 2) continue;
    const who = sameDay.map((id) => nameOf(deps, id));
    push({
      id: `emg_race_${today}_${obj.key}`,
      tick: deps.tick,
      day: today,
      kind: "emergence",
      importance: 8,
      emoji: "🔎",
      title: `${who.join(" 和 ")}同一天都去查了${obj.name}`,
      detail: `没有任何机制安排他们查同一件东西——注意力自己撞到了一起。`,
      actors: sameDay,
      locationId: obj.locationId,
      evidence: `${obj.key} 的 lastSeen 里有 ${sameDay.length} 人落在第 ${today} 天`,
    });
  }
}

/**
 * ②**共享虚构成了共享事实**（PLAN-grounding 验收信号③）：
 * 某条正典是被 A 在对话里讲出来才实体化的（source=canonized），后来 **B** 又复述了它。
 * 判据 = 存在 verdict=restate 的断言，其说话人 ≠ 该器物上任何 canonized 正典的原作者。
 * 这是"世界观在角色之间流通"的机械证据，不是修辞。
 */
function detectCanonBecameShared(deps: EmergenceDeps, push: (e: ChronicleEntry) => void): void {
  const restates = deps.objects.getClaims({ verdict: "restate" });
  if (restates.length === 0) return;
  // 每件器物上"谁把正典讲出来的"：canonized 正典的首述者从 claims 账本反查
  const canonizedBy = new Map<string, Set<string>>();
  for (const c of deps.objects.getClaims({ verdict: "canonized" })) {
    if (!canonizedBy.has(c.objectKey)) canonizedBy.set(c.objectKey, new Set());
    canonizedBy.get(c.objectKey)!.add(c.speakerId);
  }
  for (const r of restates) {
    const authors = canonizedBy.get(r.objectKey);
    if (!authors || authors.size === 0) continue;      // 复述的是预埋正典，不算流通
    if (authors.has(r.speakerId)) continue;            // 自己复述自己讲过的，不算
    const obj = deps.objects.get(r.objectKey);
    const authorNames = [...authors].map((id) => nameOf(deps, id)).join("、");
    push({
      id: `emg_shared_${r.id}`,
      tick: deps.tick,
      day: day(deps.tick),
      kind: "emergence",
      importance: 9,
      emoji: "📜",
      title: `${nameOf(deps, r.speakerId)}转述了${authorNames}讲出来的那条事实`,
      detail: `「${r.claim}」——关于${obj?.name ?? r.objectKey}。这条事实本来是对话里凭空说出来的，现在世界认了，别人也在用它。`,
      actors: [r.speakerId, ...authors],
      locationId: obj?.locationId,
      evidence: `claim ${r.id} verdict=restate，说话人 ${r.speakerId} ∉ ${r.objectKey} 的 canonized 首述者集合`,
    });
  }
}

/**
 * ③**篡改的痕迹被别人发现了**（PLAN-grounding 验收信号②）：
 * tamper 必留二级痕迹，痕迹落下后有**非篡改者**查看过这件器物。
 * 判据 = trace.id 形如 `tamper_<tick>_<篡改者>_*`，且器物 lastSeen 里有别人晚于 addedTick。
 * "没有完美犯罪"这条设计，到这一刻才算真的兑现。
 */
function detectTamperTraceFound(deps: EmergenceDeps, push: (e: ChronicleEntry) => void): void {
  for (const obj of deps.objects.all()) {
    for (const trace of obj.traces) {
      if (!trace.id.startsWith("tamper_")) continue;
      const culprit = trace.id.split("_")[2];
      if (!culprit) continue;
      for (const [charId, rawSeen] of Object.entries(obj.lastSeen)) {
        const seen = rawSeen as { tick: number };
        if (charId === culprit) continue;
        if (seen.tick <= trace.addedTick) continue;
        push({
          id: `emg_traced_${trace.id}_${charId}`,
          tick: seen.tick,
          day: day(seen.tick),
          kind: "emergence",
          importance: 9,
          emoji: "🕳️",
          title: `${nameOf(deps, charId)}查到了${obj.name}上被人动过的痕迹`,
          detail: `${trace.text}——动手的人以为抹干净了。`,
          actors: [charId, culprit],
          locationId: obj.locationId,
          evidence: `trace ${trace.id}@${trace.addedTick} 之后，${charId} 于 tick ${seen.tick} examine 过 ${obj.key}`,
        });
      }
    }
  }
}

/**
 * ④**流言传开了**：一条流言到达 ≥3 人。
 * 判据 = rumor.reachedChars.length ≥ 3。信息在人群里自己走完了这段路。
 */
function detectRumorSpread(deps: EmergenceDeps, push: (e: ChronicleEntry) => void): void {
  const rumors = deps.narrative.getWorld().rumors;
  rumors.forEach((r, idx) => {
    if ((r.reachedChars?.length ?? 0) < 3) return;
    push({
      id: `emg_rumor_${idx}_${r.tick}_${r.reachedChars.length}`,
      tick: deps.tick,
      day: day(deps.tick),
      kind: "emergence",
      importance: 8,
      emoji: "🗣️",
      title: `一条闲话传到了 ${r.reachedChars.length} 个人耳朵里`,
      detail: `「${r.content}」`,
      actors: [...(r.sourceCharId ? [r.sourceCharId] : []), ...r.reachedChars],
      evidence: `rumor#${idx} reachedChars=${r.reachedChars.length}（≥3）`,
    });
  });
}

/**
 * ⑤**执念活过了三天**：某条执念创建 ≥3 天后仍在此人身上。
 * 判据 = 当前 day − obsession.createdDay ≥ 3。
 * 记忆会衰减、琐事会挤占，能挂三天说明这件事真的在他心里扎住了。
 */
function detectLongObsession(deps: EmergenceDeps, push: (e: ChronicleEntry) => void): void {
  const today = day(deps.tick);
  for (const charId of deps.characterIds) {
    for (const o of deps.narrative.getActiveObsessions(charId, today, 8)) {
      const age = today - o.createdDay;
      if (age < 3) continue;
      push({
        id: `emg_obsession_${charId}_${o.id}_d${age}`,
        tick: deps.tick,
        day: today,
        kind: "emergence",
        importance: 7,
        emoji: "🔗",
        title: `${nameOf(deps, charId)}这件事已经挂了 ${age} 天`,
        detail: o.summary,
        actors: [charId],
        evidence: `执念 ${o.id} createdDay=${o.createdDay}，今天第 ${today} 天仍活着`,
      });
    }
  }
}

/**
 * ⑥**关系翻了向**：两人关系的正负号发生变化（好→坏 或 坏→好）。
 * 判据 = 上一次记下的符号与现在不同（符号快照随档，读档后不会误报）。
 * 关系是从零涌现的，翻向是这条弧线上唯一说得清的节点。
 */
function detectRelationshipFlip(deps: EmergenceDeps, push: (e: ChronicleEntry) => void): void {
  const ids = deps.characterIds;
  const today = day(deps.tick);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!, b = ids[j]!;
      const level = deps.getRelationLevel(a, b);
      if (level === undefined) continue;
      // 死区：|level| < 5 视为"还没定性"，不记符号也不报，避免在 0 附近来回抖
      const sign = level >= 5 ? 1 : level <= -5 ? -1 : 0;
      const prev = deps.chronicle.getRelSign(a, b);
      if (sign !== 0) deps.chronicle.setRelSign(a, b, sign);
      if (prev === undefined || prev === 0 || sign === 0 || sign === prev) continue;
      const better = sign > 0;
      push({
        id: `emg_flip_${a}_${b}_${better ? "up" : "down"}_${today}`,
        tick: deps.tick,
        day: today,
        kind: "emergence",
        importance: 9,
        emoji: better ? "🤝" : "💔",
        title: better
          ? `${nameOf(deps, a)}和${nameOf(deps, b)}的关系转正了`
          : `${nameOf(deps, a)}和${nameOf(deps, b)}彻底闹僵了`,
        detail: `关系值现在是 ${Math.round(level)}。没有任何剧本安排这一步。`,
        actors: [a, b],
        evidence: `relation(${a},${b}) 符号 ${prev} → ${sign}（level=${Math.round(level)}，死区 ±5）`,
      });
    }
  }
}
