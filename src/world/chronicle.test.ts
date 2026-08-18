/**
 * 世界编年史 + 涌现探测器单测。
 *
 * 锁的都是"悄悄坏掉就白记一场"的性质：
 * ①**幂等**——探测器每 tick 全量重跑，同一件事只能落一条
 * ②**判据齐全**——涌现条目必须带 evidence（不许"我觉得这段挺有意思"）
 * ③**随档**——一局跑完的账，读档要还在
 * ④阈值：不到判据就不报（宁可漏，不能假）
 */

import { describe, it, expect } from "vitest";
import { Chronicle, MAX_CHRONICLE_ENTRIES, type ChronicleEntry } from "./chronicle.js";
import { detectEmergence, type EmergenceDeps } from "./emergence.js";
import { WorldObjectStore } from "./world-objects.js";
import { NarrativeState } from "../narrative/narrative-state.js";

function entry(over: Partial<ChronicleEntry> = {}): ChronicleEntry {
  return {
    id: "e1", tick: 100, day: 1, kind: "case", importance: 8,
    emoji: "🕵️", title: "出事了", actors: ["asuka"], ...over,
  };
}

function makeDeps(over: Partial<EmergenceDeps> = {}): EmergenceDeps {
  const objects = new WorldObjectStore();
  objects.registerLocation({
    id: "library",
    objects: [
      { id: "ledger", name: "借阅台账", keywords: ["台账"], canon: ["台账按月换页"], tamperable: true },
      { id: "desk", name: "阅览桌", keywords: ["阅览桌"] },
    ],
  });
  return {
    chronicle: new Chronicle(),
    objects,
    narrative: new NarrativeState(),
    tick: 100, // day 1
    names: new Map([["l", "L"], ["light", "夜神月"], ["asuka", "明日香"]]),
    getRelationLevel: () => undefined,
    characterIds: ["l", "light", "asuka"],
    ...over,
  };
}

describe("Chronicle 存储", () => {
  it("同 id 只落一条（探测器每 tick 重跑的去重基石）", () => {
    const c = new Chronicle();
    expect(c.record(entry())).toBe(true);
    expect(c.record(entry({ title: "换了个说法但还是同一件事" }))).toBe(false);
    expect(c.size).toBe(1);
  });

  it("按重要性/类型/角色/涌现过滤；最新在前", () => {
    const c = new Chronicle();
    c.record(entry({ id: "a", tick: 10, importance: 5, kind: "economy", actors: ["shinji"] }));
    c.record(entry({ id: "b", tick: 20, importance: 9, kind: "emergence", actors: ["l"] }));
    c.record(entry({ id: "c", tick: 30, importance: 8, kind: "case", actors: ["l", "light"] }));
    expect(c.list().map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(c.list({ minImportance: 8 }).map((e) => e.id)).toEqual(["c", "b"]);
    expect(c.list({ kind: "economy" }).map((e) => e.id)).toEqual(["a"]);
    expect(c.list({ actor: "l" }).map((e) => e.id)).toEqual(["c", "b"]);
    expect(c.list({ emergenceOnly: true }).map((e) => e.id)).toEqual(["b"]);
  });

  it("按天出小结：头条是当天最重的一条，涌现单独计数", () => {
    const c = new Chronicle();
    c.record(entry({ id: "a", day: 1, tick: 10, importance: 7 }));
    c.record(entry({ id: "b", day: 1, tick: 20, importance: 10, title: "破案了" }));
    c.record(entry({ id: "e", day: 1, tick: 30, importance: 8, kind: "emergence" }));
    c.record(entry({ id: "c", day: 2, tick: 200, importance: 9 }));
    const digests = c.digests();
    expect(digests.map((d) => d.day)).toEqual([2, 1]); // 最新的一天在前
    const d1 = digests.find((d) => d.day === 1)!;
    expect(d1.headline!.title).toBe("破案了");
    expect(d1.emergenceCount).toBe(1);
    expect(d1.entries.map((e) => e.tick)).toEqual([10, 20, 30]); // 天内按时间正序
  });

  it("机制首演只算一次", () => {
    const c = new Chronicle();
    expect(c.claimFirst("tamper")).toBe(true);
    expect(c.claimFirst("tamper")).toBe(false);
    expect(c.hasFirst("tamper")).toBe(true);
  });

  it("超上限 FIFO 淘汰，且淘汰后 id 可重用（不会永久占坑）", () => {
    const c = new Chronicle();
    for (let i = 0; i < MAX_CHRONICLE_ENTRIES + 10; i++) {
      c.record(entry({ id: `e${i}`, tick: i }));
    }
    expect(c.size).toBe(MAX_CHRONICLE_ENTRIES);
    expect(c.record(entry({ id: "e0", tick: 9999 }))).toBe(true); // 已被淘汰，可再落
  });

  it("随档往返：条目/首演/关系符号都还在；坏条目丢弃不崩", () => {
    const c = new Chronicle();
    c.record(entry({ id: "keep" }));
    c.claimFirst("accuse");
    c.setRelSign("a", "b", -1);
    const snap = JSON.parse(JSON.stringify(c.getSnapshot()));
    snap.entries.push({ id: "bad" });            // 缺 title/tick
    snap.entries.push(null);

    const restored = new Chronicle();
    restored.replaceSnapshot(snap);
    expect(restored.size).toBe(1);
    expect(restored.list()[0]!.id).toBe("keep");
    expect(restored.hasFirst("accuse")).toBe(true);
    expect(restored.getRelSign("b", "a")).toBe(-1); // pairKey 与顺序无关
    expect(() => restored.replaceSnapshot("垃圾")).not.toThrow();
  });
});

describe("涌现探测器", () => {
  it("证据竞赛：同一天两人查同一件器物 → 报；只有一人 → 不报", () => {
    const deps = makeDeps();
    deps.objects.examine("library.ledger", "l", 100);
    expect(detectEmergence(deps)).toHaveLength(0); // 一个人不算竞赛

    deps.objects.examine("library.ledger", "light", 110);
    const found = detectEmergence(deps);
    const race = found.find((e) => e.id.startsWith("emg_race_"))!;
    expect(race).toBeTruthy();
    expect(race.title).toContain("借阅台账");
    expect(race.evidence).toContain("lastSeen");
    // 幂等：再跑一遍不重复
    expect(detectEmergence(deps).filter((e) => e.id.startsWith("emg_race_"))).toHaveLength(0);
  });

  it("共享虚构成真：正典被非首述者复述 → 报；自己复述自己 → 不报", () => {
    const deps = makeDeps();
    deps.objects.addClaim({
      id: "c1", tick: 90, speakerId: "l", objectKey: "library.ledger",
      claim: "台账第 147 页折了个角", verdict: "canonized",
    });
    // 自己复述自己讲的，不算流通
    deps.objects.addClaim({
      id: "c2", tick: 95, speakerId: "l", objectKey: "library.ledger",
      claim: "147 页那个折角", verdict: "restate",
    });
    expect(detectEmergence(deps).filter((e) => e.id.startsWith("emg_shared_"))).toHaveLength(0);

    deps.objects.addClaim({
      id: "c3", tick: 99, speakerId: "light", objectKey: "library.ledger",
      claim: "台账 147 页折过角", verdict: "restate",
    });
    const shared = detectEmergence(deps).find((e) => e.id === "emg_shared_c3")!;
    expect(shared).toBeTruthy();
    expect(shared.title).toContain("夜神月");
    expect(shared.actors).toContain("l");
    expect(shared.evidence).toContain("restate");
  });

  it("篡改痕迹被别人发现 → 报；只有篡改者自己回看 → 不报", () => {
    const deps = makeDeps();
    deps.objects.addTrace("library.ledger", {
      id: "tamper_80_light_botched", text: "有人慌乱翻动过的乱痕", addedTick: 80, source: "interaction",
    });
    deps.objects.examine("library.ledger", "light", 90); // 篡改者自己回看
    expect(detectEmergence(deps).filter((e) => e.id.startsWith("emg_traced_"))).toHaveLength(0);

    deps.objects.examine("library.ledger", "l", 95);
    const traced = detectEmergence(deps).find((e) => e.id.startsWith("emg_traced_"))!;
    expect(traced).toBeTruthy();
    expect(traced.actors).toEqual(["l", "light"]);
    expect(traced.evidence).toContain("examine");
  });

  it("流言传到 3 人才算传开（2 人不报）", () => {
    const deps = makeDeps();
    const rumors = deps.narrative.getWorld().rumors;
    rumors.push({ content: "听说有人手脚不干净", tick: 90, reachedChars: ["l", "light"] });
    expect(detectEmergence(deps).filter((e) => e.id.startsWith("emg_rumor_"))).toHaveLength(0);

    rumors[0]!.reachedChars.push("asuka");
    const spread = detectEmergence(deps).find((e) => e.id.startsWith("emg_rumor_"))!;
    expect(spread.title).toContain("3 个人");
  });

  it("执念挂满 3 天才报", () => {
    const deps = makeDeps({ tick: 96 * 2 }); // day 2
    deps.narrative.registerObsession("l", {
      id: "obs_x", summary: "赵三这个人不对劲", createdDay: 0, decayDays: 5, source: "crime",
    });
    expect(detectEmergence(deps).filter((e) => e.id.startsWith("emg_obsession_"))).toHaveLength(0);

    const day3 = makeDeps({ tick: 96 * 3, chronicle: deps.chronicle, narrative: deps.narrative });
    const long = detectEmergence(day3).find((e) => e.id.startsWith("emg_obsession_"))!;
    expect(long.title).toContain("3 天");
  });

  it("关系翻向才报；死区内来回抖不报", () => {
    let level = 20;
    const deps = makeDeps({
      characterIds: ["l", "light"],
      getRelationLevel: (a, b) => (a === "l" || b === "l" ? level : undefined),
    });
    detectEmergence(deps); // 记下初始符号 +1
    expect(deps.chronicle.list({ emergenceOnly: true })).toHaveLength(0);

    level = 2; // 掉进死区：还没定性，不报也不改符号
    expect(detectEmergence(deps).filter((e) => e.id.startsWith("emg_flip_"))).toHaveLength(0);

    level = -12; // 真翻向
    const flip = detectEmergence(deps).find((e) => e.id.startsWith("emg_flip_"))!;
    expect(flip.title).toContain("闹僵");
    expect(flip.importance).toBe(9);
    expect(flip.evidence).toContain("符号");
  });

  it("每条涌现都带机械判据（不许只有形容词）", () => {
    const deps = makeDeps();
    deps.objects.examine("library.ledger", "l", 100);
    deps.objects.examine("library.ledger", "light", 101);
    deps.narrative.getWorld().rumors.push({ content: "闲话", tick: 90, reachedChars: ["l", "light", "asuka"] });
    const found = detectEmergence(deps);
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) {
      expect(e.kind, e.id).toBe("emergence");
      expect(e.evidence, e.id).toBeTruthy();
    }
  });
});
