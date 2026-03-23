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

export interface ServerConfig {
  port: number;
  simulation: Simulation;
  engine?: TickEngine;
  staticDir?: string;
}

export function createApiServer(config: ServerConfig) {
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
          ws.send(JSON.stringify({ type: "character_detail", data: { ...character, memories, relationships } }));
        }
        break;
      }
      case "player_talk": {
        // 玩家对某个角色说话
        const { targetId, message } = msg.data ?? {};
        if (targetId && message) {
          handlePlayerTalk(targetId, message, ws);
        }
        break;
      }
    }
  }

  async function handlePlayerTalk(targetId: string, playerMessage: string, ws: WebSocket) {
    const { runConversation } = await import("../agent/conversation.js");

    // 创建临时玩家角色卡
    const playerCard = {
      id: "player",
      name: "玩家",
      age: 25,
      occupation: "旅行者",
      home: "plaza",
      personality: { traits: ["友好"], interests: [], dislikes: [], speechStyle: "" },
      background: "一个刚来到小镇的旅行者。",
      dailyRoutine: {},
      relationships: {},
    };

    const targetConfig = Array.from((simulation as any)._configs.values())
      .find((c: any) => c.card.id === targetId) as any;
    if (!targetConfig) {
      ws.send(JSON.stringify({ type: "player_talk_error", data: { error: "角色不存在" } }));
      return;
    }

    const gt = tickToGameTime(simulation.world.tick);
    const conv = await runConversation({
      initiator: playerCard,
      target: targetConfig.card,
      intent: "聊天",
      openingLine: playerMessage,
      provider: (simulation as any)._provider,
      modelId: (simulation as any)._conversationModelId,
      world: simulation.world,
      gameTime: gt,
      maxTurns: 4,
    });

    // 存入目标角色的记忆
    simulation.memory.add(targetId, {
      tick: gt.tick,
      type: "conversation",
      content: `一个叫"玩家"的旅行者找我聊天：${playerMessage}`,
      importance: 7,
    });

    ws.send(JSON.stringify({ type: "player_talk_result", data: conv }));
    broadcast({ type: "conversation", data: conv });
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
        events: summary.results
          .filter((r) => !r.skipped && r.result)
          .map((r) => ({
            characterId: r.characterId,
            action: r.action?.name,
            description: r.result?.description,
            thought: r.thought.slice(0, 80),
          })),
        conversations: summary.conversations.map((c) => ({
          participants: [c.initiatorId, c.targetId],
          messages: c.messages,
          summary: c.summary,
          relationshipDelta: c.relationshipDelta,
        })),
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
    currentAction: c.currentAction,
    inConversation: c.inConversation,
  }));
}
