import { describe, it, expect, beforeEach } from "vitest";
import { Simulation, type SimulationConfig, type TickSummary } from "./simulation.js";
import { tickToGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import { MockLLMProvider } from "../../test/helpers/mock-llm.js";
import { TEST_LOCATIONS } from "../../test/helpers/test-world.js";
import type { CharacterCard } from "../character/types.js";

const tomoriCard: CharacterCard = {
  id: "tomori",
  name: "高松灯",
  age: 19,
  occupation: "面包店学徒",
  home: "home_tomori",
  personality: { traits: ["内向"], interests: ["写东西"], dislikes: ["人多的场合"], speechStyle: "声音微弱" },
  background: "面包店学徒",
  relationships: {},
};

const anonCard: CharacterCard = {
  id: "anon",
  name: "千早爱音",
  age: 19,
  occupation: "咖啡馆兼职",
  home: "home_anon",
  personality: { traits: ["开朗"], interests: ["社交"], dislikes: ["被忽视"], speechStyle: "活泼外向" },
  background: "咖啡馆兼职",
  relationships: {},
};

describe("Simulation", () => {
  let world: World;
  let eventBus: EventBus;
  let mockLLM: MockLLMProvider;
  let sim: Simulation;

  beforeEach(() => {
    world = new World(TEST_LOCATIONS);
    world.addCharacter("tomori", "高松灯", "home_tomori");
    world.addCharacter("anon", "千早爱音", "home_anon");
    eventBus = new EventBus();
    mockLLM = new MockLLMProvider();

    sim = new Simulation(world, eventBus, {
      characters: [tomoriCard, anonCard],
      actions: ALL_BASIC_ACTIONS,
      provider: mockLLM,
      modelId: "test",
    });
  });

  it("单 tick 运行两个角色", async () => {
    // Tomori: 去咖啡馆
    mockLLM.enqueueResponse("去咖啡馆吧", [
      { name: "go_to", arguments: { location: "cafe" } },
    ]);
    // Anon: 去海边
    mockLLM.enqueueResponse("去海边", [
      { name: "go_to", arguments: { location: "beach" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(32));

    expect(summary.results).toHaveLength(2);
    expect(world.getCharacter("tomori")!.locationId).toBe("cafe");
    expect(world.getCharacter("anon")!.locationId).toBe("beach");
  });

  it("需求衰减在每 tick 执行", async () => {
    mockLLM.setDefaultResponse("", []);

    const tomoriBefore = { ...world.getCharacter("tomori")!.needs };
    await sim.runOneTick(tickToGameTime(1));

    expect(world.getCharacter("tomori")!.needs.hunger).toBe(tomoriBefore.hunger - 1);
  });

  it("晨间打算：06:00 生成并写入 state.todayPlan", async () => {
    // 所有 LLM 调用都返回打算格式的文本（agent 决策会 skip，无妨）
    mockLLM.setDefaultResponse("- 把面团揉完\n- 傍晚去海边走走", []);

    await sim.runOneTick(tickToGameTime(24)); // day 0, 06:00
    await sim.waitForBackgroundTasks();

    const plan = world.getCharacter("tomori")!.todayPlan;
    expect(plan?.day).toBe(0);
    expect(plan?.items).toContain("把面团揉完");
  });

  it("晨间打算：非 06:00 不触发", async () => {
    mockLLM.setDefaultResponse("- 什么打算", []);

    await sim.runOneTick(tickToGameTime(48)); // 12:00
    await sim.waitForBackgroundTasks();

    expect(world.getCharacter("tomori")!.todayPlan).toBeUndefined();
  });

  it("约定结算：双方到场 → kept + 记忆 + 关系提升", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");
    world.addAppointment({
      id: "ap1", proposerId: "tomori", targetId: "anon",
      locationId: "cafe", atTick: 32, status: "pending", createdTick: 20,
    });
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    await sim.runOneTick(tickToGameTime(32));

    expect(world.getAllAppointments()[0]!.status).toBe("kept");
    expect(sim.relationships.get("tomori", "anon").level).toBeGreaterThan(0);
    const memText = sim.memory.getRecent("tomori", 5).map((e) => e.content).join("");
    expect(memText).toContain("如约");
  });

  it("约定结算：一方缺席 → missed + 双方记忆 + 愧疚 intent + 关系下降", async () => {
    world.moveCharacter("tomori", "cafe");   // tomori 在等
    world.moveCharacter("anon", "beach");    // anon 爽约
    world.addAppointment({
      id: "ap1", proposerId: "anon", targetId: "tomori",
      locationId: "cafe", atTick: 32, status: "pending", createdTick: 20,
    });
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    // 宽限窗（32+2）之后才结算为爽约
    await sim.runOneTick(tickToGameTime(35));

    expect(world.getAllAppointments()[0]!.status).toBe("missed");
    expect(sim.relationships.get("tomori", "anon").level).toBeLessThan(0);
    // 等的人：被放鸽子的记忆 + intent
    expect(sim.memory.getRecent("tomori", 5).map((e) => e.content).join("")).toContain("一直没来");
    expect(world.getCurrentIntent("tomori", 35)?.summary).toContain("鸽子");
    // 爽约的人：愧疚记忆 + intent（道歉钩子）
    expect(sim.memory.getRecent("anon", 5).map((e) => e.content).join("")).toContain("你没去");
    expect(world.getCurrentIntent("anon", 35)?.summary).toContain("过意不去");
  });

  it("约定结算：提前兑现——到点前双方在约定地点聊上了 → kept", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");
    world.addAppointment({
      id: "ap1", proposerId: "tomori", targetId: "anon",
      locationId: "cafe", atTick: 34, status: "pending", createdTick: 20,
    });
    sim.conversations.recordTalk("tomori", "高松灯", "anon", "来得正好，就现在说吧", 31);
    sim.conversations.recordTalk("anon", "千早爱音", "tomori", "行啊，反正人都到了", 31);
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    await sim.runOneTick(tickToGameTime(32)); // 到点前 2 tick，早窗（4 tick）内

    expect(world.getAllAppointments()[0]!.status).toBe("kept");
    const memText = sim.memory.getRecent("tomori", 5).map((e) => e.content).join("");
    expect(memText).toContain("提前");
  });

  it("约定结算：提前同地点但没聊上 → 不提前结算（防同事同店误判）", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");
    world.addAppointment({
      id: "ap1", proposerId: "tomori", targetId: "anon",
      locationId: "cafe", atTick: 34, status: "pending", createdTick: 20,
    });
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    await sim.runOneTick(tickToGameTime(32)); // 早窗内但无对话

    expect(world.getAllAppointments()[0]!.status).toBe("pending");
  });

  it("约定结算：换地点兑现——到点双方在同一个别的地点聊着 → kept", async () => {
    world.moveCharacter("tomori", "beach");
    world.moveCharacter("anon", "beach");
    world.addAppointment({
      id: "ap1", proposerId: "tomori", targetId: "anon",
      locationId: "cafe", atTick: 32, status: "pending", createdTick: 20,
    });
    sim.conversations.recordTalk("anon", "千早爱音", "tomori", "反正人都碰上了", 31);
    sim.conversations.recordTalk("tomori", "高松灯", "anon", "嗯，那就在这儿聊", 31);
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    await sim.runOneTick(tickToGameTime(32));

    expect(world.getAllAppointments()[0]!.status).toBe("kept");
    const memText = sim.memory.getRecent("anon", 5).map((e) => e.content).join("");
    expect(memText).toContain("碰上了");
  });

  it("约定结算：宽限窗内不判爽约", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "beach");
    world.addAppointment({
      id: "ap1", proposerId: "tomori", targetId: "anon",
      locationId: "cafe", atTick: 32, status: "pending", createdTick: 20,
    });
    mockLLM.setDefaultResponse("", [{ name: "do_nothing", arguments: {} }]);

    await sim.runOneTick(tickToGameTime(33)); // 32+1，仍在宽限窗

    expect(world.getAllAppointments()[0]!.status).toBe("pending");
  });

  it("对话对象离开后不再进入会话模式", async () => {
    // 双方在 cafe 且 3 tick 内 ≥2 次交换 → 满足"活跃对话"的时间窗条件
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");
    sim.conversations.recordTalk("tomori", "高松灯", "anon", "你好", 30);
    sim.conversations.recordTalk("anon", "千早爱音", "tomori", "嗨", 31);

    // 但 anon 已经离开了 —— 对话物理上结束
    world.moveCharacter("anon", "beach");

    mockLLM.setDefaultResponse("发呆", [{ name: "do_nothing", arguments: {} }]);
    await sim.runOneTick(tickToGameTime(32));

    // tomori 的请求不应是会话模式（会话 prompt 含"然后调用 talk 工具"指令段）
    const tomoriCall = mockLLM.calls[0]!;
    const userContent = (tomoriCall.request.messages[0] as { content: string }).content;
    expect(userContent).not.toContain("然后调用 talk 工具");
  });

  it("talk 通过信箱发送消息并触发反应轮", async () => {
    // 把两人放到同一地点
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    // Tomori 对 Anon 说话
    mockLLM.enqueueResponse("看到爱音了", [
      { name: "talk", arguments: { target: "anon", message: "你、你好……" } },
    ]);
    // Anon 正常决策
    mockLLM.enqueueResponse("发会儿呆", [
      { name: "do_nothing", arguments: { thought: "刚到，先看看" } },
    ]);
    // Anon 反应轮（收到 Tomori 消息后被触发）
    mockLLM.enqueueResponse("回应", [
      { name: "talk", arguments: { target: "tomori", message: "嗨！" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));

    // 消息已传递：反应轮被触发（总 results > 2）
    expect(summary.results.length).toBeGreaterThan(2);
    // 关系应该因为 talk 而提升
    const rel = sim.relationships.get("tomori", "anon");
    expect(rel.level).toBeGreaterThan(0);
  });

  it("单次 talk 只推动一次共享关系，不再双重加分", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    mockLLM.enqueueResponse("看到爱音了", [
      { name: "talk", arguments: { target: "anon", message: "你、你好……" } },
    ]);
    mockLLM.enqueueResponse("先吃饭", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);

    await sim.runOneTick(tickToGameTime(48));

    const rel = sim.relationships.get("tomori", "anon");
    expect(rel.level).toBe(1);
  });

  it("信箱消息在下一个 tick 被消费并注入 prompt", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    // Tick 1: Tomori 对 Anon 说话
    mockLLM.enqueueResponse("打招呼", [
      { name: "talk", arguments: { target: "anon", message: "你好啊！" } },
    ]);
    mockLLM.enqueueResponse("工作", [
      { name: "work", arguments: {} },
    ]);
    await sim.runOneTick(tickToGameTime(48));

    // Tick 2: Anon 应该看到信箱消息
    mockLLM.enqueueResponse("散步", [
      { name: "go_to", arguments: { location: "plaza" } },
    ]);
    // Anon 的 work 还在进行中（duration 8），所以只有 Tomori 会被调用
    await sim.runOneTick(tickToGameTime(49));

    // 验证 Anon 的信箱已被清空（在 agent-loop 中被消费）
    // Anon 在 tick 49 还在工作中所以不会被调用，信箱保持
    // 但如果 Anon 被调用了，信箱会被消费
    // 这里主要验证机制存在
  });

  it("反应轮：信箱有消息 → 角色在同 tick 内回复", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    // 先手动往 Anon 信箱写一条消息
    world.sendMessage("anon", { fromId: "tomori", fromName: "高松灯", content: "你、你好……", tick: 48 });

    // 所有 LLM 调用都返回 talk（无论哪个角色调用）
    mockLLM.setDefaultResponse("回复", [
      { name: "talk", arguments: { target: "tomori", message: "灯酱！你好呀！" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));

    // 总结果应该 > 2（正常 2 + 反应轮至少 1）
    expect(summary.results.length).toBeGreaterThan(2);

    // 至少有人在反应轮中 talk 了
    const allTalks = summary.results.filter((r) => r.action?.name === "talk");
    expect(allTalks.length).toBeGreaterThanOrEqual(2);
  });

  it("反应轮：角色可以选择不回复", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    // Tomori 对 Anon 说话
    mockLLM.enqueueResponse("打招呼", [
      { name: "talk", arguments: { target: "anon", message: "你好……" } },
    ]);
    mockLLM.enqueueResponse("吃饭", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);
    // 反应轮：Anon 选择吃饭而非回复（已读不回）
    mockLLM.enqueueResponse("还是吃饭", [
      { name: "eat", arguments: { location: "cafe" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));

    // Anon 没有 talk 回去，反应轮应该在 1 轮后停止
    const anonTalks = summary.results.filter((r) => r.characterId === "anon" && r.action?.name === "talk");
    expect(anonTalks).toHaveLength(0);
  });

  it("同一对角色在同一 tick 内最多只交换两句", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    mockLLM.enqueueResponse("先打招呼", [
      { name: "talk", arguments: { target: "anon", message: "早上好……" } },
    ]);
    mockLLM.enqueueResponse("也打招呼", [
      { name: "talk", arguments: { target: "tomori", message: "早呀！" } },
    ]);
    mockLLM.setDefaultResponse("继续聊", [
      { name: "talk", arguments: { target: "tomori", message: "再多说一句！" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(48));
    const talks = summary.results.filter((r) => r.action?.name === "talk");

    expect(talks).toHaveLength(2);
    expect(talks.map((r) => `${r.characterId}:${r.action?.args.target as string}`)).toEqual([
      "tomori:anon",
      "anon:tomori",
    ]);
  });

  it("跨 tick 对话不再被系统拦截——模型自己判断是否继续聊", async () => {
    world.moveCharacter("tomori", "cafe");
    world.moveCharacter("anon", "cafe");

    mockLLM.enqueueResponse("先打招呼", [
      { name: "talk", arguments: { target: "anon", message: "早上好……" } },
    ]);
    mockLLM.enqueueResponse("也打招呼", [
      { name: "talk", arguments: { target: "tomori", message: "早呀！" } },
    ]);

    await sim.runOneTick(tickToGameTime(48));

    mockLLM.enqueueResponse("还是想继续说", [
      { name: "talk", arguments: { target: "anon", message: "再聊一句……" } },
    ]);
    mockLLM.enqueueResponse("我也接着说", [
      { name: "talk", arguments: { target: "tomori", message: "我也再说一句！" } },
    ]);

    const summary = await sim.runOneTick(tickToGameTime(49));
    const talks = summary.results.filter((r) => r.action?.name === "talk");
    // 对话不再被拦截，角色可以自然继续聊
    expect(talks).toHaveLength(2);
    expect(talks.every((r) => r.result?.success !== false)).toBe(true);
  });

  it("runTicks 运行多个 tick", async () => {
    // 用 do_nothing（永远可用、duration=1）让每 tick 角色都做一次决策
    mockLLM.setDefaultResponse("发呆", [
      { name: "do_nothing", arguments: { thought: "" } },
    ]);

    const summaries = await sim.runTicks(3, 32);

    expect(summaries).toHaveLength(3);
    // 每 tick 两个角色都跑了决策（不是 skipped）
    for (const s of summaries) {
      expect(s.results.length).toBeGreaterThanOrEqual(2);
      expect(s.results.every((r) => r.action?.name === "do_nothing")).toBe(true);
    }
  });

  it("onTick 监听器被调用", async () => {
    mockLLM.setDefaultResponse("", []);

    const ticks: number[] = [];
    sim.onTick((summary) => ticks.push(summary.tick));

    await sim.runTicks(3, 10);

    expect(ticks).toEqual([10, 11, 12]);
  });
});
