/**
 * API Server — WebSocket + HTTP 服务
 *
 * WebSocket: 实时推送世界事件
 * HTTP: 提供世界状态查询 + 前端静态文件
 */

import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { Simulation, TickSummary } from "../agent/simulation.js";
import type { TickEngine } from "../core/tick-engine.js";
import type { GameTime } from "../core/tick-engine.js";
import { formatGameTime, tickToGameTime } from "../core/tick-engine.js";
import type { CharacterCard } from "../character/types.js";

export interface ServerConfig {
  port: number;
  simulation: Simulation;
  engine?: TickEngine;
  staticDir?: string;
  /** 角色卡映射（id → CharacterCard），用于前端展示角色身份信息 */
  characterCards?: Map<string, CharacterCard>;
}

export function createApiServer(config: ServerConfig): { app: ReturnType<typeof express>; server: ReturnType<typeof createServer>; start: () => void; broadcast: (data: object) => void } {
  const { simulation } = config;
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  const clients = new Set<WebSocket>();

  // --- WebSocket ---
  wss.on("connection", (ws) => {
    clients.add(ws);
    // 发送当前世界状态快照
    ws.send(JSON.stringify({ type: "snapshot", data: getWorldSnapshot(simulation) }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleClientMessage(msg, ws);
      } catch {}
    });
    ws.on("close", () => clients.delete(ws));
  });

  function handleClientMessage(msg: { type: string; data?: any }, ws: WebSocket) {
    switch (msg.type) {
      case "set_speed": {
        const speed = msg.data?.speed;
        if (config.engine && typeof speed === "number") {
          config.engine.setSpeed(speed as any);
          broadcast({ type: "speed_changed", data: { speed } });
        }
        break;
      }
      case "get_character": {
        const id = msg.data?.id;
        if (id) {
          const character = simulation.world.getCharacter(id);
          const memories = simulation.memory.getRecent(id, 20);
          const relationships = simulation.relationships.getRelationshipsOf(id);
          const impressions = simulation.impressions.getAllFor(id);
          ws.send(JSON.stringify({ type: "character_detail", data: { ...character, memories, relationships, impressions } }));
        }
        break;
      }
    }
  }

  function broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // 监听 tick 事件
  simulation.onTick((summary) => {
    broadcast({
      type: "tick",
      data: {
        tick: summary.tick,
        gameTime: summary.gameTime,
        formattedTime: formatGameTime(summary.gameTime),
        characters: getCharactersState(simulation),
        events: summary.results.map((r) => ({
            characterId: r.characterId,
            action: r.action?.name ?? null,
            args: r.action?.args ?? null,
            description: r.result?.description ?? null,
            thought: r.thought || null,
            skipped: r.skipped ?? false,
            skipReason: r.skipReason ?? null,
            success: r.result?.success ?? true,
          })),
        randomEvents: (summary.randomEvents ?? []).map((re) => ({
          name: re.event.name,
          description: re.event.template.replace("{character}", re.affectedCharacters[0] ?? ""),
          affected: re.affectedCharacters,
        })),
        gossips: (summary.gossips ?? []).map((g) => ({
          from: g.spreadBy,
          to: g.spreadTo,
          about: g.originalEvent.description,
        })),
        reflections: (summary.reflections ?? []).map((r) => ({
          characterId: r.characterId,
          insights: r.insights,
          mood: r.mood,
        })),
        weather: simulation.world.weather,
        relationships: simulation.relationships.getAll().map((r) => ({
          a: r.characterA, b: r.characterB, level: r.level, type: r.type,
        })),
        // 角色名映射（ID→名字）
        nameMap: Object.fromEntries(
          simulation.world.getAllCharacters().map((c) => [c.id, c.name]),
        ),
      },
    });
  });



  // --- HTTP API ---
  app.use(express.json());

  app.get("/api/state", (_req, res) => {
    res.json(getWorldSnapshot(simulation));
  });

  app.get("/api/characters", (_req, res) => {
    res.json(getCharactersState(simulation));
  });

  app.get("/api/characters/:id", (req, res) => {
    const character = simulation.world.getCharacter(req.params.id);
    if (!character) return res.status(404).json({ error: "not found" });

    const memories = simulation.memory.getRecent(req.params.id, 20);
    const relationships = simulation.relationships.getRelationshipsOf(req.params.id);

    res.json({ ...character, memories, relationships });
  });

  app.get("/api/events", (_req, res) => {
    res.json(simulation.eventBus.history.slice(-50));
  });

  app.get("/api/relationships", (_req, res) => {
    res.json(simulation.relationships.getAll());
  });

  app.get("/api/impressions", (_req, res) => {
    // 返回所有角色的所有印象
    const all: Record<string, any[]> = {};
    for (const c of simulation.world.getAllCharacters()) {
      const imps = simulation.impressions.getAllFor(c.id);
      if (imps.length > 0) all[c.id] = imps;
    }
    res.json(all);
  });

  app.get("/api/impressions/:id", (req, res) => {
    const imps = simulation.impressions.getAllFor(req.params.id);
    res.json(imps);
  });

  app.get("/api/cards", (_req, res) => {
    if (!config.characterCards) return res.json({});
    const cards: Record<string, any> = {};
    for (const [id, card] of config.characterCards) {
      cards[id] = {
        id: card.id, name: card.name, age: card.age,
        occupation: card.occupation, appearance: card.appearance,
        personality: {
          traits: card.personality.traits,
          coreTraits: card.personality.coreTraits,
          psychology: card.personality.psychology,
          speech: card.personality.speech,
          interests: card.personality.interests,
          dislikes: card.personality.dislikes,
        },
        backstory: card.backstory,
        background: card.background,
      };
    }
    res.json(cards);
  });

  app.get("/api/conversations", (_req, res) => {
    // 返回当前所有活跃对话历史
    const chars = simulation.world.getAllCharacters();
    const convs: Record<string, any[]> = {};
    for (let i = 0; i < chars.length; i++) {
      for (let j = i + 1; j < chars.length; j++) {
        const history = simulation.conversations.getHistory(chars[i]!.id, chars[j]!.id);
        if (history.length > 0) {
          convs[`${chars[i]!.id}:${chars[j]!.id}`] = history;
        }
      }
    }
    res.json(convs);
  });

  // 静态文件
  if (config.staticDir) {
    app.use(express.static(config.staticDir));
    app.get("/{*path}", (_req, res) => {
      res.sendFile(resolve(config.staticDir!, "index.html"));
    });
  }

  return {
    app,
    server,
    start: () => {
      server.listen(config.port, () => {
        console.log(`🌍 Anima server running at http://localhost:${config.port}`);
      });
    },
    broadcast,
  };
}

function getWorldSnapshot(sim: Simulation) {
  const gt = tickToGameTime(sim.world.tick);
  return {
    tick: sim.world.tick,
    gameTime: gt,
    formattedTime: formatGameTime(gt),
    weather: sim.world.weather,
    characters: getCharactersState(sim),
    locations: sim.world.getAllLocations().map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      presentCharacters: l.presentCharacters,
    })),
  };
}

function getCharactersState(sim: Simulation) {
  return sim.world.getAllCharacters().map((c) => ({
    id: c.id,
    name: c.name,
    locationId: c.locationId,
    needs: c.needs,
    gold: c.gold,
    currentAction: c.currentAction,
    inboxCount: c.inbox.length,
  }));
}
