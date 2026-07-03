import { describe, it, expect } from "vitest";
import { ShortTermMemory } from "./short-term.js";

describe("ShortTermMemory", () => {
  it("基本记忆添加和获取", () => {
    const mem = new ShortTermMemory();
    mem.add("tomori", { tick: 1, type: "event", content: "在花店工作", importance: 4 });
    mem.add("tomori", { tick: 2, type: "event", content: "吃了午餐", importance: 3 });

    const recent = mem.getRecent("tomori", 5);
    expect(recent).toHaveLength(2);
  });

  it("formatForPrompt 标注连续未回复的 talk", () => {
    const mem = new ShortTermMemory();

    // Bob 对 sakiko 说了 3 次话，没收到回复
    mem.add("anon", { tick: 10, type: "event", content: "对sakiko说：「嘿！早上好！」", importance: 7, relatedCharacterId: "sakiko" });
    mem.add("anon", { tick: 11, type: "event", content: "对sakiko说：「要不要喝杯咖啡？」", importance: 7, relatedCharacterId: "sakiko" });
    mem.add("anon", { tick: 12, type: "event", content: "对sakiko说：「码头夕阳很美！」", importance: 7, relatedCharacterId: "sakiko" });

    const text = mem.formatForPrompt("anon", 8);

    // 最新一条应该有未回复标注
    expect(text).toContain("你已经连续3次找对方说话，但对方没有回应你");
    // 标注只应该出现一次
    const matchCount = (text.match(/对方没有回应你/g) ?? []).length;
    expect(matchCount).toBe(1);
  });

  it("收到回复后不再标注", () => {
    const mem = new ShortTermMemory();

    mem.add("anon", { tick: 10, type: "event", content: "对sakiko说：「嘿！」", importance: 7, relatedCharacterId: "sakiko" });
    mem.add("anon", { tick: 11, type: "event", content: "对sakiko说：「喝咖啡？」", importance: 7, relatedCharacterId: "sakiko" });
    // sakiko 回复了（relatedCharacterId 用 ID 统一匹配）
    mem.add("anon", { tick: 12, type: "conversation", content: "丰川祥子对你说：「谢谢，不用了」", importance: 7, relatedCharacterId: "sakiko" });
    // Bob 又说了一次（回复后的新对话，只有 1 次，不算纠缠）
    mem.add("anon", { tick: 13, type: "event", content: "对sakiko说：「好的，改天再聊！」", importance: 7, relatedCharacterId: "sakiko" });

    const text = mem.formatForPrompt("anon", 8);
    expect(text).not.toContain("对方没有回应你");
  });

  it("对不同人分别追踪", () => {
    const mem = new ShortTermMemory();

    // 对 tomori 说了 1 次（不够 2 次，不标注）
    mem.add("anon", { tick: 10, type: "event", content: "对tomori说：「花真好看」", importance: 7, relatedCharacterId: "tomori" });
    // 对 sakiko 说了 3 次
    mem.add("anon", { tick: 11, type: "event", content: "对sakiko说：「嘿！」", importance: 7, relatedCharacterId: "sakiko" });
    mem.add("anon", { tick: 12, type: "event", content: "对sakiko说：「喝咖啡？」", importance: 7, relatedCharacterId: "sakiko" });
    mem.add("anon", { tick: 13, type: "event", content: "对sakiko说：「码头很美！」", importance: 7, relatedCharacterId: "sakiko" });

    const text = mem.formatForPrompt("anon", 8);

    // sakiko 应该被标注
    expect(text).toContain("连续3次");
    // tomori 不应该被标注
    const lines = text.split("\n");
    const tomoriLine = lines.find((l) => l.includes("对tomori说"));
    expect(tomoriLine).not.toContain("对方没有回应你");
  });

  it("无 relatedCharacterId 时不标注（向后兼容）", () => {
    const mem = new ShortTermMemory();
    mem.add("anon", { tick: 10, type: "event", content: "对sakiko说：「嘿！」", importance: 7 });
    mem.add("anon", { tick: 11, type: "event", content: "对sakiko说：「喝咖啡？」", importance: 7 });
    mem.add("anon", { tick: 12, type: "event", content: "对sakiko说：「码头很美！」", importance: 7 });

    const text = mem.formatForPrompt("anon", 8);
    expect(text).not.toContain("对方没有回应你");
  });

  it("滑动窗口超出后丢弃最旧记忆", () => {
    const mem = new ShortTermMemory(3);
    mem.add("tomori", { tick: 1, type: "event", content: "A", importance: 1 });
    mem.add("tomori", { tick: 2, type: "event", content: "B", importance: 1 });
    mem.add("tomori", { tick: 3, type: "event", content: "C", importance: 1 });
    mem.add("tomori", { tick: 4, type: "event", content: "D", importance: 1 });

    const recent = mem.getRecent("tomori", 10);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.content).toBe("B");
  });

  it("窗口满时优先淘汰低重要性琐事，高重要性反思活得更久", () => {
    const mem = new ShortTermMemory(3);
    mem.add("tomori", { tick: 1, type: "thought", content: "[反思] 重要洞察", importance: 9 });
    mem.add("tomori", { tick: 2, type: "event", content: "路过琐事", importance: 2 });
    mem.add("tomori", { tick: 3, type: "event", content: "普通事件", importance: 4 });
    mem.add("tomori", { tick: 4, type: "event", content: "新事件", importance: 4 });

    const recent = mem.getRecent("tomori", 10);
    expect(recent).toHaveLength(3);
    // 被淘汰的是低重要性琐事，而不是更旧但更重要的反思
    expect(recent.map((e) => e.content)).toEqual(["[反思] 重要洞察", "普通事件", "新事件"]);
  });

  it("超过 2 个游戏天的记忆无条件淘汰（再重要也会淡忘）", () => {
    const mem = new ShortTermMemory(3);
    mem.add("tomori", { tick: 1, type: "thought", content: "很久以前的反思", importance: 9 });
    mem.add("tomori", { tick: 200, type: "event", content: "A", importance: 2 });
    mem.add("tomori", { tick: 201, type: "event", content: "B", importance: 2 });
    mem.add("tomori", { tick: 202, type: "event", content: "C", importance: 2 });

    const recent = mem.getRecent("tomori", 10);
    expect(recent.map((e) => e.content)).toEqual(["A", "B", "C"]);
  });

  it("formatForPrompt 传入 currentTick 时给跨天记忆加日期前缀", () => {
    const mem = new ShortTermMemory(30);
    mem.add("tomori", { tick: 92, type: "event", content: "昨晚的事", importance: 5 }); // day 0, 23:00
    mem.add("tomori", { tick: 120, type: "event", content: "今天的事", importance: 5 }); // day 1, 06:00

    const text = mem.formatForPrompt("tomori", 10, 124); // 当前 day 1, 07:00
    expect(text).toContain("[昨天23:00] 昨晚的事");
    expect(text).toContain("[06:00] 今天的事");
  });

  it("formatForPrompt 不传 currentTick 时保持旧格式（向后兼容）", () => {
    const mem = new ShortTermMemory(30);
    mem.add("tomori", { tick: 92, type: "event", content: "昨晚的事", importance: 5 });

    const text = mem.formatForPrompt("tomori", 10);
    expect(text).toContain("[23:00] 昨晚的事");
    expect(text).not.toContain("昨天");
  });
});
