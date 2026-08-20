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
    res.json({ ...saves.status(), name: saves.displayName, snapshots: saves.listSnapshots() });
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
   * 另存为一个**命名存档**并切换过去（像游戏的"另存为"）。
   * 不动世界、不重载——只把"以后往哪写"改到新档；旧档原样留着随时可回。
   */
  app.post("/api/save/as", (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    if (!name.trim()) return res.status(400).json({ error: "存档名必填" });
    const info = saves.saveAs(name);
    if (!info) return res.status(400).json({ error: "存档名非法或写盘失败（名字只保留中英文数字和 - _）" });
    res.json({ ok: true, saved: info, status: saves.status(), slots: saves.listSlots() });
  });

  /**
   * 档案列表：主档 / 快照 / sim 长跑归档，各带剧本与 tick（探针只读元信息不装世界）。
   * 面板**不做运行中热加载**——切世界要重建 Simulation 里一堆内存态（对话追踪/导演/脉冲），
   * 半路换掉风险远大于收益。这里只告诉你有哪些档、以及打开它的那条命令。
   */
  app.get("/api/save/slots", (_req: Request, res: Response) => {
    res.json({ current: saves.status().path, slots: saves.listSlots() });
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
