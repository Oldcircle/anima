import { describe, it, expect } from "vitest";
import { ConversationTracker, buildConversationPrompt, buildConversationRequest } from "./conversation-mode.js";
import type { CharacterCard } from "../character/types.js";
import type { CharacterState } from "../world/types.js";

// ── Test fixtures ──

const sakikoCard: CharacterCard = {
  id: "sakiko",
  name: "丰川祥子",
  age: 19,
  occupation: "咖啡馆兼职",
  home: "home_sakiko",
  appearance: "身高155cm，纤细挺拔。浅蓝色微卷及腰双马尾。",
  personality: {
    traits: ["优雅", "倔强"],
    interests: ["钢琴"],
    dislikes: ["同情"],
    speechStyle: "礼貌得体",
    coreTraits: "骨子里是优雅的大小姐",
    speech: { style: "礼貌但有距离感", habits: ["请容我..."], examples: ["欢迎光临"] },
  },
  background: "前大小姐",
  backstory: [{ event: "家族破产", impact: "一夜之间失去一切" }],
  relationships: {},
};

const mariaCard: CharacterCard = {
  id: "maria",
  name: "Maria Lopez",
  age: 30,
  occupation: "面包店老板",
  home: "home_maria",
  appearance: "棕色卷发，热情洋溢的笑容。",
  personality: {
    traits: ["热情", "外向"],
    interests: ["烘焙"],
    dislikes: ["冷漠"],
    speechStyle: "热情奔放",
    coreTraits: "像一团移动的火焰",
    speech: { style: "夹杂西班牙语", habits: ["¡Hola!"], examples: ["¡Buenos días!"] },
  },
  background: "移民到小镇的面包师",
  relationships: {},
};

const sakikoState: CharacterState = {
  id: "sakiko", name: "丰川祥子", locationId: "cafe",
  needs: { hunger: 60, energy: 70, social: 35, happiness: 50, hygiene: 80 },
  gold: 45, inbox: [],
};

const mariaState: CharacterState = {
  id: "maria", name: "Maria Lopez", locationId: "cafe",
  needs: { hunger: 50, energy: 80, social: 60, happiness: 70, hygiene: 90 },
  gold: 62, inbox: [],
};

const gameTime = { tick: 52, day: 0, hour: 13, minute: 0, season: "spring" as const, seasonDay: 1, year: 1 };

// ── ConversationTracker tests ──

describe("ConversationTracker", () => {
  it("records talk and retrieves history", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "你好！", 50);
    tracker.recordTalk("sakiko", "祥子", "maria", "你好。", 50);

    const history = tracker.getHistory("maria", "sakiko");
    expect(history).toHaveLength(2);
    expect(history[0]!.message).toBe("你好！");
    expect(history[1]!.message).toBe("你好。");
  });

  it("pair key is order-independent", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "Hi", 50);

    expect(tracker.getHistory("maria", "sakiko")).toHaveLength(1);
    expect(tracker.getHistory("sakiko", "maria")).toHaveLength(1);
  });

  it("detects active conversation when both sides talked recently", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "你好！", 50);
    tracker.recordTalk("sakiko", "祥子", "maria", "你好。", 51);

    expect(tracker.isActiveConversation("maria", "sakiko", 52)).toBe(true);
  });

  it("not active if only one side talked", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "你好！", 50);
    tracker.recordTalk("maria", "Maria", "sakiko", "在吗？", 51);

    expect(tracker.isActiveConversation("maria", "sakiko", 52)).toBe(false);
  });

  it("not active if exchanges are too old", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "你好！", 40);
    tracker.recordTalk("sakiko", "祥子", "maria", "你好。", 41);

    expect(tracker.isActiveConversation("maria", "sakiko", 52)).toBe(false);
  });

  it("cleanup removes expired conversations", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "旧消息", 10);
    tracker.recordTalk("alice", "Alice", "bob", "新消息", 50);

    tracker.cleanup(52);

    expect(tracker.getHistory("maria", "sakiko")).toHaveLength(0);
    expect(tracker.getHistory("alice", "bob")).toHaveLength(1);
  });

  it("clear removes specific conversation", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("maria", "Maria", "sakiko", "消息", 50);
    tracker.clear("maria", "sakiko");

    expect(tracker.getHistory("maria", "sakiko")).toHaveLength(0);
  });
});

// ── Conversation prompt tests ──

describe("buildConversationPrompt", () => {
  const history = [
    { speakerId: "maria", speakerName: "Maria Lopez", message: "¡Hola! 你今天看起来好像有心事？", tick: 50 },
    { speakerId: "sakiko", speakerName: "丰川祥子", message: "...没有什么特别的。只是昨晚没睡好。", tick: 51 },
  ];

  it("includes scene description with atmosphere", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
      atmosphere: { afternoon: "午后阳光透过竹帘" },
      weather: "sunny",
    });

    expect(prompt).toContain("## 场景");
    expect(prompt).toContain("咖啡馆");
    expect(prompt).toContain("午后阳光透过竹帘");
  });

  it("includes partner description and relationship", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
      relationship: { level: 24, type: "acquaintance" },
    });

    expect(prompt).toContain("## 你的对话对象");
    expect(prompt).toContain("Maria Lopez");
    expect(prompt).toContain("acquaintance");
    expect(prompt).toContain("亲密度 24");
  });

  it("includes full dialogue history with correct labels", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain("## 对话记录");
    expect(prompt).toContain("Maria Lopez：「¡Hola!");
    expect(prompt).toContain("你：「...没有什么特别的");
  });

  it("includes narrative style instructions", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain("内心活动");
    expect(prompt).toContain("犹豫");
    expect(prompt).toContain("白描");
  });

  it("includes mood hints when needs are low", () => {
    const lowSocialState = { ...sakikoState, needs: { ...sakikoState.needs, social: 15, happiness: 20 } };
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: lowSocialState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain("渴望交流");
    expect(prompt).toContain("心情不太好");
  });

  it("includes talk target ID reminder", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain('"maria"');
  });
});

// ── buildConversationRequest tests ──

describe("buildConversationRequest", () => {
  it("uses higher temperature and token budget", () => {
    const request = buildConversationRequest({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history: [], gameTime, locationName: "咖啡馆",
      actions: [],
    });

    expect(request.temperature).toBe(1.0);
    expect(request.maxTokens).toBe(1536);
  });

  it("includes tools from actions", () => {
    const mockActions = [
      { tool: { name: "talk", description: "说话", parameters: {} }, handler: () => ({ description: "", effects: [] }) },
      { tool: { name: "go_to", description: "去某处", parameters: {} }, handler: () => ({ description: "", effects: [] }) },
    ];
    const request = buildConversationRequest({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history: [], gameTime, locationName: "咖啡馆",
      actions: mockActions as any,
    });

    expect(request.tools).toHaveLength(2);
    expect(request.tools![0]!.name).toBe("talk");
  });
});
