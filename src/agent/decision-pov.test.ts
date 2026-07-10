/**
 * POV 深翻回归（决策视角实验第二阶段）：
 * - first（默认）：system prompt 顶块与旧版逐字一致（第一人称沉浸），无任何作者框架泄入
 * - third：顶块切作者/预测框架 + 决策指令带两层动机行输出契约（私有通道）
 * - 缓存纪律：third 档顶块静态（同角色重复构建逐字节一致）
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt-builder.js";
import { decisionDirective, setDecisionPov, thirdPersonIdentityHead } from "./break-config.js";
import type { CharacterCard } from "../character/types.js";

const card: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  personality: {
    traits: ["内向"],
    interests: ["写东西"],
    dislikes: ["人多的场合"],
    speechStyle: "声音微弱",
  },
  background: "从城市来的安静女孩，在面包店当学徒",
  relationships: {},
};

afterEach(() => {
  setDecisionPov("first");
});

describe("first 档（默认）——逐字节回归", () => {
  it("顶块保持第一人称沉浸原文，无作者框架", () => {
    const sys = buildSystemPrompt(card, undefined, undefined, { decisionDirective: "social" });
    expect(sys).toContain("你是沉浸式小说的创作引擎。你正在创作的角色是：高松灯，19 岁，面包店学徒。");
    expect(sys).toContain("你以第一人称完全成为这个角色");
    expect(sys).not.toContain("群像小说的作者");
    expect(sys).not.toContain("【表面】");
  });

  it("thirdPersonIdentityHead 在 first 档返回 null", () => {
    expect(thirdPersonIdentityHead("高松灯", "高松灯，19 岁，面包店学徒")).toBeNull();
  });
});

describe("third 档——深翻 + 私有通道契约", () => {
  it("顶块切成作者/预测框架，第一人称沉浸句消失", () => {
    setDecisionPov("third");
    const sys = buildSystemPrompt(card, undefined, undefined, { decisionDirective: "social" });
    expect(sys).toContain("你是这部沉浸式群像小说的作者");
    expect(sys).toContain("你看得透他，他看不透自己");
    // 表达契约保留：台词/内心独白仍是角色第一人称
    expect(sys).toContain("台词和内心独白仍用他的第一人称写");
    expect(sys).not.toContain("你以第一人称完全成为这个角色");
    // 创作理念/忠实性准则共享段不受档位影响
    expect(sys).toContain("角色忠实性准则");
  });

  it("决策指令（社交/独处）都带两层动机行契约与诚实豁免", () => {
    setDecisionPov("third");
    for (const social of [true, false]) {
      const d = decisionDirective("高松灯", social);
      expect(d).toContain("【表面】");
      expect(d).toContain("【真心】");
      expect(d).toContain("与表面一致");
    }
  });

  it("缓存纪律：third 档 system prompt 静态（重复构建逐字节一致）", () => {
    setDecisionPov("third");
    const a = buildSystemPrompt(card, undefined, undefined, { decisionDirective: "social" });
    const b = buildSystemPrompt(card, undefined, undefined, { decisionDirective: "social" });
    expect(a).toBe(b);
  });
});
