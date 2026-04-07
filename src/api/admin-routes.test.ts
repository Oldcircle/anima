/**
 * Admin Routes — CRUD 烟雾测试
 *
 * 不依赖真实 LLM。只验证：写盘 + 热重载入队 + 列表/详情读出。
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { World } from "../world/world.js";
import { EventBus } from "../core/event-bus.js";
import { Simulation } from "../agent/simulation.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { SettingsStore } from "./settings-store.js";

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "anima-admin-"));
  const charactersDir = join(tmp, "characters");
  const locationsDir = join(tmp, "locations");
  mkdirSync(charactersDir);
  mkdirSync(locationsDir);

  // 一个现成地点供初始世界用
  writeFileSync(join(locationsDir, "plaza.yml"), "id: plaza\nname: 广场\ntype: public\n");

  const world = new World([
    { id: "plaza", name: "广场", type: "public", presentCharacters: [] },
  ], 0);
  const provider = new OpenAICompatibleProvider({ id: "test", baseUrl: "http://localhost", apiKey: "" });
  const sim = new Simulation(world, new EventBus(), {
    characters: [],
    actions: ALL_BASIC_ACTIONS,
    provider,
    modelId: "x",
  });

  const app = express();
  app.use(express.json());
  registerAdminRoutes({
    app,
    simulation: sim,
    charactersDir,
    locationsDir,
    settingsStore: new SettingsStore(join(tmp, "settings.json")),
    provider,
  });

  return { tmp, charactersDir, locationsDir, app, sim, provider };
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try { return await fn(base); }
  finally { server.close(); }
}

describe("admin routes — characters CRUD", () => {
  it("create → list → detail → soft delete round trip", async () => {
    const { app, charactersDir, sim } = makeFixture();
    await withServer(app, async (base) => {
      // 创建
      const card = {
        id: "newchar",
        name: "新角色",
        home: "plaza",
        personality: { traits: ["friendly"] },
      };
      let r = await fetch(`${base}/api/admin/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(card),
      });
      expect(r.status).toBe(201);

      // 文件落盘
      expect(existsSync(join(charactersDir, "newchar.yml"))).toBe(true);

      // 列表
      r = await fetch(`${base}/api/admin/characters`);
      const list = await r.json();
      expect(list.find((c: any) => c.id === "newchar")).toBeTruthy();

      // 详情
      r = await fetch(`${base}/api/admin/characters/newchar`);
      const detail = await r.json();
      expect(detail.name).toBe("新角色");

      // 热重载入队 → drain 后 simulation 看到角色
      sim.drainMutations();
      expect(sim.getCharacterIds()).toContain("newchar");

      // 软删除
      r = await fetch(`${base}/api/admin/characters/newchar`, { method: "DELETE" });
      expect(r.status).toBe(200);
      expect(readFileSync(join(charactersDir, "newchar.yml"), "utf-8")).toContain("disabled: true");

      sim.drainMutations();
      expect(sim.getCharacterIds()).not.toContain("newchar");
    });
  });

  it("rejects bad payload", async () => {
    const { app } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/admin/characters`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "BAD ID", name: "x", home: "plaza", personality: { traits: [] } }),
      });
      expect(r.status).toBe(400);
    });
  });
});

describe("admin routes — locations CRUD", () => {
  it("create / update / delete", async () => {
    const { app, locationsDir, sim } = makeFixture();
    await withServer(app, async (base) => {
      const loc = { id: "park", name: "公园", type: "public", summary: "新建" };
      let r = await fetch(`${base}/api/admin/locations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(loc),
      });
      expect(r.status).toBe(201);
      expect(existsSync(join(locationsDir, "park.yml"))).toBe(true);

      sim.drainMutations();
      expect(sim.world.getLocation("park")).toBeTruthy();

      // 更新
      r = await fetch(`${base}/api/admin/locations/park`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...loc, summary: "改了" }),
      });
      expect(r.status).toBe(200);

      // 删除
      r = await fetch(`${base}/api/admin/locations/park`, { method: "DELETE" });
      expect(r.status).toBe(200);
      sim.drainMutations();
      expect(sim.world.getLocation("park")).toBeUndefined();
    });
  });
});

describe("admin routes — LLM settings", () => {
  it("PUT settings updates provider config", async () => {
    const { app, sim, provider } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/admin/settings/llm`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test1234",
          model: "deepseek-chat",
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.apiKey).toMatch(/1234$/); // 末 4 位
      expect(body.apiKey).not.toContain("sk-test"); // 脱敏

      sim.drainMutations();
      const cfg = provider.getConfig();
      expect(cfg.apiKey).toBe("sk-test1234");
      expect(cfg.defaultModel).toBe("deepseek-chat");
    });
  });

  it("rejects malformed url", async () => {
    const { app } = makeFixture();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/api/admin/settings/llm`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "x", baseUrl: "not-a-url", apiKey: "", model: "x" }),
      });
      expect(r.status).toBe(400);
    });
  });
});
