/**
 * D4 — agenda-store 单测
 */

import { describe, it, expect } from "vitest";
import { InMemoryAgendaStore, MAX_ACTIVE_ARCS, FREELANCE_LIFETIME_DAYS } from "./agenda-store.js";

describe("InMemoryAgendaStore", () => {
  it("creates an arc and assigns id", () => {
    const store = new InMemoryAgendaStore();
    const r = store.create(
      { beatId: "b1", goal: "测试目标", targetDay: 3, watchChars: ["alice"] },
      100,
      1,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.arc.id).toMatch(/^arc_/);
      expect(r.arc.status).toBe("setup");
      expect(r.arc.beatId).toBe("b1");
    }
  });

  it("rejects when active arc cap reached", () => {
    const store = new InMemoryAgendaStore();
    for (let i = 0; i < MAX_ACTIVE_ARCS; i++) {
      store.create({ beatId: `b${i}`, goal: "g", targetDay: 3, watchChars: [] }, 100, 1);
    }
    const r = store.create({ beatId: "b9", goal: "g", targetDay: 3, watchChars: [] }, 100, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("上限");
  });

  it("rejects second freelance arc", () => {
    const store = new InMemoryAgendaStore();
    store.create({ beatId: "freelance", goal: "f1", targetDay: 3, watchChars: [] }, 100, 1);
    const r = store.create({ beatId: "freelance", goal: "f2", targetDay: 3, watchChars: [] }, 100, 1);
    expect(r.ok).toBe(false);
  });

  it("rejects empty beat_id or goal", () => {
    const store = new InMemoryAgendaStore();
    expect(store.create({ beatId: "", goal: "g", targetDay: 3, watchChars: [] }, 100, 1).ok).toBe(false);
    expect(store.create({ beatId: "b", goal: "", targetDay: 3, watchChars: [] }, 100, 1).ok).toBe(false);
  });

  it("updates status and notes; resolved/abandoned move to archive", () => {
    const store = new InMemoryAgendaStore();
    const r = store.create({ beatId: "b1", goal: "g", targetDay: 3, watchChars: [] }, 100, 1);
    if (!r.ok) throw new Error("create failed");
    const id = r.arc.id;
    store.update(id, { status: "brewing", notes: "进展中" }, 110);
    expect(store.get(id)?.status).toBe("brewing");
    expect(store.get(id)?.notes).toBe("进展中");
    expect(store.size()).toBe(1);

    store.update(id, { status: "resolved" }, 120);
    expect(store.size()).toBe(0); // 移到 archive
    expect(store.archiveSize()).toBe(1);
    expect(store.get(id)?.status).toBe("resolved"); // 仍可查
  });

  it("update returns error for unknown arc", () => {
    const store = new InMemoryAgendaStore();
    const r = store.update("arc_999", { status: "resolved" }, 100);
    expect(r.ok).toBe(false);
  });

  it("notes 自动截断到 200 字", () => {
    const store = new InMemoryAgendaStore();
    const long = "x".repeat(300);
    const r = store.create({ beatId: "b1", goal: "g", targetDay: 3, watchChars: [], notes: long }, 100, 1);
    if (r.ok) expect(r.arc.notes.length).toBe(200);
  });

  it("maintenance abandons freelance arcs older than lifetime", () => {
    const store = new InMemoryAgendaStore();
    const r = store.create({ beatId: "freelance", goal: "g", targetDay: 5, watchChars: [] }, 100, 1);
    if (!r.ok) throw new Error("create failed");
    // day 1 创建，到 day 4 = 3 天后，超过 2 天寿命
    const abandoned = store.maintenance(4, 400);
    expect(abandoned).toBe(1);
    expect(store.size()).toBe(0);
    expect(store.get(r.arc.id)?.status).toBe("abandoned");
  });

  it("maintenance keeps non-freelance arcs even when old", () => {
    const store = new InMemoryAgendaStore();
    store.create({ beatId: "b1", goal: "g", targetDay: 5, watchChars: [] }, 100, 1);
    const abandoned = store.maintenance(10, 1000);
    expect(abandoned).toBe(0);
    expect(store.size()).toBe(1);
  });

  it("renderForPrompt 渲染当前活跃 arc", () => {
    const store = new InMemoryAgendaStore();
    expect(store.renderForPrompt()).toContain("无活跃 arc");

    store.create({ beatId: "b1", goal: "推进真相揭露", targetDay: 3, watchChars: ["alice", "bob"] }, 100, 1);
    const out = store.renderForPrompt();
    expect(out).toContain("arc_1");
    expect(out).toContain("[beat:b1]");
    expect(out).toContain("推进真相揭露");
    expect(out).toContain("alice");
  });

  it("FREELANCE_LIFETIME_DAYS 是 2", () => {
    expect(FREELANCE_LIFETIME_DAYS).toBe(2);
  });
});
