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
      case "player_action": {
        // 玩家执行任意动作（走和 AI 同一管道）
        const { action, args } = msg.data ?? {};
        if (action && args) {
          handlePlayerAction(action, args, ws);
        }
        break;
      }
      case "player_talk": {
        // 兼容旧 API：转化为 player_action
        const { targetId, message } = msg.data ?? {};
        if (targetId && message) {
          handlePlayerAction("talk", { target: targetId, message }, ws);
        }
        break;
      }
      case "get_player_actions": {
        ws.send(JSON.stringify({ type: "player_actions", data: simulation.getPlayerActions() }));
        break;
      }
    }
  }

  async function handlePlayerAction(actionName: string, args: Record<string, unknown>, ws: WebSocket) {
    if (!simulation.playerId) {
      ws.send(JSON.stringify({ type: "player_action_error", data: { error: "玩家未加入世界" } }));
      return;
    }

    const playerState = simulation.world.getCharacter(simulation.playerId);
    if (!playerState) {
      ws.send(JSON.stringify({ type: "player_action_error", data: { error: "玩家状态不存在" } }));
      return;
    }

    // 检查玩家是否在执行多 tick 行为
    if (playerState.currentAction && playerState.currentAction.remainingTicks > 0) {
      ws.send(JSON.stringify({
        type: "player_action_error",
        data: { error: `正在${playerState.currentAction.name}中，还需要 ${playerState.currentAction.remainingTicks} 个 tick` },
      }));
      return;
    }

    const result = await simulation.executePlayerAction(actionName, args);
    if (!result) {
      ws.send(JSON.stringify({ type: "player_action_error", data: { error: `未知行为: ${actionName}` } }));
      return;
    }

    ws.send(JSON.stringify({ type: "player_action_result", data: result }));
    broadcast({
      type: "player_action",
      data: {
        action: result.action,
        result: result.result,
        playerState: {
          locationId: playerState.locationId,
          needs: playerState.needs,
          gold: playerState.gold,
          currentAction: playerState.currentAction,
        },
      },
    });
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

  // 玩家 API
  app.get("/api/player", (_req, res) => {
    if (!simulation.playerId) return res.status(404).json({ error: "玩家未加入世界" });
    const state = simulation.world.getCharacter(simulation.playerId);
    if (!state) return res.status(404).json({ error: "玩家状态不存在" });
    const memories = simulation.memory.getRecent(simulation.playerId, 20);
    const relationships = simulation.relationships.getRelationshipsOf(simulation.playerId);
    res.json({ ...state, memories, relationships });
  });

  app.get("/api/player/actions", (_req, res) => {
    res.json(simulation.getPlayerActions());
  });

  app.post("/api/player/action", async (req, res) => {
    const { action, args } = req.body ?? {};
    if (!action || !args) return res.status(400).json({ error: "需要 action 和 args" });
    const result = await simulation.executePlayerAction(action, args);
    if (!result) return res.status(400).json({ error: `未知行为: ${action}` });
    res.json(result);
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
