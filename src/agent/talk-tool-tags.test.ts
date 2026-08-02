/**
 * C1 单测（DESIGN-revival §8 C1 行）：
 * - talk schema 补 intent/topic_tags/references_event 三个可选参数（reveals 缓做）
 * - schema 静态（缓存纪律：不随 tick/hour 抖动）
 * - tag-applier 链路对新参数生效
 * - reveals→disclosedSecrets 回归（schema 未列但链路仍容忍处理）
 */

import { describe, it, expect } from "vitest";
import { buildToolList, type ToolBuildContext } from "./tool-builder.js";
import { extractTagsFromArgs, applyNarrativeTags, hasAnyTags } from "../narrative/tag-applier.js";
import { World } from "../world/world.js";
import { RelationshipManager } from "../world/relationships.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

function makeCard(id: string, name: string): CharacterCard {
  return {
    id, name, age: 19, occupation: "学徒", home: "home_tomori",
    personality: { traits: ["普通"], interests: [], dislikes: [], speechStyle: "平常" },
    background: "测试角色", relationships: {},
  };
}

function makeWorld(): World {
  const world = new World(TEST_LOCATIONS, 40);
  world.addCharacter("tomori", "高松灯", "cafe");
  world.addCharacter("anon", "千早爱音", "cafe");
  return world;
}

function ctxFor(world: World, id: string, opts: { hour?: number; tick?: number } = {}): ToolBuildContext {
  const state = world.getCharacter(id)!;
  const location = world.getLocation(state.locationId)!;
  return {
    state,
    card: makeCard(id, state.name),
    location,
    nearbyCharacters: world.getCharactersAtLocation(state.locationId)
      .filter((c) => c !== id).map((c) => ({ id: c, name: world.getCharacter(c)!.name })),
    allLocations: world.getAllLocations(),
    gold: state.gold,
    hour: opts.hour ?? 12,
    tick: opts.tick ?? 40,
    relationships: new RelationshipManager(),
  };
}

function talkToolOf(world: World, id: string, opts: { hour?: number; tick?: number } = {}) {
  const talk = buildToolList(ctxFor(world, id, opts)).find((t) => t.tool.name === "talk");
  expect(talk).toBeDefined();
  return talk!;
}

describe("C1: talk schema 新参数", () => {
  it("schema 含 intent/topic_tags/references_event 三个可选参数，required 不变", () => {
    const world = makeWorld();
    const talk = talkToolOf(world, "tomori");
    const params = talk.tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties.intent).toBeDefined();
    expect(params.properties.topic_tags).toBeDefined();
    expect(params.properties.references_event).toBeDefined();
    // reveals 缓做（二轮评审：秘密管线接通前补参数只会让模型编 id）
    expect(params.properties.reveals).toBeUndefined();
    // 新参数全部可选：required 仍只有 target + message
    expect(params.required).toEqual(["target", "message"]);
  });

  it("schema 静态：不随 hour/tick 抖动（缓存纪律）", () => {
    const world = makeWorld();
    const t1 = JSON.stringify(talkToolOf(world, "tomori", { hour: 8, tick: 32 }).tool);
    const t2 = JSON.stringify(talkToolOf(world, "tomori", { hour: 23, tick: 92 }).tool);
    expect(t2).toBe(t1);
  });

  it("handler 对带新参数的调用照常工作（多余参数不干扰）", () => {
    const world = makeWorld();
    const talk = talkToolOf(world, "tomori");
    const result = talk.handler(
      {
        target: "anon", message: "上次的事还没说完呢",
        intent: "confront", topic_tags: ["昨晚的事"], references_event: "e_argument",
      },
      {
        characterId: "tomori", locationId: "cafe", locationType: "commercial",
        tick: 40, nearbyCharacters: ["anon"], gold: 100, needs: {},
      },
    );
    expect(result.success ?? true).toBe(true);
    expect(result.description).toContain("上次的事");
  });
});

describe("C1: tag-applier 链路对新参数生效", () => {
  it("talk args → extract → apply：references_event 落 unresolvedWith，intent/topic_tags 进标签日志", () => {
    const world = makeWorld();
    const args = {
      target: "anon", message: "那件事我还记着", manner: "皱着眉",
      intent: "confront", topic_tags: ["旧账"], references_event: "e_stolen_bread",
    };
    const tags = extractTagsFromArgs(args);
    expect(hasAnyTags(tags)).toBe(true);
    expect(tags.intent).toBe("confront");
    expect(tags.topic_tags).toEqual(["旧账"]);
    expect(tags.references_event).toBe("e_stolen_bread");

    const log = applyNarrativeTags(world, "tomori", args.target, tags);
    expect(log.unresolvedWithAdded).toEqual(["e_stolen_bread"]);
    expect(world.narrative.getCharacter("tomori").unresolvedWith.anon).toContain("e_stolen_bread");
    expect(log.tags.intent).toBe("confront");
  });

  it("回归：reveals 虽不在 schema，链路仍把它落 disclosedSecrets（他工具/模型越格容忍）", () => {
    const world = makeWorld();
    const tags = extractTagsFromArgs({ target: "anon", message: "其实……", reveals: ["family_secret"] });
    applyNarrativeTags(world, "tomori", "anon", tags);
    expect(world.narrative.getCharacter("tomori").disclosedSecrets).toContain("family_secret");
    expect(world.narrative.getCharacter("anon").knownFacts).toContain("tomori_family_secret");
  });

  it("无标签调用零写入（向后兼容）", () => {
    const world = makeWorld();
    const tags = extractTagsFromArgs({ target: "anon", message: "早上好" });
    expect(hasAnyTags(tags)).toBe(false);
    applyNarrativeTags(world, "tomori", "anon", tags);
    expect(world.narrative.getSnapshot().characters).toEqual({});
  });
});
