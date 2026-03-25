/**
 * Relationship Actions Tests — 关系转变行为工具
 */

import { describe, it, expect } from "vitest";
import { inviteOutAction, shareSecretAction } from "./relationship-actions.js";
import type { ActionContext } from "./types.js";

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    characterId: "tomori",
    locationId: "cafe",
    locationType: "commercial",
    tick: 100,
    nearbyCharacters: ["anon"],
    gold: 100,
    needs: { hunger: 50, energy: 50, social: 50, happiness: 50, hygiene: 50 },
    ...overrides,
  };
}

describe("invite_out", () => {
  it("在场的人 → 成功", () => {
    const result = inviteOutAction.handler(
      { target: "anon", activity: "去海边散步" },
      makeCtx(),
    );
    expect(result.success).not.toBe(false);
    expect(result.description).toContain("邀请");
    expect(result.description).toContain("海边散步");
    // 应该产生 social + happiness + relationship + inbox 效果
    expect(result.effects.length).toBeGreaterThan(3);
  });

  it("不在场的人 → 失败", () => {
    const result = inviteOutAction.handler(
      { target: "sakiko", activity: "去喝咖啡" },
      makeCtx({ nearbyCharacters: ["anon"] }),
    );
    expect(result.success).toBe(false);
  });
});

describe("share_secret", () => {
  it("在场的人 → 成功", () => {
    const result = shareSecretAction.handler(
      { target: "anon", secret: "其实我小时候把西瓜虫送给同学，把人家吓哭了" },
      makeCtx(),
    );
    expect(result.success).not.toBe(false);
    expect(result.description).toContain("心里话");
    // 应该产生 inbox 效果（秘密内容送到对方信箱）
    const inboxEffect = result.effects.find((e) => e.type === "inbox_message");
    expect(inboxEffect).toBeDefined();
    expect(inboxEffect!.message).toContain("西瓜虫");
  });

  it("不在场的人 → 失败", () => {
    const result = shareSecretAction.handler(
      { target: "sakiko", secret: "test" },
      makeCtx({ nearbyCharacters: ["anon"] }),
    );
    expect(result.success).toBe(false);
  });
});
