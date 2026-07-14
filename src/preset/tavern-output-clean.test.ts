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

describe("cleanTavernOutput TGbreak 全 COT 泄漏（compare3 实录格式）", () => {
  it("剥离领跑【StepN】脚手架段 + <ai_last_output> 查验段 + 尾部 <details> 折叠块", () => {
    const raw = [
      "【Step1-梳理】\n- 角色状态：苏苓，26岁。\n- 暗线变化：前戏起始。",
      "【Step2-推理】\n- 重构现状：唇沿脖子往下。\n  - 首先是身体感官反应。",
      "【Step3-检查】\n- 无雷点。",
      "<ai_last_output>中找<cliche>内容。假设上一轮是设定文本。表扬自己。",
      "<!-- AntiCliche：首句直接写感官 -->\n他掌心带着薄茧，贴上我腰侧。",
      "“痒。”我嘟囔着推了他一下。",
      "<details><summary>😸咪咪点评</summary>\n喵呜，嘴硬得能当扳手使。\n</details>",
      "<details><summary>摘要</summary>\n[深夜] 阿哲将苏苓压在身下。\n</details>",
    ].join("\n\n");
    expect(cleanTavernOutput(raw)).toBe("他掌心带着薄茧，贴上我腰侧。\n\n“痒。”我嘟囔着推了他一下。");
  });
  it("<details> 被 length 截断未闭合时删到结尾", () => {
    expect(cleanTavernOutput("她把脸埋进枕头。\n\n<details><summary>摘要</summary>\n[深夜] 两人")).toBe("她把脸埋进枕头。");
  });
  it("剥离 {{// 宏注释行（夏瑾式，未闭合带残标签）", () => {
    const raw = "{{//好，正文即刻在后。注意，最终输出时<coding\n\n他手糙，老茧咬住我的皮肤。";
    expect(cleanTavernOutput(raw)).toBe("他手糙，老茧咬住我的皮肤。");
  });
  it("正文段以破折号开头不误伤（只丢列表符/Step 段）", () => {
    const raw = "【Step1-梳理】\n- 状态。\n\n——他俯下身来。\n\n她没躲。";
    expect(cleanTavernOutput(raw)).toBe("——他俯下身来。\n\n她没躲。");
  });
  it("markdown 脚手架变体：应答开场白 + ## 1.梳理现状 + ## 2.正文 交付头（compare4 实录）", () => {
    const raw = [
      "好的，苏苓。我们开始吧。",
      "<!-- 梳理现状 -->",
      "## 1.梳理现状\n- **重构现状**：深夜卧室。\n- **灵魂注入**：roll点1d3。",
      "## 2.正文\n他掌心贴上来的时候，我吸了口气。",
      "<details><summary>摘要</summary>\n[深夜] 两人温存。\n</details>",
    ].join("\n\n");
    expect(cleanTavernOutput(raw)).toBe("他掌心贴上来的时候，我吸了口气。");
  });
  it("TGbreak v3.1.1 变体：<draft_notes>/<bginfor>/<catsay> 成对块整块剥离", () => {
    const raw = [
      "<draft_notes>\n**重构现状**: 深夜卧室。<peip>判定通过。\n</draft_notes>",
      "<bginfor><details><summary>背景</summary><p>空调嗡嗡响。</p></details></bginfor>",
      "他的唇贴着我脖子上的脉搏。\n\n“别轻了。”",
      "<catsay>\n<details><summary>😸</summary>点评喵。</details>\n</catsay>",
    ].join("\n\n");
    expect(cleanTavernOutput(raw)).toBe("他的唇贴着我脖子上的脉搏。\n\n“别轻了。”");
  });
  it("纯应答失败件清洗后为空（只回'好的我会写'+摘要，没有正文可救）", () => {
    const raw = "好的，作为苏苓，我会按照你的要求，以第一人称继续写下去。\n\n---\n\n<details><summary>摘要</summary>\n[深夜|卧室] 两人温存。\n</details>";
    expect(cleanTavernOutput(raw)).toBe("");
  });
});

describe("cleanTavernOutput 明月秋青只思考不写正文（判空触发重试）", () => {
  it("裸 [metacognition] 思考链无 <content> 交付区 → 判空（retry 组1 实录）", () => {
    const raw = "[metacognition]\n\n- 确认输出语言为：简体中文\n\n- 之前发生了什么？深夜卧室，阿哲压在苏苓身下。";
    expect(cleanTavernOutput(raw)).toBe("");
  });
  it("未闭合 <thinking> 无 <content> → 判空", () => {
    expect(cleanTavernOutput("<thinking>\n[metacognition]\n- 分析场景……")).toBe("");
  });
  it("有 <content> 交付区时正常提取（不误伤真正文）", () => {
    const raw = "<thinking>\n[metacognition]\n- 分析……\n</thinking>\n<content>\n他掌心贴上我腰侧。\n</content>";
    expect(cleanTavernOutput(raw)).toBe("他掌心贴上我腰侧。");
  });
  it("正文本身以'我/他'等叙事开头不误伤（不以思考特征起头）", () => {
    expect(cleanTavernOutput("他手掌贴上来的时候，我腰侧的肌肉绷紧了。")).toBe("他手掌贴上来的时候，我腰侧的肌肉绷紧了。");
  });
});

describe("cleanTavernOutput 截断兼容", () => {
  it("<content> 被 length 截断无闭合标签时仍提取正文（排除前面的状态栏）", () => {
    const raw = "<thinking>元认知…</thinking>\n```状态栏```\n<content>\n他俯下身来。";
    expect(cleanTavernOutput(raw)).toBe("他俯下身来。");
  });
});
