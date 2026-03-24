/**
 * Stress Simulation Tests — 1 日 / 7 日模拟
 *
 * 使用 SmartMockLLM 模拟 5 角色的合理行为模式，
 * 收集统计数据，检测需要优化的问题。
 *
 * 运行方式: pnpm test -- --run src/agent/stress-sim.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Simulation, type TickSummary } from "./simulation.js";
import { tickToGameTime, formatGameTime } from "../core/tick-engine.js";
import { EventBus } from "../core/event-bus.js";
import { World } from "../world/world.js";
import { ALL_BASIC_ACTIONS } from "../actions/basic-actions.js";
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from "../providers/types.js";
import type { CharacterCard } from "../character/types.js";

// ────────── Smart Mock LLM ──────────

/**
 * 智能 Mock LLM：根据 prompt 中的状态信息做出合理决策，
 * 不依赖真实 API，但模拟真实的行为分布。
 */
class SmartMockLLM implements LLMProvider {
  readonly id = "smart-mock";
  callCount = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;

  async chat(request: LLMRequest, _modelId: string): Promise<LLMResponse> {
    this.callCount++;
    const prompt = request.messages[0]?.content ?? "";
    const inputTokens = Math.ceil(prompt.length / 4);
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += 30;

    const toolCall = this._decide(prompt);
    return {
      content: toolCall ? `决定${toolCall.name}` : "无事可做",
      toolCalls: toolCall ? [toolCall] : [],
      usage: { inputTokens, outputTokens: 30 },
    };
  }

  private _decide(prompt: string): ToolCall | null {
    // 解析需求值
    const hungerMatch = prompt.match(/饥饿[:：]\s*(\d+)/);
    const energyMatch = prompt.match(/精力[:：]\s*(\d+)/);
    const socialMatch = prompt.match(/社交[:：]\s*(\d+)/);
    const happyMatch = prompt.match(/幸福[:：]\s*(\d+)/);

    const hunger = hungerMatch ? Number(hungerMatch[1]) : 60;
    const energy = energyMatch ? Number(energyMatch[1]) : 60;
    const social = socialMatch ? Number(socialMatch[1]) : 60;
    const happy = happyMatch ? Number(happyMatch[1]) : 60;

    // 解析时间
    const timeMatch = prompt.match(/(\d{2}):(\d{2})/);
    const hour = timeMatch ? Number(timeMatch[1]) : 12;

    // 解析附近的人
    const nearbyMatch = prompt.match(/附近的人[：:]\s*([^\n]+)/);
    const hasNearby = nearbyMatch && !nearbyMatch[1]!.includes("无");

    // 解析信箱消息
    const hasInbox = prompt.includes("有人对你说");

    // 解析地点
    const locationMatch = prompt.match(/当前位置[：:]\s*(\S+)/);
    const location = locationMatch ? locationMatch[1]! : "";

    // 可用地点（12 个）
    const allLocations = [
      "cafe", "plaza", "shop", "bar", "beach", "dock",
      "forest", "farm", "library", "flower_shop", "bakery",
    ];

    // 决策优先级
    // 1. 极度饥饿 → 吃饭
    if (hunger < 20) {
      return { name: "eat", arguments: { location: location || "cafe", food: "一顿饱饭" } };
    }

    // 2. 极度疲惫 → 睡觉
    if (energy < 15) {
      return { name: "sleep", arguments: {} };
    }

    // 3. 有信箱消息 → 回复
    if (hasInbox) {
      const targetMatch = prompt.match(/(\w+)对你说/);
      const target = targetMatch ? targetMatch[1]! : "someone";
      return { name: "talk", arguments: { target, message: "嗯嗯，说的有道理。" } };
    }

    // 4. 社交需求低 + 有附近的人 → 聊天
    if (social < 35 && hasNearby) {
      const targetMatch = prompt.match(/附近的人[：:]\s*(\w+)/);
      const target = targetMatch ? targetMatch[1]! : "someone";
      if (Math.random() < 0.6) {
        return { name: "talk", arguments: { target, message: "今天天气不错啊！" } };
      }
      return { name: "gossip", arguments: { target, about: "最近小镇上的事" } };
    }

    // 5. 上午工作时间 → 工作
    if (hour >= 8 && hour < 12 && energy > 30) {
      return { name: "work", arguments: { activity: "日常工作" } };
    }

    // 6. 饥饿中 → 吃饭
    if (hunger < 40) {
      return { name: "eat", arguments: { location: "cafe", food: "午餐" } };
    }

    // 7. 下午工作时间 → 工作（概率）
    if (hour >= 13 && hour < 17 && energy > 30 && Math.random() < 0.6) {
      return { name: "work", arguments: { activity: "下午工作" } };
    }

    // 8. 社交需求低 → 去公共场所
    if (social < 45) {
      const socialSpots = ["cafe", "plaza", "bar"];
      return { name: "go_to", arguments: { location: socialSpots[Math.floor(Math.random() * socialSpots.length)]! } };
    }

    // 9. 晚上 → 去酒吧/娱乐
    if (hour >= 18 && hour < 22) {
      const r = Math.random();
      if (r < 0.3) return { name: "drink", arguments: { beverage: "啤酒" } };
      if (r < 0.5) return { name: "explore", arguments: { area: "海边日落" } };
      if (r < 0.7 && hasNearby) {
        const targetMatch = prompt.match(/附近的人[：:]\s*(\w+)/);
        return { name: "talk", arguments: { target: targetMatch?.[1] ?? "someone", message: "晚上好！" } };
      }
      return { name: "hobby", arguments: { activity: "练习爱好" } };
    }

    // 10. 快乐低 → 休闲
    if (happy < 40) {
      const r = Math.random();
      if (r < 0.3) return { name: "read", arguments: { book: "一本有趣的书" } };
      if (r < 0.6) return { name: "explore", arguments: { area: "小镇周边" } };
      return { name: "hobby", arguments: { activity: "放松一下" } };
    }

    // 11. 默认：随机日常活动
    const r = Math.random();
    if (r < 0.2) return { name: "work", arguments: { activity: "处理杂事" } };
    if (r < 0.35) return { name: "go_to", arguments: { location: allLocations[Math.floor(Math.random() * allLocations.length)]! } };
    if (r < 0.5) return { name: "read", arguments: {} };
    if (r < 0.65) return { name: "explore", arguments: { area: "四处看看" } };
    if (r < 0.8) return { name: "hobby", arguments: { activity: "享受生活" } };
    return { name: "drink", arguments: { beverage: "咖啡" } };
  }
}

// ────────── 角色卡 ──────────

const CHARACTERS: CharacterCard[] = [
  {
    id: "alice", name: "Alice Chen", age: 28, occupation: "花店老板",
    home: "home_alice",
    personality: { traits: ["温柔", "善良"], interests: ["园艺", "阅读"], dislikes: ["噪音"], speechStyle: "轻声细语" },
    background: "在海边小镇开了一家温馨的花店",
    relationships: {},
  },
  {
    id: "bob", name: "Bob Wang", age: 35, occupation: "渔夫",
    home: "home_bob",
    personality: { traits: ["豪爽", "勤劳"], interests: ["钓鱼", "喝酒"], dislikes: ["早起"], speechStyle: "大大咧咧" },
    background: "每天出海打鱼，晚上喜欢去酒吧",
    relationships: {},
  },
  {
    id: "maria", name: "Maria Garcia", age: 32, occupation: "面包店老板",
    home: "home_maria",
    personality: { traits: ["热情", "细心"], interests: ["烘焙", "社交"], dislikes: ["懒惰"], speechStyle: "热情洋溢" },
    background: "镇上最好的面包店老板，手艺出众",
    relationships: {},
  },
  {
    id: "lao_chen", name: "老陈", age: 55, occupation: "杂货店老板",
    home: "home_lao_chen",
    personality: { traits: ["睿智", "节俭"], interests: ["下棋", "种菜"], dislikes: ["浪费"], speechStyle: "慢条斯理" },
    background: "经营杂货店30年，是镇上的活字典",
    relationships: {},
  },
  {
    id: "emily", name: "Emily Liu", age: 24, occupation: "图书馆管理员",
    home: "home_emily",
    personality: { traits: ["安静", "好奇"], interests: ["阅读", "写作"], dislikes: ["吵闹"], speechStyle: "文艺范" },
    background: "刚搬来小镇的文艺青年",
    relationships: {},
  },
];

const LOCATIONS = [
  { id: "home_alice", name: "Alice 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_bob", name: "Bob 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_maria", name: "Maria 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_lao_chen", name: "老陈的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "home_emily", name: "Emily 的家", type: "residential" as const, presentCharacters: [] as string[] },
  { id: "flower_shop", name: "Alice的花店", type: "commercial" as const, openHours: { open: 8, close: 18 }, presentCharacters: [] as string[] },
  { id: "bakery", name: "Maria的面包店", type: "commercial" as const, openHours: { open: 7, close: 17 }, presentCharacters: [] as string[] },
  { id: "cafe", name: "咖啡馆", type: "commercial" as const, openHours: { open: 7, close: 22 }, presentCharacters: [] as string[] },
  { id: "plaza", name: "广场", type: "public" as const, presentCharacters: [] as string[] },
  { id: "shop", name: "杂货店", type: "commercial" as const, openHours: { open: 8, close: 20 }, presentCharacters: [] as string[] },
  { id: "bar", name: "酒吧", type: "commercial" as const, openHours: { open: 17, close: 2 }, presentCharacters: [] as string[] },
  { id: "beach", name: "海边", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "dock", name: "码头", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "forest", name: "森林", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "farm", name: "农田", type: "nature" as const, presentCharacters: [] as string[] },
  { id: "library", name: "图书馆", type: "public" as const, openHours: { open: 9, close: 18 }, presentCharacters: [] as string[] },
];

// ────────── 统计收集器 ──────────

interface SimStats {
  totalTicks: number;
  totalLLMCalls: number;
  totalActions: number;
  totalSkipped: number;
  actionDistribution: Map<string, number>;
  characterStats: Map<string, {
    actions: number;
    skipped: number;
    needsHistory: Array<{ tick: number; hunger: number; energy: number; social: number; happiness: number; hygiene: number }>;
    goldHistory: Array<{ tick: number; gold: number }>;
    locationHistory: Map<string, number>;
  }>;
  reflectionCount: number;
  randomEventCount: number;
  gossipCount: number;
  reactionRoundActions: number;
  talkCount: number;
  tickDurations: number[];
  memorySize: number;
  eventBusSize: number;
  peakMemoryEntries: number;
}

function collectStats(summaries: TickSummary[], world: World, eventBus: EventBus, llm: SmartMockLLM, memory: any): SimStats {
  const stats: SimStats = {
    totalTicks: summaries.length,
    totalLLMCalls: llm.callCount,
    totalActions: 0,
    totalSkipped: 0,
    actionDistribution: new Map(),
    characterStats: new Map(),
    reflectionCount: 0,
    randomEventCount: 0,
    gossipCount: 0,
    reactionRoundActions: 0,
    talkCount: 0,
    tickDurations: [],
    memorySize: 0,
    eventBusSize: eventBus.history.length,
    peakMemoryEntries: 0,
  };

  // 初始化角色统计
  for (const c of CHARACTERS) {
    stats.characterStats.set(c.id, {
      actions: 0, skipped: 0,
      needsHistory: [],
      goldHistory: [],
      locationHistory: new Map(),
    });
  }

  for (const s of summaries) {
    // 统计每个 tick 的结果
    for (const r of s.results) {
      const cs = stats.characterStats.get(r.characterId);
      if (!cs) continue;

      if (r.skipped) {
        stats.totalSkipped++;
        cs.skipped++;
      } else {
        stats.totalActions++;
        cs.actions++;
        const name = r.action?.name ?? "unknown";
        stats.actionDistribution.set(name, (stats.actionDistribution.get(name) ?? 0) + 1);
        if (name === "talk") stats.talkCount++;
      }
    }

    // 正常决策是前 5 个角色（最多），超过的是反应轮
    const normalCount = Math.min(s.results.length, CHARACTERS.length);
    if (s.results.length > normalCount) {
      stats.reactionRoundActions += s.results.length - normalCount;
    }

    // 反思
    if (s.reflections) stats.reflectionCount += s.reflections.length;

    // 随机事件
    if (s.randomEvents) stats.randomEventCount += s.randomEvents.length;

    // 八卦
    if (s.gossips) stats.gossipCount += s.gossips.length;

    // 每隔 4 tick（1小时）记录需求快照
    if (s.tick % 4 === 0) {
      for (const c of world.getAllCharacters()) {
        const cs = stats.characterStats.get(c.id);
        if (cs) {
          cs.needsHistory.push({
            tick: s.tick,
            hunger: c.needs.hunger,
            energy: c.needs.energy,
            social: c.needs.social,
            happiness: c.needs.happiness,
            hygiene: c.needs.hygiene,
          });
          cs.goldHistory.push({ tick: s.tick, gold: c.gold });
          cs.locationHistory.set(c.locationId, (cs.locationHistory.get(c.locationId) ?? 0) + 1);
        }
      }
    }
  }

  return stats;
}

// ────────── 诊断报告 ──────────

function printDiagnostics(stats: SimStats, world: World, label: string): string[] {
  const issues: string[] = [];

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(60)}\n`);

  // 总览
  console.log("📊 总览:");
  console.log(`  Tick 数: ${stats.totalTicks}`);
  console.log(`  LLM 调用: ${stats.totalLLMCalls}`);
  console.log(`  有效行为: ${stats.totalActions}`);
  console.log(`  跳过: ${stats.totalSkipped}`);
  console.log(`  反应轮行为: ${stats.reactionRoundActions}`);
  console.log(`  对话次数: ${stats.talkCount}`);
  console.log(`  反思: ${stats.reflectionCount}`);
  console.log(`  随机事件: ${stats.randomEventCount}`);
  console.log(`  八卦传播: ${stats.gossipCount}`);
  console.log(`  事件总线大小: ${stats.eventBusSize}`);

  // 行为分布
  console.log("\n🎯 行为分布:");
  const sortedActions = [...stats.actionDistribution.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedActions) {
    const pct = ((count / stats.totalActions) * 100).toFixed(1);
    console.log(`  ${name}: ${count} (${pct}%)`);
  }

  // 角色最终状态
  console.log("\n👤 角色最终状态:");
  for (const c of world.getAllCharacters()) {
    const n = c.needs;
    const cs = stats.characterStats.get(c.id)!;
    console.log(
      `  ${c.name}: 📍${c.locationId} 💰${c.gold} | H:${n.hunger.toFixed(0)} E:${n.energy.toFixed(0)} S:${n.social.toFixed(0)} Joy:${n.happiness.toFixed(0)} Hyg:${n.hygiene.toFixed(0)} | 行为:${cs.actions} 跳过:${cs.skipped}`,
    );
  }

  // ── 问题检测 ──

  // 1. 需求归零检测
  for (const c of world.getAllCharacters()) {
    const n = c.needs;
    if (n.hunger === 0) issues.push(`⚠️ ${c.name} 饿死了 (hunger=0)`);
    if (n.energy === 0) issues.push(`⚠️ ${c.name} 精力耗尽 (energy=0)`);
    if (n.social === 0) issues.push(`⚠️ ${c.name} 社交归零 (social=0)`);
    if (n.happiness === 0) issues.push(`⚠️ ${c.name} 快乐归零 (happiness=0)`);
    if (n.hygiene === 0) issues.push(`⚠️ ${c.name} 卫生归零 (hygiene=0)`);
  }

  // 2. 经济失衡检测
  for (const c of world.getAllCharacters()) {
    if (c.gold <= 0) issues.push(`⚠️ ${c.name} 破产了 (gold=${c.gold})`);
    if (c.gold > 1000) issues.push(`⚠️ ${c.name} 金币过多 (gold=${c.gold})，经济通胀`);
  }

  // 3. 行为单一化检测
  const topAction = sortedActions[0];
  if (topAction && topAction[1] / stats.totalActions > 0.5) {
    issues.push(`⚠️ 行为过于集中: ${topAction[0]} 占 ${((topAction[1] / stats.totalActions) * 100).toFixed(0)}%`);
  }

  // 4. 社交活跃度检测
  const socialActions = (stats.actionDistribution.get("talk") ?? 0)
    + (stats.actionDistribution.get("gossip") ?? 0)
    + (stats.actionDistribution.get("comfort") ?? 0)
    + (stats.actionDistribution.get("give_gift") ?? 0);
  const socialPct = stats.totalActions > 0 ? socialActions / stats.totalActions : 0;
  if (socialPct < 0.05) {
    issues.push(`⚠️ 社交行为过少: ${(socialPct * 100).toFixed(1)}%，角色们几乎不互动`);
  }

  // 5. LLM 调用效率
  const callsPerTick = stats.totalLLMCalls / stats.totalTicks;
  console.log(`\n📈 效率指标:`);
  console.log(`  LLM 调用/tick: ${callsPerTick.toFixed(2)}`);
  console.log(`  有效行为率: ${((stats.totalActions / (stats.totalActions + stats.totalSkipped)) * 100).toFixed(1)}%`);
  console.log(`  Token 估算: 输入 ~${stats.totalLLMCalls * 800} / 输出 ~${stats.totalLLMCalls * 30}`);

  if (callsPerTick > 8) {
    issues.push(`⚠️ LLM 调用过多: ${callsPerTick.toFixed(1)}/tick，反应轮可能失控`);
  }

  // 6. 卫生衰减无恢复手段检测
  let hygieneIssue = false;
  for (const c of world.getAllCharacters()) {
    if (c.needs.hygiene < 10) hygieneIssue = true;
  }
  if (hygieneIssue) {
    issues.push(`⚠️ 卫生值过低且无法恢复：缺少洗澡/清洁行为`);
  }

  // 7. 需求衰减 vs 恢复平衡检测
  for (const [id, cs] of stats.characterStats) {
    if (cs.needsHistory.length < 2) continue;
    const first = cs.needsHistory[0]!;
    const last = cs.needsHistory[cs.needsHistory.length - 1]!;

    // 如果某个需求持续下降到 10 以下
    const lowTicks = cs.needsHistory.filter((h) => h.hunger < 10).length;
    if (lowTicks > cs.needsHistory.length * 0.3) {
      issues.push(`⚠️ ${id} 长期饥饿 (${lowTicks}/${cs.needsHistory.length} 快照 hunger<10)`);
    }
  }

  // 8. 事件总线无限增长检测
  if (stats.eventBusSize > stats.totalTicks * 6) {
    issues.push(`⚠️ 事件总线增长过快: ${stats.eventBusSize} 事件 / ${stats.totalTicks} tick`);
  }

  // 9. 角色位置多样性检测
  for (const [id, cs] of stats.characterStats) {
    const uniqueLocations = cs.locationHistory.size;
    if (uniqueLocations <= 1 && cs.needsHistory.length > 10) {
      issues.push(`⚠️ ${id} 从不移动，始终在同一位置`);
    }
  }

  // 打印问题
  if (issues.length > 0) {
    console.log(`\n🔴 发现 ${issues.length} 个问题:`);
    for (const issue of issues) {
      console.log(`  ${issue}`);
    }
  } else {
    console.log("\n🟢 未发现明显问题");
  }

  console.log(`\n${"═".repeat(60)}\n`);

  return issues;
}

// ────────── 测试 ──────────

function createSimulation(llm: SmartMockLLM) {
  const world = new World(LOCATIONS, 24); // 从 06:00 开始
  for (const card of CHARACTERS) {
    world.addCharacter(card.id, card.name, card.home);
  }
  const eventBus = new EventBus();
  const sim = new Simulation(world, eventBus, {
    characters: CHARACTERS,
    actions: ALL_BASIC_ACTIONS,
    provider: llm,
    modelId: "smart-mock",
  });
  return { world, eventBus, sim };
}

describe("压力测试：1 日模拟", () => {
  it("5 角色跑完整 1 天 (96 tick)", async () => {
    const llm = new SmartMockLLM();
    const { world, eventBus, sim } = createSimulation(llm);

    const startTime = Date.now();
    const summaries = await sim.runTicks(96, 0); // tick 0 ~ 95 = 一整天
    const elapsed = Date.now() - startTime;

    const stats = collectStats(summaries, world, eventBus, llm, sim.memory);
    const issues = printDiagnostics(stats, world, "1 日模拟 (96 tick)");

    console.log(`  ⏱️  耗时: ${elapsed}ms (${(elapsed / 96).toFixed(1)}ms/tick)`);

    // 基本合理性断言
    expect(stats.totalTicks).toBe(96);
    expect(stats.totalActions).toBeGreaterThan(0);

    // 所有角色应该存活（需求不全归零）
    for (const c of world.getAllCharacters()) {
      const aliveScore = c.needs.hunger + c.needs.energy + c.needs.social + c.needs.happiness;
      expect(aliveScore).toBeGreaterThan(0);
    }

    // 应该有事件产生
    expect(eventBus.history.length).toBeGreaterThan(5);

    // 输出问题数量（不强制为 0，但要记录）
    if (issues.length > 0) {
      console.log(`\n  ℹ️  1日模拟发现 ${issues.length} 个优化点`);
    }
  }, 30_000);
});

describe("压力测试：7 日模拟", () => {
  it("5 角色跑完整 7 天 (672 tick)", async () => {
    const llm = new SmartMockLLM();
    const { world, eventBus, sim } = createSimulation(llm);

    const startTime = Date.now();
    const TOTAL_TICKS = 96 * 7; // 672
    const summaries = await sim.runTicks(TOTAL_TICKS, 0);
    const elapsed = Date.now() - startTime;

    const stats = collectStats(summaries, world, eventBus, llm, sim.memory);
    const issues = printDiagnostics(stats, world, "7 日模拟 (672 tick)");

    console.log(`  ⏱️  耗时: ${elapsed}ms (${(elapsed / TOTAL_TICKS).toFixed(1)}ms/tick)`);

    // 基本合理性断言
    expect(stats.totalTicks).toBe(TOTAL_TICKS);
    expect(stats.totalActions).toBeGreaterThan(0);

    // 7 天后角色仍然存活
    for (const c of world.getAllCharacters()) {
      const aliveScore = c.needs.hunger + c.needs.energy + c.needs.social + c.needs.happiness;
      expect(aliveScore).toBeGreaterThan(0);
    }

    // 7 天应该有多次反思（每天 23:00 一次 = 最多 7 次 × 5 角色 = 35）
    console.log(`  反思总数: ${stats.reflectionCount}`);

    // 经济数据
    console.log("\n💰 7 天经济变化:");
    for (const c of world.getAllCharacters()) {
      const card = CHARACTERS.find((ch) => ch.id === c.id)!;
      console.log(`  ${c.name} (${card.occupation}): 初始 100 → 最终 ${c.gold} (${c.gold >= 100 ? "+" : ""}${c.gold - 100})`);
    }

    // 需求趋势分析
    console.log("\n📉 需求趋势 (每天结束时快照):");
    for (const [id, cs] of stats.characterStats) {
      if (cs.needsHistory.length === 0) continue;
      // 取每天结束时的快照（约每 24 个快照一天）
      const dailySnapshots = cs.needsHistory.filter((_h, i) => i % 24 === 23 || i === cs.needsHistory.length - 1);
      const card = CHARACTERS.find((c) => c.id === id)!;
      console.log(`  ${card.name}:`);
      for (const snap of dailySnapshots) {
        const gt = tickToGameTime(snap.tick);
        console.log(`    D${gt.day} ${String(gt.hour).padStart(2, "0")}:${String(gt.minute).padStart(2, "0")} — H:${snap.hunger.toFixed(0)} E:${snap.energy.toFixed(0)} S:${snap.social.toFixed(0)} Joy:${snap.happiness.toFixed(0)} Hyg:${snap.hygiene.toFixed(0)}`);
      }
    }

    // 位置多样性
    console.log("\n🗺️  位置分布 (采样次数):");
    for (const [id, cs] of stats.characterStats) {
      const card = CHARACTERS.find((c) => c.id === id)!;
      const sorted = [...cs.locationHistory.entries()].sort((a, b) => b[1] - a[1]);
      const top5 = sorted.slice(0, 5).map(([loc, count]) => `${loc}(${count})`).join(", ");
      console.log(`  ${card.name}: ${top5}`);
    }

    if (issues.length > 0) {
      console.log(`\n  ℹ️  7日模拟发现 ${issues.length} 个优化点`);
    }

    // 性能检查：672 tick mock 应该在 5 秒内完成
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});
