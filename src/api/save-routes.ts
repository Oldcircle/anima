/**
 * Save Routes — 存档端点
 *
 * 手动存档**不立即执行**：tick 内部有 await（LLM 调用），中途存会存出
 * "一半角色已决策、一半没有"的世界。所以请求只登记意图，由 tick 末尾执行；
 * 引擎停着（暂停/未启动）时才立即存。返回体的 `applied` 说明走了哪条路。
 *
 * 只注册在 CLI 起的服务上（headless 测试不带 SaveManager 时整组路由不挂）。
 */

import type { Express, Request, Response } from "express";
import type { SaveManager } from "../persistence/save-manager.js";
import type { TickEngine } from "../core/tick-engine.js";

export function registerSaveRoutes(app: Express, saves: SaveManager, engine?: TickEngine): void {
  app.get("/api/save", (_req: Request, res: Response) => {
    res.json({ ...saves.status(), snapshots: saves.listSnapshots() });
  });

  /** 立即/排队存主档 */
  app.post("/api/save", (req: Request, res: Response) => {
    const reason = typeof req.body?.reason === "string" && req.body.reason ? req.body.reason.slice(0, 40) : "手动";
    // 引擎在跑 → 排到 tick 边界；停着 → 立即存
    const applied = saves.request(reason, { engineRunning: engine?.running ?? false });
    res.json({
      ok: true,
      applied,
      message: applied ? "已保存" : "已排队，将在当前 tick 结束时保存",
      status: saves.status(),
    });
  });

  /**
   * 命名快照（另存不覆盖主档）：跑长程实验前留一手。
   * 快照只写不删——删存档是不可逆的，留给用户自己在文件系统里做。
   */
  app.post("/api/save/snapshot", (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const info = saves.snapshot(name);
    if (!info) return res.status(500).json({ error: "快照失败（详见服务端日志）" });
    res.json({ ok: true, snapshot: info, snapshots: saves.listSnapshots() });
  });
}
