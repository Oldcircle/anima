import { describe, expect, it, afterEach } from "vitest";
import { buildUserPrompt } from "./prompt-builder.js";
import { setBreakLevel } from "./break-config.js";
import { ImpressionStore } from "../memory/impressions.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";
import { tickToGameTime } from "../core/tick-engine.js";

const baseCard: CharacterCard = {
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

function createState(): CharacterState {
  return {
    id: "tomori",
    name: "高松灯",
    locationId: "cafe",
    needs: {
      hunger: 80,
      energy: 70,
      social: 60,
      fun: 70,
      hygiene: 80,
      bladder: 90,
    },
    gold: 100,   // 真实起始金币；配合生计系统，100 金币约 5 天开销 = "够用"不焦虑
    moodlets: [], inbox: [],
  };
}

describe("prompt-builder", () => {
  it("不再直接暴露亲密度数值，而是用主观感觉描述关系", () => {
    const prompt = buildUserPrompt({
      card: baseCard,
      state: createState(),
      gameTime: tickToGameTime(48),
      nearbyCharacters: [
        {
          id: "anon",
          name: "千早爱音",
          relationship: { level: 42, type: "friend" },
          currentAction: "在看书",
        },
      ],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("你对他们的主观感觉");
    expect(prompt).toContain("说话不会太拘谨");
    expect(prompt).not.toContain("亲密度");
    expect(prompt).not.toContain("42");
  });

  it("需求值正常时显示身体状态不错", () => {
    const state = createState(); // all needs are high
    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("身体状态不错");
    expect(prompt).not.toContain("/100");
    expect(prompt).not.toContain("饥饿:");
  });

  it("饥饿偏低时显示身体感受", () => {
    const state = createState();
    state.needs.hunger = 25;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("你的身体感受");
    expect(prompt).toContain("饿");
    expect(prompt).not.toContain("/100");
  });

  it("社交饱和时感受中提示想安静", () => {
    const state = createState();
    state.needs.social = 92;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("安静");
  });

  it("没钱时感受中提及口袋空", () => {
    const state = createState();
    state.gold = 0;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("口袋快空了");
  });

  it("极端饥饿+没钱时显示紧急感受", () => {
    const state = createState();
    state.gold = 0;
    state.needs.hunger = 10;

    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
    });

    expect(prompt).toContain("又穷又饿");
    expect(prompt).toContain("胃在抽痛");
  });

  it("会把当前还挂着的短期意图注入 prompt", () => {
    const state = createState();
    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [{ id: "home_tomori", name: "灯的家" }],
      currentIntent: {
        kind: "reply",
        source: "message",
        targetId: "anon",
        summary: "爱音刚刚对你说了「等会要不要一起坐坐？」，你还没回应。",
        createdTick: 48,
        expiresAt: 52,
      },
    });

    expect(prompt).toContain("你心里挂着的事");
    expect(prompt).toContain("你还没回应");
  });

  it("social 极高时 prompt 提示想安静", () => {
    const state = createState();
    state.needs.social = 92;
    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [],
    });

    expect(prompt).toContain("聊了很多");
  });

  it("在面包店时注入相关 backstory", () => {
    const state = createState();
    const cardWithBackstory = {
      ...baseCard,
      backstory: [
        { event: "小时候把西瓜虫送给同学当礼物", impact: "从此认定自己是怪人" },
        { event: "在面包店找到了学徒的工作", impact: "发现揉面团是少数能让自己安心的事情" },
      ],
    };

    const prompt = buildUserPrompt({
      card: cardWithBackstory,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "海风面包坊",
      locationType: "commercial",
      allLocationNames: [],
    });

    expect(prompt).toContain("面包店找到了");
    expect(prompt).toContain("揉面团");
    expect(prompt).toContain("你突然想起的");
  });

  it("独处且社交低时注入孤独相关 backstory", () => {
    const state = createState();
    state.needs.social = 20;
    const cardWithBackstory = {
      ...baseCard,
      backstory: [
        { event: "在学校一直是独来独往，没有朋友", impact: "养成了观察微小事物的习惯" },
        { event: "在面包店找到了学徒的工作", impact: "发现揉面团让自己安心" },
      ],
    };

    const prompt = buildUserPrompt({
      card: cardWithBackstory,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "广场",
      locationType: "public",
      allLocationNames: [],
    });

    expect(prompt).toContain("没有朋友");
  });

  it("social 适中时不提示想安静", () => {
    const state = createState();
    state.needs.social = 60;
    const prompt = buildUserPrompt({
      card: baseCard,
      state,
      gameTime: tickToGameTime(48),
      nearbyCharacters: [],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [],
    });

    expect(prompt).not.toContain("聊了很多");
    expect(prompt).not.toContain("想安静");
  });
});

// ── C7 开场白反模板 + 食物话题对冲（DESIGN-revival §3 C7）──

describe("C7 开场白反模板与食物话题对冲", () => {
  afterEach(() => setBreakLevel("mild"));

  const buildAt = (locationName: string, withPeople = true) =>
    buildUserPrompt({
      card: baseCard,
      state: createState(),
      gameTime: tickToGameTime(48),
      nearbyCharacters: withPeople
        ? [{ id: "anon", name: "千早爱音", relationship: { level: 42, type: "friend" }, currentAction: "在看书" }]
        : [],
      recentEvents: [],
      locationName,
      locationType: "commercial",
      allLocationNames: [],
    });

  it("mild：有人在场时注入开场白反模板 nudge；餐饮地点追加食物话题对冲", () => {
    const prompt = buildAt("海风面包坊");
    expect(prompt).toContain("开口别用模板寒暄");
    expect(prompt).toContain("不等于只能聊吃的");
  });

  it("非餐饮地点不注食物对冲，但反模板 nudge 仍在", () => {
    const prompt = buildAt("广场");
    expect(prompt).toContain("开口别用模板寒暄");
    expect(prompt).not.toContain("不等于只能聊吃的");
  });

  it("没人在场时两条都不注", () => {
    const prompt = buildAt("海风面包坊", false);
    expect(prompt).not.toContain("开口别用模板寒暄");
    expect(prompt).not.toContain("不等于只能聊吃的");
  });

  it("off 档两条都不注（治愈系基线逐字节回归）", () => {
    setBreakLevel("off");
    const prompt = buildAt("海风面包坊");
    expect(prompt).not.toContain("开口别用模板寒暄");
    expect(prompt).not.toContain("不等于只能聊吃的");
  });
});

// ── C4 疑惑槽节流在决策 prompt 的接线（formatForPrompt + curiosities 双通道）──

describe("C4 疑惑槽节流（决策 prompt 接线）", () => {
  afterEach(() => setBreakLevel("mild"));

  const buildWithImpressions = (impressions: ImpressionStore) =>
    buildUserPrompt({
      card: baseCard,
      state: createState(),
      gameTime: tickToGameTime(48),
      nearbyCharacters: [{ id: "anon", name: "千早爱音", relationship: { level: 42, type: "friend" } }],
      recentEvents: [],
      locationName: "咖啡馆",
      locationType: "commercial",
      allLocationNames: [],
      impressions,
    });

  function seedImpression(store: ImpressionStore): void {
    store.set("tomori", {
      characterId: "anon",
      summary: "开朗但有点让人捉摸不透",
      observations: ["总在看窗外"],
      mentalLabel: "在意的人",
      unresolved: ["她到底想不想留在镇上"],
      lastUpdated: 40,
    });
  }

  it("mild：首登记的疑惑（计数 1）不注入印象区也不进好奇提示", () => {
    const store = new ImpressionStore();
    seedImpression(store);
    const prompt = buildWithImpressions(store);
    expect(prompt).not.toContain("她到底想不想留在镇上");
  });

  it("mild：挺过一次印象更新（计数 2）后注回两条通道", () => {
    const store = new ImpressionStore();
    seedImpression(store);
    store.merge("tomori", {
      characterId: "anon", summary: "还是捉摸不透", observations: [],
      mentalLabel: "在意的人", unresolved: [], lastUpdated: 60,
    });
    const prompt = buildWithImpressions(store);
    expect(prompt).toContain("你的疑惑：她到底想不想留在镇上");
    expect(prompt).toContain("你心里有些好奇的事：关于千早爱音：她到底想不想留在镇上");
  });

  it("off：不节流，首登记即注入（基线行为）", () => {
    setBreakLevel("off");
    const store = new ImpressionStore();
    seedImpression(store);
    const prompt = buildWithImpressions(store);
    expect(prompt).toContain("她到底想不想留在镇上");
  });
});
