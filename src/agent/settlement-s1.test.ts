/**
 * S1 对话结算形状单测（对话结束管线第五兄弟）。
 *
 * 锁的是形状不是数值：
 * - 预过滤：<4 句 / 无所求 → 不进抽取（不烧 LLM）
 * - 防线②：evidence 未逐字命中转录 → 丢弃
 * - 防线③：归属**反向**校验——原话不是对方说的 → 丢弃
 * - 防线⑤：「反将」无明示原话 → 降档「被拒」
 * - 默认项：判「未果」不落账（平局是合法结果，只是从此可计量）
 * - 拒绝账本：有向、同向换所求类型从头计、tier 单调且封顶、清账
 * - 执念原地升档：同 id 改写而不新开条目（每人 6 条 FIFO，别挤爆执念池）
 * - 随档：normalize 回填 + 脏值整条丢弃 + round-trip
 * - 手段升档：同类所求碰壁 → 所求行写硬；异类不受影响；≤1 行契约不破
 * - off 档 / ANIMA_SETTLEMENT=0 整层退场
 */

import { describe, it, expect, afterEach, beforeEach, beforeAll } from "vitest";
import {
  applyOutcomeLadder,
  extractSettlements,
  mightContainSettlement,
  settlementEnabled,
  cleanEvidence,
  MIN_EVIDENCE_CHARS,
  type SettlementSubject,
} from "./settlement-extractor.js";
import { computeAddressableDesire, MAX_REFUSAL_TIER, DEBT_DESIRE_OVERDUE_TICKS } from "./conversation-desire.js";
import { setBreakLevel } from "./break-config.js";
import {
  NarrativeState,
  emptyNarrativeState,
  normalizeNarrativeSnapshot,
  refusalKey,
} from "../narrative/narrative-state.js";
import type { ConversationExchange } from "./conversation-mode.js";
import type { LLMProvider } from "../providers/types.js";
import type { CharacterCard } from "../character/types.js";

// 所求层的闸在 break-config 的模块级 _level（env 只在 import 时读一次），
// 钉死成 mild：这套测试锁的是升档形状，不是 off 档基线（off 基线另有专测）
beforeAll(() => setBreakLevel("mild"));

// ── fixtures ──

function ex(speakerId: string, speakerName: string, message: string, tick = 10): ConversationExchange {
  return { speakerId, speakerName, message, tick };
}

/** 明日香跟夜神月要钱：她开口，他回绝 */
const HISTORY: ConversationExchange[] = [
  ex("asuka", "明日香", "喂，你上次说的那笔钱，什么时候还？"),
  ex("light", "夜神月", "我兜里是真没钱，这你自己也听见了。"),
  ex("asuka", "明日香", "少来这套，你昨天还买了可颂。"),
  ex("light", "夜神月", "凭什么我得先还你？你自己欠图书馆的书还没还呢。"),
  ex("asuka", "明日香", "……行吧，那就再宽你两天，别让我第三次来问。"),
];

const SUBJECTS: SettlementSubject[] = [
  { charId: "asuka", charName: "明日香", want: "想把欠账要回来", kind: "hostile" },
];

function fakeProvider(content: string): LLMProvider {
  return {
    chat: async () => ({ content, toolCalls: [] }),
  } as unknown as LLMProvider;
}

const ARGS = {
  history: HISTORY,
  subjects: SUBJECTS,
  charAId: "asuka", charAName: "明日香",
  charBId: "light", charBName: "夜神月",
  modelId: "test-model",
};

function makeCard(): CharacterCard {
  return {
    id: "asuka", name: "明日香", age: 20, occupation: "店员", home: "home_a",
    personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
    background: "", relationships: {},
  };
}

const TOP_PAIR = {
  getTopPairFor: () => ({
    a: "asuka", b: "light", pressure: 80,
    inputs: { activeOpenStances: 1, grudge: false, debtOverdueDays: 0, missedAppointments: 0, frictions: 0 },
  }),
} as any;

function desireFor(refusal?: { kind: string; count: number; tier: number }) {
  return computeAddressableDesire({
    selfId: "asuka", selfCard: makeCard(),
    partnerId: "light", partnerName: "夜神月",
    pressureGraph: TOP_PAIR, tick: 10, day: 1, refusal,
  });
}

// 环境隔离：这套测试锁的是形状，不该被跑测时的 ambient env 掀翻
// （ANIMA_PURSUIT=0 跑全量时，追求向那几条会因为总闸关着而挂）
beforeEach(() => {
  delete process.env.ANIMA_PURSUIT;
});

afterEach(() => {
  delete process.env.ANIMA_SETTLEMENT;
  delete process.env.ANIMA_BREAK_LEVEL;
  delete process.env.ANIMA_PURSUIT;
});

// ── 预过滤 ──

describe("预过滤（防线①）", () => {
  it("<4 句不进抽取", () => {
    expect(mightContainSettlement(HISTORY.slice(0, 3), SUBJECTS)).toBe(false);
  });

  it("没有任何一方有所求 → 不进抽取（寒暄底噪没有胜负可判）", () => {
    expect(mightContainSettlement(HISTORY, [])).toBe(false);
  });

  it("≥4 句且有所求 → 进", () => {
    expect(mightContainSettlement(HISTORY, SUBJECTS)).toBe(true);
  });

  it("subjects 为空时 extractSettlements 直接返回，不调 provider", async () => {
    let called = false;
    const p = { chat: async () => { called = true; return { content: "", toolCalls: [] }; } } as unknown as LLMProvider;
    expect(await extractSettlements({ ...ARGS, subjects: [], provider: p })).toEqual([]);
    expect(called).toBe(false);
  });
});

// ── 抽取防线 ──

describe("抽取防线", () => {
  it("正常路径：被拒落一条，holder/target 方向正确", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("角色: 明日香\n结果: 被拒\n原话: 我兜里是真没钱，这你自己也听见了。"),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ holderId: "asuka", targetId: "light", outcome: "被拒" });
  });

  it("防线②：evidence 未逐字命中转录 → 丢弃", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("角色: 明日香\n结果: 被拒\n原话: 他说他没有钱（意译）"),
    });
    expect(out).toEqual([]);
  });

  it("prompt 带说话人反面示例（live2 两连败：模型引所求方自己的复述/宣布）", async () => {
    let sys = "";
    const p = {
      chat: async (req: { system?: string }) => {
        sys = req.system ?? "";
        return { content: "", toolCalls: [] };
      },
    } as unknown as LLMProvider;
    await extractSettlements({ ...ARGS, provider: p });
    expect(sys).toContain("自己");
    expect(sys).toContain("复述");
    expect(sys).toContain("咱们两清");
  });

  it("防线③：原话是 holder 自己说的 → 归属错误丢弃", async () => {
    const out = await extractSettlements({
      ...ARGS,
      // 这句是明日香自己说的，不是对方回绝她的话
      provider: fakeProvider("角色: 明日香\n结果: 被拒\n原话: 少来这套，你昨天还买了可颂。"),
    });
    expect(out).toEqual([]);
  });

  it("防线⑤：反将有明示原话 → 保留反将", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("角色: 明日香\n结果: 反将\n原话: 凭什么我得先还你？你自己欠图书馆的书还没还呢。"),
    });
    expect(out[0]!.outcome).toBe("反将");
  });

  it("防线⑤：反将无明示原话 → 降档被拒", () => {
    expect(applyOutcomeLadder("反将", "我兜里是真没钱")).toBe("被拒");
    expect(applyOutcomeLadder("反将", "凭什么我得先还你")).toBe("反将");
    expect(applyOutcomeLadder("被拒", "随便什么话")).toBe("被拒");
  });

  it("未果 → 不落账（平局是合法结果，只是从此可计量）", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("角色: 明日香\n结果: 未果\n原话: "),
    });
    expect(out).toEqual([]);
  });

  it("没登记所求的人被判了结果 → 丢弃（模型不许替旁人加戏）", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("角色: 夜神月\n结果: 得手\n原话: 少来这套，你昨天还买了可颂。"),
    });
    expect(out).toEqual([]);
  });

  it("坏输出 / 非法结果 → 不落账不崩", async () => {
    expect(await extractSettlements({ ...ARGS, provider: fakeProvider("我不知道该怎么判") })).toEqual([]);
    expect(await extractSettlements({ ...ARGS, provider: fakeProvider("角色: 明日香\n结果: 打平\n原话: x") })).toEqual([]);
    expect(await extractSettlements({ ...ARGS, provider: fakeProvider("") })).toEqual([]);
  });

  it("provider 抛异常 → 返回空数组，不冒泡出 tick", async () => {
    const p = { chat: async () => { throw new Error("boom"); } } as unknown as LLMProvider;
    expect(await extractSettlements({ ...ARGS, provider: p })).toEqual([]);
  });

  it("markdown 围栏 + 全角冒号也认", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("```\n角色：明日香\n结果：被拒\n原话：我兜里是真没钱，这你自己也听见了。\n```"),
    });
    expect(out).toHaveLength(1);
  });

  it("防线⑤b：得手拿不出明示应允原话 → 退回未果（得手是唯一会删持久状态的结果，判据必须更严）", async () => {
    const out = await extractSettlements({
      ...ARGS,
      // 这句是对方说的、逐字命中、归属正确——只差"应允"这层意思
      provider: fakeProvider("角色: 明日香\n结果: 得手\n原话: 我兜里是真没钱，这你自己也听见了。"),
    });
    expect(out).toEqual([]);
  });

  it("防线⑤b：有明示应允原话的得手才落账", async () => {
    const out = await extractSettlements({
      ...ARGS,
      subjects: [{ charId: "light", charName: "夜神月", want: "想再拖两天", kind: "hostile" }],
      provider: fakeProvider("角色: 夜神月\n结果: 得手\n原话: ……行吧，那就再宽你两天，别让我第三次来问。"),
    });
    expect(out[0]).toMatchObject({ holderId: "light", outcome: "得手" });
  });

  it("第四格「拖延」：答应了但推到以后 —— 既不是得手也不是被拒", async () => {
    const out = await extractSettlements({
      ...ARGS,
      provider: fakeProvider("角色: 明日香\n结果: 拖延\n原话: 我兜里是真没钱，这你自己也听见了。"),
    });
    expect(out).toEqual([]);   // 没有"推后"的字面 → 判不出，丢弃
  });

  it("**模型判「得手」但原话里带着推后字面 → 降档拖延**（那不是给了，是答应了以后给）", () => {
    expect(applyOutcomeLadder("得手", "等打烊了，我把钱凑一凑还你。")).toBe("拖延");
    expect(applyOutcomeLadder("得手", "行吧，回头再说。")).toBe("拖延");
    // 当场给的才是得手
    expect(applyOutcomeLadder("得手", "……行吧，钱拿去，别再问了。")).toBe("得手");
  });

  it("拖延要有明示推后原话，否则退回未果", () => {
    expect(applyOutcomeLadder("拖延", "等打烊了我把钱凑一凑还你")).toBe("拖延");
    expect(applyOutcomeLadder("拖延", "打烊前给你个准数")).toBe("拖延");
    expect(applyOutcomeLadder("拖延", "我兜里是真没钱")).toBeUndefined();
  });

  it("evidence 最小长度：单字/单标点撑不起任何结算", () => {
    expect(applyOutcomeLadder("得手", "嗯")).toBeUndefined();
    expect(applyOutcomeLadder("得手", "，")).toBeUndefined();
    expect(applyOutcomeLadder("被拒", "不行")).toBeUndefined();
    expect(MIN_EVIDENCE_CHARS).toBeGreaterThan(1);
  });

  it("焊块防护：模型漏写分隔线/漏写角色行时，后写的结果不许覆盖前一块", async () => {
    const out = await extractSettlements({
      ...ARGS,
      // 第二块没有"角色"行也没有分隔线：旧实现会用「得手」覆盖「被拒」，
      // 而 evidence 还是对方的回绝原话 —— 防线③照样放行
      provider: fakeProvider(
        "角色: 明日香\n结果: 被拒\n原话: 我兜里是真没钱，这你自己也听见了。\n" +
        "结果: 得手\n原话: ……行吧，那就再宽你两天，别让我第三次来问。",
      ),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe("被拒");
  });

  it("evidence 带发言人前缀 / markdown 加粗照样认（否则整条被静默丢弃）", async () => {
    for (const body of [
      "角色: 明日香\n结果: 被拒\n原话: 夜神月：「我兜里是真没钱，这你自己也听见了。」",
      "**角色**: 明日香\n**结果**: 被拒\n**原话**: 我兜里是真没钱，这你自己也听见了。",
    ]) {
      const out = await extractSettlements({ ...ARGS, provider: fakeProvider(body) });
      expect(out, body).toHaveLength(1);
      expect(out[0]!.outcome).toBe("被拒");
    }
  });

  it("cleanEvidence 只剥壳不改内容", () => {
    expect(cleanEvidence("夜神月：「我兜里是真没钱」")).toBe("我兜里是真没钱");
    expect(cleanEvidence("**我兜里是真没钱**")).toBe("我兜里是真没钱");
    expect(cleanEvidence("我兜里是真没钱")).toBe("我兜里是真没钱");
    // 台词自带冒号但没有发言人前缀时不许误剥（名字段限长 12 字且不含引号）
    expect(cleanEvidence("我就说一句话：这钱我不还了，你能怎么着")).toBe("我就说一句话：这钱我不还了，你能怎么着");
  });

  it("一场对话最多两方各一条，同一人不重复", async () => {
    const out = await extractSettlements({
      ...ARGS,
      subjects: [...SUBJECTS, { charId: "light", charName: "夜神月", want: "想把话岔开", kind: "hostile" }],
      provider: fakeProvider(
        "角色: 明日香\n结果: 被拒\n原话: 我兜里是真没钱，这你自己也听见了。\n---\n" +
        "角色: 明日香\n结果: 反将\n原话: 凭什么我得先还你？你自己欠图书馆的书还没还呢。\n---\n" +
        "角色: 夜神月\n结果: 得手\n原话: ……行吧，那就再宽你两天，别让我第三次来问。",
      ),
    });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((o) => o.holderId)).size).toBe(2);
  });
});

// ── 拒绝账本 ──

describe("拒绝账本（随档）", () => {
  it("有向：a→b 与 b→a 是两笔账", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 1 });
    expect(ns.getRefusal("a", "b")).toBeTruthy();
    expect(ns.getRefusal("b", "a")).toBeUndefined();
    expect(refusalKey("a", "b")).toBe("a:b");
    expect(refusalKey("b", "a")).toBe("b:a");
  });

  it("tier 随 count 单调递增并封顶", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    const tiers: number[] = [];
    for (let i = 0; i < 6; i++) {
      tiers.push(ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: i }).tier);
    }
    expect(tiers).toEqual([1, 2, 3, 3, 3, 3]);
    expect(Math.max(...tiers)).toBe(MAX_REFUSAL_TIER);
    expect(ns.getRefusal("a", "b")!.count).toBe(6);
  });

  it("同向换了所求类型 → 从头计（借钱碰壁不等于闲聊碰壁）", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 1 });
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 2 });
    expect(ns.getRefusal("a", "b")!.count).toBe(2);
    const switched = ns.recordRefusal({ fromId: "a", toId: "b", kind: "bond", tick: 3 });
    expect(switched.count).toBe(1);
    expect(switched.tier).toBe(1);
  });

  it("反将单独计数", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 1 });
    const e = ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 2, counterAttack: true });
    expect(e.count).toBe(2);
    expect(e.counterAttacks).toBe(1);
  });

  it("清账：单向 / 双向（和解走双向）", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 1 });
    ns.recordRefusal({ fromId: "b", toId: "a", kind: "hostile", tick: 1 });
    expect(ns.clearRefusals("a", "b")).toBe(1);
    expect(ns.getRefusal("b", "a")).toBeTruthy();
    expect(ns.clearRefusals("a", "b", true)).toBe(1);
    expect(ns.getRefusal("b", "a")).toBeUndefined();
  });

  it("normalize：旧档缺字段回填空 + 脏条目整条丢弃 + tier 钳位", () => {
    const snap = normalizeNarrativeSnapshot({} as any);
    expect(snap.world.refusals).toEqual({});

    const dirty = normalizeNarrativeSnapshot({
      world: {
        ...emptyNarrativeState().world,
        refusals: {
          "a:b": { fromId: "a", toId: "b", kind: "hostile", count: 2, tier: 99, counterAttacks: Number.NaN, lastTick: 5 },
          "c:d": { fromId: "c", count: 1, lastTick: 1 },          // 缺字段 → 丢
          "e:f": { fromId: "e", toId: "f", kind: "bond", count: Number.NaN, lastTick: 1 }, // 脏数值 → 丢
          "g:h": { fromId: "g", toId: "h", kind: "bond", count: 2, lastTick: 3 },          // 缺 tier → 由 count 推
        },
      },
    } as any);
    expect(Object.keys(dirty.world.refusals).sort()).toEqual(["a:b", "g:h"]);
    expect(dirty.world.refusals["a:b"]!.tier).toBe(MAX_REFUSAL_TIER);
    expect(dirty.world.refusals["a:b"]!.counterAttacks).toBe(0);
    expect(dirty.world.refusals["g:h"]!.tier).toBe(2);
  });

  it("round-trip：JSON 往返后账本还在", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 7 });
    ns.recordRefusal({ fromId: "a", toId: "b", kind: "hostile", tick: 9 });
    const revived = new NarrativeState(
      normalizeNarrativeSnapshot(JSON.parse(JSON.stringify(ns.getSnapshot()))),
    );
    expect(revived.getRefusal("a", "b")).toMatchObject({ count: 2, tier: 2, kind: "hostile" });
  });
});

// ── 执念原地升档 ──

describe("执念原地升档", () => {
  it("同 id 改写 summary 并重新计时，不新开条目", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.registerObsession("a", {
      id: "obs_refusal_a_b", summary: "第一档", createdDay: 1, decayDays: 5,
      source: "settlement", relatedId: "refusal_a_b",
    });
    expect(ns.upgradeObsession("a", "obs_refusal_a_b", "第二档", 3)).toBe(true);
    const list = ns.getActiveObsessions("a", 3, 10);
    expect(list).toHaveLength(1);
    expect(list[0]!.summary).toBe("第二档");
    expect(list[0]!.createdDay).toBe(3);
  });

  it("找不到 id → false（调用方据此走首次登记）", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    expect(ns.upgradeObsession("a", "obs_refusal_a_b", "x", 1)).toBe(false);
  });

  it("registerObsession 同 id 仍然拒收——所以升档必须走 upgrade", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    const entry = { id: "obs_refusal_a_b", summary: "一", createdDay: 1, decayDays: 5, source: "settlement" };
    expect(ns.registerObsession("a", entry)).toBe(true);
    expect(ns.registerObsession("a", { ...entry, summary: "二" })).toBe(false);
    expect(ns.getActiveObsessions("a", 1, 10)[0]!.summary).toBe("一");
  });

  it("relatedId 约定能被 clearObsessionsRelatedTo 清掉（得手清账）", () => {
    const ns = new NarrativeState(emptyNarrativeState());
    ns.registerObsession("a", {
      id: "obs_refusal_a_b", summary: "碰壁", createdDay: 1, decayDays: 5,
      source: "settlement", relatedId: "refusal_a_b",
    });
    expect(ns.clearObsessionsRelatedTo("refusal_a_b")).toBe(1);
    expect(ns.getActiveObsessions("a", 1, 10)).toHaveLength(0);
  });
});

// ── 手段升档（所求行写硬） ──

describe("手段升档（所求行）", () => {
  it("无拒绝账本 → 与旧版逐字节一致（升档不改基线）", () => {
    expect(desireFor()!.line).toBe(desireFor(undefined)!.line);
    expect(desireFor()!.line).not.toContain("没接住");
  });

  it("同类所求碰过壁 → 行文变硬，且档位越高越硬", () => {
    const t1 = desireFor({ kind: "hostile", count: 1, tier: 1 })!.line;
    const t2 = desireFor({ kind: "hostile", count: 2, tier: 2 })!.line;
    const t3 = desireFor({ kind: "hostile", count: 3, tier: 3 })!.line;
    expect(t1).toContain("没接住");
    expect(t2).toContain("两回钉子");
    expect(t3).toContain("走到头");
    expect(new Set([t1, t2, t3]).size).toBe(3);
  });

  it("异类所求不受影响（借钱碰壁不该把闲聊也写硬）", () => {
    const line = desireFor({ kind: "bond", count: 3, tier: 3 })!.line;
    expect(line).toBe(desireFor()!.line);
  });

  it("≤1 行契约不破（升档是追加到同一行，不新开 prompt 槽位）", () => {
    for (const tier of [0, 1, 2, 3]) {
      const line = desireFor({ kind: "hostile", count: tier, tier })!.line;
      expect(line).not.toContain("\n");
      expect(line.startsWith("💭")).toBe(true);
    }
  });

  it("债务所求：对方欠我且逾期 → 债主向（这是世界里现成的场景目标）", () => {
    const d = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      partnerDebts: [{ lenderId: "asuka", amount: 30, borrowedTick: 0 }],
      tick: 300, day: 3,
    })!;
    expect(d.kind).toBe("debt");
    expect(d.want).toContain("30");
    expect(d.line).toContain("30");
    expect(d.line).not.toContain("\n");
  });

  it("债务所求：我欠对方且逾期 → 欠债人向（同一桩账，两个方向两种所求）", () => {
    const d = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      myDebts: [{ lenderId: "light", amount: 30, borrowedTick: 0 }],
      tick: 300, day: 3,
    })!;
    expect(d.kind).toBe("debt");
    expect(d.id).toBe("desire_debt_asuka_light");
    expect(d.want).toContain("拖");
  });

  it("债务未逾期 → 不成为所求（刚借的钱不叫心里压着事）", () => {
    expect(computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      partnerDebts: [{ lenderId: "asuka", amount: 30, borrowedTick: 290 }],
      tick: 300, day: 3,
    })).toBeUndefined();
    expect(DEBT_DESIRE_OVERDUE_TICKS).toBeGreaterThan(96);
  });

  it("债务所求也吃升档（同类碰壁 → 那行写硬）", () => {
    const base = { selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      partnerDebts: [{ lenderId: "asuka", amount: 30, borrowedTick: 0 }], tick: 300, day: 3 };
    const plain = computeAddressableDesire(base)!.line;
    const hard = computeAddressableDesire({ ...base, refusal: { kind: "debt", count: 2, tier: 2 } })!.line;
    expect(hard.startsWith(plain)).toBe(true);
    expect(hard).toContain("两回钉子");
  });

  it("**债务优先于敌对**：逾期欠账自己就把这对顶过压力线，让 hostile 抢走等于把可核验的账变成不可核验的", () => {
    const d = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      pressureGraph: TOP_PAIR,   // 压力 80，远超 hostile 的 40 线
      partnerDebts: [{ lenderId: "asuka", amount: 30, borrowedTick: 0 }],
      tick: 300, day: 3,
    })!;
    // kind 一旦被标成 hostile：①_verifiableProgress 认不出 → 欠条 baseline=undefined
    // → 到期静默过期、爽约永不落账 ②压力跨线那刻 kind 翻转，拒绝账按"换类型"从头计
    expect(d.kind).toBe("debt");
    expect(d.want).toContain("30");
  });

  it("没有逾期债时 hostile 照常（债务优先不等于把 hostile 关了）", () => {
    const d = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      pressureGraph: TOP_PAIR, tick: 300, day: 3,
    })!;
    expect(d.kind).toBe("hostile");
  });

  it("欠债人不该拿到债主的怨气：hostile 行文里的「欠账」要判方向", () => {
    const debtPressure = {
      getTopPairFor: () => ({
        a: "asuka", b: "light", pressure: 80,
        inputs: { activeOpenStances: 0, grudge: false, debtOverdueDays: 2, missedAppointments: 0, frictions: 0 },
      }),
    } as any;
    // asuka 是欠债人（她欠 light），但债还没到我的逾期门槛 → 落到 hostile 分支
    const debtor = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      pressureGraph: debtPressure,
      myDebts: [{ lenderId: "light", amount: 30, borrowedTick: 295 }],
      tick: 300, day: 3,
    })!;
    expect(debtor.line).not.toContain("欠账拖了这么久");

    // 反方向：asuka 是债主 → 可以说欠账
    const creditor = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      pressureGraph: debtPressure,
      partnerDebts: [{ lenderId: "asuka", amount: 30, borrowedTick: 295 }],
      tick: 300, day: 3,
    })!;
    expect(creditor.line).toContain("欠账拖了这么久");
  });

  const activePursuit = (target: string, status = "active") => ({
    id: "p1", summary: `想跟${target === "light" ? "夜神月" : "绫波丽"}成为真正说得上话的人`,
    metric: { kind: "relationship" as const, target }, target: 40,
    status: status as "active" | "achieved" | "failed", lastProgress: 0,
  });

  it("追求向所求：pursuit 绑在这个人身上（作者预埋的方向，比 level≥60 早得多）", () => {
    const d = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      selfPursuit: activePursuit("light"), tick: 300, day: 3,
    })!;
    expect(d.kind).toBe("pursuit");
    expect(d.line).toContain("绕不开");
    expect(d.line).not.toContain("\n");
  });

  it("追求绑的是别人 → 不注入（不是见谁都提自己的追求）", () => {
    expect(computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      selfPursuit: activePursuit("rei"), tick: 300, day: 3,
    })).toBeUndefined();
  });

  it("**已达成/已永久失败的追求不再催人**（读运行期 status，不是卡片上的静态声明）", () => {
    for (const st of ["achieved", "failed"]) {
      expect(computeAddressableDesire({
        selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
        selfPursuit: activePursuit("light", st), tick: 300, day: 3,
      }), st).toBeUndefined();
    }
  });

  it("ANIMA_PURSUIT=0 时追求向整层退场（不该绕过总闸）", () => {
    process.env.ANIMA_PURSUIT = "0";
    try {
      expect(computeAddressableDesire({
        selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
        selfPursuit: activePursuit("light"), tick: 300, day: 3,
      })).toBeUndefined();
    } finally {
      delete process.env.ANIMA_PURSUIT;
    }
  });

  it("债务优先于追求（欠账比愿望更硌人）", () => {
    const d = computeAddressableDesire({
      selfId: "asuka", selfCard: makeCard(), partnerId: "light", partnerName: "夜神月",
      selfPursuit: activePursuit("light"),
      partnerDebts: [{ lenderId: "asuka", amount: 30, borrowedTick: 0 }],
      tick: 300, day: 3,
    })!;
    expect(d.kind).toBe("debt");
  });

  it("所求是可寻址的：带 kind/id/want", () => {
    const d = desireFor()!;
    expect(d.kind).toBe("hostile");
    expect(d.id).toContain("desire_hostile");
    expect(d.want.length).toBeGreaterThan(0);
  });

  it("want 只喂结算器，绝不出现在注入行里（告诉角色'你要什么'是写结果）", () => {
    const d = desireFor()!;
    expect(d.line).not.toContain(d.want);
  });
});

// ── 总闸 ──

describe("整层退场", () => {
  it("ANIMA_SETTLEMENT=0 → settlementEnabled false", () => {
    expect(settlementEnabled()).toBe(true);
    process.env.ANIMA_SETTLEMENT = "0";
    expect(settlementEnabled()).toBe(false);
  });

  it("off 档：所求本身就不产出 → 结算无从触发（A/B 基线）", () => {
    process.env.ANIMA_BREAK_LEVEL = "off";
    // conversation-desire 的 off 闸读的是 break-config 的模块级 _level，
    // 这里只锁"没有所求就没有 subjects，预过滤直接拦下"这条形状
    expect(mightContainSettlement(HISTORY, [])).toBe(false);
  });
});

describe("拖延词表的边界（宽到误判当场应允就毁了得手这一格）", () => {
  it("当场给的字面压过推后的字面", () => {
    expect(applyOutcomeLadder("得手", "拿去吧，回头别再问我了。")).toBe("得手");
    expect(applyOutcomeLadder("得手", "喏，钱在这儿，行吧。")).toBe("得手");
    expect(applyOutcomeLadder("得手", "这就给你，好吧。")).toBe("得手");
  });

  it("真正的推后仍然判拖延", () => {
    expect(applyOutcomeLadder("得手", "行吧，等打烊了给你。")).toBe("拖延");
    expect(applyOutcomeLadder("得手", "好的，明天一定还你。")).toBe("拖延");
  });

  it("「等」不再无条件命中：作为语气词的「等」不该把当场应允拖走", () => {
    // 「等等」「等于」这类不是推后
    expect(applyOutcomeLadder("得手", "行吧，这些等于我先垫的，拿去。")).toBe("得手");
  });
});
