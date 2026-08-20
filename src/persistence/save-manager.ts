/**
 * Save Manager — 存档调度（不是新存档格式，是把已有的 saveGame 用对）
 *
 * 既有能力没问题：SQLite 单事务写入、启动自动读档、按剧本归属存档文件。
 * 破的是**触发时机**，三个都在长跑里真会咬人：
 *
 * ① **只认 SIGINT**：这个项目的长跑纪律是 `screen -dmS` / `nohup` 脱管
 *    （STATUS 有实锤："r1 被后台超时杀"、"长跑必须 nohup 脱管"）。
 *    脱管进程被杀时来的是 **SIGTERM**，关终端是 SIGHUP，崩溃是 uncaughtException——
 *    一个都不会走 SIGINT。跑了半天的世界就这么没了
 * ② **每 96 tick 才自动存**：一整个游戏日 ≈ 24 现实分钟。异常退出最多丢一整天
 * ③ **覆盖式写入无备份**：存档写坏了没有退路
 *
 * 对应三条：信号全覆盖 + 间隔缩短可配 + 覆盖前轮转 .bak。另加命名快照，
 * 让"跑 r3 之前留一手"不用手动 cp 文件。
 *
 * 一条不显然但重要的纪律：**手动存档必须排到 tick 边界**。
 * tick 内部有 await（LLM 调用），中途存档会存出"一半角色已决策、一半没有"的世界；
 * 读档后那个 tick 重跑，已行动的角色会再动一次。所以 API 来的请求只登记意图，
 * 由 tick 末尾的 `onTickBoundary` 执行；引擎停着时才立即存。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { saveGame, peekSave } from "./save-load.js";
import type { Simulation } from "../agent/simulation.js";

/** 自动存档默认间隔（tick）：24 = 6 游戏小时 ≈ 6 现实分钟 @1x。旧默认 96 = 一整天，丢得太多 */
export const DEFAULT_AUTOSAVE_TICKS = 24;

export interface SaveStatus {
  path: string;
  /** 上次成功存档的游戏 tick */
  lastSaveTick?: number;
  /** 上次成功存档的真实时间戳（ms） */
  lastSaveAt?: number;
  lastReason?: string;
  saveCount: number;
  failCount: number;
  lastError?: string;
  /** 存档文件字节数（不存在为 0） */
  sizeBytes: number;
  /** 有手动请求排队等 tick 边界 */
  pending: boolean;
  autosaveTicks: number;
}

export interface SlotInfo {
  /** main=主档/剧本档 · named=命名存档 · snapshot=手动快照 · run=sim 长跑归档 */
  kind: "main" | "named" | "snapshot" | "run";
  name: string;
  file: string;
  sizeBytes: number;
  savedAt: number;
  tick?: number;
  day?: number;
  scenarioId?: string;
  /** 打开这个档的命令（面板不热加载，把命令交给人） */
  openWith: string;
}

export interface SnapshotInfo {
  name: string;
  file: string;
  sizeBytes: number;
  /** 文件修改时间（ms） */
  savedAt: number;
}

export function resolveAutosaveTicks(): number {
  const raw = process.env.ANIMA_AUTOSAVE_TICKS;
  if (raw === undefined) return DEFAULT_AUTOSAVE_TICKS;
  const n = Number(raw);
  // 0 = 关掉周期自动存档（信号存档仍在岗）
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_AUTOSAVE_TICKS;
}

/** 命名存档目录（相对 data/）：像游戏那样一个名字一个档 */
export const SAVES_DIR_NAME = "saves";

/**
 * 存档名消毒 → 文件名。中英文数字空格与 -_ 保留（空格转 -），其余一律剔掉。
 * 防路径穿越是硬要求：`../../etc/passwd` 不能变成一条真路径。
 */
export function sanitizeSaveName(raw: string): string {
  const cleaned = raw.trim().replace(/[^\w一-龥\s-]/g, "").replace(/[\s-]+/g, "-").slice(0, 48);
  return cleaned.replace(/^-|-$/g, "");
}

/** 快照名消毒：只留中英文数字与 -_，防路径穿越 */
export function sanitizeSnapshotName(raw: string): string {
  const cleaned = raw.trim().replace(/[^\w一-龥-]/g, "-").replace(/-+/g, "-").slice(0, 40);
  return cleaned.replace(/^-|-$/g, "");
}

export class SaveManager {
  private _sim: Simulation;
  private _path: string;
  private _scenarioId: string;
  private _snapshotDir: string;
  private _runsDir: string;
  private _savesDir: string;
  private _autosaveTicks: number;
  private _saving = false;
  private _pendingReason?: string;
  private _status: { lastSaveTick?: number; lastSaveAt?: number; lastReason?: string; saveCount: number; failCount: number; lastError?: string } = {
    saveCount: 0,
    failCount: 0,
  };

  constructor(opts: {
    simulation: Simulation;
    savePath: string;
    scenarioId: string;
    snapshotDir: string;
    /** sim 长跑归档目录（缺省 = 主档同级 runs/） */
    runsDir?: string;
    /** 命名存档目录（缺省 = 主档同级 saves/） */
    savesDir?: string;
    autosaveTicks?: number;
  }) {
    this._sim = opts.simulation;
    this._path = opts.savePath;
    this._scenarioId = opts.scenarioId;
    this._snapshotDir = opts.snapshotDir;
    this._runsDir = opts.runsDir ?? join(dirname(opts.savePath), "runs");
    this._savesDir = opts.savesDir ?? join(dirname(opts.savePath), SAVES_DIR_NAME);
    this._autosaveTicks = opts.autosaveTicks ?? resolveAutosaveTicks();
  }

  get path(): string {
    return this._path;
  }

  get autosaveTicks(): number {
    return this._autosaveTicks;
  }

  /**
   * 立即存档。**防重入**：正在存的时候再来一次直接跳过——
   * 信号可能连着来两个（SIGTERM 后用户又按 Ctrl+C），半途重入会写出坏档。
   * 永不抛：存档失败不该带走整个进程。
   */
  saveNow(reason: string): boolean {
    if (this._saving) return false;
    this._saving = true;
    try {
      this._rotateBackup();
      saveGame(this._sim, this._path, this._scenarioId);
      this._status.lastSaveTick = this._sim.world.tick;
      this._status.lastSaveAt = Date.now();
      this._status.lastReason = reason;
      this._status.saveCount++;
      this._status.lastError = undefined;
      return true;
    } catch (e) {
      this._status.failCount++;
      this._status.lastError = (e as Error)?.message?.slice(0, 200) ?? "unknown";
      console.error(`💾 存档失败（${reason}）:`, e);
      return false;
    } finally {
      this._saving = false;
      this._pendingReason = undefined;
    }
  }

  /**
   * 请求一次存档。tick 跑着的时候只登记意图，等 `onTickBoundary` 执行——
   * tick 中途存会存出半个 tick（见文件头说明）。引擎停着就立即存。
   * 返回 true = 已立即执行；false = 已排队。
   */
  request(reason: string, opts?: { engineRunning?: boolean }): boolean {
    if (opts?.engineRunning === false) {
      return this.saveNow(reason);
    }
    this._pendingReason = reason;
    return false;
  }

  /**
   * tick 末尾调用：消化排队的手动请求 + 到点自动存档。
   * 手动请求优先（用户在等），到点自动存档次之，两者不重复执行。
   */
  onTickBoundary(tick: number): void {
    if (this._pendingReason) {
      this.saveNow(this._pendingReason);
      return;
    }
    if (this._autosaveTicks > 0 && tick % this._autosaveTicks === 0) {
      this.saveNow("自动");
    }
  }

  /**
   * 命名快照：把当前世界另存到 `data/snapshots/`，不动主存档。
   * 用途 = "跑 r3 之前留一手"，或在剧情关键点存一个可回溯的点。
   */
  snapshot(name?: string): SnapshotInfo | undefined {
    const tick = this._sim.world.tick;
    const safe = name ? sanitizeSnapshotName(name) : "";
    const base = `${safe || "snapshot"}-t${tick}`;
    try {
      mkdirSync(this._snapshotDir, { recursive: true });
      const file = join(this._snapshotDir, `${base}.db`);
      saveGame(this._sim, file, this._scenarioId);
      const st = statSync(file);
      return { name: base, file, sizeBytes: st.size, savedAt: st.mtimeMs };
    } catch (e) {
      console.error("💾 快照失败:", e);
      return undefined;
    }
  }

  /**
   * **另存为一个命名存档并切换过去**（像游戏的"另存为"）。
   * 不动世界、不重载任何东西——只是把"以后自动存档往哪写"改到新档上。
   * 旧档原样留在原地，随时可以 `pnpm dev --load <旧名字>` 回去。
   *
   * 返回新档信息；名字非法或写盘失败返回 undefined。
   */
  saveAs(name: string): { name: string; file: string } | undefined {
    const safe = sanitizeSaveName(name);
    if (!safe) return undefined;
    try {
      mkdirSync(this._savesDir, { recursive: true });
      const file = join(this._savesDir, `${safe}.db`);
      saveGame(this._sim, file, this._scenarioId);
      // 切换：从这一刻起，自动存档/信号存档都写新档
      this._path = file;
      this._status.lastSaveTick = this._sim.world.tick;
      this._status.lastSaveAt = Date.now();
      this._status.lastReason = `另存为「${safe}」`;
      this._status.saveCount++;
      console.log(`💾 已另存为「${safe}」并切换：${file}`);
      return { name: safe, file };
    } catch (e) {
      this._status.failCount++;
      this._status.lastError = (e as Error)?.message?.slice(0, 200) ?? "unknown";
      console.error("💾 另存为失败:", e);
      return undefined;
    }
  }

  /** 当前档的显示名（命名档给名字，主档给文件名） */
  get displayName(): string {
    return basename(this._path, ".db");
  }

  /**
   * 档案清单：主档 + 命名存档 + 快照 + sim 长跑归档，各带剧本与 tick。
   * `openWith` 直接给出打开它的命令——面板不做热加载，把命令交给人比替他切世界安全。
   */
  listSlots(): SlotInfo[] {
    const seen = new Set<string>();
    const out: SlotInfo[] = [];
    const add = (file: string, kind: SlotInfo["kind"]) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      try {
        const st = statSync(file);
        const peeked = peekSave(file);
        out.push({
          kind,
          name: basename(file, ".db"),
          file,
          sizeBytes: st.size,
          savedAt: st.mtimeMs,
          tick: peeked?.tick,
          day: peeked ? Math.floor(peeked.tick / 96) : undefined,
          scenarioId: peeked?.scenarioId,
          openWith: kind === "named"
            ? `pnpm dev --load ${basename(file, ".db")}`   // 命名档按名字打开，好记
            : `pnpm dev --load ${file}`,
        });
      } catch { /* 单个档读不动不该让整张清单挂掉 */ }
    };

    add(this._path, this._path.includes(`/${SAVES_DIR_NAME}/`) ? "named" : "main");
    for (const dir of [this._savesDir, this._snapshotDir, this._runsDir]) {
      const kind = dir === this._savesDir ? "named" : dir === this._snapshotDir ? "snapshot" : "run";
      try {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".db")) add(join(dir, f), kind);
        }
      } catch { /* 目录读不动就跳过这一类 */ }
    }
    // 同目录下别的存档（save-*.db：剧本归属档 / --new 新开档）
    try {
      const dataDir = dirname(this._path);
      for (const f of readdirSync(dataDir)) {
        if (f.endsWith(".db") && f.startsWith("save")) add(join(dataDir, f), "main");
      }
    } catch { /* 同上 */ }

    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  listSnapshots(): SnapshotInfo[] {
    try {
      if (!existsSync(this._snapshotDir)) return [];
      return readdirSync(this._snapshotDir)
        .filter((f) => f.endsWith(".db"))
        .map((f) => {
          const file = join(this._snapshotDir, f);
          const st = statSync(file);
          return { name: f.replace(/\.db$/, ""), file, sizeBytes: st.size, savedAt: st.mtimeMs };
        })
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  status(): SaveStatus {
    let sizeBytes = 0;
    try {
      if (existsSync(this._path)) sizeBytes = statSync(this._path).size;
    } catch { /* 读不到大小不影响别的字段 */ }
    return {
      path: this._path,
      ...this._status,
      sizeBytes,
      pending: this._pendingReason !== undefined,
      autosaveTicks: this._autosaveTicks,
    };
  }

  /** 覆盖前留一份 .bak：存档写坏时还有退路（只留最近一份，再多没意义） */
  private _rotateBackup(): void {
    try {
      if (existsSync(this._path)) copyFileSync(this._path, `${this._path}.bak`);
    } catch { /* 备份失败不阻止正档写入——有档总比没档强 */ }
  }

  /**
   * 注册退出兜底：**信号全覆盖**是这个模块存在的首要理由。
   * - SIGINT：Ctrl+C（原本就有）
   * - SIGTERM：`kill`、screen/nohup 脱管进程被杀、容器停止 —— 长跑最常见的死法
   * - SIGHUP：终端关闭
   * - uncaughtException / unhandledRejection：崩溃前抢救一次
   *
   * `_exiting` 防抖：连着来两个信号只存一次、只退出一次。
   */
  installExitHandlers(onBeforeExit?: () => void): void {
    let exiting = false;
    const bail = (reason: string, code: number, err?: unknown) => {
      if (exiting) return;
      exiting = true;
      if (err) console.error(`\n💥 ${reason}:`, err);
      console.log(`\n💾 正在保存（${reason}）…`);
      const ok = this.saveNow(reason);
      console.log(ok ? `💾 已保存到 ${this._path}（tick ${this._sim.world.tick}）` : "💾 保存失败——上一份 .bak 仍在");
      try { onBeforeExit?.(); } catch { /* 收尾失败不挡退出 */ }
      process.exit(code);
    };

    process.on("SIGINT", () => bail("SIGINT", 0));
    process.on("SIGTERM", () => bail("SIGTERM", 0));
    process.on("SIGHUP", () => bail("SIGHUP", 0));
    process.on("SIGQUIT", () => bail("SIGQUIT", 0));
    process.on("uncaughtException", (err) => bail("未捕获异常", 1, err));
    process.on("unhandledRejection", (err) => bail("未处理的 Promise 拒绝", 1, err));
  }
}
