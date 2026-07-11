import { describe, it, expect } from "vitest";
import { postProcessPrompt, PROMPT_PLACEHOLDER } from "./post-processing.js";
import type { TavernMessage } from "./assembler.js";

const M = (role: TavernMessage["role"], content: string, name?: string): TavernMessage =>
  name ? { role, content, name } : { role, content };

describe("Prompt Post-Processing（一比一复刻 ST）", () => {
  it("none：原样返回", () => {
    const msgs = [M("system", "a"), M("user", "u")];
    expect(postProcessPrompt(msgs, "none")).toEqual(msgs);
  });

  it("merge：相邻同角色用 \\n\\n 合并（含 system 与 user）", () => {
    const msgs = [M("system", "a"), M("system", "b"), M("user", "u"), M("user", "v"), M("assistant", "x")];
    expect(postProcessPrompt(msgs, "merge")).toEqual([
      M("system", "a\n\nb"),
      M("user", "u\n\nv"),
      M("assistant", "x"),
    ]);
  });

  it("semi：中段 system 变 user 后再合并（强制交替）", () => {
    const msgs = [M("system", "a"), M("user", "u"), M("system", "b"), M("assistant", "x")];
    expect(postProcessPrompt(msgs, "semi")).toEqual([
      M("system", "a"),
      M("user", "u\n\nb"),
      M("assistant", "x"),
    ]);
  });

  it("strict：首条 system 后若非 user 则插占位，保证 user 最先", () => {
    const msgs = [M("system", "a"), M("assistant", "x")];
    expect(postProcessPrompt(msgs, "strict")).toEqual([
      M("system", "a"),
      M("user", PROMPT_PLACEHOLDER),
      M("assistant", "x"),
    ]);
  });

  it("strict：开头既非 system 也非 user → 前插占位 user", () => {
    expect(postProcessPrompt([M("assistant", "x")], "strict")).toEqual([
      M("user", PROMPT_PLACEHOLDER),
      M("assistant", "x"),
    ]);
  });

  it("single：全部并成一条 user，带名字前缀", () => {
    const msgs = [M("system", "a"), M("user", "u"), M("assistant", "x")];
    expect(postProcessPrompt(msgs, "single", { charName: "L", userName: "U" })).toEqual([
      M("user", "a\n\nU: u\n\nL: x"),
    ]);
  });

  it("带 name 的消息前缀化 name:", () => {
    expect(postProcessPrompt([M("user", "hi", "Bob")], "merge")).toEqual([M("user", "Bob: hi")]);
  });
});
