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
    world.addCharacter("alice", "Alice Chen", "home_alice");

    const alice = world.getCharacter("alice");
    expect(alice).toBeDefined();
    expect(alice!.name).toBe("Alice Chen");
    expect(alice!.locationId).toBe("home_alice");

    expect(world.getCharactersAtLocation("home_alice")).toContain("alice");
  });

  it("移动角色", () => {
    const world = createTestWorldWithCharacters();

    world.moveCharacter("alice", "cafe");

    expect(world.getCharacter("alice")!.locationId).toBe("cafe");
    expect(world.getCharactersAtLocation("home_alice")).not.toContain("alice");
    expect(world.getCharactersAtLocation("cafe")).toContain("alice");
  });

  it("移动到不存在的地点返回 false", () => {
    const world = createTestWorldWithCharacters();
    expect(world.moveCharacter("alice", "nonexistent")).toBe(false);
  });

  it("需求衰减", () => {
    const world = createTestWorldWithCharacters();
    const aliceBefore = { ...world.getCharacter("alice")!.needs };

    world.decayNeeds();

    const aliceAfter = world.getCharacter("alice")!.needs;
    expect(aliceAfter.hunger).toBe(aliceBefore.hunger - 2);
    expect(aliceAfter.energy).toBe(aliceBefore.energy - 0.5);
    expect(aliceAfter.social).toBe(aliceBefore.social - 1);
    expect(aliceAfter.happiness).toBe(aliceBefore.happiness); // 快乐不自动衰减
    expect(aliceAfter.hygiene).toBe(aliceBefore.hygiene - 0.5);
  });

  it("需求值不低于 0", () => {
    const world = new World(TEST_LOCATIONS);
    world.addCharacter("alice", "Alice", "home_alice", { hunger: 1 });

    world.decayNeeds();

    expect(world.getCharacter("alice")!.needs.hunger).toBe(0);
  });

  it("修改需求值", () => {
    const world = createTestWorldWithCharacters();
    world.modifyNeed("alice", "hunger", 50);

    // 初始 80 + 50 = 130 → clamp to 100
    expect(world.getCharacter("alice")!.needs.hunger).toBe(100);
  });

  it("getAllCharacters 返回所有角色", () => {
    const world = createTestWorldWithCharacters();
    expect(world.getAllCharacters()).toHaveLength(2);
  });

  it("信箱：发送和消费消息", () => {
    const world = createTestWorldWithCharacters();

    // 发送消息
    world.sendMessage("bob", { fromId: "alice", fromName: "Alice Chen", content: "你好！", tick: 10 });
    world.sendMessage("bob", { fromId: "alice", fromName: "Alice Chen", content: "在吗？", tick: 11 });

    // Bob 信箱有 2 条
    expect(world.getCharacter("bob")!.inbox).toHaveLength(2);

    // 消费信箱
    const messages = world.consumeInbox("bob");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("你好！");
    expect(messages[1]!.content).toBe("在吗？");

    // 消费后信箱为空
    expect(world.getCharacter("bob")!.inbox).toHaveLength(0);
    expect(world.consumeInbox("bob")).toHaveLength(0);
  });

  it("信箱：对不存在的角色发送不报错", () => {
    const world = createTestWorldWithCharacters();
    world.sendMessage("nobody", { fromId: "alice", fromName: "Alice", content: "test", tick: 1 });
    expect(world.consumeInbox("nobody")).toHaveLength(0);
  });
});
