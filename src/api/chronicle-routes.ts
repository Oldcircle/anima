/**
 * Chronicle Routes — 世界编年史端点（观察者通道）
 *
 * 面板的默认姿势是"我不想盯着看"：所以默认只给 ≥7 分的条目、按天分组、
 * 每天带一条头条。想看全部再把阈值拉下来。
 */

import type { Express, Request, Response } from "express";
import type { Simulation } from "../agent/simulation.js";
import { DEFAULT_MIN_IMPORTANCE, type ChronicleKind } from "../world/chronicle.js";

export function registerChronicleRoutes(app: Express, simulation: Simulation): void {
  app.get("/api/chronicle", (req: Request, res: Response) => {
    const chronicle = simulation.world.chronicle;
    const q = req.query;
    const rawMin = Number(q.minImportance);
    const minImportance = Number.isFinite(rawMin) ? Math.max(1, Math.min(10, rawMin)) : DEFAULT_MIN_IMPORTANCE;
    const kind = typeof q.kind === "string" && q.kind ? (q.kind as ChronicleKind) : undefined;
    const actor = typeof q.actor === "string" && q.actor ? q.actor : undefined;
    const emergenceOnly = q.emergenceOnly === "1" || q.emergenceOnly === "true";
    const rawLimit = Number(q.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 200;

    const entries = chronicle.list({ minImportance, kind, actor, emergenceOnly, limit });
    // 名册给前端把 actor id 显示成名字（含静态 NPC——编年史里他也是角儿）
    const names = Object.fromEntries(simulation.world.getAllCharacters().map((c) => [c.id, c.name]));

    res.json({
      tick: simulation.world.tick,
      day: Math.floor(simulation.world.tick / 96),
      size: chronicle.size,
      minImportance,
      entries,
      digests: chronicle.digests({ minImportance }),
      names,
      /** 面板筛选项：只列真出现过的（空世界不摆一排点不动的按钮） */
      kinds: [...new Set(chronicle.list({ limit: 500 }).map((e) => e.kind))].sort(),
    });
  });
}
