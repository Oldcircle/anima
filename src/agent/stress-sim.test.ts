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
    const prompt = request.messages[request.messages.length - 1]?.content ?? "";
    const inputTokens = Math.ceil(prompt.length / 4);
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += 30;

    const available = (request.tools ?? []).map((t) => t.name);
    const toolCall = this._decide(prompt, available, request);
    return {
      content: toolCall ? `决定${toolCall.name}` : "无事可做",
      toolCalls: toolCall ? [toolCall] : [],
      usage: { inputTokens, outputTokens: 30 },
    };
  }

  /** 检查工具是否可用 */
  private _has(available: string[], name: string): boolean {
    return available.includes(name);
  }

  private _decide(prompt: string, available: string[], request: LLMRequest): ToolCall | null {
    if (available.length === 0) return null;

    // 解析需求感受（新系统使用自然语言描述，不再输出数值）
    const isHungry = prompt.includes("胃在抽痛") || prompt.includes("饿得") || prompt.includes("发晕");
    const isMildHungry = isHungry || (prompt.includes("肚子") && prompt.includes("饿"));
    const isTired = prompt.includes("站不稳") || prompt.includes("睁不开") || prompt.includes("眼皮很重");
    const isMildTired = isTired || prompt.includes("有点累") || prompt.includes("哈欠");
    const isLonely = prompt.includes("空荡荡") || prompt.includes("很想找人说说话") || prompt.includes("寂寞");
    const isBored = prompt.includes("闷得发慌") || prompt.includes("无聊");
    const isNight = prompt.includes("深夜") || prompt.includes("正常人都已经睡了");
    const needsBathroom = prompt.includes("憋不住") || prompt.includes("憋得");

    // 解析时间
    const timeMatch = prompt.match(/(\d{2}):(\d{2})/);
    const hour = timeMatch ? Number(timeMatch[1]) : 12;

    // 解析附近的人
    const hasNearby = prompt.includes("你现在看见了谁");
    const hasInbox = prompt.includes("## 有人对你说");

    // 可用地点
    const allLocations = ["cafe", "plaza", "shop", "bar", "beach", "dock", "forest", "farm", "library", "flower_shop", "bakery"];

    // 从 eat 描述中提取第一个食物名称
    const eatItem = this._parseEatItem(request);
    // 从 prompt 中提取角色的 home
    const homeMatch = prompt.match(/家——/);
    const homeLocMatch = prompt.match(/(\w+_\w+):\s*家/);
    const homeLoc = homeLocMatch?.[1] ?? "home_tomori";

    // 决策优先级（只选可用的工具）

    // 从 buy 描述中也提取物品
    const buyItem = this._parseBuyItem(request);

    // 1. 极度饥饿 → 吃饭（或去能吃的地方）
    if (isHungry) {
      if (this._has(available, "eat") && eatItem) return { name: "eat", arguments: { item: eatItem } };
      if (this._has(available, "cook")) return { name: "cook", arguments: {} };
      if (this._has(available, "buy") && buyItem) return { name: "buy", arguments: { item: buyItem } };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: "shop" } };
    }

    // 2. 上厕所
    if (needsBathroom) {
      if (this._has(available, "use_toilet")) return { name: "use_toilet", arguments: {} };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: homeLoc } };
    }

    // 3. 极度疲惫或深夜 → 睡觉
    if (isTired || isNight) {
      if (this._has(available, "sleep")) return { name: "sleep", arguments: {} };
      if (this._has(available, "rest")) return { name: "rest", arguments: {} };
      if (this._has(available, "nap")) return { name: "nap", arguments: {} };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: homeLoc } };
    }

    // 4. 有信箱消息 → 回复
    if (hasInbox && this._has(available, "talk")) {
      const idMatch = prompt.match(/ID:(\w+)/);
      return { name: "talk", arguments: { target: idMatch?.[1] ?? "someone", message: "嗯嗯，说的有道理。" } };
    }

    // 5. 社交需求低 + 有附近的人 → 聊天
    if (isLonely && hasNearby && this._has(available, "talk")) {
      const idMatch = prompt.match(/ID:(\w+)/);
      return { name: "talk", arguments: { target: idMatch?.[1] ?? "someone", message: "今天天气不错啊！" } };
    }

    // 6. 上午工作时间 → 员工工具
    const workerTools = ["serve_customer", "make_coffee", "bake", "knead_dough", "shelve_books", "help_reader", "arrange_flowers", "clean_table"];
    if (hour >= 8 && hour < 12 && !isMildTired) {
      const wt = available.filter(t => workerTools.includes(t));
      if (wt.length > 0) return { name: wt[Math.floor(Math.random() * wt.length)]!, arguments: {} };
    }

    // 7. 轻微饥饿 → 吃饭
    if (isMildHungry) {
      if (this._has(available, "eat") && eatItem) return { name: "eat", arguments: { item: eatItem } };
      if (this._has(available, "cook")) return { name: "cook", arguments: {} };
      if (this._has(available, "buy") && buyItem) return { name: "buy", arguments: { item: buyItem } };
      if (this._has(available, "go_to")) return { name: "go_to", arguments: { location: "shop" } };
    }

    // 8. 下午工作
    if (hour >= 13 && hour < 17 && !isMildTired && Math.random() < 0.6) {
      const wt = available.filter(t => workerTools.includes(t));
      if (wt.length > 0) return { name: wt[Math.floor(Math.random() * wt.length)]!, arguments: {} };
    }

    // 9. 社交需求低 → 去公共场所
    if (isLonely && this._has(available, "go_to")) {
      const socialSpots = ["cafe", "plaza", "bar"];
      return { name: "go_to", arguments: { location: socialSpots[Math.floor(Math.random() * socialSpots.length)]! } };
    }

    // 10. 晚上 → 休闲
    if (hour >= 18 && hour < 22) {
      if (this._has(available, "explore") && Math.random() < 0.4) return { name: "explore", arguments: {} };
      if (this._has(available, "read") && Math.random() < 0.4) return { name: "read", arguments: {} };
      if (hasNearby && this._has(available, "talk")) {
        const idMatch = prompt.match(/ID:(\w+)/);
        return { name: "talk", arguments: { target: idMatch?.[1] ?? "someone", message: "晚上好！" } };
      }
    }

    // 11. 无聊 → 休闲
    if (isBored) {
      if (this._has(available, "read")) return { name: "read", arguments: {} };
      if (this._has(available, "explore")) return { name: "explore", arguments: {} };
      if (this._has(available, "rest")) return { name: "rest", arguments: {} };
    }

    // 12. 默认：从可用工具中选择合理的（排除需要参数的）
    const needsArgs = new Set(["eat", "buy", "give", "talk", "comfort", "argue", "prepare"]);
    const localTools = available.filter((t) => t !== "go_to" && !needsArgs.has(t));
    if (localTools.length > 0 && Math.random() < 0.6) {
      const tool = localTools[Math.floor(Math.random() * localTools.length)]!;
      return { name: tool, arguments: {} };
    }

    // 13. 去别的地方
    if (this._has(available, "go_to")) {
      return { name: "go_to", arguments: { location: allLocations[Math.floor(Math.random() * allLocations.length)]! } };
    }

    // 14. 兜底：idle
    if (this._has(available, "idle")) return { name: "idle", arguments: {} };
    return { name: available[0]!, arguments: {} };
  }

  /** 从 eat 工具的描述中提取第一个食物名称 */
  private _parseEatItem(request: LLMRequest): string | undefined {
    const eatTool = request.tools?.find(t => t.name === "eat");
    if (!eatTool) return undefined;
    // 描述格式："吃点东西。你身上有：红豆面包（免费）。店里有：三明治（12金币）"
    // 或者 "吃点东西。店里有：白面包（5金币）、红豆面包（8金币）"
    const match = eatTool.description.match(/(?:你身上有|店里有)：([^（(，、]+)/);
    return match?.[1]?.trim();
  }

  /** 从 buy 工具的描述中提取第一个物品名称 */
  private _parseBuyItem(request: LLMRequest): string | undefined {
    const buyTool = request.tools?.find(t => t.name === "buy");
    if (!buyTool) return undefined;
    const match = buyTool.description.match(/店里有：([^（(，、]+)/);
    return match?.[1]?.trim();
  }
}

// ────────── 角色卡 ──────────

const CHARACTERS: CharacterCard[] = [
  {
    id: "tomori", name: "高松灯", age: 19, occupation: "面包店学徒",
    home: "home_tomori",
    personality: { traits: ["内向", "纯真"], interests: ["写东西", "捡石头"], dislikes: ["人多的场合"], speechStyle: "声音微弱，断断续续" },
    background: "从城市来的安静女孩，在面包店当学徒",
    life: { occupation: "面包店学徒", workplace: "bakery", age: 19, income: 8, skills: { baking: 1 }, aspiration: "找到能理解我的人" },
    relationships: {},
  },
  {
    id: "anon", name: "千早爱音", age: 20, occupation: "咖啡馆店员",
    home: "home_anon",
    personality: { traits: ["开朗", "察言观色"], interests: ["社交", "逛街"], dislikes: ["被忽视"], speechStyle: "活泼外向" },
    background: "从东京转来的社交达人，在咖啡馆兼职",
    life: { occupation: "咖啡馆店员", workplace: "cafe", age: 20, income: 12, skills: { social: 4 }, aspiration: "被真正地喜欢" },
    relationships: {},
  },
  {
    id: "sakiko", name: "丰川祥子", age: 19, occupation: "咖啡馆兼职",
    home: "home_sakiko",
    personality: { traits: ["优雅", "倔强"], interests: ["钢琴", "阅读"], dislikes: ["同情"], speechStyle: "礼貌但有距离感" },
    background: "前大小姐，家族破产后在咖啡馆兼职",
    life: { occupation: "咖啡馆兼职", workplace: "cafe", age: 19, income: 10, skills: { piano: 7 }, aspiration: "靠自己的力量站住脚" },
    relationships: {},
  },
  {
    id: "mutsumi", name: "若叶睦", age: 21, occupation: "花店店主",
    home: "home_mutsumi",
    personality: { traits: ["温和", "包容"], interests: ["吉他", "做饭"], dislikes: ["争吵"], speechStyle: "温柔平稳" },
    background: "花店店主，沉默寡言但内心细腻",
    life: { occupation: "花店店主", workplace: "flower_shop", age: 21, income: 18, skills: { botany: 5 }, aspiration: "找到表达真实自己的方式" },
    relationships: {},
  },
  {
    id: "soyo", name: "长崎素世", age: 20, occupation: "图书馆管理员",
    home: "home_soyo",
    personality: { traits: ["体贴", "执着"], interests: ["阅读", "钢琴"], dislikes: ["被欺骗"], speechStyle: "温柔有礼" },
    background: "看起来温柔体贴，内心有着强烈的执念",
    life: { occupation: "图书馆管理员", workplace: "library", age: 20, income: 14, skills: { social: 3 }, aspiration: "成为不可或缺的人" },
    relationships: {},
  },
];

// 共通工具定义（适配新系统：shop 代替旧 eat/drink，worker_tools 代替旧 work）
const HOME_TOOLS = [
  { name: "sleep", description: "睡觉休息", effects: { energy: 100 }, duration: 32, condition: "energy < 80" },
  { name: "wash", description: "洗澡梳洗", effects: { hygiene: 100 }, duration: 2, condition: "hygiene < 70" },
  { name: "use_toilet", description: "上厕所", effects: { bladder: 100 }, duration: 1, condition: "bladder < 70" },
  { name: "nap", description: "小睡", effects: { energy: 25, fun: -5 }, duration: 4, condition: "energy < 60" },
];
const NATURE_TOOLS = [
  { name: "explore", description: "在自然中漫步", effects: { fun: 15, energy: -5 } },
  { name: "swim", description: "游泳", effects: { fun: 25, energy: -10, hygiene: -15 }, duration: 3 },
];

type TestLoc = { id: string; name: string; type: string; presentCharacters: string[]; tools: any[]; shop?: any[]; workerTools?: any[] };
const LOCATIONS: TestLoc[] = [
  { id: "home_tomori", name: "灯的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "home_anon", name: "爱音的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "home_sakiko", name: "祥子的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "home_mutsumi", name: "睦的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "home_soyo", name: "素世的家", type: "residential", presentCharacters: [], tools: HOME_TOOLS },
  { id: "flower_shop", name: "潮声花店", type: "commercial", openHours: { open: 8, close: 18 }, presentCharacters: [], tools: [],
    shop: [{ id: "flower_bouquet", name: "花束", price: 15 }],
    workerTools: [
      { name: "arrange_flowers", description: "整理花束", effects: { energy: -2, fun: 2 }, income: 1 },
      { name: "serve_customer", description: "招呼客人", effects: { energy: -2, social: 3 }, income: 3 },
    ],
  },
  { id: "bakery", name: "海风面包坊", type: "commercial", openHours: { open: 7, close: 17 }, presentCharacters: [], tools: [],
    shop: [{ id: "bread_plain", name: "白面包", price: 5 }, { id: "bread_red_bean", name: "红豆面包", price: 8 }],
    workerTools: [
      { name: "knead_dough", description: "揉面团", effects: { energy: -3, fun: -1 }, duration: 2 },
      { name: "bake", description: "烤面包", effects: { energy: -2 }, duration: 3, income: 2 },
      { name: "serve_customer", description: "招呼客人", effects: { energy: -2, social: 3 }, income: 3 },
    ],
  },
  { id: "cafe", name: "咖啡馆", type: "commercial", openHours: { open: 7, close: 22 }, presentCharacters: [],
    tools: [{ name: "use_toilet", description: "上厕所", effects: { bladder: 100 }, duration: 1, condition: "bladder < 70" }],
    shop: [{ id: "coffee_latte", name: "拿铁", price: 8 }, { id: "sandwich", name: "三明治", price: 12 }],
    workerTools: [
      { name: "make_coffee", description: "做咖啡", effects: { energy: -2, fun: 1 }, income: 2 },
      { name: "serve_customer", description: "招呼客人", effects: { energy: -3, social: 2 }, income: 3 },
      { name: "clean_table", description: "擦桌子", effects: { energy: -2, fun: -3 } },
    ],
  },
  { id: "plaza", name: "广场", type: "public", presentCharacters: [], tools: [
    { name: "walk", description: "散步", effects: { fun: 5, energy: -2 } },
    { name: "rest", description: "在长椅上歇会儿", effects: { energy: 5, fun: -2 } },
  ] },
  { id: "shop", name: "杂货店", type: "commercial", openHours: { open: 8, close: 20 }, presentCharacters: [], tools: [],
    shop: [{ id: "ingredients", name: "食材", price: 5 }, { id: "bento", name: "便当", price: 10 }, { id: "onigiri", name: "饭团", price: 5 }],
  },
  { id: "bar", name: "酒吧", type: "commercial", openHours: { open: 17, close: 2 }, presentCharacters: [],
    tools: [{ name: "use_toilet", description: "上厕所", effects: { bladder: 100 }, condition: "bladder < 70" }],
    shop: [{ id: "beer", name: "啤酒", price: 10 }, { id: "juice", name: "果汁", price: 6 }],
  },
  { id: "beach", name: "海边", type: "nature", presentCharacters: [], tools: NATURE_TOOLS },
  { id: "dock", name: "码头", type: "nature", presentCharacters: [], tools: [{ name: "explore", description: "看看船", effects: { fun: 5, energy: -2 } }] },
  { id: "forest", name: "森林", type: "nature", presentCharacters: [], tools: [{ name: "explore", description: "探索", effects: { fun: 10, energy: -3 } }] },
  { id: "farm", name: "农田", type: "nature", presentCharacters: [], tools: [{ name: "explore", description: "逛逛", effects: { fun: 5, energy: -2 } }] },
  { id: "library", name: "图书馆", type: "public", openHours: { open: 9, close: 18 }, presentCharacters: [],
    tools: [{ name: "read", description: "看书", effects: { fun: 20, energy: -5, social: -3 }, duration: 4 }],
    workerTools: [
      { name: "shelve_books", description: "整理书架", effects: { energy: -3, fun: -1 }, income: 1 },
      { name: "help_reader", description: "帮人找书", effects: { energy: -2, social: 3, fun: 1 }, income: 2 },
    ],
  },
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
    needsHistory: Array<{ tick: number; hunger: number; energy: number; social: number; fun: number; hygiene: number; bladder: number }>;
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
            fun: c.needs.fun,
            hygiene: c.needs.hygiene,
            bladder: c.needs.bladder,
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
      `  ${c.name}: 📍${c.locationId} 💰${c.gold} | H:${n.hunger.toFixed(0)} E:${n.energy.toFixed(0)} S:${n.social.toFixed(0)} Fun:${n.fun.toFixed(0)} Hyg:${n.hygiene.toFixed(0)} Bld:${n.bladder.toFixed(0)} | 行为:${cs.actions} 跳过:${cs.skipped}`,
    );
  }

  // ── 问题检测 ──

  // 1. 需求归零检测
  for (const c of world.getAllCharacters()) {
    const n = c.needs;
    if (n.hunger === 0) issues.push(`⚠️ ${c.name} 饿死了 (hunger=0)`);
    if (n.energy === 0) issues.push(`⚠️ ${c.name} 精力耗尽 (energy=0)`);
    if (n.social === 0) issues.push(`⚠️ ${c.name} 社交归零 (social=0)`);
    if (n.fun === 0) issues.push(`⚠️ ${c.name} 快乐归零 (fun=0)`);
    if (n.bladder === 0) issues.push(`⚠️ ${c.name} 膀胱归零 (bladder=0)`);
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

async function createSimulation(llm: SmartMockLLM) {
  const world = new World(LOCATIONS, 24); // 从 06:00 开始
  const { addToInventory } = await import("../world/item-registry.js");
  for (const card of CHARACTERS) {
    world.addCharacter(card.id, card.name, card.home, undefined, card.life, card.gender);
    const state = world.getCharacter(card.id)!;
    // 给每个角色初始食材和便当
    addToInventory(state.inventory, "ingredients", 20);
    addToInventory(state.inventory, "bento", 10);
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
    const { world, eventBus, sim } = await createSimulation(llm);

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
      const aliveScore = c.needs.hunger + c.needs.energy + c.needs.social + c.needs.fun;
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
    const { world, eventBus, sim } = await createSimulation(llm);

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

    // 7 天后至少有角色存活（部分需求可能归零，但不是全部）
    const aliveCount = world.getAllCharacters().filter(c => {
      const total = (c.needs.hunger ?? 0) + (c.needs.energy ?? 0) + (c.needs.social ?? 0) + (c.needs.fun ?? 0);
      return total > 0;
    }).length;
    expect(aliveCount).toBeGreaterThan(0);

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
        console.log(`    D${gt.day} ${String(gt.hour).padStart(2, "0")}:${String(gt.minute).padStart(2, "0")} — H:${snap.hunger.toFixed(0)} E:${snap.energy.toFixed(0)} S:${snap.social.toFixed(0)} Fun:${snap.fun.toFixed(0)} Hyg:${snap.hygiene.toFixed(0)} Bld:${snap.bladder.toFixed(0)}`);
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
