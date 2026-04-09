/**
 * Narrative Routes — 叙事系统 HTTP 端点 (N4/N5)
 *
 * 抽出来便于独立测试。CLI 启动的 server.ts 会调 registerNarrativeRoutes 注册。
 */

import type { Express, Request, Response } from "express";
import type { Simulation } from "../agent/simulation.js";

export function registerNarrativeRoutes(app: Express, simulation: Simulation): void {
  // 完整 narrative 状态（debug / 玩家面板用）
  app.get("/api/narrative", (_req: Request, res: Response) => {
    res.json({
      snapshot: simulation.world.narrative.getSnapshot(),
      beats: {
        loaded: simulation.beatEngine.getBeats().length,
        triggered: simulation.beatEngine.getTriggered(),
        all: simulation.beatEngine.getBeats().map((b) => ({
          id: b.id,
          description: b.description,
          fallbackDeadlineDay: b.fallback_deadline_day,
        })),
      },
      director: simulation.director
        ? {
            enabled: simulation.director.isEnabled(),
            recentCalls: simulation.director.getCallLogs().slice(-20),
          }
        : { enabled: false },
    });
  });

  // 玩家干预：注入未解决事件
  app.post("/api/narrative/inject-event", (req: Request, res: Response) => {
    const { id, summary, involved, visibleTo } = req.body ?? {};
    if (typeof id !== "string" || typeof summary !== "string") {
      return res.status(400).json({ error: "id and summary are required strings" });
    }
    simulation.world.narrative.addUnresolvedEvent({
      id,
      summary,
      involved: Array.isArray(involved) ? involved : [],
      visibleTo: visibleTo === "*" || Array.isArray(visibleTo) ? visibleTo : "*",
      createdTick: simulation.world.tick,
    });
    res.json({ ok: true, id });
  });

  // 玩家干预：注入流言
  app.post("/api/narrative/inject-rumor", (req: Request, res: Response) => {
    const { content, sourceCharId, spreadTo } = req.body ?? {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content is required string" });
    }
    simulation.world.narrative.getWorld().rumors.push({
      content,
      sourceCharId: typeof sourceCharId === "string" ? sourceCharId : undefined,
      tick: simulation.world.tick,
      reachedChars: Array.isArray(spreadTo) ? spreadTo : [],
    });
    res.json({ ok: true });
  });

  // 玩家干预：塞纸条
  app.post("/api/narrative/inject-observation", (req: Request, res: Response) => {
    const { observerId, summary } = req.body ?? {};
    if (typeof observerId !== "string" || typeof summary !== "string") {
      return res.status(400).json({ error: "observerId and summary are required strings" });
    }
    if (!simulation.world.getCharacter(observerId)) {
      return res.status(404).json({ error: "unknown character" });
    }
    simulation.world.sendMessage(observerId, {
      fromId: "__player__",
      fromName: "（你心里突然浮现）",
      content: summary,
      tick: simulation.world.tick,
    });
    res.json({ ok: true });
  });

  // 玩家手动触发 director 节奏检查
  app.post("/api/narrative/nudge", async (_req: Request, res: Response) => {
    if (!simulation.director?.isEnabled()) {
      return res.status(400).json({ error: "director not enabled" });
    }
    const log = await simulation.director.handleDailyPacing(simulation.world, simulation.world.tick);
    res.json({ ok: true, log });
  });
}
