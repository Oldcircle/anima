/**
 * Prompt Routes — 提示词追踪的只读端点（观察者通道）
 *
 * 数据源是进程内环形缓冲 `promptTrace`（见 providers/prompt-trace.ts），
 * 与模拟核心零耦合：这里只读、只清空，不参与任何角色决策。
 *
 * 列表刻意不带长文本（一次 tick 七个角色的 prompt 加起来几十 KB，
 * 列表要能 5 秒轮询一次），完整请求体走详情端点按需取。
 */

import type { Express, Request, Response } from "express";
import { promptTrace } from "../providers/prompt-trace.js";

export function registerPromptRoutes(app: Express): void {
  /** 列表：kind/角色过滤 + 条数上限，最新在前 */
  app.get("/api/prompts", (req: Request, res: Response) => {
    const kind = typeof req.query.kind === "string" && req.query.kind ? req.query.kind : undefined;
    const tag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag : undefined;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
    res.json({
      enabled: promptTrace.enabled,
      size: promptTrace.size,
      items: promptTrace.list({ kind, tag, limit }),
    });
  });

  /** 统计：按 kind 分桶（命中率/耗时/前缀断点次数）+ 可选筛选项 */
  app.get("/api/prompts/stats", (_req: Request, res: Response) => {
    res.json({ enabled: promptTrace.enabled, size: promptTrace.size, ...promptTrace.stats() });
  });

  /** 详情：完整 system / 工具表 / messages / 响应 / 前缀断点 */
  app.get("/api/prompts/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const rec = promptTrace.get(id);
    if (!rec) return res.status(404).json({ error: "unknown prompt id（可能已被环形缓冲淘汰）" });
    res.json(rec);
  });

  /** 清空：长跑中想从某个时点重新观察时用 */
  app.delete("/api/prompts", (_req: Request, res: Response) => {
    promptTrace.clear();
    res.json({ ok: true });
  });
}
