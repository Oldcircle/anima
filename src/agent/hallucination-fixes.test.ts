/**
 * 幻觉修复回归测试（牛奶债案的三道闸）
 *
 * ① 口头交易落账：对话里"当场交割"的钱/物 → 抽取 → 机械结算（空头支票账本不认）
 * ② give 支持给金币：真金白银第一次有合法转移路径
 * ③ 防编造闸进 system prompt（全模式）；印象/观察推理接地
 * ④ 晨间打算可供性锚
 */

import { describe, it, expect } from "vitest";
import {
  mightContainTransaction, extractTransaction,
} from "./promise-extractor.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { runAgentTick } from "./agent-loop.js";
import { Simulation } from "./simulation.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { RelationshipManager } from "../world/relationships.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { addToInventory, hasItem } from "../world/item-registry.js";
import type { CharacterCard } from "../character/types.js";
import type { ConversationExchange } from "./conversation-mode.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 19, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function exchange(speakerId: string, speakerName: string, message: string, tick = 40): ConversationExchange {
  return { speakerId, speakerName, message, tick };
}

function makeSim() {
  const world = new World(TEST_LOCATIONS, 40);
  world.addCharacter("tomori", "高松灯", "plaza");
  world.addCharacter("anon", "千早爱音", "plaza");
  const sim = new Simulation(world, new EventBus(), {
    characters: [makeCard("tomori", "高松灯"), makeCard("anon", "千早爱音")],
    actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(),
    modelId: "test",
  });
  return { world, sim };
}

describe("口头交易抽取", () => {
  it("预过滤：没有交割词的对话不烧 LLM", () => {
    expect(mightContainTransaction([
      exchange("a", "A", "今天天气不错"),
      exchange("b", "B", "是啊"),
    ])).toBe(false);
    expect(mightContainTransaction([
      exchange("a", "A", "牛奶钱4个金币，一分不能少"),
      exchange("b", "B", "给你"),
    ])).toBe(true);
  });

  it("抽取：解析给的人/金额；金额离谱丢弃；没交割返回 null", async () => {
    const provider = new MockLLMProvider();
    const base = {
      history: [exchange("tomori", "高松灯", "4个金币，给你"), exchange("anon", "千早爱音", "收下了")],
      charAId: "tomori", charAName: "高松灯", charBId: "anon", charBName: "千早爱音",
      provider, modelId: "test",
    };

    provider.enqueueResponse("交割: 有\n给的人: 高松灯\n金额: 4\n物品: 无");
    expect(await extractTransaction(base)).toEqual({ fromId: "tomori", toId: "anon", gold: 4, itemName: undefined, qty: 1 });

    provider.enqueueResponse("交割: 有\n给的人: 千早爱音\n金额: 0\n物品: 可颂");
    expect(await extractTransaction(base)).toEqual({ fromId: "anon", toId: "tomori", gold: 0, itemName: "可颂", qty: 1 });

    // 半日实测实锤：物品名带数量注释也要能解析
    provider.enqueueResponse("交割: 有\n给的人: 千早爱音\n金额: 0\n物品: 可颂（三个）");
    expect(await extractTransaction(base)).toEqual({ fromId: "anon", toId: "tomori", gold: 0, itemName: "可颂", qty: 3 });

    provider.enqueueResponse("交割: 有\n给的人: 高松灯\n金额: 5000\n物品: 无");
    expect(await extractTransaction(base)).toBeNull(); // 离谱金额=抽取失误

    provider.enqueueResponse("交割: 没有");
    expect(await extractTransaction(base)).toBeNull();
  });
});

describe("口头交易结算", () => {
  it("金币：以身上的钱为限转移；分文没有=空头支票不结算", () => {
    const { world, sim } = makeSim();
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    t.gold = 3;
    a.gold = 10;

    (sim as any)._settleSpokenTransaction({ fromId: "tomori", toId: "anon", gold: 4 }, tickToGameTime(40));
    expect(t.gold).toBe(0);  // 口头说 4，身上只有 3，给 3
    expect(a.gold).toBe(13);

    t.gold = 0;
    (sim as any)._settleSpokenTransaction({ fromId: "tomori", toId: "anon", gold: 4 }, tickToGameTime(41));
    expect(a.gold).toBe(13); // 空头支票，账本不认
  });

  it("物品：真持有才转移；世界里不存在的物品（牛奶）不落账", () => {
    const { world, sim } = makeSim();
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    addToInventory(t.inventory, "croissant", 1);

    (sim as any)._settleSpokenTransaction({ fromId: "tomori", toId: "anon", gold: 0, itemName: "可颂" }, tickToGameTime(40));
    expect(hasItem(t.inventory, "croissant")).toBe(false);
    expect(hasItem(a.inventory, "croissant")).toBe(true);

    // 牛奶：注册表里没有 → 无法落账（不 throw、不凭空造物）
    (sim as any)._settleSpokenTransaction({ fromId: "tomori", toId: "anon", gold: 0, itemName: "牛奶" }, tickToGameTime(41));
    expect(a.inventory.length).toBe(1);

    // 说给却没有 → 不落账
    (sim as any)._settleSpokenTransaction({ fromId: "tomori", toId: "anon", gold: 0, itemName: "吉他" }, tickToGameTime(42));
    expect(hasItem(a.inventory, "guitar")).toBe(false);
  });

  it("柜台代买：店员口头卖自家货架商品 → 按 buy 语义结算（付钱+扣库存+进背包）", () => {
    const { world, sim } = makeSim();
    const t = world.getCharacter("tomori")!;   // 店员（cafe 卖三明治 12 金）
    const a = world.getCharacter("anon")!;     // 买家
    t.life = { ...(t.life as any), workplace: "cafe" } as any;
    a.gold = 30;
    const cafe = world.getLocation("cafe")!;
    cafe.stock = { sandwich: 5 };

    (sim as any)._settleSpokenTransaction(
      { fromId: "tomori", toId: "anon", gold: 0, itemName: "三明治", qty: 2 },
      tickToGameTime(40),
    );

    expect(a.gold).toBe(6);                    // 30 - 12×2
    expect(hasItem(a.inventory, "sandwich")).toBe(true);
    expect(cafe.stock.sandwich).toBe(3);

    // 钱不够买满：有多少钱买多少
    (sim as any)._settleSpokenTransaction(
      { fromId: "tomori", toId: "anon", gold: 0, itemName: "三明治", qty: 3 },
      tickToGameTime(41),
    );
    expect(a.gold).toBe(6 - 0); // 6 金买不起 12 金一份 → 0 份，账本不认
    expect(cafe.stock.sandwich).toBe(3);
  });

  it("防重复：对话窗口内已有机制层真实转移（give）→ 不再落账", () => {
    const { sim } = makeSim();
    // 模拟 give 在 tick 41 真实发生过（在对话窗口 [40, ...] 内）
    (sim as any)._promoteConflictsToLongTerm([{
      characterId: "tomori", thought: "",
      action: { name: "give", args: { target: "anon", gold: 4 } },
      result: { description: "把 4 金币给了anon", effects: [] },
    }], tickToGameTime(41));
    expect((sim as any)._pairTransferTick.get("anon:tomori")).toBe(41);

    // 结算调度看到窗口内已有真实转移 → 直接跳过（不排后台任务）
    const before = (sim as any)._backgroundTasks.size;
    (sim as any)._scheduleTransactionSettlement({
      charA: "tomori", charB: "anon",
      history: [exchange("tomori", "高松灯", "4个金币给你", 40), exchange("anon", "千早爱音", "收下了", 41)],
    }, tickToGameTime(50));
    expect((sim as any)._backgroundTasks.size).toBe(before);
  });
});

describe("give 给金币（合法转移路径）", () => {
  it("钱够：真转账 + 对方 inbox 有感知；钱不够：拒绝", async () => {
    const { world } = makeSim();
    const t = world.getCharacter("tomori")!;
    const a = world.getCharacter("anon")!;
    t.gold = 10;
    a.gold = 0;

    const provider = new MockLLMProvider();
    provider.enqueueResponse("把牛奶钱还了", [{ id: "c1", name: "give", arguments: { target: "anon", gold: 4 } }]);
    await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(40),
      relationships: new RelationshipManager(),
    });
    expect(t.gold).toBe(6);
    expect(a.gold).toBe(4);
    expect(a.inbox.some((m) => m.content.includes("4 金币"))).toBe(true);

    // 钱不够
    t.currentAction = undefined;
    provider.enqueueResponse("再给点", [{ id: "c2", name: "give", arguments: { target: "anon", gold: 100 } }]);
    const r = await runAgentTick({
      config: { card: makeCard("tomori", "高松灯"), actions: [], provider, modelId: "test" },
      world, eventBus: new EventBus(), gameTime: tickToGameTime(42),
      relationships: new RelationshipManager(),
    });
    expect(r.result?.success).toBe(false);
    expect(t.gold).toBe(6);
  });
});

describe("防编造闸（prompt 侧）", () => {
  it("system prompt 含真实边界块（全模式生效，含对话模式）", () => {
    const sys = buildSystemPrompt(makeCard("tomori", "高松灯"));
    expect(sys).toContain("真实边界");
    expect(sys).toContain("给不出去");
    expect(sys).toContain("不在这个镇上");
  });
});
