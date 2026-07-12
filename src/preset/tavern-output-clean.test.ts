import { describe, it, expect } from "vitest";
import { cleanTavernOutput } from "./anima-bridge.js";

describe("cleanTavernOutput（对齐 ST reasoning 解析）", () => {
  it("剥离成对 <thinking> 块", () => {
    expect(cleanTavernOutput("<thinking>草稿自检…</thinking>\n他吻了上来。")).toBe("他吻了上来。");
  });
  it("优先提取 <content> 交付区（明月秋青式：COT 在外、正文在内）", () => {
    const raw = "<thinking>[metacognition]\n一大段元认知…</thinking>\n```状态栏```\n<content>\n他的手贴上来。\n</content>";
    expect(cleanTavernOutput(raw)).toBe("他的手贴上来。");
  });
  it("清残留孤立/未闭合标签（夏瑾式：结尾漏 </textarea>）", () => {
    expect(cleanTavernOutput("她轻轻叹了口气。\n</textarea>")).toBe("她轻轻叹了口气。");
  });
  it("去 HTML 注释自检块（TGbreak 式 <!-- -->）", () => {
    expect(cleanTavernOutput("<!-- 排雷：不写比喻 -->他低下头。")).toBe("他低下头。");
  });
  it("干净输入原样返回（TGbreak-anima 已干净）", () => {
    expect(cleanTavernOutput("他的唇沿着脖子往下。")).toBe("他的唇沿着脖子往下。");
  });
  it("空输入安全", () => {
    expect(cleanTavernOutput("")).toBe("");
  });
});

describe("cleanTavernOutput 截断兼容", () => {
  it("<content> 被 length 截断无闭合标签时仍提取正文（排除前面的状态栏）", () => {
    const raw = "<thinking>元认知…</thinking>\n```状态栏```\n<content>\n他俯下身来。";
    expect(cleanTavernOutput(raw)).toBe("他俯下身来。");
  });
});
