import { describe, expect, it } from "vitest";
import { kiraStrikeAction } from "./kira-actions.js";
import type { EmergeContext, ActionContext } from "./types.js";

function makeEmergeCtx(over?: Partial<{ inventory: { defId: string; quantity: number }[]; hour: number; locType: string }>): EmergeContext {
  return {
    state: {
      inventory: (over?.inventory ?? []) as EmergeContext["state"]["inventory"],
      locationId: "home_light",
    },
    location: { id: "home_light", type: over?.locType ?? "residential" },
    hour: over?.hour ?? 21,
  };
}

const book = [{ defId: "cursed_notebook", quantity: 1 }];

function makeActionCtx(nearby: string[] = []): ActionContext {
  return {
    characterId: "light",
    locationId: "home_light",
    locationType: "residential",
    tick: 84,
    nearbyCharacters: nearby,
    gold: 100,
    needs: {},
  };
}

describe("kira_strike 浮现门（emerge 谓词）", () => {
  it("持册 + 夜间 + 在住宅 → 浮现", () => {
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book }))).toBe(true);
  });

  it("没有册子 → 永远看不到（其余六人视角）", () => {
    expect(kiraStrikeAction.emerge!(makeEmergeCtx())).toBe(false);
  });

  it("白天不浮现；傍晚起与凌晨（失眠时分）都浮现", () => {
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book, hour: 12 }))).toBe(false);
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book, hour: 17 }))).toBe(false);
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book, hour: 18 }))).toBe(true);
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book, hour: 2 }))).toBe(true);
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book, hour: 6 }))).toBe(false);
  });

  it("公共场所 → 不浮现（只在家写）", () => {
    expect(kiraStrikeAction.emerge!(makeEmergeCtx({ inventory: book, locType: "commercial" }))).toBe(false);
  });
});

describe("kira_strike handler（执行期）", () => {
  it("没写目标 → 失败", () => {
    const r = kiraStrikeAction.handler({}, makeActionCtx());
    expect(r.success).toBe(false);
  });

  it("有人在场 → 失败（册子不能被看见）", () => {
    const r = kiraStrikeAction.handler({ target: "shinji" }, makeActionCtx(["rei"]));
    expect(r.success).toBe(false);
    expect(r.description).toContain("别人");
  });

  it("独处写名 → 成功并带 _kiraStrike 后门标记（世界结算走 agent-loop）", () => {
    const r = kiraStrikeAction.handler({ target: "shinji", judgment: "他偷过店里的钱" }, makeActionCtx());
    expect(r.success).not.toBe(false);
    expect((r as any)._kiraStrike).toEqual({ target: "shinji", judgment: "他偷过店里的钱" });
    // 旁观者视角不泄底
    expect(r.observableState).not.toContain("册");
    expect(r.observableState).not.toContain("名字");
  });
});
