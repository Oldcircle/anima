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

/**
 * GET /api/grounding —— 世界接地面板的观察者通道（PLAN-grounding 前端消费）。
 * 器物/正典/痕迹 + 断言账本 + 案件账本 + 线索执念一次给全；
 * perpId 在这条路由上是**故意给的**（观看者可见、角色互不可见，对齐 🎭 motive），
 * 前端默认折叠——引擎侧"真凶不进 prompt"的红线与本路由无关。
 */
describe("narrative routes — GET /api/grounding", () => {
  it("空世界：结构齐全、各段为空", async () => {
    const { app } = makeFixture();
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/api/grounding`)).json();
      expect(body.objects).toEqual([]);
      expect(body.claims).toEqual([]);
      expect(body.cases).toEqual([]);
      expect(body.leads).toEqual([]);
      expect(typeof body.tick).toBe("number");
    });
  });

  it("有器物/痕迹/正典/案件/线索时逐段给出（含 perpId 剧透字段）", async () => {
    const { app, world } = makeFixture();
    world.objects.registerLocation({
      id: "park",
      objects: [{ id: "bench", name: "长椅", keywords: ["长椅"], canon: ["第三根木条松了"] }],
    });
    world.objects.addTrace("park.bench", {
      id: "t1", text: "椅面上多了一道新划痕", addedTick: 10, source: "event",
    });
    world.narrative.registerCase({
      id: "theft_10_alice", kind: "theft", perpId: "npc_x", victimId: "alice", amount: 30, createdTick: 10,
    });
    world.narrative.registerObsession("alice", {
      id: "obs_theft_10_alice_witness", summary: "那个人在门口转悠的样子你没忘",
      createdDay: 0, decayDays: 5, source: "crime", relatedId: "theft_10_alice",
    });

    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/api/grounding`)).json();
      const bench = body.objects.find((o: { key: string }) => o.key === "park.bench");
      expect(bench.locationName).toBe("Park");
      expect(bench.canonFacts[0].text).toBe("第三根木条松了");
      expect(bench.traces[0].text).toContain("新划痕");

      expect(body.cases).toHaveLength(1);
      expect(body.cases[0].status).toBe("open");
      expect(body.cases[0].publicSinceTick).toBeUndefined(); // 还没公开，面板照实说
      expect(body.cases[0].perpId).toBe("npc_x");            // 观看者通道：剧透字段确实给

      expect(body.leads).toHaveLength(1);
      expect(body.leads[0].characterId).toBe("alice");
      expect(body.leads[0].relatedId).toBe("theft_10_alice");
    });
  });
});
