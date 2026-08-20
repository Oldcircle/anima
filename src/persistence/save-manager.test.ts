/**
 * SaveManager 单测。
 *
 * 锁的是"存档系统看起来在跑、其实没保护住"的那几种：
 * ①**tick 边界纪律**——手动请求不能在 tick 中途落地（会存出半个 tick 的世界）
 * ②**防重入**——两个信号连着来只能存一次
 * ③**备份轮转**——覆盖前留 .bak
 * ④**永不抛**——存档失败不该带走进程
 * ⑤快照名消毒（防路径穿越）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaveManager, sanitizeSnapshotName, sanitizeSaveName, resolveAutosaveTicks, DEFAULT_AUTOSAVE_TICKS } from "./save-manager.js";
import { archiveRun } from "./run-archive.js";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const card: CharacterCard = {
  id: "tomori", name: "高松灯", age: 20, occupation: "镇民", home: "home_tomori",
  personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
  background: "", relationships: {},
};

let dir: string;

function makeManager(over?: { autosaveTicks?: number; savePath?: string }) {
  const world = new World(TEST_LOCATIONS, 100);
  world.addCharacter("tomori", "高松灯", "cafe");
  const sim = new Simulation(world, new EventBus(), {
    characters: [card], actions: ALL_BASIC_ACTIONS,
    provider: new MockLLMProvider(), modelId: "test",
  });
  const saves = new SaveManager({
    simulation: sim,
    savePath: over?.savePath ?? join(dir, "save.db"),
    scenarioId: "default",
    snapshotDir: join(dir, "snapshots"),
    runsDir: join(dir, "data", "runs"),
    savesDir: join(dir, "saves"),
    autosaveTicks: over?.autosaveTicks ?? 24,
  });
  return { world, sim, saves };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-save-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("SaveManager 存档", () => {
  it("saveNow 真写盘，status 记录 tick/次数/原因", () => {
    const { saves, world } = makeManager();
    expect(saves.saveNow("测试")).toBe(true);
    expect(existsSync(saves.path)).toBe(true);
    const st = saves.status();
    expect(st.saveCount).toBe(1);
    expect(st.lastSaveTick).toBe(world.tick);
    expect(st.lastReason).toBe("测试");
    expect(st.sizeBytes).toBeGreaterThan(0);
  });

  it("覆盖前轮转 .bak（存档写坏了还有退路）", () => {
    const { saves } = makeManager();
    saves.saveNow("第一次");
    expect(existsSync(`${saves.path}.bak`)).toBe(false); // 首存没有可备份的旧档
    saves.saveNow("第二次");
    expect(existsSync(`${saves.path}.bak`)).toBe(true);
  });

  it("存档失败不抛、记进 status（失败不该带走进程）", () => {
    const { saves } = makeManager({ savePath: join(dir, "no-such-dir", "save.db") });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => saves.saveNow("坏路径")).not.toThrow();
    expect(saves.saveNow("坏路径")).toBe(false);
    expect(saves.status().failCount).toBeGreaterThan(0);
    expect(saves.status().lastError).toBeTruthy();
  });
});

describe("SaveManager tick 边界纪律", () => {
  it("引擎在跑 → 手动请求只排队，不当场写盘", () => {
    const { saves } = makeManager();
    const applied = saves.request("手动", { engineRunning: true });
    expect(applied).toBe(false);
    expect(saves.status().pending).toBe(true);
    expect(existsSync(saves.path)).toBe(false); // 关键：tick 中途一个字节都没写

    saves.onTickBoundary(101);                  // 到边界才落地
    expect(existsSync(saves.path)).toBe(true);
    expect(saves.status().pending).toBe(false);
    expect(saves.status().lastReason).toBe("手动");
  });

  it("引擎停着 → 立即存（没有 tick 会来，排队等于永远不存）", () => {
    const { saves } = makeManager();
    expect(saves.request("手动", { engineRunning: false })).toBe(true);
    expect(existsSync(saves.path)).toBe(true);
  });

  it("到点自动存档；没到点不存；排队的手动请求优先且不重复存", () => {
    const { saves } = makeManager({ autosaveTicks: 24 });
    saves.onTickBoundary(23);
    expect(saves.status().saveCount).toBe(0);
    saves.onTickBoundary(24);
    expect(saves.status().saveCount).toBe(1);
    expect(saves.status().lastReason).toBe("自动");

    saves.request("手动", { engineRunning: true });
    saves.onTickBoundary(48); // 同时到点：只存一次，且算手动
    expect(saves.status().saveCount).toBe(2);
    expect(saves.status().lastReason).toBe("手动");
  });

  it("autosaveTicks=0 关掉周期存档（信号存档仍可用）", () => {
    const { saves } = makeManager({ autosaveTicks: 0 });
    saves.onTickBoundary(0);
    saves.onTickBoundary(96);
    expect(saves.status().saveCount).toBe(0);
    expect(saves.saveNow("信号")).toBe(true);
  });
});

describe("SaveManager 快照", () => {
  it("快照另存到 snapshots/，不动主档；列表按时间倒序", () => {
    const { saves } = makeManager();
    saves.saveNow("主档");
    const mainBefore = readFileSync(saves.path).length;

    const snap = saves.snapshot("跑r3之前")!;
    expect(snap).toBeTruthy();
    expect(snap.name).toContain("t100");           // 快照名带 tick，可回溯
    expect(existsSync(snap.file)).toBe(true);
    expect(readFileSync(saves.path).length).toBe(mainBefore); // 主档没被动

    const list = saves.listSnapshots();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe(snap.name);
  });

  it("快照名消毒：路径穿越与怪字符都被挡掉", () => {
    expect(sanitizeSnapshotName("../../etc/passwd")).not.toContain("/");
    expect(sanitizeSnapshotName("../../etc/passwd")).not.toContain("..");
    expect(sanitizeSnapshotName("跑 r3 之前")).toBe("跑-r3-之前");
    expect(sanitizeSnapshotName("!!!")).toBe("");
  });

  it("没有 snapshots 目录时列表为空数组（不抛）", () => {
    const { saves } = makeManager();
    expect(saves.listSnapshots()).toEqual([]);
  });
});

describe("SaveManager 命名存档（像游戏那样）", () => {
  it("另存为：写命名档 + 切换当前档 + 旧档原样留着", () => {
    const { saves } = makeManager();
    vi.spyOn(console, "log").mockImplementation(() => {});
    saves.saveNow("主档");
    const mainPath = saves.path;
    const mainBytes = readFileSync(mainPath).length;

    const info = saves.saveAs("小镇第一周")!;
    expect(info.name).toBe("小镇第一周");
    expect(existsSync(info.file)).toBe(true);
    expect(saves.path).toBe(info.file);            // 已切换：以后往新档写
    expect(saves.displayName).toBe("小镇第一周");
    expect(readFileSync(mainPath).length).toBe(mainBytes); // 旧档一个字节没动

    // 切换后的自动存档落在新档上
    saves.onTickBoundary(24);
    expect(saves.status().lastReason).toBe("自动");
    expect(saves.path).toBe(info.file);
  });

  it("存档名消毒：路径穿越挡掉、空格转连字符、空名拒绝", () => {
    expect(sanitizeSaveName("../../etc/passwd")).not.toContain("/");
    expect(sanitizeSaveName("../../etc/passwd")).not.toContain("..");
    expect(sanitizeSaveName("小镇 第一周")).toBe("小镇-第一周");
    expect(sanitizeSaveName("  !!!  ")).toBe("");

    const { saves } = makeManager();
    expect(saves.saveAs("")).toBeUndefined();
    expect(saves.saveAs("///")).toBeUndefined();   // 消毒后为空 → 拒绝，不写盘
  });

  it("命名档在清单里归 named 类，打开命令用名字不用路径", () => {
    const { saves } = makeManager();
    vi.spyOn(console, "log").mockImplementation(() => {});
    saves.saveAs("存档甲");
    const named = saves.listSlots().find((s) => s.kind === "named")!;
    expect(named.name).toBe("存档甲");
    expect(named.openWith).toBe("pnpm dev --load 存档甲");  // 好记，不是一长条路径
  });
});

describe("SaveManager 档案清单", () => {
  it("主档/快照/长跑归档各归各类，带 tick+剧本+打开命令，最新在前", () => {
    const { saves, sim } = makeManager();
    saves.saveNow("主档");
    saves.snapshot("跑前留一手");
    // 真跑一次归档：sim 长跑跑完就是走这条路
    vi.spyOn(console, "log").mockImplementation(() => {});
    const runFile = archiveRun(sim, "grounding-verify-r3", "default", { projectRoot: dir })!;
    expect(runFile).toBeTruthy();

    const slots = saves.listSlots();
    const main = slots.find((s) => s.kind === "main")!;
    const snap = slots.find((s) => s.kind === "snapshot")!;
    const run = slots.find((s) => s.kind === "run")!;
    expect(run.name).toContain("grounding-verify-r3");
    expect(run.tick).toBe(sim.world.tick);
    expect(main.tick).toBe(sim.world.tick);      // 探针读得出进度，不用装世界
    expect(main.scenarioId).toBe("default");
    expect(main.openWith).toContain("pnpm dev --load");
    expect(snap.name).toContain("跑前留一手");
    expect(slots.every((s) => s.sizeBytes > 0)).toBe(true);
  });

  it("目录不存在 / 档读不动 → 返回能读的那些，不整张挂掉", () => {
    const { saves } = makeManager();
    expect(saves.listSlots()).toEqual([]);        // 一个档都还没有
    saves.saveNow("主档");
    writeFileSync(join(dir, "save-坏档.db"), "这不是 sqlite");
    const slots = saves.listSlots();
    expect(slots.some((s) => s.name === "save")).toBe(true);
    // 坏档进得了清单但没有 tick（探针读不出来），不影响别的
    const bad = slots.find((s) => s.name === "save-坏档");
    expect(bad?.tick).toBeUndefined();
  });
});

describe("resolveAutosaveTicks", () => {
  afterEach(() => { delete process.env.ANIMA_AUTOSAVE_TICKS; });

  it("默认 24 tick（6 游戏小时）；env 可调；0 = 关闭；非法值回落默认", () => {
    expect(resolveAutosaveTicks()).toBe(DEFAULT_AUTOSAVE_TICKS);
    process.env.ANIMA_AUTOSAVE_TICKS = "8";
    expect(resolveAutosaveTicks()).toBe(8);
    process.env.ANIMA_AUTOSAVE_TICKS = "0";
    expect(resolveAutosaveTicks()).toBe(0);
    process.env.ANIMA_AUTOSAVE_TICKS = "不是数字";
    expect(resolveAutosaveTicks()).toBe(DEFAULT_AUTOSAVE_TICKS);
  });
});
