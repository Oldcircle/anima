/**
 * 器物层（PLAN-grounding M0）单测
 *
 * 锁形状：
 * - YAML 声明解析（normalizeObjectDefs 逐字段显式映射，非法条目丢弃）
 * - 登记幂等：重复登记保留动态状态，authored 字段以 YAML 为准
 * - resolveByName 三级模糊（全等/包含/关键词）
 * - examine 返回 ground truth（骨架+正典+痕迹）并落 lastSeen
 * - trace 去重 + addTraceAt 词面命中（命不中静默跳过）
 * - 重访 diff：看过的器物变了才提醒
 * - 意图指路：词面命中给指路不给真相；已看过且未变不刷屏；上限
 * - 骨架行只有名字零状态（缓存安全）
 * - 快照往返（只存动态）+ 脏快照规范化 + YAML 已删器物的孤儿动态丢弃
 * - DB world_objects 键往返
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import {
  WorldObjectStore,
  normalizeObjectDefs,
  INTENT_MATCH_CAP,
  type WorldObjectDef,
} from "./world-objects.js";
import { AnimaDB } from "../persistence/database.js";

const LIB_OBJECTS: WorldObjectDef[] = [
  {
    id: "ledger",
    name: "借阅台账",
    summary: "前台那本厚台账",
    keywords: ["台账", "借阅", "记录"],
    canon: ["台账按月换页"],
    tamperable: true,
  },
  { id: "shelves", name: "书架", summary: "一排排高书架", keywords: ["书架"], canon: [] },
  { id: "desk", name: "阅览桌", keywords: [], canon: ["桌角有刻痕"] },
];

function makeStore(): WorldObjectStore {
  const store = new WorldObjectStore();
  store.registerLocation({ id: "library", objects: LIB_OBJECTS });
  return store;
}

describe("normalizeObjectDefs — YAML 解析", () => {
  it("合法条目逐字段映射；缺 id/name 的丢弃；单字关键词过滤", () => {
    const defs = normalizeObjectDefs([
      { id: "a", name: "钱盒", keywords: ["钱盒", "盒", 42], canon: ["锁扣是新的", 7], tamperable: true },
      { id: "", name: "无 id" },
      { name: "无 id 字段" },
      "不是对象",
    ]);
    expect(defs).toHaveLength(1);
    expect(defs![0]).toEqual({
      id: "a",
      name: "钱盒",
      summary: undefined,
      keywords: ["钱盒"],
      canon: ["锁扣是新的"],
      tamperable: true,
    });
  });

  it("非数组/空数组返回 undefined", () => {
    expect(normalizeObjectDefs(undefined)).toBeUndefined();
    expect(normalizeObjectDefs("objects")).toBeUndefined();
    expect(normalizeObjectDefs([])).toBeUndefined();
  });
});

describe("登记与解析", () => {
  it("骨架行只有名字零状态；没器物的地点返回 undefined", () => {
    const store = makeStore();
    expect(store.describeSkeleton("library")).toBe("这里值得留意的有：借阅台账、书架、阅览桌。");
    expect(store.describeSkeleton("beach")).toBeUndefined();
    // 加 trace 后骨架行逐字节不变（静态承诺）
    store.addTrace("library.ledger", { id: "t1", text: "被撕了一页", addedTick: 5, source: "event" });
    expect(store.describeSkeleton("library")).toBe("这里值得留意的有：借阅台账、书架、阅览桌。");
  });

  it("resolveByName：全等 > 名字包含 > 关键词", () => {
    const store = makeStore();
    expect(store.resolveByName("library", "借阅台账")?.defId).toBe("ledger");
    expect(store.resolveByName("library", "台账")?.defId).toBe("ledger"); // 名字包含
    expect(store.resolveByName("library", "查一下借阅记录")?.defId).toBe("ledger"); // 关键词
    expect(store.resolveByName("library", "烤炉")).toBeUndefined();
    expect(store.resolveByName("library", "")).toBeUndefined();
  });

  it("重复登记幂等：动态状态保留，authored 以 YAML 为准", () => {
    const store = makeStore();
    store.addTrace("library.ledger", { id: "t1", text: "被撕了一页", addedTick: 5, source: "event" });
    store.addCanonFact("library.ledger", "上月的页码对不上", 6, "event");
    // YAML 改版重新登记（authored canon 换了）
    store.registerLocation({
      id: "library",
      objects: [{ ...LIB_OBJECTS[0]!, canon: ["新版钩子"] }, LIB_OBJECTS[1]!, LIB_OBJECTS[2]!],
    });
    const obj = store.get("library.ledger")!;
    expect(obj.traces.map((t) => t.id)).toEqual(["t1"]); // 动态保留
    expect(obj.canonFacts.map((f) => f.text)).toEqual(["新版钩子", "上月的页码对不上"]); // authored 换新，动态在后
  });
});

describe("examine 与痕迹", () => {
  it("examine 返回骨架+正典+痕迹并落 lastSeen", () => {
    const store = makeStore();
    store.addTrace("library.ledger", { id: "t1", text: "最新一页有涂改的墨团", addedTick: 5, source: "event" });
    const text = store.examine("library.ledger", "l_lawliet", 10)!;
    expect(text).toContain("前台那本厚台账");
    expect(text).toContain("台账按月换页");
    expect(text).toContain("最新一页有涂改的墨团");
    expect(store.get("library.ledger")!.lastSeen["l_lawliet"]!.tick).toBe(10);
  });

  it("光板器物 examine 给「寻常」兜底而不是空串", () => {
    const store = new WorldObjectStore();
    store.registerLocation({ id: "x", objects: [{ id: "cup", name: "杯子" }] });
    expect(store.examine("x.cup", "a", 1)).toContain("寻常");
  });

  it("重复衰减：未变化的器物再查只给短反馈；变化后全文恢复", () => {
    const store = makeStore();
    const first = store.examine("library.ledger", "l", 10)!;
    expect(first).toContain("台账按月换页"); // 首查全文
    const repeat = store.examine("library.ledger", "l", 11)!;
    expect(repeat).toContain("没什么新东西"); // 复读被衰减
    expect(repeat).not.toContain("台账按月换页");
    // 别的角色首查不受影响
    expect(store.examine("library.ledger", "light", 12)).toContain("台账按月换页");
    // 器物变化 → 全文恢复（含新痕迹）
    store.addTrace("library.ledger", { id: "torn", text: "最新一页被撕掉了", addedTick: 13, source: "event" });
    const afterChange = store.examine("library.ledger", "l", 14)!;
    expect(afterChange).toContain("最新一页被撕掉了");
    expect(afterChange).toContain("台账按月换页");
  });

  it("trace 同 id 去重；addTraceAt 词面命中落痕、命不中静默跳过", () => {
    const store = makeStore();
    expect(store.addTrace("library.ledger", { id: "t1", text: "x", addedTick: 1, source: "event" })).toBe(true);
    expect(store.addTrace("library.ledger", { id: "t1", text: "y", addedTick: 2, source: "event" })).toBe(false);
    expect(store.get("library.ledger")!.traces).toHaveLength(1);

    expect(store.addTraceAt("library", "台账", { id: "t2", text: "z", addedTick: 3, source: "event" })).toBe(true);
    expect(store.addTraceAt("library", "钱盒", { id: "t3", text: "w", addedTick: 3, source: "event" })).toBe(false);
    expect(store.addTraceAt("nowhere", "台账", { id: "t4", text: "v", addedTick: 3, source: "event" })).toBe(false);
  });
});

describe("触发通道（M1 判据）", () => {
  it("重访 diff：examine 过的器物变了才提醒，没看过的不提醒", () => {
    const store = makeStore();
    expect(store.diffForCharacter("library", "l")).toEqual([]); // 没看过
    store.examine("library.ledger", "l", 10);
    expect(store.diffForCharacter("library", "l")).toEqual([]); // 看过没变
    store.addTrace("library.ledger", { id: "torn", text: "被撕了一页", addedTick: 20, source: "interaction" });
    const diff = store.diffForCharacter("library", "l");
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain("借阅台账");
    expect(diff[0]).toContain("不太一样");
    // 别的角色没看过 → 不提醒
    expect(store.diffForCharacter("library", "light")).toEqual([]);
  });

  it("意图指路：词面命中给指路不给真相；看过且未变不刷屏；上限生效", () => {
    const store = makeStore();
    const lines = store.matchIntents("library", ["把借阅记录调出来看看"], "l");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("借阅台账");
    expect(lines[0]).not.toContain("台账按月换页"); // 真相不白送

    // 看过且未变 → 不再指路
    store.examine("library.ledger", "l", 10);
    expect(store.matchIntents("library", ["把借阅记录调出来看看"], "l")).toEqual([]);
    // 变了 → 恢复指路（diff 通道也会提醒，两路同源不冲突）
    store.addTrace("library.ledger", { id: "torn", text: "x", addedTick: 20, source: "event" });
    expect(store.matchIntents("library", ["把借阅记录调出来看看"], "l")).toHaveLength(1);

    // 上限：意图同时命中三件也只给 INTENT_MATCH_CAP 条
    const many = store.matchIntents("library", ["翻台账、搜书架、查阅览桌"], "light");
    expect(many.length).toBeLessThanOrEqual(INTENT_MATCH_CAP);
  });

  it("空意图/无器物地点零输出", () => {
    const store = makeStore();
    expect(store.matchIntents("library", [], "l")).toEqual([]);
    expect(store.matchIntents("beach", ["找台账"], "l")).toEqual([]);
  });
});

describe("快照往返（随档）", () => {
  it("只存动态；往返后动态恢复、authored 来自登记", () => {
    const store = makeStore();
    store.addTrace("library.ledger", { id: "t1", text: "撬痕", addedTick: 5, source: "event" });
    store.addCanonFact("library.ledger", "运行期正典", 6, "canonized");
    store.setFlag("library.ledger", "pried", true);
    store.examine("library.ledger", "l", 10);

    const snap = JSON.parse(JSON.stringify(store.getSnapshot()));
    expect(Object.keys(snap.objects)).toEqual(["library.ledger"]); // 纯 YAML 态不入档

    const fresh = makeStore();
    fresh.replaceSnapshot(snap);
    const obj = fresh.get("library.ledger")!;
    expect(obj.traces.map((t) => t.id)).toEqual(["t1"]);
    expect(obj.canonFacts.map((f) => f.text)).toEqual(["台账按月换页", "运行期正典"]);
    expect(obj.flags.pried).toBe(true);
    expect(obj.lastSeen["l"]!.tick).toBe(10);
  });

  it("脏快照规范化：非法条目丢弃、YAML 已删器物的孤儿动态丢弃、垃圾输入不炸", () => {
    const store = makeStore();
    store.replaceSnapshot(null);
    store.replaceSnapshot("garbage");
    store.replaceSnapshot({
      version: 1,
      objects: {
        "library.ledger": {
          traces: [{ id: "ok", text: "合法", addedTick: 1, source: "event" }, { id: "bad", addedTick: NaN }],
          canonFacts: [{ text: "合法", addedTick: 2, source: "canonized" }, { text: "authored 不该来", addedTick: 0, source: "authored" }],
          flags: { a: 1, b: { nested: true } },
          lastSeen: { l: { tick: 3, digest: "d" }, bad: { tick: "x" } },
        },
        "library.gone_object": { traces: [{ id: "orphan", text: "孤儿", addedTick: 1, source: "event" }] },
      },
    });
    const obj = store.get("library.ledger")!;
    expect(obj.traces.map((t) => t.id)).toEqual(["ok"]);
    // authored 声称的条目不从快照进（authored 只来自 YAML）
    expect(obj.canonFacts.filter((f) => f.source === "authored").map((f) => f.text)).toEqual(["台账按月换页"]);
    expect(obj.canonFacts.some((f) => f.text === "合法")).toBe(true);
    expect(obj.flags).toEqual({ a: 1 });
    expect(Object.keys(obj.lastSeen)).toEqual(["l"]);
    expect(store.get("library.gone_object")).toBeUndefined();
  });

  it("DB world_objects 键往返", () => {
    const dbPath = join(tmpdir(), `anima-world-objects-test-${process.pid}.db`);
    if (existsSync(dbPath)) unlinkSync(dbPath);
    const db = new AnimaDB(dbPath);
    try {
      const store = makeStore();
      store.addTrace("library.ledger", { id: "t1", text: "撬痕", addedTick: 5, source: "event" });
      db.saveWorldState(100, "sunny", undefined, "default", undefined, undefined, JSON.stringify(store.getSnapshot()));
      const loaded = db.loadWorldState()!;
      const fresh = makeStore();
      fresh.replaceSnapshot(JSON.parse(loaded.worldObjectsJson!));
      expect(fresh.get("library.ledger")!.traces.map((t) => t.id)).toEqual(["t1"]);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
    }
  });
});
