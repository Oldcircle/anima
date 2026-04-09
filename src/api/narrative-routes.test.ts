/**
 * Narrative Routes — 端到端 HTTP 测试 (N5)
 *
 * 验证玩家干预入口能正确写入 narrative_state。
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { registerNarrativeRoutes } from "./narrative-routes.js";
import type { Location } from "../world/types.js";
import type { CharacterCard } from "../character/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
];

const aliceCard: CharacterCard = {
  id: "alice",
  name: "Alice",
  age: 20,
  gender: "female",
  occupation: "x",
  home: "park",
  personality: { traits: [], interests: [], dislikes: [], speechStyle: "" },
  background: "",
  relationships: {},
};

function makeFixture() {
  const world = new World(fakeLocations);
  world.addCharacter("alice", "Alice", "park");
  const mockLLM = new MockLLMProvider();
  const sim = new Simulation(world, new EventBus(), {
    characters: [aliceCard],
    actions: ALL_BASIC_ACTIONS,
    provider: mockLLM,
    modelId: "test",
  });
  const app = express();
  app.use(express.json());
  registerNarrativeRoutes(app, sim);
  return { world, sim, mockLLM, app };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

describe("narrative routes — GET /api/narrative", () => {
  it("returns snapshot + beats + director state", async () => {
    const { app, sim } = makeFixture();
    sim.loadBeats([{ id: "b1", preconditions: ["true"] }]);
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.snapshot.world.tensionIndex).toBe(0);
      expect(body.beats.loaded).toBe(1);
      expect(body.beats.all[0].id).toBe("b1");
      expect(body.director.enabled).toBe(false);
    });
  });
});

describe("narrative routes — POST /api/narrative/inject-event", () => {
  it("writes unresolved event into world.narrative", async () => {
    const { app, world } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/inject-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "e1", summary: "something happened", involved: ["alice"], visibleTo: "*" }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(world.narrative.getWorld().unresolvedEvents.length).toBe(1);
      expect(world.narrative.getWorld().unresolvedEvents[0]!.id).toBe("e1");
    });
  });

  it("400 on missing fields", async () => {
    const { app } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/inject-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
    });
  });
});

describe("narrative routes — POST /api/narrative/inject-rumor", () => {
  it("writes rumor", async () => {
    const { app, world } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/inject-rumor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "听说...", spreadTo: ["alice"] }),
      });
      expect(r.status).toBe(200);
      const rumors = world.narrative.getWorld().rumors;
      expect(rumors.length).toBe(1);
      expect(rumors[0]!.reachedChars).toEqual(["alice"]);
    });
  });
});

describe("narrative routes — POST /api/narrative/inject-observation", () => {
  it("delivers via inbox", async () => {
    const { app, world } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/inject-observation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ observerId: "alice", summary: "你想起昨天的事" }),
      });
      expect(r.status).toBe(200);
      const inbox = world.consumeInbox("alice");
      expect(inbox.length).toBe(1);
      expect(inbox[0]!.fromId).toBe("__player__");
    });
  });

  it("404 on unknown character", async () => {
    const { app } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/inject-observation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ observerId: "ghost", summary: "x" }),
      });
      expect(r.status).toBe(404);
    });
  });
});

describe("narrative routes — POST /api/narrative/nudge", () => {
  it("400 when director not enabled", async () => {
    const { app } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/nudge`, { method: "POST" });
      expect(r.status).toBe(400);
    });
  });

  it("ok when director enabled", async () => {
    const { app, sim, mockLLM } = makeFixture();
    sim.enableDirector({ provider: mockLLM, modelId: "test", dailyBudget: 5 });
    mockLLM.setDefaultResponse("ok", [{ name: "do_nothing", arguments: {} }]);
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/narrative/nudge`, { method: "POST" });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.log.toolCalls[0].name).toBe("do_nothing");
    });
  });
});
