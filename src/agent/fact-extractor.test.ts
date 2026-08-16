/**
 * M2 懒实体化正典裁决（PLAN-grounding）单测
 *
 * 锁形状：
 * - 预过滤 mentionedObjects：<4句/无命中零调用；关键词命中；地点撞名优先；上限 3
 * - 抽取防线：no_claim / evidence 逐字+归属 / 人名升档（detail→hidden）/
 *   contradict 行号校验（无效降档）/ 坏 JSON 不崩
 * - 三规裁决：①detail 首述即正典（examine 立刻查得到=闭环）+与既有正典去重
 *   ②hidden 持有推导 verified/false、推不出 rumor ③contradict 挂账正典不动
 * - claims 账本快照往返
 */

import { describe, it, expect } from "vitest";
import {
  mentionedObjects,
  extractFacts,
  settleExtractedFacts,
  type ExtractedFact,
} from "./fact-extractor.js";
import { WorldObjectStore } from "../world/world-objects.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import type { ConversationExchange } from "./conversation-mode.js";

// ── 测试基建 ──

function makeStore(): WorldObjectStore {
  const store = new WorldObjectStore();
  store.registerLocation({
    id: "library",
    objects: [
      {
        id: "ledger", name: "借阅台账", summary: "前台那本厚台账",
        keywords: ["台账", "借阅", "记录"], canon: ["台账按月换页"], tamperable: true,
      },
      { id: "desk", name: "阅览桌", keywords: ["阅览桌"] },
    ],
  });
  store.registerLocation({
    id: "cafe",
    objects: [{ id: "register", name: "收银台", keywords: ["收银"] }],
  });
  return store;
}

function exchange(speakerId: string, speakerName: string, message: string, tick = 10): ConversationExchange {
  return { speakerId, speakerName, message, tick, locationId: "library" } as ConversationExchange;
}

/** ≥4 句的对话，最后一句可指定 */
function makeHistory(lastMessage: string, lastSpeaker: [string, string] = ["l", "L"]): ConversationExchange[] {
  return [
    exchange("l", "L", "早上好。"),
    exchange("light", "夜神月", "早。"),
    exchange("l", "L", "今天天气不错。"),
    exchange(lastSpeaker[0], lastSpeaker[1], lastMessage),
  ];
}

const SPEAKERS = [
  { id: "l", name: "L" },
  { id: "light", name: "夜神月" },
];
const CAST = new Map([
  ["L", "l"],
  ["夜神月", "light"],
  ["碇真嗣", "shinji"],
]);

async function runExtract(store: WorldObjectStore, history: ConversationExchange[], mockJson: string) {
  const provider = new MockLLMProvider();
  provider.enqueueResponse(mockJson);
  const objects = mentionedObjects(history, store, "library", ["library", "cafe"]);
  return {
    facts: await extractFacts({ history, objects, speakers: SPEAKERS, castNames: CAST, provider, modelId: "mock" }),
    provider,
  };
}

// ── 预过滤 ──

describe("mentionedObjects 预过滤", () => {
  it("<4 句 / 无词面命中 → 空（不烧 LLM）", () => {
    const store = makeStore();
    expect(mentionedObjects([exchange("l", "L", "台账呢")], store, "library", ["library"])).toEqual([]);
    expect(mentionedObjects(makeHistory("随便聊聊"), store, "library", ["library", "cafe"])).toEqual([]);
  });

  it("名字/关键词命中；跨地点也认；同名优先对话所在地点", () => {
    const store = makeStore();
    const hits = mentionedObjects(makeHistory("我去查过借阅记录了，另外咖啡馆收银台边上那枚外国硬币还在"), store, "library", ["library", "cafe"]);
    expect(hits.map((o) => o.key)).toContain("library.ledger");
    expect(hits.map((o) => o.key)).toContain("cafe.register");
  });
});

// ── 抽取防线 ──

describe("extractFacts 防线", () => {
  it("no_claim / 坏 JSON → []", async () => {
    const store = makeStore();
    const h = makeHistory("台账的事回头再说。");
    expect((await runExtract(store, h, '{"claims":[{"kind":"no_claim"}]}')).facts).toEqual([]);
    expect((await runExtract(store, h, "这不是JSON")).facts).toEqual([]);
  });

  it("detail 快乐路径：evidence 逐字+归属通过", async () => {
    const store = makeStore();
    const h = makeHistory("阅览桌的桌腿垫着一枚旧硬币。");
    const { facts } = await runExtract(
      store, h,
      '{"claims":[{"kind":"detail","object":"阅览桌","speaker":"L","claim":"阅览桌的桌腿垫着一枚旧硬币","evidence":"阅览桌的桌腿垫着一枚旧硬币。","contradict_index":-1}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("detail");
    expect(facts[0]!.objectKey).toBe("library.desk");
    expect(facts[0]!.speakerId).toBe("l");
  });

  it("evidence 不逐字 / 归属错误 → 丢弃", async () => {
    const store = makeStore();
    const h = makeHistory("阅览桌的桌腿垫着一枚旧硬币。"); // L 说的
    const notVerbatim = await runExtract(
      store, h,
      '{"claims":[{"kind":"detail","object":"阅览桌","speaker":"L","claim":"桌腿垫硬币","evidence":"桌腿下面垫了枚硬币","contradict_index":-1}]}',
    );
    expect(notVerbatim.facts).toEqual([]);
    const wrongSpeaker = await runExtract(
      store, h,
      '{"claims":[{"kind":"detail","object":"阅览桌","speaker":"夜神月","claim":"桌腿垫硬币","evidence":"阅览桌的桌腿垫着一枚旧硬币。","contradict_index":-1}]}',
    );
    expect(wrongSpeaker.facts).toEqual([]);
  });

  it("人名升档：detail 断言含 cast 人名 → 强制 hidden", async () => {
    const store = makeStore();
    const h = makeHistory("台账上碇真嗣的名字挂了三个月了。");
    const { facts } = await runExtract(
      store, h,
      '{"claims":[{"kind":"detail","object":"借阅台账","speaker":"L","claim":"台账上碇真嗣的名字挂了三个月","evidence":"台账上碇真嗣的名字挂了三个月了。","contradict_index":-1}]}',
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("hidden"); // 关于人的细节不是器物细节
  });

  it("contradict 行号校验：有效行号带正典原文；无效行号降档 hidden", async () => {
    const store = makeStore();
    const h = makeHistory("这台账根本不按月换页，一年才换一次。");
    const valid = await runExtract(
      store, h,
      '{"claims":[{"kind":"contradict","object":"借阅台账","speaker":"L","claim":"台账一年才换一次页","evidence":"这台账根本不按月换页，一年才换一次。","contradict_index":0}]}',
    );
    expect(valid.facts[0]!.kind).toBe("contradict");
    expect(valid.facts[0]!.contradictText).toBe("台账按月换页");

    const invalid = await runExtract(
      store, h,
      '{"claims":[{"kind":"contradict","object":"借阅台账","speaker":"L","claim":"台账一年才换一次页","evidence":"这台账根本不按月换页，一年才换一次。","contradict_index":99}]}',
    );
    expect(invalid.facts[0]!.kind).toBe("hidden");
  });
});

// ── 三规裁决 ──

describe("settleExtractedFacts 三规", () => {
  const deps = (store: WorldObjectStore, inventory: Array<{ defId: string; quantity: number }> = []) => ({
    store,
    getCharacter: (id: string) =>
      id === "shinji" ? { inventory: inventory as any, name: "碇真嗣" } : undefined,
    tick: 100,
  });

  it("规则①：detail 首述即正典——examine 立刻查得到（闭环）；复述既有正典不重复落", () => {
    const store = makeStore();
    const fact: ExtractedFact = {
      kind: "detail", speakerId: "l", objectKey: "library.desk",
      claim: "阅览桌的桌腿垫着一枚旧硬币", evidence: "…",
    };
    const settled = settleExtractedFacts(deps(store), [fact]);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.verdict).toBe("canonized");
    // 闭环：别人 examine 阅览桌能看到这条正典
    expect(store.examine("library.desk", "light", 101)).toContain("旧硬币");
    // 复述去重
    const again = settleExtractedFacts(deps(store), [{ ...fact, claim: "阅览桌的桌腿垫着一枚旧硬币" }]);
    expect(again).toEqual([]);
  });

  it("规则②：hidden 持有推导——持有=verified / 不持有=false / 解析不出=rumor", () => {
    const store = makeStore();
    const base: Omit<ExtractedFact, "aboutCharacterId" | "aboutItem"> = {
      kind: "hidden", speakerId: "light", objectKey: "library.ledger",
      claim: "吉他在碇真嗣手上", evidence: "…",
    };
    // 真持有 → verified
    const verified = settleExtractedFacts(
      deps(store, [{ defId: "guitar", quantity: 1 }]),
      [{ ...base, aboutCharacterId: "shinji", aboutItem: "吉他" }],
    );
    expect(verified[0]!.verdict).toBe("verified");
    // 不持有 → false（与世界不符）
    const falsy = settleExtractedFacts(
      deps(store, []),
      [{ ...base, claim: "笔记本在碇真嗣手上", aboutCharacterId: "shinji", aboutItem: "笔记本" }],
    );
    expect(falsy[0]!.verdict).toBe("false");
    // 人/物解析不出 → rumor 死胡同
    const rumor = settleExtractedFacts(deps(store), [{ ...base, claim: "有人半夜翻过台账" }]);
    expect(rumor[0]!.verdict).toBe("rumor");
  });

  it("规则③：contradict 挂账、正典一个字不动", () => {
    const store = makeStore();
    const before = store.get("library.ledger")!.canonFacts.map((f) => f.text);
    const settled = settleExtractedFacts(deps(store), [
      {
        kind: "contradict", speakerId: "light", objectKey: "library.ledger",
        claim: "台账一年才换一次页", evidence: "…", contradictText: "台账按月换页",
      },
    ]);
    expect(settled[0]!.verdict).toBe("contradict");
    expect(store.get("library.ledger")!.canonFacts.map((f) => f.text)).toEqual(before);
    expect(store.getClaims({ verdict: "contradict" })).toHaveLength(1);
  });

  it("claims 账本快照往返", () => {
    const store = makeStore();
    settleExtractedFacts(deps(store), [
      { kind: "detail", speakerId: "l", objectKey: "library.desk", claim: "桌面朝窗一侧褪色更重", evidence: "…" },
    ]);
    const snap = JSON.parse(JSON.stringify(store.getSnapshot()));
    const fresh = makeStore();
    fresh.replaceSnapshot(snap);
    expect(fresh.getClaims()).toHaveLength(1);
    expect(fresh.getClaims()[0]!.verdict).toBe("canonized");
    // 正典也随 objects 部分恢复
    expect(fresh.examine("library.desk", "x", 1)).toContain("褪色");
  });
});
