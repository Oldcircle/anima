/**
 * Bartle 玩法人格（PLAN-grounding 附）形状单测：
 * - 四型各有块；未声明/无效值 → 不注入（旧角色卡逐字节回归）
 * - `ANIMA_PLAYSTYLE=0` 整层退场（A/B 基线）
 * - 作用面限定：文本谈"选哪个工具"，不谈台词风格
 * - 缓存纪律：per 角色恒定（同一张卡两次构建逐字节一致）
 * - 角色卡加载：YAML playstyle 字段进 card；default 阵容已作者
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildPlaystyleBlock, playstyleEnabled, isPlaystyle } from "./playstyle.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { loadCharacterFromYAML } from "../character/loader.js";
import { join } from "node:path";
import type { CharacterCard } from "../character/types.js";

const CARDS_DIR = join(process.cwd(), "data", "characters");

function makeCard(playstyle?: string): CharacterCard {
  return {
    id: "t", name: "测试者", age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: ["安静"], interests: [], dislikes: [], speechStyle: "平淡" },
    background: "无", relationships: {}, playstyle,
  };
}

afterEach(() => {
  delete process.env.ANIMA_PLAYSTYLE;
});

describe("buildPlaystyleBlock", () => {
  it("四型各有块，且都在谈'选哪个工具'不谈说话方式", () => {
    for (const ps of ["achiever", "explorer", "socializer", "killer"]) {
      const block = buildPlaystyleBlock(ps);
      expect(block, ps).toBeTruthy();
      expect(block!).toContain("先伸手够哪个工具");
      expect(block!).toContain("不影响你怎么说话");
    }
    // 四型文本互不相同（不是一句话套四个标签）
    const texts = ["achiever", "explorer", "socializer", "killer"].map((p) => buildPlaystyleBlock(p));
    expect(new Set(texts).size).toBe(4);
  });

  it("未声明 / 无效值 → 不注入（旧角色卡逐字节回归）", () => {
    expect(buildPlaystyleBlock(undefined)).toBeUndefined();
    expect(buildPlaystyleBlock("")).toBeUndefined();
    expect(buildPlaystyleBlock("成就者")).toBeUndefined(); // 只认四个英文枚举值
    expect(isPlaystyle("achiever")).toBe(true);
    expect(isPlaystyle("wanderer")).toBe(false);
  });

  it("ANIMA_PLAYSTYLE=0 整层退场（A/B 基线）", () => {
    process.env.ANIMA_PLAYSTYLE = "0";
    expect(playstyleEnabled()).toBe(false);
    expect(buildPlaystyleBlock("achiever")).toBeUndefined();
    // system prompt 与未声明玩法的卡逐字节一致
    expect(buildSystemPrompt(makeCard("achiever"))).toBe(buildSystemPrompt(makeCard()));
  });

  it("缓存纪律：per 角色恒定，同卡两次构建逐字节一致", () => {
    const card = makeCard("explorer");
    expect(buildSystemPrompt(card)).toBe(buildSystemPrompt(card));
    // 声明了玩法的卡 ≠ 没声明的卡（确实注进去了）
    expect(buildSystemPrompt(card)).not.toBe(buildSystemPrompt(makeCard()));
    expect(buildSystemPrompt(card)).toContain("你玩这个世界的方式");
  });
});

describe("角色卡加载", () => {
  it("YAML playstyle 进 card；default 阵容已作者且值合法", () => {
    const authored: Record<string, string> = {
      asuka: "achiever", l_lawliet: "explorer", light: "killer",
      lelouch: "killer", senjougahara: "socializer", shinji: "socializer",
    };
    for (const [id, expected] of Object.entries(authored)) {
      const card = loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`));
      expect(card.playstyle, id).toBe(expected);
      expect(isPlaystyle(card.playstyle), id).toBe(true);
    }
    // 缺省路径的活样本：rei 没声明，走不注入分支
    const rei = loadCharacterFromYAML(join(CARDS_DIR, "rei.yml"));
    expect(rei.playstyle).toBeUndefined();
    expect(buildSystemPrompt(rei)).not.toContain("你玩这个世界的方式");
  });
});
