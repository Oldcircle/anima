/**
 * Scenario Loader 单测
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenario, loadScenarioManifest } from "./scenario-loader.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "anima-scenario-test-"));

  // 构造一个最小的项目结构
  mkdirSync(join(root, "data", "characters"), { recursive: true });
  mkdirSync(join(root, "data", "locations"), { recursive: true });
  mkdirSync(join(root, "data", "scenarios", "all"), { recursive: true });
  mkdirSync(join(root, "data", "scenarios", "subset"), { recursive: true });
  mkdirSync(join(root, "data", "scenarios", "bad-id"), { recursive: true });

  // characters: alice (active), bob (active), cara (disabled)
  writeFileSync(
    join(root, "data", "characters", "alice.yml"),
    'id: "alice"\nname: "Alice"\n',
  );
  writeFileSync(
    join(root, "data", "characters", "bob.yml"),
    'id: "bob"\nname: "Bob"\n',
  );
  writeFileSync(
    join(root, "data", "characters", "cara.yml"),
    'id: "cara"\nname: "Cara"\ndisabled: true\n',
  );

  // locations: park, cafe, hidden (disabled)
  writeFileSync(
    join(root, "data", "locations", "park.yml"),
    'id: "park"\nname: "Park"\ntype: "outdoor"\n',
  );
  writeFileSync(
    join(root, "data", "locations", "cafe.yml"),
    'id: "cafe"\nname: "Cafe"\ntype: "venue"\n',
  );
  writeFileSync(
    join(root, "data", "locations", "hidden.yml"),
    'id: "hidden"\nname: "Hidden"\ntype: "outdoor"\ndisabled: true\n',
  );

  // scenario "all": wildcard
  writeFileSync(
    join(root, "data", "scenarios", "all", "manifest.yml"),
    'id: all\nname: All\ncharacters: "*"\nlocations: "*"\n',
  );

  // scenario "subset": explicit ids, includes a disabled character to verify override
  writeFileSync(
    join(root, "data", "scenarios", "subset", "manifest.yml"),
    'id: subset\ncharacters:\n  - cara\n  - alice\nlocations:\n  - cafe\n',
  );

  // scenario with mismatched id
  writeFileSync(
    join(root, "data", "scenarios", "bad-id", "manifest.yml"),
    'id: wrong\ncharacters: "*"\nlocations: "*"\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scenario-loader", () => {
  it("loads wildcard scenario (= current loader behavior)", () => {
    const s = loadScenario("all", { projectRoot: root });
    expect(s.manifest.id).toBe("all");
    // wildcard 模式应过滤 disabled
    const charIds = s.characters.map((c) => c.id).sort();
    expect(charIds).toEqual(["alice", "bob"]);
    const locIds = s.locations.map((l) => l.id).sort();
    expect(locIds).toEqual(["cafe", "park"]);
  });

  it("loads explicit-id scenario and overrides disabled flag", () => {
    const s = loadScenario("subset", { projectRoot: root });
    const charIds = s.characters.map((c) => c.id).sort();
    // cara 是 disabled 的，但 scenario 显式包含 → 应被加载
    expect(charIds).toEqual(["alice", "cara"]);
    const locIds = s.locations.map((l) => l.id);
    expect(locIds).toEqual(["cafe"]);
  });

  it("preserves character order from selector", () => {
    const s = loadScenario("subset", { projectRoot: root });
    expect(s.characters.map((c) => c.id)).toEqual(["cara", "alice"]);
  });

  it("throws on missing scenario", () => {
    expect(() => loadScenario("nonexistent", { projectRoot: root })).toThrow(
      /Scenario not found/,
    );
  });

  it("throws on id mismatch between manifest and dir", () => {
    expect(() => loadScenarioManifest("bad-id", join(root, "data", "scenarios"))).toThrow(
      /does not match directory name/,
    );
  });

  it("throws on unknown character id in selector", () => {
    mkdirSync(join(root, "data", "scenarios", "missing-char"), { recursive: true });
    writeFileSync(
      join(root, "data", "scenarios", "missing-char", "manifest.yml"),
      'id: missing-char\ncharacters:\n  - ghost\nlocations: "*"\n',
    );
    expect(() => loadScenario("missing-char", { projectRoot: root })).toThrow(
      /unknown character ids: ghost/,
    );
  });

  it("throws on unknown location id in selector", () => {
    mkdirSync(join(root, "data", "scenarios", "missing-loc"), { recursive: true });
    writeFileSync(
      join(root, "data", "scenarios", "missing-loc", "manifest.yml"),
      'id: missing-loc\ncharacters: "*"\nlocations:\n  - moon\n',
    );
    expect(() => loadScenario("missing-loc", { projectRoot: root })).toThrow(
      /unknown location ids: moon/,
    );
  });

  it("rejects invalid selector type", () => {
    mkdirSync(join(root, "data", "scenarios", "bad-selector"), { recursive: true });
    writeFileSync(
      join(root, "data", "scenarios", "bad-selector", "manifest.yml"),
      'id: bad-selector\ncharacters: 123\nlocations: "*"\n',
    );
    expect(() => loadScenario("bad-selector", { projectRoot: root })).toThrow(
      /must be "\*" or string\[\]/,
    );
  });
});
