/**
 * 长期记忆 store 测试（活人感体检 P2）
 *
 * 回归锁：此前 LTM 只是存档快照、运行期零调用（48 小时记忆气泡）；
 * 现在反思/冲突/约定结算当刻写入，对话时按对象检索注入。
 */

import { describe, it, expect } from "vitest";
import { LongTermMemoryStore, formatSharedHistory } from "./long-term.js";

describe("LongTermMemoryStore", () => {
  it("按对象检索：getAbout 只返回和这个人有关的记忆", () => {
    const store = new LongTermMemoryStore();
    store.add("a", { tick: 10, type: "event", content: "你和B大吵了一架", importance: 8, relatedCharacterId: "b" });
    store.add("a", { tick: 20, type: "reflection", content: "[反思] 今天很累", importance: 9 });
    store.add("a", { tick: 30, type: "event", content: "C放了你鸽子", importance: 8, relatedCharacterId: "c" });

    const aboutB = store.getAbout("a", "b");
    expect(aboutB).toHaveLength(1);
    expect(aboutB[0]!.content).toContain("大吵");
  });

  it("同内容同 tick 去重（重复写入不堆积）", () => {
    const store = new LongTermMemoryStore();
    for (let i = 0; i < 5; i++) {
      store.add("a", { tick: 10, type: "reflection", content: "[反思] 一样的话", importance: 9 });
    }
    expect(store.all("a")).toHaveLength(1);
  });

  it("getTop 按重要性优先", () => {
    const store = new LongTermMemoryStore();
    store.add("a", { tick: 1, type: "event", content: "小事", importance: 5 });
    store.add("a", { tick: 2, type: "event", content: "大事", importance: 9 });
    expect(store.getTop("a", 1)[0]!.content).toBe("大事");
  });

  it("restore 整体替换（读档路径）", () => {
    const store = new LongTermMemoryStore();
    store.add("a", { tick: 1, type: "event", content: "旧的", importance: 5 });
    store.restore("a", [
      { tick: 5, type: "event", content: "档里的", importance: 7, relatedCharacterId: "b" },
    ]);
    expect(store.all("a")).toHaveLength(1);
    expect(store.getAbout("a", "b")[0]!.content).toBe("档里的");
  });
});

describe("formatSharedHistory", () => {
  it("没有共同历史时返回 undefined（刚认识就是刚认识）", () => {
    expect(formatSharedHistory({ longTermAbout: [], relationHistory: [], formatTime: () => "" })).toBeUndefined();
  });

  it("合并 LTM 和关系史，关系史里重复的内容不重复列", () => {
    const text = formatSharedHistory({
      longTermAbout: [{ tick: 10, type: "event", content: "你和B大吵了一架（她弄乱了你的东西）", importance: 8, relatedCharacterId: "b" }],
      relationHistory: ["和B吵了起来：她弄乱了你的东西", "如约见面"],
      formatTime: (t) => `t${t}`,
    })!;
    expect(text).toContain("[t10] 你和B大吵了一架");
    expect(text).toContain("如约见面");
  });
});
