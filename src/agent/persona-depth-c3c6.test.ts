/**
 * C3 + C6 形状单测（DESIGN-revival §3）：
 *
 * C3 二级 prompt 人设加深：reflection / morning-plan / observation 补
 * speech.style + psychology 前两行（此前只拿 traits 标签，产出千人一腔）。
 * off 档返回 ""（治愈系基线逐字节回归，与 C4/C7 同款纪律）。
 *
 * C6 独处 tick 轻量人格锚：solo 决策变体的 system prompt 追加人格锚
 * （社交场景有 traitReminder，独处此前是空窗）。静态 per 角色（缓存安全）；off 档不加。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt, personaDeepeningLines } from "./prompt-builder.js";
import { generateMorningPlan } from "./morning-plan.js";
import { runReflection } from "./reflection.js";
import { generateObservation } from "./observation-reasoning.js";
import { setBreakLevel } from "./break-config.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { RelationshipManager } from "../world/relationships.js";
import { World } from "../world/world.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

/** 带深度人格字段的角色卡（speech + 三行 psychology） */
const deepCard: CharacterCard = {
  id: "asuka", name: "明日香", age: 19, occupation: "花店店员", home: "home_tomori",
  personality: {
    traits: ["要强", "毒舌"],
    interests: ["逞强"],
    dislikes: ["被同情"],
    speechStyle: "语速快，带刺",
    psychology: "第一行：用攻击性掩饰怕被抛弃。\n第二行：越在意越嘴硬。\n第三行：这一行不该被注入。",
    speech: { style: "句子短促，先呛一句再说正事", habits: ["哼"], examples: ["哼，谁要你管。"] },
  },
  background: "测试",
  relationships: {},
};

beforeEach(() => setBreakLevel("mild"));
afterEach(() => setBreakLevel("mild"));

describe("C3 personaDeepeningLines", () => {
  it("mild：speech.style + psychology 只取前两行；off：返回空串", () => {
    const lines = personaDeepeningLines(deepCard);
    expect(lines).toContain("你的说话方式：句子短促，先呛一句再说正事");
    expect(lines).toContain("第一行");
    expect(lines).toContain("第二行");
    expect(lines).not.toContain("第三行"); // 只取前两行
    setBreakLevel("off");
    expect(personaDeepeningLines(deepCard)).toBe("");
  });

  it("无 speech 字段时回退 speechStyle；无 psychology 时不产出内心行", () => {
    const flat: CharacterCard = {
      ...deepCard,
      personality: { ...deepCard.personality, speech: undefined, psychology: undefined },
    };
    const lines = personaDeepeningLines(flat);
    expect(lines).toContain("你的说话方式：语速快，带刺");
    expect(lines).not.toContain("你的内心底色");
  });
});

describe("C3 三个二级 prompt 接线", () => {
  it("morning-plan：system 含人设加深；off 档不含", async () => {
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("- 去店里");
    const world = new World(TEST_LOCATIONS, 24);
    world.addCharacter("asuka", "明日香", "cafe");
    const state = world.getCharacter("asuka")!;

    await generateMorningPlan({ card: deepCard, state, provider: mock, modelId: "test" });
    expect(mock.calls[0]!.request.system).toContain("你的说话方式：句子短促");
    expect(mock.calls[0]!.request.system).toContain("你的内心底色");

    setBreakLevel("off");
    await generateMorningPlan({ card: deepCard, state, provider: mock, modelId: "test" });
    expect(mock.calls[1]!.request.system).not.toContain("你的说话方式：");
  });

  it("reflection：system 含人设加深；off 档不含", async () => {
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("心情: 烦");
    const memory = new ShortTermMemory();
    memory.add("asuka", { tick: 10, type: "event", content: "今天被客人气到了", importance: 5 });
    const base = {
      card: deepCard, memory, relationships: new RelationshipManager(),
      provider: mock, modelId: "test", dayStartTick: 0, dayEndTick: 92,
    };
    await runReflection(base);
    expect(mock.calls[0]!.request.system).toContain("你的说话方式：句子短促");

    setBreakLevel("off");
    await runReflection(base);
    expect(mock.calls[1]!.request.system).not.toContain("你的说话方式：");
  });

  it("observation：system 含人设加深 + 口吻提示；off 档逐字节回归（两者都不含）", async () => {
    const mock = new MockLLMProvider();
    mock.setDefaultResponse("她看起来在憋着什么事。");
    const world = new World(TEST_LOCATIONS, 24);
    world.addCharacter("asuka", "明日香", "cafe");
    const ctx = {
      observerCard: deepCard,
      observerState: world.getCharacter("asuka")!,
      visibleCharacters: [{ id: "rei", name: "丽", action: "一个人坐在角落看着窗外" }],
      locationName: "咖啡馆",
      tick: 24,
    };
    await generateObservation(ctx, mock, "test");
    expect(mock.calls[0]!.request.system).toContain("你的说话方式：句子短促");
    expect(mock.calls[0]!.request.system).toContain("不是中立旁白");

    setBreakLevel("off");
    await generateObservation(ctx, mock, "test");
    expect(mock.calls[1]!.request.system).not.toContain("你的说话方式：");
    expect(mock.calls[1]!.request.system).not.toContain("不是中立旁白");
  });
});

describe("C6 独处 tick 轻量人格锚", () => {
  it("solo 变体含锚（psychology 首行 + 说话方式）；social 变体不含；off 档不含", () => {
    const solo = buildSystemPrompt(deepCard, undefined, undefined, { decisionDirective: "solo" });
    expect(solo).toContain("## 独处的时候你也是你");
    expect(solo).toContain("第一行：用攻击性掩饰怕被抛弃。");
    expect(solo).toContain("句子短促，先呛一句再说正事");

    const social = buildSystemPrompt(deepCard, undefined, undefined, { decisionDirective: "social" });
    expect(social).not.toContain("## 独处的时候你也是你");

    setBreakLevel("off");
    const offSolo = buildSystemPrompt(deepCard, undefined, undefined, { decisionDirective: "solo" });
    expect(offSolo).not.toContain("## 独处的时候你也是你");
  });

  it("锚是静态文本：同角色两次构建逐字节一致（缓存纪律）", () => {
    const a = buildSystemPrompt(deepCard, undefined, undefined, { decisionDirective: "solo" });
    const b = buildSystemPrompt(deepCard, undefined, undefined, { decisionDirective: "solo" });
    expect(b).toBe(a);
  });

  it("无深度字段的角色也有基础锚（coreTraits/psychology 缺失时不崩）", () => {
    const flat: CharacterCard = {
      ...deepCard,
      personality: {
        traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常",
        psychology: undefined, coreTraits: undefined, speech: undefined,
      },
    };
    const solo = buildSystemPrompt(flat, undefined, undefined, { decisionDirective: "solo" });
    expect(solo).toContain("## 独处的时候你也是你");
    expect(solo).toContain("平常"); // speechStyle 回退
  });
});
