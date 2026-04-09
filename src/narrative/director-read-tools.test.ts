/**
 * D1 — director-read-tools 单测
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestWorldWithCharacters } from "../../test/helpers/test-world.js";
import { ShortTermMemory } from "../memory/short-term.js";
import { ImpressionStore } from "../memory/impressions.js";
import {
  readCharacterTool,
  readSceneTool,
  readArcStatusTool,
} from "./director-read-tools.js";
import type { DirectorToolContext } from "./director-tools.js";
import type { World } from "../world/world.js";

function makeCtx(world: World, tick = 100): DirectorToolContext {
  return {
    world,
    tick,
    memory: new ShortTermMemory(),
    impressions: new ImpressionStore(),
  };
}

describe("director-read-tools D1", () => {
  let world: World;
  let ctx: DirectorToolContext;

  beforeEach(() => {
    world = createTestWorldWithCharacters({ tick: 100 });
    ctx = makeCtx(world, 100);
  });

  describe("read_character", () => {
    it("returns ok with name + location for existing character", () => {
      const result = readCharacterTool.handler({ character_id: "tomori" }, ctx);
      expect(result.ok).toBe(true);
      expect(result.description).toContain("高松灯");
      expect(result.description).toContain("灯的家");
      expect(result.description).toContain("(无)"); // 没有 currentIntent
    });

    it("returns error for unknown character", () => {
      const result = readCharacterTool.handler({ character_id: "ghost" }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unknown_character");
    });

    it("returns error when character_id missing", () => {
      const result = readCharacterTool.handler({}, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("missing_arg");
    });

    it("includes recent actions from short-term memory within 8-tick window", () => {
      ctx.memory!.add("tomori", { tick: 95, type: "event", content: "去了广场", importance: 5 });
      ctx.memory!.add("tomori", { tick: 99, type: "event", content: "买了便当", importance: 5 });
      ctx.memory!.add("tomori", { tick: 80, type: "event", content: "太久以前的事", importance: 5 });
      const result = readCharacterTool.handler({ character_id: "tomori" }, ctx);
      expect(result.description).toContain("去了广场");
      expect(result.description).toContain("买了便当");
      expect(result.description).not.toContain("太久以前的事");
    });

    it("includes recent thoughts", () => {
      ctx.memory!.add("tomori", { tick: 98, type: "thought", content: "我有点饿了", importance: 4 });
      const result = readCharacterTool.handler({ character_id: "tomori" }, ctx);
      expect(result.description).toContain("我有点饿了");
    });

    it("includes top impressions when impressionStore has data", () => {
      ctx.impressions!.set("tomori", {
        characterId: "anon",
        summary: "总是很活泼的女孩",
        observations: ["很爱说话"],
        mentalLabel: "开朗的同学",
        unresolved: [],
        lastUpdated: 90,
      });
      const result = readCharacterTool.handler({ character_id: "tomori" }, ctx);
      expect(result.description).toContain("开朗的同学");
      expect(result.description).toContain("总是很活泼的女孩");
    });
  });

  describe("read_scene", () => {
    it("returns occupants of a location", () => {
      world.moveCharacter("tomori", "plaza");
      world.moveCharacter("anon", "plaza");
      const result = readSceneTool.handler({ location_id: "plaza" }, ctx);
      expect(result.ok).toBe(true);
      expect(result.description).toContain("广场");
      expect(result.description).toContain("tomori");
      expect(result.description).toContain("anon");
    });

    it("reports empty location", () => {
      const result = readSceneTool.handler({ location_id: "library" }, ctx);
      expect(result.ok).toBe(true);
      expect(result.description).toContain("(无人)");
    });

    it("returns error for unknown location", () => {
      const result = readSceneTool.handler({ location_id: "atlantis" }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unknown_location");
    });

    it("includes recent events from occupants' short-term memory", () => {
      world.moveCharacter("tomori", "plaza");
      ctx.memory!.add("tomori", { tick: 95, type: "event", content: "在广场坐着", importance: 5 });
      const result = readSceneTool.handler({ location_id: "plaza" }, ctx);
      expect(result.description).toContain("在广场坐着");
    });
  });

  describe("read_arc_status (D4)", () => {
    it("returns no_agenda_store when ctx 没有 agendaStore", () => {
      const result = readArcStatusTool.handler({ arc_id: "any" }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_agenda_store");
    });

    it("returns unknown_arc when arc 不存在", async () => {
      const { InMemoryAgendaStore } = await import("./agenda-store.js");
      const ctxWithAgenda = { ...ctx, agendaStore: new InMemoryAgendaStore() };
      const result = readArcStatusTool.handler({ arc_id: "arc_999" }, ctxWithAgenda);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unknown_arc");
    });

    it("returns arc detail when arc exists", async () => {
      const { InMemoryAgendaStore } = await import("./agenda-store.js");
      const agenda = new InMemoryAgendaStore();
      agenda.create({ beatId: "b1", goal: "推真相", targetDay: 3, watchChars: ["alice"] }, 100, 1);
      const ctxWithAgenda = { ...ctx, agendaStore: agenda };
      const result = readArcStatusTool.handler({ arc_id: "arc_1" }, ctxWithAgenda);
      expect(result.ok).toBe(true);
      expect(result.description).toContain("推真相");
      expect(result.description).toContain("setup");
    });
  });
});
