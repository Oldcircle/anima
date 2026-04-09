/**
 * Director Tools 单测
 */

import { describe, it, expect, beforeEach } from "vitest";
import { World } from "../world/world.js";
import {
  ALL_DIRECTOR_TOOLS,
  getDirectorToolByName,
  injectIntentTool,
  injectObservationTool,
  addUnresolvedEventTool,
  addRumorTool,
  setObservableStateTool,
  nudgeWeatherTool,
  doNothingTool,
} from "./director-tools.js";
import type { Location } from "../world/types.js";

const fakeLocations: Location[] = [
  { id: "park", name: "Park", type: "outdoor", openHours: null, presentCharacters: [] } as Location,
];

describe("Director Tools", () => {
  let world: World;

  beforeEach(() => {
    world = new World(fakeLocations);
    world.addCharacter("alice", "Alice", "park");
    world.addCharacter("bob", "Bob", "park");
  });

  describe("inject_intent", () => {
    it("sets currentIntent on character", () => {
      const r = injectIntentTool.handler(
        { character_id: "alice", summary: "想找 bob 谈一谈", kind: "plan", target_character_id: "bob" },
        { world, tick: 100 },
      );
      expect(r.ok).toBe(true);
      const intent = world.getCurrentIntent("alice", 100);
      expect(intent?.summary).toBe("想找 bob 谈一谈");
      expect(intent?.targetId).toBe("bob");
    });

    it("uses default expires_in_ticks", () => {
      injectIntentTool.handler(
        { character_id: "alice", summary: "x" },
        { world, tick: 100 },
      );
      const intent = world.getCurrentIntent("alice", 100);
      expect(intent!.expiresAt).toBe(116); // 100 + 16
    });

    it("fails on unknown character", () => {
      const r = injectIntentTool.handler(
        { character_id: "ghost", summary: "x" },
        { world, tick: 0 },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toBe("unknown_character");
    });
  });

  describe("inject_observation", () => {
    it("delivers a system message via inbox", () => {
      const r = injectObservationTool.handler(
        { observer_id: "alice", summary: "你想起了昨天 bob 奇怪的眼神" },
        { world, tick: 50 },
      );
      expect(r.ok).toBe(true);
      const inbox = world.consumeInbox("alice");
      expect(inbox.length).toBe(1);
      expect(inbox[0]!.fromId).toBe("__director__");
      expect(inbox[0]!.content).toContain("奇怪的眼神");
    });
  });

  describe("add_unresolved_event", () => {
    it("writes to narrative_state", () => {
      const r = addUnresolvedEventTool.handler(
        {
          id: "mystery_letter",
          summary: "一封无名信出现在花店门口",
          involved: ["alice", "bob"],
          visible_to: "*",
        },
        { world, tick: 10 },
      );
      expect(r.ok).toBe(true);
      const events = world.narrative.getWorld().unresolvedEvents;
      expect(events.length).toBe(1);
      expect(events[0]!.id).toBe("mystery_letter");
    });
  });

  describe("add_rumor", () => {
    it("appends a rumor", () => {
      addRumorTool.handler(
        { content: "听说祥子昨晚没回家", source_character_id: "alice", spread_to: ["bob"] },
        { world, tick: 5 },
      );
      const rumors = world.narrative.getWorld().rumors;
      expect(rumors.length).toBe(1);
      expect(rumors[0]!.content).toContain("祥子");
      expect(rumors[0]!.reachedChars).toEqual(["bob"]);
    });
  });

  describe("set_observable_state", () => {
    it("updates character observable state", () => {
      setObservableStateTool.handler(
        { character_id: "alice", summary: "眼眶红红的，像刚哭过" },
        { world, tick: 30 },
      );
      const obs = world.getObservableState("alice", 30);
      expect(obs?.summary).toContain("哭过");
    });
  });

  describe("nudge_weather", () => {
    it("changes weather", () => {
      nudgeWeatherTool.handler({ weather: "rainy" }, { world, tick: 0 });
      expect(world.weather).toBe("rainy");
    });

    it("rejects unknown weather", () => {
      const r = nudgeWeatherTool.handler({ weather: "alien" }, { world, tick: 0 });
      expect(r.ok).toBe(false);
    });
  });

  describe("do_nothing", () => {
    it("always returns ok", () => {
      const r = doNothingTool.handler({ reason: "world is fine" }, { world, tick: 0 });
      expect(r.ok).toBe(true);
    });
  });

  describe("toolset boundary", () => {
    it("does NOT contain any 'talk'/'say' tool", () => {
      // 守卫：导演工具集绝不能包含让角色说话的工具
      for (const t of ALL_DIRECTOR_TOOLS) {
        const name = t.tool.name.toLowerCase();
        expect(name.startsWith("talk")).toBe(false);
        expect(name.startsWith("say")).toBe(false);
        expect(name.startsWith("speak")).toBe(false);
        expect(name.includes("message")).toBe(false);
      }
    });

    it("getDirectorToolByName resolves all tools", () => {
      for (const t of ALL_DIRECTOR_TOOLS) {
        expect(getDirectorToolByName(t.tool.name)).toBeDefined();
      }
      expect(getDirectorToolByName("nonexistent")).toBeUndefined();
    });
  });
});
