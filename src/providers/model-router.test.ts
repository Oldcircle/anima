/**
 * 分层模型路由单测（省钱主杠杆）。
 *
 * 锁三件：
 * ①默认清单只含"不吃文采"的结构化小任务——decision/conversation **不能**被默认下放
 * ②`ANIMA_CHEAP_KINDS` 可覆盖（想 A/B 把 decision 也下放时用）；空串 = 整层关
 * ③未标注 kind 的调用一律走 primary（宁可贵，不可错）
 */

import { describe, it, expect } from "vitest";
import { resolveCheapKinds, tierFor, DEFAULT_CHEAP_KINDS } from "./model-router.js";

describe("分层模型路由", () => {
  it("默认清单：结构化小任务走便宜档，决策/对话/导演留在 primary", () => {
    const cheap = resolveCheapKinds(undefined);
    for (const k of ["impression", "observation", "reflection", "morning-plan",
                     "fact-extract", "stance-extract", "transaction-extract", "promise-extract"]) {
      expect(tierFor(k, cheap), k).toBe("cheap");
    }
    // r3 实测这三类占 78% 调用量，且最吃模型水平——默认绝不下放
    for (const k of ["decision", "conversation", "director"]) {
      expect(tierFor(k, cheap), k).toBe("primary");
    }
  });

  it("未标注 kind → primary（宁可贵，不可错）", () => {
    expect(tierFor(undefined, resolveCheapKinds(undefined))).toBe("primary");
    expect(tierFor("", resolveCheapKinds(undefined))).toBe("primary");
  });

  it("env 覆盖：想把 decision 也下放做 A/B 时用", () => {
    const cheap = resolveCheapKinds("decision,impression");
    expect(tierFor("decision", cheap)).toBe("cheap");
    expect(tierFor("impression", cheap)).toBe("cheap");
    expect(tierFor("observation", cheap)).toBe("primary"); // 覆盖=替换，不是叠加
  });

  it("空串 = 整层关掉，全部走 primary（A/B 基线）", () => {
    const cheap = resolveCheapKinds("");
    expect(cheap.size).toBe(0);
    for (const k of DEFAULT_CHEAP_KINDS) {
      expect(tierFor(k, cheap), k).toBe("primary");
    }
  });

  it("清单里的空白项被剔掉（写成 'a, ,b' 不会造出空 kind）", () => {
    const cheap = resolveCheapKinds("impression, , observation ");
    expect([...cheap].sort()).toEqual(["impression", "observation"]);
  });
});
