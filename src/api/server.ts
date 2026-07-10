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
import * as itemRegistry from "../world/item-registry.js";
import { computeTemperature } from "../world/climate.js";
import { financeLabel } from "../world/economy.js";
import type { CharacterCard } from "../character/types.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerNarrativeRoutes } from "./narrative-routes.js";
import { SettingsStore } from "./settings-store.js";
import type { OpenAICompatibleProvider } from "../providers/openai-compatible.js";

export interface ServerConfig {
  port: number;
  simulation: Simulation;
  engine?: TickEngine;
  staticDir?: string;
  /** 角色卡映射（id → CharacterCard），用于前端展示角色身份信息 */
  characterCards?: Map<string, CharacterCard>;
  /** 管理面板用：角色/地点 YAML 目录与设置文件路径 */
  admin?: {
    charactersDir: string;
    locationsDir: string;
    settingsFile: string;
    provider?: OpenAICompatibleProvider;
  };
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
          const finance = character ? financeLabel(character.gold, character.life?.income) : undefined;
          ws.send(JSON.stringify({ type: "character_detail", data: { ...character, finance, memories, relationships, impressions } }));
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

  // 监听 beat 事件 (N5)：把规则导演触发的 beat 实时推送到前端
  simulation.eventBus.on((event) => {
    if (event.type === "beat.ready") {
      broadcast({
        type: "beat_ready",
        data: {
          tick: event.tick,
          beatId: event.id.replace(/^beat_/, "").replace(/_\d+$/, ""),
          description: event.description,
        },
      });
    }
  });

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
            observableState: r.result?.observableState ?? null,
            thought: r.thought || null,
            motive: r.motive ?? null,
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
          wish: r.wish,
          concern: r.concern,
        })),
        weather: simulation.world.weather,
        temperature: computeTemperature(summary.gameTime.season, simulation.world.weather, summary.gameTime.hour),
        relationships: simulation.relationships.getAll().map((r) => ({
          a: r.characterA, b: r.characterB, level: r.level, type: r.type, bond: r.bond,
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
        id: card.id, name: card.name,
        age: card.life?.age ?? card.age,
        occupation: card.life?.occupation ?? card.occupation,
        appearance: card.appearance,
        life: card.life,
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

  // ── 叙事系统 (N4 + N5) ──
  registerNarrativeRoutes(app, simulation);

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

  // 管理 CRUD + 设置
  if (config.admin) {
    registerAdminRoutes({
      app,
      simulation,
      charactersDir: config.admin.charactersDir,
      locationsDir: config.admin.locationsDir,
      settingsStore: new SettingsStore(config.admin.settingsFile),
      provider: config.admin.provider,
    });
  }

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
  const ns = sim.world.narrative.getWorld();
  return {
    tick: sim.world.tick,
    gameTime: gt,
    formattedTime: formatGameTime(gt),
    weather: sim.world.weather,
    temperature: computeTemperature(gt.season, sim.world.weather, gt.hour),
    characters: getCharactersState(sim),
    locations: sim.world.getAllLocations().map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      presentCharacters: l.presentCharacters,
    })),
    narrative: {
      tensionIndex: ns.tensionIndex,
      activePhase: ns.activePhase,
      unresolvedEventsCount: ns.unresolvedEvents.length,
      triggeredBeatsCount: ns.triggeredBeats.length,
      rumorsCount: ns.rumors.length,
      directorEnabled: Boolean(sim.director?.isEnabled()),
    },
  };
}

function getCharactersState(sim: Simulation) {
  return sim.world.getAllCharacters().map((c) => ({
    id: c.id,
    name: c.name,
    locationId: c.locationId,
    needs: c.needs,
    gold: c.gold,
    finance: financeLabel(c.gold, c.life?.income),
    currentAction: c.currentAction,
    observableState: c.observableState ? {
      actionName: c.observableState.actionName,
      summary: c.observableState.summary,
      targetId: c.observableState.targetId,
    } : undefined,
    inboxCount: c.inbox.length,
    life: c.life ? {
      occupation: c.life.occupation,
      workplace: c.life.workplace,
      age: c.life.age,
      income: c.life.income,
      skills: c.life.skills,
      aspiration: c.life.aspiration,
      currentGoal: c.life.currentGoal,
      currentConcern: c.life.currentConcern,
    } : undefined,
    moodlets: c.moodlets.length > 0 ? c.moodlets.map((m) => ({
      emotion: m.emotion,
      intensity: m.intensity,
      reason: m.reason,
    })) : undefined,
    inventory: c.inventory && c.inventory.length > 0 ? c.inventory.map((i) => {
      const def = itemRegistry.getItemDef(i.defId);
      return {
        defId: i.defId,
        name: def?.name ?? i.defId,
        type: def?.type,
        quantity: i.quantity,
        giftedBy: i.giftedBy,
        memoryTag: i.memoryTag,
        customDesc: i.customDesc,
      };
    }) : undefined,
  }));
}
