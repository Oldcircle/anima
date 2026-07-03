import { describe, it, expect } from "vitest";
import { generateMorningPlan } from "./morning-plan.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { World } from "../world/world.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const card: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多"], speechStyle: "轻声" },
  background: "面包店学徒",
  relationships: {},
};

function makeState() {
  const world = new World(TEST_LOCATIONS, 24);
  world.addCharacter("tomori", "高松灯", "home_tomori");
  return world.getCharacter("tomori")!;
}

describe("generateMorningPlan", () => {
  it("解析 LLM 输出的打算列表（每行一条）", async () => {
    const mock = new MockLLMProvider();
    mock.enqueueResponse("- 把昨天没揉完的面团处理掉\n- 傍晚去海边捡石头\n顺便说点别的废话");

    const result = await generateMorningPlan({
      card, state: makeState(), provider: mock, modelId: "test",
      yesterdayWish: "想去海边",
    });

    expect(result.items).toEqual(["把昨天没揉完的面团处理掉", "傍晚去海边捡石头"]);
  });

  it("最多保留 3 条", async () => {
    const mock = new MockLLMProvider();
    mock.enqueueResponse("- a1\n- a2\n- a3\n- a4\n- a5");

    const result = await generateMorningPlan({ card, state: makeState(), provider: mock, modelId: "test" });
    expect(result.items).toHaveLength(3);
  });

  it("LLM 失败时降级为无打算（不抛错）", async () => {
    const mock = new MockLLMProvider();
    mock.failNext("network error");

    const result = await generateMorningPlan({ card, state: makeState(), provider: mock, modelId: "test" });
    expect(result.items).toEqual([]);
  });

  it("昨日反思/约定/天气进入生成 prompt", async () => {
    const mock = new MockLLMProvider();
    mock.enqueueResponse("- 去见人");

    await generateMorningPlan({
      card, state: makeState(), provider: mock, modelId: "test",
      yesterdayWish: "想和爱音和好",
      yesterdayConcern: "面包店的生意",
      todayAppointments: ["今天12:00在咖啡馆和千早爱音见面"],
      weather: "rainy",
    });

    const content = (mock.calls[0]!.request.messages[0] as { content: string }).content;
    expect(content).toContain("想和爱音和好");
    expect(content).toContain("面包店的生意");
    expect(content).toContain("咖啡馆");
  });
});
