/**
 * S1 全链干跑（零 API，SmartMock 之外连 LLM 都不需要）：
 * 被拒 → 拒绝账本 → 执念**原地**升档 → 所求行写硬 → 档位到 2 → argue 兜底注入摊牌 intent。
 *
 * 这是这一轮最该被证明的一条：改动的意义不在"能抽出一个结果"，
 * 而在"输一次之后，下一场戏的起点真的变了"。链断在哪一节，戏就回到平局。
 *
 * 项目纪律：烧 API 之前先离线证明全链接通（失业/追求两层都是这么验的）。
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach } from "vitest";
import { Simulation } from "./simulation.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { computeAddressableDesire } from "./conversation-desire.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { setBreakLevel } from "./break-config.js";
import { DEFERRAL_GRACE_TICKS, NarrativeState, normalizeNarrativeSnapshot } from "../narrative/narrative-state.js";
import type { CharacterCard } from "../character/types.js";
import type { ExtractedSettlement, SettlementSubject } from "./settlement-extractor.js";

// 所求层的闸在 break-config 的模块级 _level（env 只在 import 时读一次），
// 钉死成 mild：这套测试锁的是升档形状，不是 off 档基线（off 基线另有专测）
beforeAll(() => setBreakLevel("mild"));

const cardA: CharacterCard = {
  id: "tomori", name: "高松灯", age: 19, occupation: "面包店学徒", home: "home_tomori",
  personality: { traits: ["内向"], interests: [], dislikes: [], speechStyle: "声音微弱" },
  background: "面包店学徒", relationships: {},
};
const cardB: CharacterCard = {
  id: "anon", name: "千早爱音", age: 19, occupation: "咖啡馆兼职", home: "home_anon",
  personality: { traits: ["开朗"], interests: [], dislikes: [], speechStyle: "活泼外向" },
  background: "咖啡馆兼职", relationships: {},
};

const SUBJECTS: SettlementSubject[] = [
  { charId: "tomori", charName: "高松灯", want: "想把借出去的钱要回来", kind: "hostile" },
];

function refused(outcome: ExtractedSettlement["outcome"] = "被拒"): ExtractedSettlement[] {
  return [{ holderId: "tomori", targetId: "anon", outcome, evidence: "我现在真的拿不出来。" }];
}

describe("S1 全链干跑：输一次之后，下一场戏的起点变了", () => {
  let world: World;
  let sim: Simulation;
  // 私有方法直呼：这条链的两个关键节都在 Simulation 内部，seam 测不到
  let call: any;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    sim = new Simulation(world, new EventBus(), {
      characters: [cardA, cardB],
      actions: ALL_BASIC_ACTIONS,
      provider: new MockLLMProvider(),
      modelId: "test",
    });
    call = sim as any;
  });

  it("第 1 节：被拒落进拒绝账本 + 关系下行 + 执念登记 + 编年史", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));

    const entry = world.narrative.getRefusal("tomori", "anon");
    expect(entry).toMatchObject({ kind: "hostile", count: 1, tier: 1 });
    // 有向：反方向没有账
    expect(world.narrative.getRefusal("anon", "tomori")).toBeUndefined();

    expect(world.narrative.getActiveObsessions("tomori", 1, 5)).toHaveLength(1);
    expect(sim.relationships.get("tomori", "anon").level).toBeLessThan(0);
    expect(world.chronicle.list().some((e) => e.emoji === "🧾")).toBe(true);
  });

  it("第 2 节：再被拒 → 档位升到 2，执念**原地**升档而不是多挂一条", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    // 注意：getActiveObsessions 返回的是活引用，要比对"改写前后"必须先拷一份
    const first = { ...world.narrative.getActiveObsessions("tomori", 1, 5)[0]! };
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(300));

    expect(world.narrative.getRefusal("tomori", "anon")!.tier).toBe(2);
    const list = world.narrative.getActiveObsessions("tomori", 3, 5);
    expect(list).toHaveLength(1);                    // 没挤爆执念池
    expect(list[0]!.id).toBe(first.id);              // 同一条
    expect(list[0]!.summary).not.toBe(first.summary); // 但话说重了
    expect(list[0]!.summary).toContain("两回");
  });

  it("第 2 节回归：升档后必须抢得到 limit=2 的曝光位（prompt 真实口径就是 2）", () => {
    // 先塞两条更"新"的别的执念，把碰壁执念挤到数组前段
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    for (const [i, id] of ["obs_other_1", "obs_other_2"].entries()) {
      world.narrative.registerObsession("tomori", {
        id, summary: `别的心事${i}`, createdDay: 2, decayDays: 5, source: "test",
      });
    }
    // 再碰一次壁 → 升档，必须挪到队尾才拿得到曝光位
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(300));

    const shown = world.narrative.getActiveObsessions("tomori", 3, 2);
    expect(shown.some((o) => o.id.includes("refusal"))).toBe(true);
  });

  it("第 3 节：账本回流所求行——同一个人下次开口，那一行写硬了", () => {
    const before = computeAddressableDesire({
      selfId: "tomori", selfCard: cardA, partnerId: "anon", partnerName: "千早爱音",
      pressureGraph: TOP_PAIR, tick: 10, day: 1,
    })!.line;

    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    const r = world.narrative.getRefusal("tomori", "anon")!;
    const after = computeAddressableDesire({
      selfId: "tomori", selfCard: cardA, partnerId: "anon", partnerName: "千早爱音",
      pressureGraph: TOP_PAIR, tick: 200, day: 3,
      refusal: { kind: r.kind, count: r.count, tier: r.tier },
    })!.line;

    expect(after).not.toBe(before);
    expect(after.startsWith(before)).toBe(true); // 只追加，不改写既有行文
    expect(after).not.toContain("\n");
  });

  it("第 4 节：档位到 2 且撞见对方 → argue 兜底注入摊牌 intent（说这条路走死了）", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(300));
    expect(world.narrative.getRefusal("tomori", "anon")!.tier).toBe(2);

    // 撞在同一地点、手上没别的心事
    world.moveCharacter("anon", "home_tomori");
    expect(world.getCurrentIntent("tomori", 500)).toBeUndefined();

    call._applyConfrontationFallback(tickToGameTime(500));

    const intent = world.getCurrentIntent("tomori", 500);
    expect(intent).toBeTruthy();
    expect(intent!.targetId).toBe("anon");
    // 「挑明」是 tool-builder 把 argue 强制上菜的词面钥匙——丢了这两个字，链就断在最后一步
    expect(intent!.summary).toContain("挑明");
    expect(intent!.summary).toContain("走死");
  });

  it("第 4 节反证：档位只有 1 且没疙瘩 → 不注入（别把每次碰壁都升级成摊牌）", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    world.moveCharacter("anon", "home_tomori");
    call._applyConfrontationFallback(tickToGameTime(500));
    expect(world.getCurrentIntent("tomori", 500)).toBeUndefined();
  });

  it("得手 → **退一档而不是清空**：误判一次只值一档，不该一键抹掉几天的阶梯", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(300));
    expect(world.narrative.getRefusal("tomori", "anon")!.tier).toBe(2);

    call._settleConversationOutcomes(refused("得手"), SUBJECTS, tickToGameTime(500));

    const after = world.narrative.getRefusal("tomori", "anon");
    expect(after).toBeTruthy();
    expect(after!.tier).toBe(1);
    // 执念还在，但话说软了
    const obs = world.narrative.getActiveObsessions("tomori", 5, 5);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.summary).toContain("这回成了");
  });

  it("退到 0 才整条摘掉（账本 + 执念一起）", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    call._settleConversationOutcomes(refused("得手"), SUBJECTS, tickToGameTime(300));

    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined();
    expect(world.narrative.getActiveObsessions("tomori", 3, 5)).toHaveLength(0);
  });

  it("和解仍是一次清空（话说开了 ≠ 单次要到了）", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(300));
    expect(world.narrative.clearRefusals("tomori", "anon", true)).toBe(1);
    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined();
  });

  it("反将比被拒更重：关系掉得更多，且额外结疙瘩", () => {
    // _addFriction 只往**已存在**的印象上追加（既有语义，B1 立场落账同款），双向各播一条
    sim.impressions.set("tomori", {
      characterId: "anon", summary: "同事", observations: [], mentalLabel: "",
      unresolved: [], frictions: [], lastUpdated: 0,
    });
    sim.impressions.set("anon", {
      characterId: "tomori", summary: "同事", observations: [], mentalLabel: "",
      unresolved: [], frictions: [], lastUpdated: 0,
    });
    const counter: ExtractedSettlement[] = [
      { holderId: "tomori", targetId: "anon", outcome: "反将", evidence: "凭什么先还你？" },
    ];
    call._settleConversationOutcomes(counter, SUBJECTS, tickToGameTime(100));

    expect(world.narrative.getRefusal("tomori", "anon")!.counterAttacks).toBe(1);
    expect(sim.relationships.get("tomori", "anon").level).toBeLessThanOrEqual(-2);
    expect(sim.impressions.get("tomori", "anon")!.frictions!.length).toBeGreaterThan(0);
    // **双向**：被将一军的记在心里，回敬的那一方也记了一笔
    expect(sim.impressions.get("anon", "tomori")!.frictions!.length).toBeGreaterThan(0);
  });

  it("被拒掉 1、反将掉 2——钉死数值，不然改成 -9 也测不出来", () => {
    const base = sim.relationships.get("tomori", "anon").level;
    call._settleConversationOutcomes(refused("被拒"), SUBJECTS, tickToGameTime(100));
    const afterRefuse = sim.relationships.get("tomori", "anon").level;
    expect(base - afterRefuse).toBe(1);

    call._settleConversationOutcomes(refused("反将"), SUBJECTS, tickToGameTime(300));
    expect(afterRefuse - sim.relationships.get("tomori", "anon").level).toBe(2);
  });

  it("刻意不结 grudge：结了会把 argue 兜底那条路自己关掉（两个兜底不互踩）", () => {
    call._settleConversationOutcomes(refused("反将"), SUBJECTS, tickToGameTime(100));
    expect(sim.relationships.get("tomori", "anon").grudge).toBeFalsy();
  });

  it("空结算不落任何账", () => {
    call._settleConversationOutcomes([], SUBJECTS, tickToGameTime(100));
    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined();
    expect(world.chronicle.list()).toHaveLength(0);
  });
});

const TOP_PAIR = {
  getTopPairFor: () => ({
    a: "tomori", b: "anon", pressure: 80,
    inputs: { activeOpenStances: 1, grudge: false, debtOverdueDays: 0, missedAppointments: 0, frictions: 0 },
  }),
} as any;

/**
 * 真实入口覆盖（对抗审查确认的 blocker）：上面所有用例都直呼内层
 * `_settleConversationOutcomes`，**跳过了入口段的三道闸**——实测把
 * off 闸 / ANIMA_SETTLEMENT 闸 / 每对每天≤1 水位三行一起删掉，全套用例照样绿。
 * 下面这组打的是入口 `_scheduleSettlementExtraction` 本身。
 */
describe("S1 真实入口：_scheduleSettlementExtraction 的三道闸", () => {
  let world: World;
  let sim: Simulation;
  let call: any;
  let llm: MockLLMProvider;
  /** provider 被调了几次 = 有没有真的烧 LLM */
  let calls: number;

  const conv = (n = 4) => ({
    charA: "tomori",
    charB: "anon",
    history: Array.from({ length: n }, (_, i) => ({
      speakerId: i % 2 ? "anon" : "tomori",
      speakerName: i % 2 ? "千早爱音" : "高松灯",
      message: i % 2 ? "我现在真的拿不出来。" : "那笔钱你什么时候还？",
      tick: 100 + i,
    })),
  });

  /** 手工往所求账本里塞一条（真实路径由 _conversationDesireFor 写入） */
  function seedDesire(selfId: string, partnerId: string) {
    (sim as any)._desireLedger.set(`${selfId}:${partnerId}`, {
      kind: "hostile", id: "d1", want: "想把钱要回来", line: "💭 …", tick: 100,
    });
  }

  beforeEach(() => {
    calls = 0;
    llm = new MockLLMProvider();
    const origChat = llm.chat.bind(llm);
    (llm as any).chat = async (...a: any[]) => { calls++; return origChat(...(a as [any, any])); };
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    sim = new Simulation(world, new EventBus(), {
      characters: [cardA, cardB], actions: ALL_BASIC_ACTIONS, provider: llm, modelId: "test",
    });
    call = sim as any;
    setBreakLevel("mild");
  });

  afterEach(() => {
    delete process.env.ANIMA_SETTLEMENT;
    setBreakLevel("mild");
  });

  it("没有任何一方有所求 → 不烧 LLM（寒暄底噪没有胜负可判）", () => {
    call._scheduleSettlementExtraction(conv(), tickToGameTime(200));
    expect(calls).toBe(0);
  });

  it("<4 句 → 不烧 LLM", () => {
    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(conv(3), tickToGameTime(200));
    expect(calls).toBe(0);
  });

  it("有所求且 ≥4 句 → 真的进抽取（证明这一层不是死代码）", () => {
    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(conv(), tickToGameTime(200));
    expect(calls).toBe(1);
  });

  it("闸①ANIMA_SETTLEMENT=0 → 整层退场，不烧 LLM", () => {
    process.env.ANIMA_SETTLEMENT = "0";
    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(conv(), tickToGameTime(200));
    expect(calls).toBe(0);
  });

  it("闸②off 档 → 整层退场（红线②治愈系 A/B 基线）", () => {
    setBreakLevel("off");
    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(conv(), tickToGameTime(200));
    expect(calls).toBe(0);
  });

  it("闸③每对每天 ≤1：同一天第二次不再烧，跨天恢复", () => {
    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(conv(), tickToGameTime(200));
    expect(calls).toBe(1);

    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(conv(), tickToGameTime(200));
    expect(calls).toBe(1); // 同一天，被水位挡住

    // 跨天（history 末句的 tick 决定 day，用 96 tick/天推到次日）
    const nextDay = { ...conv(), history: conv().history.map((e) => ({ ...e, tick: e.tick + 96 })) };
    seedDesire("tomori", "anon");
    call._scheduleSettlementExtraction(nextDay, tickToGameTime(300));
    expect(calls).toBe(2);
  });

  it("本 tick 没有对话结束 → 所求账本原样（清理只发生在对话真结束时）", () => {
    seedDesire("tomori", "anon");
    call._schedulePromiseExtraction(tickToGameTime(200));
    expect(call._desireLedger.size).toBe(1);
  });

  it("**对话真结束时账本被清**（不清会让下一场戏拿着上一场的所求误判）", () => {
    // 让 tracker 里有一场真会结束的对话：>8 tick 没新句即视为结束
    sim.conversations.recordTalk("tomori", "高松灯", "anon", "那笔钱呢？", 100);
    sim.conversations.recordTalk("anon", "千早爱音", "tomori", "等打烊。", 101);
    seedDesire("tomori", "anon");
    seedDesire("anon", "tomori");
    expect(call._desireLedger.size).toBe(2);

    call._schedulePromiseExtraction(tickToGameTime(120));   // 120-101 > 8 → 结束
    expect(call._desireLedger.size).toBe(0);
  });

  it("**清理必须排在结算抽取之后**：顺序反了整层静默死掉（subjects 恒空）", () => {
    sim.conversations.recordTalk("tomori", "高松灯", "anon", "那笔钱什么时候还？", 100);
    sim.conversations.recordTalk("anon", "千早爱音", "tomori", "等打烊了我凑一凑。", 101);
    sim.conversations.recordTalk("tomori", "高松灯", "anon", "上回你也这么说。", 102);
    sim.conversations.recordTalk("anon", "千早爱音", "tomori", "这回真的。", 103);
    seedDesire("tomori", "anon");

    let sawSubjects = -1;
    const orig = call._scheduleSettlementExtraction.bind(sim);
    call._scheduleSettlementExtraction = (conv: any, gt: any) => {
      // 抽取器跑的那一刻，账本里必须还有所求——这正是顺序的意义
      sawSubjects = call._desireLedger.size;
      return orig(conv, gt);
    };
    call._schedulePromiseExtraction(tickToGameTime(120));
    expect(sawSubjects).toBeGreaterThan(0);
  });
});

/**
 * 上游可达性（第二轮审查确认「修了内层没修外层」）：
 * 和解分支里的清账代码是对的，但 `_scheduleStanceExtraction` 的绕行钥匙原先只认
 * openStance——而结算层**刻意不建** openStance、不结 grudge。于是纯碰壁攒出来的那一对
 * 在近窗 valence 为空时压根进不了抽取，清账那段永远执行不到。
 */
describe("S1 和解清账的上游可达性", () => {
  let world: World;
  let sim: Simulation;
  let call: any;
  let calls: number;

  const reconcileConv = () => ({
    charA: "tomori", charB: "anon",
    history: [
      { speakerId: "tomori", speakerName: "高松灯", message: "那天的事……对不起。", tick: 100 },
      { speakerId: "anon", speakerName: "千早爱音", message: "我也有不对，把话说开就好了。", tick: 101 },
      { speakerId: "tomori", speakerName: "高松灯", message: "嗯。是我不对。", tick: 102 },
      { speakerId: "anon", speakerName: "千早爱音", message: "别往心里去了。", tick: 103 },
    ],
  });

  beforeEach(() => {
    calls = 0;
    const llm = new MockLLMProvider();
    const orig = llm.chat.bind(llm);
    (llm as any).chat = async (...a: any[]) => { calls++; return orig(...(a as [any, any])); };
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    sim = new Simulation(world, new EventBus(), {
      characters: [cardA, cardB], actions: ALL_BASIC_ACTIONS, provider: llm, modelId: "test",
    });
    call = sim as any;
    setBreakLevel("mild");
  });

  it("只有拒绝账（无 openStance / 无 grudge / valence 窗为空）→ 和解对话仍能进抽取", () => {
    call._settleConversationOutcomes(refused(), SUBJECTS, tickToGameTime(100));
    expect(world.narrative.getRefusal("tomori", "anon")).toBeTruthy();
    expect(world.narrative.getActiveOpenStances("tomori", "anon")).toHaveLength(0);
    expect(sim.relationships.get("tomori", "anon").grudge).toBeFalsy();

    calls = 0;
    call._scheduleStanceExtraction(reconcileConv(), tickToGameTime(400));
    expect(calls).toBe(1); // 绕行钥匙认了拒绝账
  });

  it("反证：什么账都没有 → 和解对话照旧被 valence 门挡住（不无中生有）", () => {
    calls = 0;
    call._scheduleStanceExtraction(reconcileConv(), tickToGameTime(400));
    expect(calls).toBe(0);
  });
});

/**
 * S2 拖延（结算第四格）全链干跑。
 *
 * live 实证的那场戏——明日香追真嗣还 15 金，十二个来回，真嗣自始至终**既没给也没拒，他拖**——
 * 判「未果」是对的，缺的是分类里少了这一格。拖延自带期限，所以天然可结算：
 * 到点兑现=得手，到点没兑现=**爽约**（不是没要到，是被骗了一次）。
 */
describe("S2 拖延：答应了，然后到点没做", () => {
  let world: World;
  let sim: Simulation;
  let call: any;

  const DEBT_SUBJECT: SettlementSubject[] = [
    { charId: "tomori", charName: "高松灯", want: "想把借出去的 15 金要回来", kind: "debt" },
  ];
  const deferred = (): ExtractedSettlement[] => [
    { holderId: "tomori", targetId: "anon", outcome: "拖延", evidence: "等打烊了，我把钱凑一凑还你。" },
  ];

  /** anon 欠 tomori 15 金 */
  function seedDebt(amount = 15) {
    const anon = world.getCharacter("anon")!;
    anon.debts = amount > 0 ? [{ lenderId: "tomori", amount, borrowedTick: 0 }] : [];
  }

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    sim = new Simulation(world, new EventBus(), {
      characters: [cardA, cardB], actions: ALL_BASIC_ACTIONS, provider: new MockLLMProvider(), modelId: "test",
    });
    call = sim as any;
    setBreakLevel("mild");
    seedDebt();
  });

  it("落账：立一张带到期与 baseline 的欠条，**不升档也不清账**（胜负要等到点）", () => {
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(100));
    const d = world.narrative.getDeferral("tomori", "anon")!;
    expect(d).toMatchObject({ kind: "debt", dueTick: 100 + DEFERRAL_GRACE_TICKS, baseline: 15 });
    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined(); // 还没输
    expect(world.narrative.getActiveObsessions("tomori", 1, 5)[0]!.summary).toContain("到时候看他做不做");
  });

  it("到期兑现（债真的少了）→ 等同得手：退档 + 关系上行", () => {
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(100));
    const before = sim.relationships.get("tomori", "anon").level;
    seedDebt(0);                                   // 他真还了
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));

    expect(world.narrative.getDeferral("tomori", "anon")).toBeUndefined();
    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined();
    expect(sim.relationships.get("tomori", "anon").level).toBeGreaterThan(before);
    expect(world.chronicle.list().some((e) => e.title.includes("说到做到"))).toBe(true);
  });

  it("兑现但账没退干净时：执念被改写成「说到做到」而不是整条摘掉（前面碰的壁还在）", () => {
    // 先碰两次壁，账攒到 count=2
    call._settleConversationOutcomes(refused(), DEBT_SUBJECT, tickToGameTime(100));
    call._settleConversationOutcomes(refused(), DEBT_SUBJECT, tickToGameTime(300));
    expect(world.narrative.getRefusal("tomori", "anon")!.count).toBe(2);

    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(400));
    seedDebt(0);
    call._sweepDeferrals(tickToGameTime(400 + DEFERRAL_GRACE_TICKS));

    expect(world.narrative.getRefusal("tomori", "anon")).toBeTruthy();   // 没退干净
    const obs = world.narrative.getActiveObsessions("tomori", 5, 5);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.summary).toContain("说到做到");
  });

  it("到期没兑现 → **爽约**：记拒绝 + brokenPromises + 关系掉得比普通被拒更狠", () => {
    // _addFriction 只往已存在的印象上追加（既有语义），借过钱的两个人当然有印象
    sim.impressions.set("tomori", {
      characterId: "anon", summary: "借过钱给她", observations: [], mentalLabel: "",
      unresolved: [], frictions: [], lastUpdated: 0,
    });
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(100));
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));

    const r = world.narrative.getRefusal("tomori", "anon")!;
    expect(r.brokenPromises).toBe(1);
    expect(r.count).toBe(1);
    expect(r.tier).toBe(2);                        // 爽约计入档位 → 一次就到 2
    expect(sim.relationships.get("tomori", "anon").level).toBeLessThanOrEqual(-3);
    expect(world.narrative.getActiveObsessions("tomori", 1, 5)[0]!.summary).toContain("什么都没有");
    // 疙瘩是承重的：它喂压力图谱（×8）、喂 hostileDesireLine 挑"压着的事"、
    // 也是 argue 兜底 boiling 那条入口的输入
    expect(sim.impressions.get("tomori", "anon")!.frictions!.some((f) => f.includes("到点没办"))).toBe(true);
    // 爽约那条编年史才是要端给观众看的那一下（importance≥7，面板默认可见）
    const chr = world.chronicle.list().find((e) => e.title.includes("放了空话"))!;
    expect(chr).toBeTruthy();
    expect(chr.importance).toBeGreaterThanOrEqual(7);
    expect(chr.title).toContain("第 1 回");
  });

  it("**一次爽约就够到摊牌门**（tier≥2）——这正是把平局变成戏的那一下", () => {
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(100));
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));

    world.moveCharacter("anon", "home_tomori");
    call._applyConfrontationFallback(tickToGameTime(400));
    const intent = world.getCurrentIntent("tomori", 400);
    expect(intent?.summary).toContain("挑明");
  });

  it("爽约两回 → 所求那行说得出口（全系统最锋利的一句）", () => {
    for (const t of [100, 400]) {
      seedDebt();
      call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(t));
      call._sweepDeferrals(tickToGameTime(t + DEFERRAL_GRACE_TICKS));
    }
    const r = world.narrative.getRefusal("tomori", "anon")!;
    expect(r.brokenPromises).toBe(2);

    const line = computeAddressableDesire({
      selfId: "tomori", selfCard: cardA, partnerId: "anon", partnerName: "千早爱音",
      partnerDebts: world.getCharacter("anon")!.debts,
      tick: 700, day: 7,
      refusal: { kind: r.kind, count: r.count, tier: r.tier, brokenPromises: r.brokenPromises },
    })!.line;
    expect(line).toContain("答应过你 2 回");
    expect(line).not.toContain("\n");
  });

  it("**第一次爽约**就该有专属措辞（不是复用「碰过两回钉子」）", () => {
    const line = computeAddressableDesire({
      selfId: "tomori", selfCard: cardA, partnerId: "anon", partnerName: "千早爱音",
      partnerDebts: [{ lenderId: "tomori", amount: 15, borrowedTick: 0 }],
      tick: 700, day: 7,
      refusal: { kind: "debt", count: 1, tier: 2, brokenPromises: 1 },
    })!.line;
    expect(line).toContain("上回他答应得好好的");
    expect(line).not.toContain("两回钉子");
  });

  it("pendingDeferral 只对**同类**所求生效（借钱的欠条不该软化闲聊那行）", () => {
    const base = {
      selfId: "tomori", selfCard: cardA, partnerId: "anon", partnerName: "千早爱音",
      partnerDebts: [{ lenderId: "tomori", amount: 15, borrowedTick: 0 }],
      tick: 700, day: 7,
    };
    const plain = computeAddressableDesire(base)!.line;
    // 异类欠条（bond）不该碰 debt 那行
    expect(computeAddressableDesire({
      ...base,
      pendingDeferral: { kind: "bond", evidence: "回头一起去海边", dueTick: 900 },
    })!.line).toBe(plain);
    // 同类欠条才软化
    expect(computeAddressableDesire({
      ...base,
      pendingDeferral: { kind: "debt", evidence: "等打烊了还你", dueTick: 900 },
    })!.line).toContain("还没到点");
  });

  it("欠条未到期时，所求那行是「等着」不是「碰壁」（这时候硬起来是不讲理）", () => {
    // 债务要逾期 2 天（192 tick）才成为所求，所以时间轴要推到那之后
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(300));
    const d = world.narrative.getDeferral("tomori", "anon")!;
    expect(d.dueTick).toBeGreaterThan(320);
    const line = computeAddressableDesire({
      selfId: "tomori", selfCard: cardA, partnerId: "anon", partnerName: "千早爱音",
      partnerDebts: world.getCharacter("anon")!.debts, tick: 320, day: 3,
      pendingDeferral: { kind: d.kind, evidence: d.evidence, dueTick: d.dueTick },
    })!.line;
    expect(line).toContain("还没到点");
    expect(line).not.toContain("钉子");
  });

  it("核验不了的 kind（非债务）→ 到点静默过期，绝不凭 LLM 自评判兑现", () => {
    call._settleConversationOutcomes(
      [{ holderId: "tomori", targetId: "anon", outcome: "拖延", evidence: "回头再说吧。" }],
      [{ charId: "tomori", charName: "高松灯", want: "想约他一起去海边", kind: "bond" }],
      tickToGameTime(100),
    );
    expect(world.narrative.getDeferral("tomori", "anon")!.baseline).toBeUndefined();
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));
    expect(world.narrative.getDeferral("tomori", "anon")).toBeUndefined();
    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined(); // 不判胜负
  });

  it("接线回归：**真实 tick** 会跑到期扫描（直呼私有方法测不出接线）", async () => {
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(100));
    expect(world.narrative.getDeferral("tomori", "anon")).toBeTruthy();

    // 让两个角色本 tick 什么都不做，只验扫描有没有被 tick 主循环调到
    const llm = (sim as any)._provider as MockLLMProvider;
    llm.setDefaultResponse("", [{ name: "do_nothing", arguments: { reason: "发呆" } }]);
    await sim.runOneTick(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));

    expect(world.narrative.getDeferral("tomori", "anon")).toBeUndefined();
    expect(world.narrative.getRefusal("tomori", "anon")?.brokenPromises).toBe(1);
  });

  it("随档 round-trip：欠条活得过存读", () => {
    call._settleConversationOutcomes(deferred(), DEBT_SUBJECT, tickToGameTime(100));
    const revived = new NarrativeState(
      normalizeNarrativeSnapshot(JSON.parse(JSON.stringify(world.narrative.getSnapshot()))),
    );
    expect(revived.getDeferral("tomori", "anon")).toMatchObject({ kind: "debt", baseline: 15 });
  });
});

/** 对抗审查第二轮确认项的回归锁（每条都对应一个"改坏了曾经全绿"的地方） */
describe("S2 加固回归", () => {
  let world: World; let sim: Simulation; let call: any;
  const SUB: SettlementSubject[] = [
    { charId: "tomori", charName: "高松灯", want: "想把借出去的 15 金要回来", kind: "debt" },
  ];
  const DEBTOR_SUB: SettlementSubject[] = [
    { charId: "anon", charName: "千早爱音", want: "想跟高松灯把欠的钱拖一拖", kind: "debt" },
  ];
  const defer = (from: string, to: string): ExtractedSettlement[] =>
    [{ holderId: from, targetId: to, outcome: "拖延", evidence: "等打烊了，我把钱凑一凑还你。" }];

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    sim = new Simulation(world, new EventBus(), {
      characters: [cardA, cardB], actions: ALL_BASIC_ACTIONS, provider: new MockLLMProvider(), modelId: "test",
    });
    call = sim as any;
    setBreakLevel("mild");
    world.getCharacter("anon")!.debts = [{ lenderId: "tomori", amount: 15, borrowedTick: 0 }];
  });

  it("**全额还清（债记录整条消失）判兑现**，不是爽约", () => {
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(100));
    world.getCharacter("anon")!.debts = [];          // repay_debt 是 filter 掉整条
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));
    expect(world.narrative.getRefusal("tomori", "anon")).toBeUndefined();
    expect(world.chronicle.list().some((e) => e.title.includes("说到做到"))).toBe(true);
  });

  it("**欠债人向的欠条不记 baseline**：承诺方是债主，他的「宽限」没有机械动作可测", () => {
    call._settleConversationOutcomes(defer("anon", "tomori"), DEBTOR_SUB, tickToGameTime(100));
    expect(world.narrative.getDeferral("anon", "tomori")!.baseline).toBeUndefined();
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));
    // 静默过期，绝不因为"欠债人自己没还钱"去判债主爽约
    expect(world.narrative.getRefusal("anon", "tomori")).toBeUndefined();
  });

  it("立约那刻账已清 → 不记 baseline（记了必判爽约：now=0 不小于 baseline=0）", () => {
    world.getCharacter("anon")!.debts = [];
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(100));
    expect(world.narrative.getDeferral("tomori", "anon")!.baseline).toBeUndefined();
  });

  it("**未到期再答应一次不能续期**（否则是无限拖的免罪符）", () => {
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(100));
    const first = { ...world.narrative.getDeferral("tomori", "anon")! };
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(150));
    const second = world.narrative.getDeferral("tomori", "anon")!;
    expect(second.dueTick).toBe(first.dueTick);
    expect(second.baseline).toBe(first.baseline);
  });

  it("到期之后再答应 → 才是一张新欠条", () => {
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(100));
    const first = { ...world.narrative.getDeferral("tomori", "anon")! };
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(100 + DEFERRAL_GRACE_TICKS + 1));
    expect(world.narrative.getDeferral("tomori", "anon")!.dueTick).toBeGreaterThan(first.dueTick);
  });

  it("立欠条会刷新拒绝账 lastTick（欠条悬着时 TTL 日扫不该先把阶梯抹掉）", () => {
    world.narrative.recordRefusal({ fromId: "tomori", toId: "anon", kind: "debt", tick: 10 });
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(400));
    expect(world.narrative.getRefusal("tomori", "anon")!.lastTick).toBe(400);
  });

  it("**得手退档时爽约计数也退**，否则爽约过的对永远退不下来", () => {
    const ns = world.narrative;
    ns.recordRefusal({ fromId: "tomori", toId: "anon", kind: "debt", tick: 10, brokenPromise: true });
    ns.recordRefusal({ fromId: "tomori", toId: "anon", kind: "debt", tick: 20, brokenPromise: true });
    expect(ns.getRefusal("tomori", "anon")).toMatchObject({ count: 2, brokenPromises: 2, tier: 3 });

    const eased = ns.easeRefusal("tomori", "anon", 30)!;
    expect(eased.brokenPromises).toBe(1);
    expect(eased.tier).toBe(2);      // 3 → 2，真的退了一档
  });

  it("ANIMA_SETTLEMENT=0 时到期扫描整层退场（存档里的欠条不该照样结算）", () => {
    call._settleConversationOutcomes(defer("tomori", "anon"), SUB, tickToGameTime(100));
    process.env.ANIMA_SETTLEMENT = "0";
    try {
      call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));
      expect(world.narrative.getDeferral("tomori", "anon")).toBeTruthy();  // 原封不动
    } finally {
      delete process.env.ANIMA_SETTLEMENT;
    }
  });
});

/**
 * S3 全链干跑：世界里真发生的事 → 击穿信念 → **system prompt 变了**。
 * 这是「人物会变」的全部意思——第七天的他和第一天读到的自我认知不一样，
 * 而且不一样的原因是账本上有据可查的事，不是随机漂移。
 */
describe("S3 信念击穿全链", () => {
  let world: World; let sim: Simulation; let call: any;
  const believer: CharacterCard = {
    ...cardA,
    beliefs: [{
      id: "burden", text: "你是个累赘。",
      brokenWhen: { metric: "kept_promises", atLeast: 2 },
      whenBroken: "有人指望过你，你没搞砸。",
    }],
  };
  const SUB: SettlementSubject[] = [
    { charId: "anon", charName: "千早爱音", want: "想把借出去的 15 金要回来", kind: "debt" },
  ];
  /** tomori 欠 anon 的钱；tomori 答应还，到点真还了 = tomori 兑现一次 */
  const deferByTomori = (): ExtractedSettlement[] =>
    [{ holderId: "anon", targetId: "tomori", outcome: "拖延", evidence: "等打烊了，我把钱凑一凑还你。" }];

  function oweAgain(amount = 15) {
    world.getCharacter("tomori")!.debts = [{ lenderId: "anon", amount, borrowedTick: 0 }];
  }

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    sim = new Simulation(world, new EventBus(), {
      characters: [believer, cardB], actions: ALL_BASIC_ACTIONS, provider: new MockLLMProvider(), modelId: "test",
    });
    call = sim as any;
    setBreakLevel("mild");
    delete process.env.ANIMA_BELIEFS;   // 环境隔离，同上
  });

  it("兑现一次不够，两次才击穿（判据是机械计数，不是氛围）", () => {
    oweAgain();
    call._settleConversationOutcomes(deferByTomori(), SUB, tickToGameTime(100));
    world.getCharacter("tomori")!.debts = [];
    call._sweepDeferrals(tickToGameTime(100 + DEFERRAL_GRACE_TICKS));
    expect(world.narrative.getBeliefCounters("tomori").keptPromises).toBe(1);

    call._sweepBeliefs(tickToGameTime(300));
    expect(world.narrative.getBrokenBeliefs("tomori")).toHaveLength(0);   // 差一次

    oweAgain();
    call._settleConversationOutcomes(deferByTomori(), SUB, tickToGameTime(400));
    world.getCharacter("tomori")!.debts = [];
    call._sweepDeferrals(tickToGameTime(400 + DEFERRAL_GRACE_TICKS));
    call._sweepBeliefs(tickToGameTime(600));

    expect(world.narrative.getBrokenBeliefs("tomori")).toEqual(["burden"]);
  });

  it("**击穿之后 system prompt 真的换了那一行**", () => {
    const before = buildSystemPrompt(believer, undefined, undefined, {
      brokenBeliefs: world.narrative.getBrokenBeliefs("tomori"),
    });
    world.narrative.breakBelief("tomori", "burden");
    const after = buildSystemPrompt(believer, undefined, undefined, {
      brokenBeliefs: world.narrative.getBrokenBeliefs("tomori"),
    });
    expect(before).toContain("你是个累赘。");
    expect(after).not.toContain("你是个累赘。");
    expect(after).toContain("有人指望过你");
  });

  it("击穿落 imp9 长期记忆 + 编年史（这是这个人一生里的大事）", () => {
    world.narrative.bumpBeliefCounter("tomori", "keptPromises", 2);
    call._sweepBeliefs(tickToGameTime(300));
    expect(sim.longTerm.all("tomori").some((m: any) => m.importance >= 9)).toBe(true);
    expect(world.chronicle.list().some((e) => e.emoji === "🫀")).toBe(true);
  });

  it("**击穿不可逆**：再扫一遍不重复播报，计数回落也不恢复", () => {
    world.narrative.bumpBeliefCounter("tomori", "keptPromises", 2);
    call._sweepBeliefs(tickToGameTime(300));
    const chronCount = world.chronicle.list().filter((e) => e.emoji === "🫀").length;

    call._sweepBeliefs(tickToGameTime(400));
    expect(world.chronicle.list().filter((e) => e.emoji === "🫀").length).toBe(chronCount);

    world.narrative.bumpBeliefCounter("tomori", "keptPromises", -5);
    call._sweepBeliefs(tickToGameTime(500));
    expect(world.narrative.getBrokenBeliefs("tomori")).toEqual(["burden"]);
  });

  it("被拒也会记账（另一个方向的判据源）", () => {
    call._settleConversationOutcomes(
      [{ holderId: "tomori", targetId: "anon", outcome: "被拒", evidence: "我现在真的拿不出来。" }],
      [{ charId: "tomori", charName: "高松灯", want: "想借点钱", kind: "debt" }],
      tickToGameTime(100),
    );
    expect(world.narrative.getBeliefCounters("tomori").refusedByOthers).toBe(1);
  });

  it("ANIMA_BELIEFS=0 → 日扫整层退场", () => {
    world.narrative.bumpBeliefCounter("tomori", "keptPromises", 9);
    process.env.ANIMA_BELIEFS = "0";
    try {
      call._sweepBeliefs(tickToGameTime(300));
      expect(world.narrative.getBrokenBeliefs("tomori")).toHaveLength(0);
    } finally { delete process.env.ANIMA_BELIEFS; }
  });

  it("接线回归：**真实 06:00 tick** 会跑击穿扫描（直呼私有方法测不出接线）", async () => {
    world.narrative.bumpBeliefCounter("tomori", "keptPromises", 2);
    const llm = (sim as any)._provider as MockLLMProvider;
    llm.setDefaultResponse("", [{ name: "do_nothing", arguments: { reason: "发呆" } }]);

    // 06:00 = 每天的第 24 tick（1 tick = 15 分钟）
    await sim.runOneTick(tickToGameTime(96 + 24));
    expect(world.narrative.getBrokenBeliefs("tomori")).toEqual(["burden"]);
  });

  it("随档 round-trip：击穿记录与计数都活得过存读", () => {
    world.narrative.bumpBeliefCounter("tomori", "keptPromises", 2);
    world.narrative.breakBelief("tomori", "burden");
    const revived = new NarrativeState(
      normalizeNarrativeSnapshot(JSON.parse(JSON.stringify(world.narrative.getSnapshot()))),
    );
    expect(revived.getBrokenBeliefs("tomori")).toEqual(["burden"]);
    expect(revived.getBeliefCounters("tomori").keptPromises).toBe(2);
  });
});
