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
  id: "mutsumi",
  name: "要乐奏",
  age: 19,
  occupation: "杂货店帮工",
  home: "home_mutsumi",
  appearance: "温柔的笑容，总是让人安心。",
  personality: {
    traits: ["温和", "包容"],
    interests: ["吉他"],
    dislikes: ["争吵"],
    speechStyle: "温柔平稳",
    coreTraits: "天生的调解者",
    speech: { style: "温柔但坚定", habits: ["没关系的"], examples: ["大家都很努力呢"] },
  },
  background: "乐器店老板的女儿",
  relationships: {},
};

const sakikoState: CharacterState = {
  id: "sakiko", name: "丰川祥子", locationId: "cafe",
  needs: { hunger: 60, energy: 70, social: 35, happiness: 50, hygiene: 80 },
  gold: 45, moodlets: [], inbox: [],
};

const mariaState: CharacterState = {
  id: "mutsumi", name: "要乐奏", locationId: "cafe",
  needs: { hunger: 50, energy: 80, social: 60, happiness: 70, hygiene: 90 },
  gold: 62, moodlets: [], inbox: [],
};

const gameTime = { tick: 52, day: 0, hour: 13, minute: 0, season: "spring" as const, seasonDay: 1, year: 1 };

// ── ConversationTracker tests ──

describe("ConversationTracker", () => {
  it("records talk and retrieves history", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "你好！", 50);
    tracker.recordTalk("sakiko", "祥子", "mutsumi", "你好。", 50);

    const history = tracker.getHistory("mutsumi", "sakiko");
    expect(history).toHaveLength(2);
    expect(history[0]!.message).toBe("你好！");
    expect(history[1]!.message).toBe("你好。");
  });

  it("pair key is order-independent", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "Hi", 50);

    expect(tracker.getHistory("mutsumi", "sakiko")).toHaveLength(1);
    expect(tracker.getHistory("sakiko", "mutsumi")).toHaveLength(1);
  });

  it("detects active conversation when both sides talked recently", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "你好！", 50);
    tracker.recordTalk("sakiko", "祥子", "mutsumi", "你好。", 51);

    expect(tracker.isActiveConversation("mutsumi", "sakiko", 52)).toBe(true);
  });

  it("not active if only one side talked", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "你好！", 50);
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "在吗？", 51);

    expect(tracker.isActiveConversation("mutsumi", "sakiko", 52)).toBe(false);
  });

  it("not active if exchanges are too old", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "你好！", 40);
    tracker.recordTalk("sakiko", "祥子", "mutsumi", "你好。", 41);

    expect(tracker.isActiveConversation("mutsumi", "sakiko", 52)).toBe(false);
  });

  it("cleanup removes expired conversations", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "旧消息", 10);
    tracker.recordTalk("tomori", "高松灯", "anon", "新消息", 50);

    tracker.cleanup(52);

    expect(tracker.getHistory("mutsumi", "sakiko")).toHaveLength(0);
    expect(tracker.getHistory("tomori", "anon")).toHaveLength(1);
  });

  it("clear removes specific conversation", () => {
    const tracker = new ConversationTracker();
    tracker.recordTalk("mutsumi", "要乐奏", "sakiko", "消息", 50);
    tracker.clear("mutsumi", "sakiko");

    expect(tracker.getHistory("mutsumi", "sakiko")).toHaveLength(0);
  });
});

// ── Conversation prompt tests ──

describe("buildConversationPrompt", () => {
  const history = [
    { speakerId: "mutsumi", speakerName: "要乐奏", message: "祥子，你今天看起来好像有心事？", tick: 50 },
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
    expect(prompt).toContain("要乐奏");
    expect(prompt).toContain("有些印象");
    expect(prompt).not.toContain("亲密度");
  });

  it("includes full dialogue history with correct labels", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain("## 对话记录");
    expect(prompt).toContain("要乐奏：「祥子，你今天");
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

  it("includes body feeling hints when needs are low", () => {
    const lowState = { ...sakikoState, needs: { ...sakikoState.needs, social: 15, happiness: 20 } };
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: lowState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain("心情不太好");
  });

  it("includes talk target ID reminder", () => {
    const prompt = buildConversationPrompt({
      card: sakikoCard, state: sakikoState,
      partnerCard: mariaCard, partnerState: mariaState,
      history, gameTime, locationName: "咖啡馆",
    });

    expect(prompt).toContain('"mutsumi"');
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
    expect(request.maxTokens).toBe(1024);
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
