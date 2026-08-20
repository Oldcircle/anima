/**
 * steal 动机门单测（凶手能不能是镇上的人，卡在这一格）。
 *
 * 背景：旧门槛 `destitute && hunger<20` 在经济调参后几乎不可达 → `crime_supply: cast`
 * 放大器长期空转 → 真凶只能由静态 NPC 兜底 → 戏没分量。
 *
 * 锁四件：
 * ①三条路径各自能开门 ②宽裕/无怨/无债时**关着**（不能全员当贼）
 * ③怨恨路径要有**看得见的贫富差**（穷鬼互相偷不成立）
 * ④红线不变：这里只决定"选项摆不摆上桌"，不替任何人做决定
 */

import { describe, it, expect, afterEach } from "vitest";
import { stealMotive, DEBT_OVERDUE_TICKS, type ToolBuildContext } from "./tool-builder.js";
import { RelationshipManager } from "../world/relationships.js";
import { setBreakLevel } from "./break-config.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";

const card = { id: "me", name: "我", age: 20, occupation: "镇民", home: "h",
  personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
  background: "", relationships: {} } as CharacterCard;

function ctxOf(over: {
  gold?: number; hunger?: number; debts?: CharacterState["debts"]; tick?: number;
  nearby?: Array<{ id: string; name: string }>;
  rels?: RelationshipManager;
  otherGold?: Record<string, number>;
}): ToolBuildContext {
  const state = {
    id: "me", name: "我", gold: over.gold ?? 0,
    needs: { hunger: over.hunger ?? 100, energy: 100, social: 100, fun: 100, hygiene: 100 },
    debts: over.debts ?? [], life: { income: 12 },
  } as unknown as CharacterState;
  return {
    card, state, gold: over.gold ?? 0, tick: over.tick ?? 1000,
    nearbyCharacters: over.nearby ?? [],
    relationships: over.rels,
    getCharacterById: (id: string) => ({ gold: over.otherGold?.[id] ?? 0 }) as CharacterState,
    location: { id: "plaza", name: "广场" },
    allLocations: [], hour: 12,
  } as unknown as ToolBuildContext;
}

afterEach(() => setBreakLevel(undefined));

describe("stealMotive 三条路径", () => {
  it("①生理绝境：赤贫 + 饿到 20 以下 → 开（原路径）", () => {
    expect(stealMotive(ctxOf({ gold: 0, hunger: 10 }))?.kind).toBe("hunger");
  });

  it("②债务压顶：逾期 2 天 + 还不上 + 手头紧 → 开", () => {
    const debts = [{ lenderId: "bob", amount: 30, borrowedTick: 0 }] as CharacterState["debts"];
    const m = stealMotive(ctxOf({ gold: 5, hunger: 90, debts, tick: DEBT_OVERDUE_TICKS + 1 }));
    expect(m?.kind).toBe("debt");
  });

  it("②反例：账还没逾期 / 手头够还 → 关", () => {
    const debts = [{ lenderId: "bob", amount: 30, borrowedTick: 0 }] as CharacterState["debts"];
    expect(stealMotive(ctxOf({ gold: 5, hunger: 90, debts, tick: 10 }))).toBeUndefined();
    expect(stealMotive(ctxOf({ gold: 500, hunger: 90, debts, tick: DEBT_OVERDUE_TICKS + 1 }))).toBeUndefined();
  });

  it("③怨恨 + 贫富差 → 开，且**指名道姓**（因怨恨而偷的人不随机挑目标）", () => {
    setBreakLevel("mild");
    const rels = new RelationshipManager();
    rels.setGrudge("me", "rich", "当众下我面子", "rich", 100);
    const m = stealMotive(ctxOf({
      gold: 10, hunger: 90, nearby: [{ id: "rich", name: "阔佬" }],
      rels, otherGold: { rich: 200 },
    }));
    expect(m?.kind).toBe("grudge");
    expect(m?.targetId).toBe("rich");   // 案子的指向性就来自这里
  });

  it("③反例：有怨但对方也穷 → 关（穷鬼互相偷不成立）", () => {
    setBreakLevel("mild");
    const rels = new RelationshipManager();
    rels.setGrudge("me", "poor", "旧账", "poor", 100);
    expect(stealMotive(ctxOf({
      gold: 10, hunger: 90, nearby: [{ id: "poor", name: "穷邻居" }],
      rels, otherGold: { poor: 15 },
    }))).toBeUndefined();
  });

  it("③反例：对方富但没有怨 → 关（有钱不是被偷的理由）", () => {
    setBreakLevel("mild");
    expect(stealMotive(ctxOf({
      gold: 10, hunger: 90, nearby: [{ id: "rich", name: "阔佬" }],
      rels: new RelationshipManager(), otherGold: { rich: 500 },
    }))).toBeUndefined();
  });

  it("off 档（治愈系基线）不走怨恨路径", () => {
    setBreakLevel("off");
    const rels = new RelationshipManager();
    rels.setGrudge("me", "rich", "旧账", "rich", 100);
    expect(stealMotive(ctxOf({
      gold: 10, hunger: 90, nearby: [{ id: "rich", name: "阔佬" }],
      rels, otherGold: { rich: 200 },
    }))).toBeUndefined();
  });

  it("日子过得去的人：三条路径全关（不能全员当贼）", () => {
    setBreakLevel("mild");
    expect(stealMotive(ctxOf({ gold: 120, hunger: 80 }))).toBeUndefined();
  });
});
