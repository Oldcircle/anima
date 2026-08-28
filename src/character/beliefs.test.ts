/**
 * S3 可击穿信念形状单测。
 *
 * 锁的是：
 * - normalizeBeliefs 逐字段显式映射（snake/camel 双接受；单条非法只丢那一条）
 * - 击穿判据**全机械**（六个指标各一条），零 LLM
 * - 未声明 / `ANIMA_BELIEFS=0` → 整层退场（buildSystemPrompt 逐字节回归）
 * - 击穿后 prompt 里换的是**那一行**，不是加一段
 * - 五张作者化的卡真的加载得到，且判据都是这个人真会遇到的事
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  normalizeBeliefs, beliefsToYaml, buildBeliefBlock, evaluateBeliefs, beliefsEnabled,
  type BeliefDef, type BeliefStats,
} from "./beliefs.js";
import { buildSystemPrompt } from "../agent/prompt-builder.js";
import { loadCharacterFromYAML } from "./loader.js";
import { join } from "node:path";
import type { CharacterCard } from "./types.js";

const CARDS_DIR = join(process.cwd(), "data", "characters");

const B = (over: Partial<BeliefDef> = {}): BeliefDef => ({
  id: "b1", text: "你是个累赘。",
  brokenWhen: { metric: "kept_promises", atLeast: 2 },
  whenBroken: "有人指望过你，你没搞砸。",
  ...over,
});

const STATS = (over: Partial<BeliefStats> = {}): BeliefStats => ({
  keptPromises: 0, brokenPromises: 0, refusedByOthers: 0, asksLanded: 0,
  closestBond: 0, gold: 0, ...over,
});

function makeCard(beliefs?: BeliefDef[]): CharacterCard {
  return {
    id: "t", name: "测试者", age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: ["安静"], interests: [], dislikes: [], speechStyle: "平淡" },
    background: "无", relationships: {}, beliefs,
  };
}

// 环境隔离：锁的是形状，不该被跑测时的 ambient env 掀翻
beforeEach(() => { delete process.env.ANIMA_BELIEFS; });
afterEach(() => { delete process.env.ANIMA_BELIEFS; });

describe("normalizeBeliefs（显式映射，绝不整体 cast）", () => {
  const raw = {
    id: "burden", text: "你是个累赘。",
    broken_when: { metric: "kept_promises", at_least: 2 },
    when_broken: "有人指望过你。",
  };

  it("snake_case 与 camelCase 都认", () => {
    expect(normalizeBeliefs([raw])).toEqual([B({ id: "burden", whenBroken: "有人指望过你。" })]);
    expect(normalizeBeliefs([{
      id: "burden", text: "你是个累赘。",
      brokenWhen: { metric: "kept_promises", atLeast: 2 },
      whenBroken: "有人指望过你。",
    }])![0]!.brokenWhen).toEqual({ metric: "kept_promises", atLeast: 2 });
  });

  it("单条非法只丢那一条，不拖累整组", () => {
    const out = normalizeBeliefs([raw, { id: "x", text: "y" }, { ...raw, id: "ok2" }])!;
    expect(out.map((b) => b.id)).toEqual(["burden", "ok2"]);
  });

  it("未知 metric / 非正阈值 → 丢弃（不静默当成 0）", () => {
    expect(normalizeBeliefs([{ ...raw, broken_when: { metric: "vibes", at_least: 2 } }])).toBeUndefined();
    expect(normalizeBeliefs([{ ...raw, broken_when: { metric: "gold", at_least: 0 } }])).toBeUndefined();
  });

  it("同 id 只留第一条；空数组/非数组 → undefined", () => {
    expect(normalizeBeliefs([raw, { ...raw, text: "另一句" }])).toHaveLength(1);
    expect(normalizeBeliefs([])).toBeUndefined();
    expect(normalizeBeliefs({})).toBeUndefined();
    expect(normalizeBeliefs(undefined)).toBeUndefined();
  });

  it("beliefsToYaml 与 normalize 严格互逆（回写 camelCase 会让整层静默消失）", () => {
    const defs = normalizeBeliefs([raw])!;
    expect(normalizeBeliefs(beliefsToYaml(defs))).toEqual(defs);
    expect(Object.keys(beliefsToYaml(defs)[0]!)).toContain("broken_when");
  });
});

describe("evaluateBeliefs（判据全机械，零 LLM）", () => {
  it("六个指标各自都判得动", () => {
    const cases: Array<[BeliefDef["brokenWhen"]["metric"], Partial<BeliefStats>]> = [
      ["kept_promises", { keptPromises: 2 }],
      ["broken_promises", { brokenPromises: 2 }],
      ["refused_by_others", { refusedByOthers: 2 }],
      ["asks_landed", { asksLanded: 2 }],
      ["closest_bond", { closestBond: 2 }],
      ["gold", { gold: 2 }],
    ];
    for (const [metric, s] of cases) {
      const b = B({ brokenWhen: { metric, atLeast: 2 } });
      expect(evaluateBeliefs([b], [], STATS(s)), metric).toHaveLength(1);
      expect(evaluateBeliefs([b], [], STATS()), metric).toHaveLength(0);
    }
  });

  it("差一点不算击穿（阈值是 >=）", () => {
    expect(evaluateBeliefs([B()], [], STATS({ keptPromises: 1 }))).toHaveLength(0);
    expect(evaluateBeliefs([B()], [], STATS({ keptPromises: 2 }))).toHaveLength(1);
  });

  it("已击穿的不重复报（击穿不可逆，也不重复播报）", () => {
    expect(evaluateBeliefs([B()], ["b1"], STATS({ keptPromises: 9 }))).toHaveLength(0);
  });

  it("ANIMA_BELIEFS=0 → 一条都不判", () => {
    process.env.ANIMA_BELIEFS = "0";
    expect(beliefsEnabled()).toBe(false);
    expect(evaluateBeliefs([B()], [], STATS({ keptPromises: 9 }))).toHaveLength(0);
  });
});

describe("buildBeliefBlock", () => {
  it("未击穿 → 原文；击穿 → **换成那一行**，不是加一段", () => {
    const before = buildBeliefBlock([B()], [])!;
    const after = buildBeliefBlock([B()], ["b1"])!;
    expect(before).toContain("你是个累赘。");
    expect(after).toContain("有人指望过你，你没搞砸。");
    expect(after).not.toContain("你是个累赘。");
    // 只换字不加段：行数一样
    expect(after.split("\n").length).toBe(before.split("\n").length);
  });

  it("未声明 / 空 / 关闸 → undefined（不是空串——空串 push 会砸逐字节 A/B）", () => {
    expect(buildBeliefBlock(undefined)).toBeUndefined();
    expect(buildBeliefBlock([])).toBeUndefined();
    process.env.ANIMA_BELIEFS = "0";
    expect(buildBeliefBlock([B()])).toBeUndefined();
  });

  it("块标题不与缓存断言锚点撞名", () => {
    const block = buildBeliefBlock([B()])!;
    expect(block).not.toContain("## 对话记录");
    expect(block).not.toContain("## 你现在的状态");
    expect(block).not.toContain("\n时间: ");
  });
});

describe("buildSystemPrompt 集成", () => {
  it("ANIMA_BELIEFS=0 时，有 beliefs 的卡与没有的逐字节相同（A/B 基线）", () => {
    process.env.ANIMA_BELIEFS = "0";
    expect(buildSystemPrompt(makeCard([B()]))).toBe(buildSystemPrompt(makeCard(undefined)));
  });

  it("未声明 beliefs 的卡不受影响（旧卡逐字节回归）", () => {
    const a = buildSystemPrompt(makeCard(undefined));
    process.env.ANIMA_BELIEFS = "0";
    expect(buildSystemPrompt(makeCard(undefined))).toBe(a);
  });

  it("**击穿真的改变了 system prompt**——这就是「人物会变」的全部意思", () => {
    const card = makeCard([B()]);
    const day1 = buildSystemPrompt(card, undefined, undefined, { brokenBeliefs: [] });
    const day7 = buildSystemPrompt(card, undefined, undefined, { brokenBeliefs: ["b1"] });
    expect(day1).not.toBe(day7);
    expect(day1).toContain("你是个累赘。");
    expect(day7).toContain("有人指望过你");
  });

  it("缓存纪律：同一张卡 + 同一份击穿集，两次构建逐字节一致", () => {
    const card = makeCard([B()]);
    expect(buildSystemPrompt(card, undefined, undefined, { brokenBeliefs: ["b1"] }))
      .toBe(buildSystemPrompt(card, undefined, undefined, { brokenBeliefs: ["b1"] }));
  });
});

describe("角色卡作者化", () => {
  it("五张卡的 beliefs 真的进了 card（loader 白名单漏一行就整层静默退场）", () => {
    for (const id of ["shinji", "rei", "asuka", "light", "senjougahara"]) {
      const card = loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`));
      expect(card.beliefs, id).toBeTruthy();
      expect(card.beliefs!.length, id).toBeGreaterThan(0);
      for (const b of card.beliefs!) {
        expect(b.text.length, `${id}/${b.id}`).toBeGreaterThan(0);
        expect(b.whenBroken, `${id}/${b.id}`).not.toBe(b.text);   // 击穿后必须真的不一样
        expect(b.brokenWhen.atLeast, `${id}/${b.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("阈值必须够得着（定得太高等于这个人永远不会变）", () => {
    for (const id of ["shinji", "rei", "asuka", "light", "senjougahara"]) {
      for (const b of loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`)).beliefs!) {
        const cap = b.brokenWhen.metric === "closest_bond" ? 60
          : b.brokenWhen.metric === "gold" ? 200 : 5;
        expect(b.brokenWhen.atLeast, `${id}/${b.id}`).toBeLessThanOrEqual(cap);
      }
    }
  });
});
