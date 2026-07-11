import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadTavernPreset } from "./loader.js";
import {
  assembleMessages,
  substituteMacros,
  squashSystemMessages,
  staticPrefix,
  type TavernMessage,
} from "./assembler.js";
import type { TavernPreset } from "./types.js";

/** 造一个最小合成预设，隔离验证组装规则 */
function makePreset(overrides?: Partial<TavernPreset>): TavernPreset {
  return {
    name: "synthetic",
    prompts: [
      { identifier: "sysA", name: "A", role: "system", marker: false, content: "系统A {{user}}" },
      { identifier: "charDescription", name: "Char", role: "system", marker: true },
      { identifier: "sysB", name: "B", role: "system", marker: false, content: "系统B" },
      { identifier: "chatHistory", name: "History", role: "system", marker: true },
      { identifier: "off1", name: "Off", role: "system", marker: false, content: "不该出现" },
      { identifier: "empty1", name: "Empty", role: "system", marker: false, content: "   " },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: "sysA", enabled: true },
          { identifier: "charDescription", enabled: true },
          { identifier: "empty1", enabled: true },
          { identifier: "sysB", enabled: true },
          { identifier: "off1", enabled: false },
          { identifier: "chatHistory", enabled: true },
        ],
      },
    ],
    sampling: {},
    raw: { squash_system_messages: false },
    ...overrides,
  };
}

describe("宏替换", () => {
  it("替换已知宏，大小写不敏感，未知宏原样保留", () => {
    expect(substituteMacros("你好 {{User}} 和 {{char}} 与 {{unknown}}", { user: "观察者", char: "L" })).toBe(
      "你好 观察者 和 L 与 {{unknown}}",
    );
  });
});

describe("相邻 system 合并", () => {
  it("只合并相邻 system，跨 user 不合并", () => {
    const msgs: TavernMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "u" },
      { role: "system", content: "c" },
    ];
    expect(squashSystemMessages(msgs)).toEqual([
      { role: "system", content: "a\nb" },
      { role: "user", content: "u" },
      { role: "system", content: "c" },
    ]);
  });

  it("ST 规则：丢空 system，带 name 的 system 不参与合并", () => {
    const msgs: TavernMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "" }, // 空 → 丢弃
      { role: "system", content: "b", name: "L" }, // 带 name → 不合并
      { role: "system", content: "c" },
    ];
    expect(squashSystemMessages(msgs)).toEqual([
      { role: "system", content: "a" },
      { role: "system", content: "b", name: "L" },
      { role: "system", content: "c" },
    ]);
  });
});

describe("组装器（S1）", () => {
  const preset = makePreset();

  it("按 order 渲染，跳过 disabled，丢弃空块，替换 marker 与宏", () => {
    const msgs = assembleMessages(preset, {
      markers: { charDescription: "这是L的人设", chatHistory: [{ role: "user", content: "发生了X" }] },
      macros: { user: "观察者" },
    });
    expect(msgs).toEqual([
      { role: "system", content: "系统A 观察者" },
      { role: "system", content: "这是L的人设" },
      { role: "system", content: "系统B" },
      { role: "user", content: "发生了X" },
    ]);
    // off1(disabled) 与 empty1(空) 都没出现
    expect(msgs.some((m) => m.content.includes("不该出现"))).toBe(false);
  });

  it("postHistory 永远追加在最末尾", () => {
    const msgs = assembleMessages(preset, {
      markers: { chatHistory: [{ role: "user", content: "h" }] },
      postHistory: [{ role: "system", content: "此刻：L 在咖啡馆，饿。请决策" }],
    });
    expect(msgs[msgs.length - 1]).toEqual({ role: "system", content: "此刻：L 在咖啡馆，饿。请决策" });
  });
});

describe("缓存前缀稳定性（核心目标）", () => {
  const preset = makePreset();
  const staticMarkers = { charDescription: "L 的固定人设" };

  it("改对话/改此刻快照，静态前缀逐字节不变", () => {
    const prefix = staticPrefix(preset, { markers: staticMarkers, macros: { user: "观察者" } });

    const runA = assembleMessages(preset, {
      markers: { ...staticMarkers, chatHistory: [{ role: "user", content: "早上好" }] },
      macros: { user: "观察者" },
      postHistory: [{ role: "system", content: "此刻 tick=10" }],
    });
    const runB = assembleMessages(preset, {
      markers: {
        ...staticMarkers,
        chatHistory: [
          { role: "user", content: "早上好" },
          { role: "assistant", content: "嗯" },
          { role: "user", content: "在忙？" },
        ],
      },
      macros: { user: "观察者" },
      postHistory: [{ role: "system", content: "此刻 tick=999 天气突变" }],
    });

    // 两次运行开头都严格等于静态前缀
    expect(runA.slice(0, prefix.length)).toEqual(prefix);
    expect(runB.slice(0, prefix.length)).toEqual(prefix);
    // 逐字节比较（JSON 序列化）
    expect(JSON.stringify(runA.slice(0, prefix.length))).toBe(JSON.stringify(prefix));
    expect(JSON.stringify(runB.slice(0, prefix.length))).toBe(JSON.stringify(prefix));
  });
});

describe("吃真实 TGbreak 预设组装", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const preset = loadTavernPreset(resolve(here, "../../reference/tavern-presets/TGbreak-v3.1.1.json"));

  it("首条是 main 破限系统块，宏被替换，postHistory 殿后", () => {
    const msgs = assembleMessages(preset, {
      markers: {
        charDescription: "测试角色卡",
        chatHistory: [{ role: "user", content: "观察：门开了" }],
      },
      macros: { user: "观察者", char: "L" },
      postHistory: [{ role: "system", content: "【此刻】请以工具调用输出决策" }],
    });
    expect(msgs.length).toBeGreaterThan(5);
    // squash_system_messages=true → 开头系统块被合并成一条
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("虚构文学");
    // 真实预设含 84 处 {{user}}，替换后不应残留
    const joined = msgs.map((m) => m.content).join("\n");
    expect(joined).not.toContain("{{user}}");
    expect(msgs[msgs.length - 1].content).toContain("请以工具调用输出决策");
  });
});
