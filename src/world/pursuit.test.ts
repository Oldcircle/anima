/**
 * 追求单测 —— 世界的「方向」。
 *
 * 锁四件（每一条都是"退回成一句漂亮话"的防线）：
 * ①**进度从真实世界状态读**，四种口径都真的量得出来
 * ②达成/错过是**一次性不可逆**——结算过就不再返回，不能重来
 * ③**到期即失败**，哪怕只差一点（日子不等人）
 * ④注入文案只报进度与剩余时间，**不给建议**（怎么够归角色）
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  normalizePursuit, readProgress, settlePursuit, describePursuit, pursuitsEnabled,
  type PursuitState,
} from "./pursuit.js";
import type { CharacterState } from "./types.js";

function who(over: Partial<CharacterState> = {}): CharacterState {
  return {
    id: "me", name: "我", locationId: "cafe", gold: 0,
    needs: { hunger: 80, energy: 80, social: 80, fun: 80, hygiene: 80 },
    inventory: [], life: { occupation: "店员", workplace: "cafe", age: 20, income: 12, skills: {}, aspiration: "" },
    ...over,
  } as unknown as CharacterState;
}

const active = (over: Partial<PursuitState> = {}): PursuitState => ({
  id: "p1", summary: "攒够钱", metric: { kind: "gold" }, target: 100,
  deadlineDay: 6, status: "active", lastProgress: 0, ...over,
});

afterEach(() => { delete process.env.ANIMA_PURSUIT; });

describe("YAML 解析（逐字段显式映射）", () => {
  it("四种口径都认；缺 summary/target/metric 一律拒收", () => {
    expect(normalizePursuit({ summary: "攒钱", target: 100, metric: { kind: "gold" } })?.metric.kind).toBe("gold");
    expect(normalizePursuit({ summary: "练手艺", target: 6, metric: { kind: "skill", skill: "barista" } })?.metric)
      .toEqual({ kind: "skill", skill: "barista" });
    expect(normalizePursuit({ summary: "拉近", target: 40, metric: { kind: "relationship", target: "light" } })?.metric)
      .toEqual({ kind: "relationship", target: "light" });
    expect(normalizePursuit({ summary: "收菜", target: 4, metric: { kind: "item", item_id: "vegetable" } })?.metric)
      .toEqual({ kind: "item", itemId: "vegetable" });

    expect(normalizePursuit({ target: 1, metric: { kind: "gold" } })).toBeUndefined();     // 没 summary
    expect(normalizePursuit({ summary: "x", target: 0, metric: { kind: "gold" } })).toBeUndefined();
    expect(normalizePursuit({ summary: "x", target: 1, metric: { kind: "什么" } })).toBeUndefined();
    expect(normalizePursuit(null)).toBeUndefined();
  });
});

describe("进度从真实世界状态读（不问任何人）", () => {
  it("金币 / 技能 / 物品都量得出来", () => {
    expect(readProgress(active(), { state: who({ gold: 52 }) })).toBe(52);
    expect(readProgress(active({ metric: { kind: "skill", skill: "barista" } }),
      { state: who({ life: { skills: { barista: 4 } } as never }) })).toBe(4);
    expect(readProgress(active({ metric: { kind: "item", itemId: "vegetable" } }),
      { state: who({ inventory: [{ defId: "vegetable", quantity: 3 }] as never }) })).toBe(3);
  });

  it("关系取正值（负关系不算负进度——那是另一回事）", () => {
    const p = active({ metric: { kind: "relationship", target: "light" } });
    expect(readProgress(p, { state: who(), getRelationLevel: () => 30 })).toBe(30);
    expect(readProgress(p, { state: who(), getRelationLevel: () => -50 })).toBe(0);
  });
});

describe("结算：达成与错过都不可逆", () => {
  it("够了 → achieved，且**只报一次**", () => {
    const p = active();
    expect(settlePursuit(p, 3, { state: who({ gold: 120 }) })).toEqual({ kind: "achieved", current: 120 });
    expect(p.status).toBe("achieved");
    expect(settlePursuit(p, 4, { state: who({ gold: 120 }) })).toBeUndefined(); // 不再重复
  });

  it("到期没够 → failed，哪怕只差一点（日子不等人）", () => {
    const p = active();
    const out = settlePursuit(p, 6, { state: who({ gold: 99 }) })!;
    expect(out).toEqual({ kind: "failed", current: 99, short: 1 });
    expect(p.status).toBe("failed");
    // 失败之后就算钱够了也回不去——错过了就是错过了
    expect(settlePursuit(p, 7, { state: who({ gold: 999 }) })).toBeUndefined();
    expect(p.status).toBe("failed");
  });

  it("没到期 → 只报进度增量（给「有没有在往前走」一个机械判据）", () => {
    const p = active();
    expect(settlePursuit(p, 1, { state: who({ gold: 30 }) })).toEqual({ kind: "progress", current: 30, delta: 30 });
    expect(settlePursuit(p, 2, { state: who({ gold: 45 }) })).toEqual({ kind: "progress", current: 45, delta: 15 });
    expect(settlePursuit(p, 3, { state: who({ gold: 45 }) })).toEqual({ kind: "progress", current: 45, delta: 0 }); // 停滞
  });

  it("无期限的追求永远不会失败（但注入文案也不催——所以强烈建议给期限）", () => {
    const p = active({ deadlineDay: undefined });
    expect(settlePursuit(p, 999, { state: who({ gold: 1 }) })?.kind).toBe("progress");
  });
});

describe("注入文案", () => {
  it("只报进度与剩余时间，不给建议", () => {
    const line = describePursuit(active(), 3, { state: who({ gold: 52 }) })!;
    expect(line).toContain("52/100");
    expect(line).toContain("还差 48");
    expect(line).toContain("还剩 3 天");
    expect(line).not.toMatch(/你应该|建议|去做|不如/); // 世界不替角色想办法
  });

  it("最后一天有紧迫感；已结算的不再注入（不给死人上香）", () => {
    expect(describePursuit(active(), 6, { state: who({ gold: 52 }) })).toContain("最后期限");
    expect(describePursuit(active({ status: "failed" }), 7, { state: who() })).toBeUndefined();
    expect(describePursuit(active({ status: "achieved" }), 7, { state: who() })).toBeUndefined();
  });

  it("ANIMA_PURSUIT=0 整层退场", () => {
    process.env.ANIMA_PURSUIT = "0";
    expect(pursuitsEnabled()).toBe(false);
    expect(describePursuit(active(), 3, { state: who({ gold: 52 }) })).toBeUndefined();
    expect(settlePursuit(active(), 6, { state: who() })).toBeUndefined();
  });
});
