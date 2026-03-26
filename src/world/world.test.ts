import { describe, it, expect } from "vitest";
import { World } from "./world.js";
import { TEST_LOCATIONS, createTestWorldWithCharacters } from "../../test/helpers/test-world.js";

describe("World", () => {
  it("初始化地点", () => {
    const world = new World(TEST_LOCATIONS);
    expect(world.getAllLocations()).toHaveLength(TEST_LOCATIONS.length);
    expect(world.getLocation("cafe")?.name).toBe("咖啡馆");
  });

  it("添加角色到指定地点", () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");

    const tomori = world.getCharacter("tomori");
    expect(tomori).toBeDefined();
    expect(tomori!.name).toBe("高松灯");
    expect(tomori!.locationId).toBe("home_tomori");

    expect(world.getCharactersAtLocation("home_tomori")).toContain("tomori");
  });

  it("移动角色", () => {
    const world = createTestWorldWithCharacters();

    world.moveCharacter("tomori", "cafe");

    expect(world.getCharacter("tomori")!.locationId).toBe("cafe");
    expect(world.getCharactersAtLocation("home_tomori")).not.toContain("tomori");
    expect(world.getCharactersAtLocation("cafe")).toContain("tomori");
  });

  it("移动到不存在的地点返回 false", () => {
    const world = createTestWorldWithCharacters();
    expect(world.moveCharacter("tomori", "nonexistent")).toBe(false);
  });

  it("需求衰减", () => {
    const world = createTestWorldWithCharacters();
    const tomoriBefore = { ...world.getCharacter("tomori")!.needs };

    world.decayNeeds();

    const tomoriAfter = world.getCharacter("tomori")!.needs;
    expect(tomoriAfter.hunger).toBe(tomoriBefore.hunger - 2);
    expect(tomoriAfter.energy).toBe(tomoriBefore.energy - 1);
    expect(tomoriAfter.social).toBe(tomoriBefore.social - 1);
    expect(tomoriAfter.fun).toBe(tomoriBefore.fun - 1.5);
    expect(tomoriAfter.bladder).toBe(tomoriBefore.bladder - 1.5);
    expect(tomoriAfter.hygiene).toBe(tomoriBefore.hygiene - 0.5);
  });

  it("需求值不低于 0", () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "灯", "home_tomori", { hunger: 1 });

    world.decayNeeds();

    expect(world.getCharacter("tomori")!.needs.hunger).toBe(0);
  });

  it("修改需求值", () => {
    const world = createTestWorldWithCharacters();
    world.modifyNeed("tomori", "hunger", 50);

    // 初始 80 + 50 = 130 → clamp to 100
    expect(world.getCharacter("tomori")!.needs.hunger).toBe(100);
  });

  it("getAllCharacters 返回所有角色", () => {
    const world = createTestWorldWithCharacters();
    expect(world.getAllCharacters()).toHaveLength(2);
  });

  it("信箱：发送和消费消息", () => {
    const world = createTestWorldWithCharacters();

    // 发送消息
    world.sendMessage("anon", { fromId: "tomori", fromName: "高松灯", content: "你好！", tick: 10 });
    world.sendMessage("anon", { fromId: "tomori", fromName: "高松灯", content: "在吗？", tick: 11 });

    // Anon 信箱有 2 条
    expect(world.getCharacter("anon")!.inbox).toHaveLength(2);

    // 消费信箱
    const messages = world.consumeInbox("anon");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("你好！");
    expect(messages[1]!.content).toBe("在吗？");

    // 消费后信箱为空
    expect(world.getCharacter("anon")!.inbox).toHaveLength(0);
    expect(world.consumeInbox("anon")).toHaveLength(0);
  });

  it("信箱：对不存在的角色发送不报错", () => {
    const world = createTestWorldWithCharacters();
    world.sendMessage("nobody", { fromId: "tomori", fromName: "灯", content: "test", tick: 1 });
    expect(world.consumeInbox("nobody")).toHaveLength(0);
  });

  it("短期意图会设置并在过期后自动清除", () => {
    const world = createTestWorldWithCharacters();
    world.setIntent("tomori", {
      kind: "reply",
      source: "message",
      targetId: "anon",
      summary: "爱音刚刚跟你说了话。",
      createdTick: 10,
      expiresAt: 12,
    });

    expect(world.getCurrentIntent("tomori", 11)?.targetId).toBe("anon");
    expect(world.getCurrentIntent("tomori", 13)).toBeUndefined();
    expect(world.getCharacter("tomori")!.currentIntent).toBeUndefined();
  });
});
