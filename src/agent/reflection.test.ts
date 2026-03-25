/**
 * Reflection Tests — 反思系统（含愿望/担忧提取）
 */

import { describe, it, expect } from "vitest";
import { runReflection, type ReflectionResult } from "./reflection.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { RelationshipManager } from "../world/relationships.js";
import type { CharacterCard } from "../character/types.js";

const baseCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: {
    traits: ["内向", "敏感"],
    interests: [],
    dislikes: [],
    speechStyle: "声音微弱",
  },
  background: "面包店学徒",
  relationships: {},
  life: {
    occupation: "面包店学徒",
    workplace: "bakery",
    age: 19,
    income: 8,
    skills: { baking: 1 },
    aspiration: "找到能理解我的人",
  },
};

function setupMemoryWithEntries(memory: ShortTermMemory): void {
  memory.add("tomori", { tick: 24, type: "action", content: "去面包店揉面团", importance: 5 });
  memory.add("tomori", { tick: 30, type: "social", content: "和爱音聊了天", importance: 6 });
  memory.add("tomori", { tick: 60, type: "action", content: "去海边捡了石头", importance: 4 });
}

describe("反思系统", () => {
  it("解析包含愿望和担忧的反思结果", async () => {
    const mockLLM = new MockLLMProvider();
    mockLLM.enqueueResponse(
      `洞察1: 今天在面包店揉面团时感到很安心
洞察2: 和爱音聊天意外地开心
心情: 有点温暖
愿望: 想再和爱音聊聊
担忧: 这个月的面包做得不太好`,
    );

    const memory = new ShortTermMemory();
    setupMemoryWithEntries(memory);

    const result = await runReflection({
      card: baseCard,
      memory,
      relationships: new RelationshipManager(),
      provider: mockLLM,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 95,
    });

    expect(result.insights).toHaveLength(2);
    expect(result.mood).toBe("有点温暖");
    expect(result.wish).toBe("想再和爱音聊聊");
    expect(result.concern).toBe("这个月的面包做得不太好");
  });

  it("愿望为'没有'时不设置 wish", async () => {
    const mockLLM = new MockLLMProvider();
    mockLLM.enqueueResponse(
      `洞察1: 平淡的一天
心情: 平静
愿望: 没有
担忧: 没有`,
    );

    const memory = new ShortTermMemory();
    setupMemoryWithEntries(memory);

    const result = await runReflection({
      card: baseCard,
      memory,
      relationships: new RelationshipManager(),
      provider: mockLLM,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 95,
    });

    expect(result.wish).toBeUndefined();
    expect(result.concern).toBeUndefined();
  });

  it("愿望存入记忆", async () => {
    const mockLLM = new MockLLMProvider();
    mockLLM.enqueueResponse(
      `洞察1: 今天很开心
心情: 开心
愿望: 学会做法棍
担忧: 无`,
    );

    const memory = new ShortTermMemory();
    setupMemoryWithEntries(memory);

    await runReflection({
      card: baseCard,
      memory,
      relationships: new RelationshipManager(),
      provider: mockLLM,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 95,
    });

    // 检查记忆中有愿望条目
    const allMemories = memory.getRecent("tomori", 20);
    const wishMemory = allMemories.find((m) => m.content.includes("[愿望]"));
    expect(wishMemory).toBeDefined();
    expect(wishMemory!.content).toContain("学会做法棍");
    expect(wishMemory!.importance).toBe(7);
  });

  it("没有记忆时返回空结果", async () => {
    const mockLLM = new MockLLMProvider();
    const memory = new ShortTermMemory();
    // 不添加任何记忆

    const result = await runReflection({
      card: baseCard,
      memory,
      relationships: new RelationshipManager(),
      provider: mockLLM,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 95,
    });

    expect(result.insights).toHaveLength(0);
    expect(result.mood).toBe("平静");
    expect(result.wish).toBeUndefined();
    expect(result.concern).toBeUndefined();
    // 不应调用 LLM
    expect(mockLLM.calls).toHaveLength(0);
  });

  it("反思 prompt 包含抱负信息", async () => {
    const mockLLM = new MockLLMProvider();
    mockLLM.enqueueResponse("洞察1: test\n心情: 平静\n愿望: 没有\n担忧: 没有");

    const memory = new ShortTermMemory();
    setupMemoryWithEntries(memory);

    await runReflection({
      card: baseCard,
      memory,
      relationships: new RelationshipManager(),
      provider: mockLLM,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 95,
    });

    // 检查 system prompt 包含抱负
    const systemPrompt = mockLLM.calls[0]!.request.system;
    expect(systemPrompt).toContain("找到能理解我的人");
  });

  it("使用中文冒号的格式也能正确解析", async () => {
    const mockLLM = new MockLLMProvider();
    mockLLM.enqueueResponse(
      `洞察1：在面包店度过了充实的一天
心情：满足
愿望：明天想试试新配方
担忧：钱不太够`,
    );

    const memory = new ShortTermMemory();
    setupMemoryWithEntries(memory);

    const result = await runReflection({
      card: baseCard,
      memory,
      relationships: new RelationshipManager(),
      provider: mockLLM,
      modelId: "test",
      dayStartTick: 0,
      dayEndTick: 95,
    });

    expect(result.mood).toBe("满足");
    expect(result.wish).toBe("明天想试试新配方");
    expect(result.concern).toBe("钱不太够");
  });
});
