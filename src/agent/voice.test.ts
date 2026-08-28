/**
 * 声部（减法）形状单测：
 * - normalizeVoice 逐字段显式映射（snake/camel 双接受；非法值静默丢弃）
 * - 未声明 voice / `ANIMA_VOICE=0` → 整层退场（buildSystemPrompt 逐字节回归）
 * - 块文本自限：明说覆盖"一两句到三四句"，且声明"这是嘴的上限不是心的上限"
 * - 缓存纪律：per 角色恒定（同一张卡两次构建逐字节一致）
 * - 机械侧：未超顶逐字节不动；超顶切在句边界且不超上限；违规计数只记一次
 * - 角色卡加载：YAML voice 字段真进 card；对照组（L/鲁鲁修）故意留空
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { runAgentTick, type AgentConfig } from "./agent-loop.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import {
  buildVoiceBlock,
  enforceVoice,
  normalizeVoice,
  voiceEnabled,
  getVoiceOverflowCounts,
  resetVoiceOverflowCounts,
  enforceVoiceOnArgs,
  voiceOriginal,
  VOICE_SPEECH_ARGS,
  SPEECH_ARGS_BY_TOOL,
} from "./voice.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { loadCharacterFromYAML } from "../character/loader.js";
import { join } from "node:path";
import type { CharacterCard } from "../character/types.js";

const CARDS_DIR = join(process.cwd(), "data", "characters");

function makeCard(voice?: CharacterCard["voice"]): CharacterCard {
  return {
    id: "t", name: "测试者", age: 20, occupation: "镇民", home: "home_tomori",
    personality: { traits: ["安静"], interests: [], dislikes: [], speechStyle: "平淡" },
    background: "无", relationships: {}, voice,
  };
}

beforeEach(() => resetVoiceOverflowCounts());
afterEach(() => {
  delete process.env.ANIMA_VOICE;
  resetVoiceOverflowCounts();
});

describe("normalizeVoice（显式映射，绝不整体 cast）", () => {
  it("snake_case 与 camelCase 都认", () => {
    expect(normalizeVoice({ max_chars: 24 })).toEqual({ maxChars: 24 });
    expect(normalizeVoice({ maxChars: 24 })).toEqual({ maxChars: 24 });
  });

  it("非法 ban 逐条丢弃，合法的留下（宁缺毋滥）", () => {
    expect(normalizeVoice({ bans: ["比喻", "喝水", "排比", 7] })).toEqual({ bans: ["比喻", "排比"] });
  });

  it("非法/无效 max_chars 丢弃而不是整块放弃", () => {
    expect(normalizeVoice({ max_chars: "20", bans: ["反问"] })).toEqual({ bans: ["反问"] });
    expect(normalizeVoice({ max_chars: 0, bans: ["反问"] })).toEqual({ bans: ["反问"] });
    expect(normalizeVoice({ max_chars: Number.NaN, bans: ["反问"] })).toEqual({ bans: ["反问"] });
  });

  it("整块没有任何有效项 → undefined（= 不设限，对照组）", () => {
    expect(normalizeVoice(undefined)).toBeUndefined();
    expect(normalizeVoice({})).toBeUndefined();
    expect(normalizeVoice({ bans: ["瞎写"] })).toBeUndefined();
    expect(normalizeVoice([])).toBeUndefined();
    expect(normalizeVoice("voice")).toBeUndefined();
  });

  it("silence 只认真正的 true", () => {
    expect(normalizeVoice({ silence: true })).toEqual({ silence: true });
    expect(normalizeVoice({ silence: "yes" })).toBeUndefined();
  });
});

describe("buildVoiceBlock", () => {
  it("字数上限进块，且明说覆盖前面的句数建议", () => {
    const block = buildVoiceBlock({ maxChars: 24 })!;
    expect(block).toContain("24");
    expect(block).toContain("覆盖");
  });

  it("自限尾句在：这是嘴的上限不是心的上限（防被读成'写得更精炼'）", () => {
    const block = buildVoiceBlock({ maxChars: 30 })!;
    expect(block).toContain("嘴");
    expect(block).toContain("不是心的上限");
    expect(block).toContain("别把它当成要写得更精炼的意思");
  });

  it("每种 ban 有各自的文本，互不相同", () => {
    const texts = (["比喻", "反问", "排比", "书面语", "感叹"] as const).map(
      (b) => buildVoiceBlock({ bans: [b] })!,
    );
    expect(new Set(texts).size).toBe(5);
  });

  it("未声明 voice → undefined（不是空串——空串 push 会砸逐字节 A/B）", () => {
    expect(buildVoiceBlock(undefined)).toBeUndefined();
    expect(buildVoiceBlock({})).toBeUndefined();
  });

  it("ANIMA_VOICE=0 整层退场", () => {
    process.env.ANIMA_VOICE = "0";
    expect(voiceEnabled()).toBe(false);
    expect(buildVoiceBlock({ maxChars: 20, bans: ["比喻"], silence: true })).toBeUndefined();
  });
});

describe("buildSystemPrompt 集成", () => {
  it("ANIMA_VOICE=0 时，有 voice 的卡与没 voice 的卡逐字节相同（A/B 基线）", () => {
    process.env.ANIMA_VOICE = "0";
    const withVoice = buildSystemPrompt(makeCard({ maxChars: 20, bans: ["比喻"], silence: true }));
    const without = buildSystemPrompt(makeCard(undefined));
    expect(withVoice).toBe(without);
  });

  it("未声明 voice 的卡不受影响（旧卡逐字节回归）", () => {
    const a = buildSystemPrompt(makeCard(undefined));
    process.env.ANIMA_VOICE = "0";
    const b = buildSystemPrompt(makeCard(undefined));
    expect(a).toBe(b);
  });

  it("开启时块真进了 system prompt", () => {
    const p = buildSystemPrompt(makeCard({ maxChars: 24 }));
    expect(p).toContain("## 说话的限度");
    expect(p).toContain("24");
  });

  it("缓存纪律：同一张卡两次构建逐字节一致", () => {
    const card = makeCard({ maxChars: 24, bans: ["比喻"], silence: true });
    expect(buildSystemPrompt(card)).toBe(buildSystemPrompt(card));
  });

  it("块的标题不与缓存断言锚点撞名", () => {
    const block = buildVoiceBlock({ maxChars: 24 })!;
    expect(block).not.toContain("## 对话记录");
    expect(block).not.toContain("## 你现在的状态");
    expect(block).not.toContain("\n时间: ");
  });
});

describe("enforceVoice（机械侧硬顶）", () => {
  it("未超顶 → 逐字节原样返回，且不计违规", () => {
    const msg = "嗯。";
    expect(enforceVoice(msg, { maxChars: 24 }, "rei")).toBe(msg);
    expect(getVoiceOverflowCounts()).toEqual({});
  });

  it("没有 maxChars / 没有 voice → 原样返回", () => {
    const msg = "这句话很长很长很长很长很长很长很长很长很长很长很长很长。";
    expect(enforceVoice(msg, undefined, "l")).toBe(msg);
    expect(enforceVoice(msg, { bans: ["比喻"] }, "l")).toBe(msg);
  });

  it("超顶 → 切在句边界，结果不超上限，且计一次违规", () => {
    const msg = "我不知道。它们都很好。可是我说不上来为什么会这样觉得，也许只是习惯了。";
    const out = enforceVoice(msg, { maxChars: 24 }, "rei");
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out.endsWith("。")).toBe(true);
    expect(msg.startsWith(out)).toBe(true); // 只截不改写
    expect(getVoiceOverflowCounts()).toEqual({ rei: 1 });
  });

  it("上限内找不到句末标点 → 硬切补省略号（不假装说完了）", () => {
    const out = enforceVoice("啊那个我我我我我我我我我我我我我我我我我我我我我我", { maxChars: 10 }, "shinji");
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(10); // 省略号算在上限内，否则这层不幂等
  });

  it("ANIMA_VOICE=0 时不截断（整层退场）", () => {
    process.env.ANIMA_VOICE = "0";
    const msg = "一二三四五六七八九十一二三四五六七八九十。";
    expect(enforceVoice(msg, { maxChars: 5 }, "rei")).toBe(msg);
    expect(getVoiceOverflowCounts()).toEqual({});
  });

  it("幂等：任何输入截一次之后再截都不变（生产里这层会被调两次）", () => {
    for (const msg of [
      "一二三四五六七八九十一二三四五六七八九十。",
      "我不知道。它们都很好。可是我说不上来为什么会这样觉得。",
      "啊那个我我我我我我我我我我我我我我我我",
    ]) {
      for (const max of [4, 8, 10, 24]) {
        const once = enforceVoice(msg, { maxChars: max }, "t");
        expect(once.length, `${max}/${msg}`).toBeLessThanOrEqual(max);
        expect(enforceVoice(once, { maxChars: max }, "t"), `${max}/${msg}`).toBe(once);
      }
    }
  });

  it("违规计数按角色分别累加", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十。";
    enforceVoice(long, { maxChars: 5 }, "rei");
    enforceVoice(long, { maxChars: 5 }, "rei");
    enforceVoice(long, { maxChars: 5 }, "shinji");
    expect(getVoiceOverflowCounts()).toEqual({ rei: 2, shinji: 1 });
  });
});

describe("接线（真实台词路径，不是纯函数调用）", () => {
  it("VOICE_SPEECH_ARGS 覆盖全部自撰台词出口：talk.message / comfort·argue.words / share_secret.secret", () => {
    expect([...VOICE_SPEECH_ARGS].sort()).toEqual(["message", "secret", "words"]);
  });

  it("按工具收各自的台词出口，非台词参数一字不动", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十。";
    for (const [tool, keys] of Object.entries(SPEECH_ARGS_BY_TOOL)) {
      const args: Record<string, unknown> = {
        message: long, words: long, secret: long, reason: long,
        target: "anon", manner: long, activity: long, count: 3,
      };
      enforceVoiceOnArgs(tool, args, { maxChars: 8 }, "rei");
      for (const k of keys) expect((args[k] as string).length, `${tool}.${k}`).toBeLessThanOrEqual(8);
      // 不在该工具清单里的一律不动
      for (const k of ["target", "manner", "activity", "count"]) {
        expect(args[k], `${tool}.${k}`).toBe(k === "target" ? "anon" : k === "count" ? 3 : long);
      }
    }
  });

  it("argue 必须连 reason 一起收：words 是可选的，模型只填 reason 时 reason 就是那句台词", () => {
    expect(SPEECH_ARGS_BY_TOOL.argue).toContain("reason");
    const long = "一二三四五六七八九十一二三四五六七八九十。";
    const args: Record<string, unknown> = { target: "anon", reason: long };
    enforceVoiceOnArgs("argue", args, { maxChars: 8 }, "rei");
    expect((args.reason as string).length).toBeLessThanOrEqual(8);
  });

  it("voiceOriginal 留住截断前的原文（道歉词在句尾，判道歉要读它）", () => {
    const line = "那天在店里我说的话太重了，我一整晚都在想这件事。对不起。";
    const args: Record<string, unknown> = { message: line };
    enforceVoiceOnArgs("talk", args, { maxChars: 20 }, "rei");
    expect((args.message as string).length).toBeLessThanOrEqual(20);
    expect(args.message).not.toContain("对不起");
    expect(voiceOriginal(args, "message")).toBe(line);
    // 没被截过的参数：返回当前值
    expect(voiceOriginal({ message: "嗯。" }, "message")).toBe("嗯。");
  });

  it("幂等：已截过的再调一次原样返回，且不重复计违规", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十。";
    const args: Record<string, unknown> = { message: long };
    enforceVoiceOnArgs("talk", args, { maxChars: 8 }, "rei");
    const once = args.message;
    enforceVoiceOnArgs("talk", args, { maxChars: 8 }, "rei");
    expect(args.message).toBe(once);
    expect(getVoiceOverflowCounts()).toEqual({ rei: 1 });
  });

  it("没有 voice 的卡（对照组）一字不动", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十。";
    const args: Record<string, unknown> = { message: long };
    enforceVoiceOnArgs("talk", args, undefined, "l");
    expect(args.message).toBe(long);
    expect(getVoiceOverflowCounts()).toEqual({});
  });
});

describe("角色卡作者化（default 阵容）", () => {
  it("设限的五张卡 YAML 字段真的进了 card（loader 白名单漏一行就静默退场）", () => {
    for (const id of ["shinji", "rei", "asuka", "light", "senjougahara"]) {
      const card = loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`));
      expect(card.voice, id).toBeTruthy();
      expect(card.voice!.maxChars, id).toBeGreaterThan(0);
    }
  });

  it("对照组故意留空——不是所有人都设限，对比度本身就是目的", () => {
    for (const id of ["l_lawliet", "lelouch"]) {
      const card = loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`));
      expect(card.voice, id).toBeUndefined();
    }
  });

  it("bans / silence 也真的落进了 card（词表错配会被 filter 静默丢弃，光验 maxChars 测不出）", () => {
    const expected: Record<string, { bans: string[]; silence: boolean }> = {
      shinji: { bans: ["比喻", "排比", "反问"], silence: true },
      rei: { bans: ["比喻", "排比"], silence: true },
      asuka: { bans: ["比喻", "书面语"], silence: false },
      light: { bans: ["感叹"], silence: false },
      senjougahara: { bans: ["感叹"], silence: false },
    };
    for (const [id, want] of Object.entries(expected)) {
      const v = loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`)).voice!;
      expect(v.bans ?? [], id).toEqual(want.bans);
      expect(v.silence === true, id).toBe(want.silence);
    }
  });

  it("卡上每个 ban 都真的进了 prompt 块（拼错的词会被静默丢，卡里看着还在）", () => {
    for (const id of ["shinji", "rei", "asuka", "light", "senjougahara"]) {
      const card = loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`));
      const block = buildVoiceBlock(card.voice)!;
      for (const b of card.voice!.bans ?? []) {
        expect(buildVoiceBlock({ bans: [b] })!.split("\n").some((l) => block.includes(l)), `${id}/${b}`).toBe(true);
      }
    }
  });

  it("上限拉开了档次：最紧的一张不到最松的一张的一半", () => {
    const caps = ["shinji", "rei", "asuka", "light", "senjougahara"].map(
      (id) => loadCharacterFromYAML(join(CARDS_DIR, `${id}.yml`)).voice!.maxChars!,
    );
    expect(Math.min(...caps) * 2).toBeLessThan(Math.max(...caps));
  });
});

/**
 * 接线回归（对抗审查确认的 blocker）：上面那些用例都是纯函数调用——
 * 实测把 agent-loop 里那两处 enforceVoiceOnArgs **整段删掉，全套用例照样绿**。
 * 下面这组走真实 runAgentTick，删掉接线就红。
 */
describe("接线回归：真实 runAgentTick 上的硬顶", () => {
  let world: World;
  let mockLLM: MockLLMProvider;

  const LONG = "我不知道该说什么才好。可是如果你一定要问的话，我想我大概是不太明白的。对不起。";

  function cfg(voice?: CharacterCard["voice"]): AgentConfig {
    return {
      card: {
        id: "rei", name: "绫波丽", age: 19, occupation: "花店店员", home: "home_tomori",
        personality: { traits: ["寡言"], interests: [], dislikes: [], speechStyle: "极简" },
        background: "花店店员", relationships: {}, voice,
      },
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test-model",
    };
  }

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("rei", "绫波丽", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_tomori");
    mockLLM = new MockLLMProvider();
  });

  it("有 voice 的角色：真实 tick 后落到 action.args 的台词已被截断", async () => {
    mockLLM.enqueueResponse("……", [
      { name: "talk", arguments: { target: "anon", message: LONG } },
    ]);
    const r = await runAgentTick({
      config: cfg({ maxChars: 20 }), world, eventBus: new EventBus(), gameTime: tickToGameTime(48),
    });
    const said = (r.action?.args as { message?: string })?.message ?? "";
    expect(said.length).toBeGreaterThan(0);
    expect(said.length).toBeLessThanOrEqual(20);
    expect(LONG.startsWith(said.replace(/…$/, ""))).toBe(true);
    // 下游看到的也是截断后的（description 由 handler 用同一份 args 拼）
    expect(r.result?.description ?? "").not.toContain("对不起。");
  });

  it("对照组（没有 voice）：同一句台词一字不动", async () => {
    mockLLM.enqueueResponse("……", [
      { name: "talk", arguments: { target: "anon", message: LONG } },
    ]);
    const r = await runAgentTick({
      config: cfg(undefined), world, eventBus: new EventBus(), gameTime: tickToGameTime(48),
    });
    expect((r.action?.args as { message?: string })?.message).toBe(LONG);
  });

  it("ANIMA_VOICE=0：接线在岗但整层退场，台词一字不动", async () => {
    process.env.ANIMA_VOICE = "0";
    mockLLM.enqueueResponse("……", [
      { name: "talk", arguments: { target: "anon", message: LONG } },
    ]);
    const r = await runAgentTick({
      config: cfg({ maxChars: 20 }), world, eventBus: new EventBus(), gameTime: tickToGameTime(48),
    });
    expect((r.action?.args as { message?: string })?.message).toBe(LONG);
  });
});
