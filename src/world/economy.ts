/**
 * Economy — 经济系统
 *
 * 角色工作赚金币，在商店/酒吧/咖啡馆消费。
 * 深化（2026-07-04）：加入生计压力（每日开销/房租）、财务体感、破产后果、季节市场价格，
 * 让"赚钱活下去"真的有分量——钱不再是只涨不跌的数字。三位一体：可感知 + 有压力 + 看得见。
 */

import type { CharacterState, Season } from "./types.js";
import { getItemDef } from "./item-registry.js";
import { addMoodlet } from "./moodlets.js";

export interface ShopItem {
  id: string;
  name: string;
  price: number;
  category: "food" | "drink" | "gift" | "tool" | "seed";
}

export const SHOP_ITEMS: ShopItem[] = [
  { id: "sandwich", name: "三明治", price: 15, category: "food" },
  { id: "bread", name: "面包", price: 8, category: "food" },
  { id: "fish_soup", name: "鱼汤", price: 20, category: "food" },
  { id: "coffee", name: "咖啡", price: 10, category: "drink" },
  { id: "beer", name: "啤酒", price: 12, category: "drink" },
  { id: "tea", name: "茶", price: 5, category: "drink" },
  { id: "flower_bouquet", name: "花束", price: 30, category: "gift" },
  { id: "fresh_fish", name: "新鲜鱼", price: 25, category: "gift" },
  { id: "pastry", name: "糕点", price: 18, category: "gift" },
  { id: "book", name: "书", price: 35, category: "gift" },
];

/** 工作收入（每次 work 行为） */
export const WORK_INCOME: Record<string, number> = {
  "面包店学徒": 20,
  "咖啡馆店员": 22,
  "咖啡馆兼职": 15,
  "花店店主": 30,
  "图书馆管理员": 22,
  // 旧名兼容
  "花店老板": 30,
  "渔夫": 25,
  "面包店老板": 28,
  "杂货店老板": 20,
};

export function getWorkIncome(occupation: string): number {
  return WORK_INCOME[occupation] ?? 15;
}

/** 消费价格（eat/drink 行为的成本） */
export function getConsumptionCost(action: string, location: string): number {
  if (action === "eat") {
    if (location.includes("home")) return 0; // 在家吃不花钱
    return 15; // 在外吃
  }
  if (action === "drink") {
    if (location === "bar") return 12;
    return 8;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────
// 生计压力（Livelihood）—— 让钱有牙齿：每天都要为"活着"花钱
// ─────────────────────────────────────────────────────────────

/** 每日基础开销（房租 + 水电杂用） */
const BASE_UPKEEP = 12;

/** 每日开销：基础 + 收入的一部分（住得好、过得好 → 开销也高，累进而非人头税） */
export function dailyUpkeep(income: number | undefined): number {
  return Math.round(BASE_UPKEEP + (income ?? 15) * 0.35);
}

export interface UpkeepResult {
  cost: number;
  charged: number;
  shortfall: number;   // 没付清的部分（付不起时）
  paid: boolean;
}

/** 轻量记忆接口（避免和 ShortTermMemory 硬耦合；entry 用 any 规避类型协变问题） */
export interface MemorySink {
  add(characterId: string, entry: any): void;
}

/**
 * 每天扣一次生活开销。付得起就扣清；付不起就尽量付，缺口用"心里发慌"的压力表达
 * （不引入持久 debt 字段——用 moodlet + 记忆表达欠账，避免存档 schema 改动）。
 */
export function applyDailyUpkeep(state: CharacterState, tick: number, memory?: MemorySink): UpkeepResult {
  const cost = dailyUpkeep(state.life?.income);
  const charged = Math.min(state.gold, cost);
  const shortfall = cost - charged;
  state.gold = Math.max(0, state.gold - cost);
  if (shortfall > 0) {
    addMoodlet(state, "anxious", 3, "这个月的开销没付清，心里发慌", 48, "event", tick);
    memory?.add(state.id, {
      tick, type: "thought",
      content: `[生计] 手头紧，这次开销差了 ${shortfall} 金币没付上，得赶紧想办法挣钱。`,
      importance: 7,
    });
  }
  return { cost, charged, shortfall, paid: shortfall === 0 };
}

// ── 财务体感：相对"日开销"衡量（撑得了几天），而非绝对金额 ──

export type FinanceBand = "flush" | "comfortable" | "ok" | "tight" | "broke" | "destitute";

export function financeBand(gold: number, dailyCost: number): FinanceBand {
  const days = gold / Math.max(1, dailyCost);   // 手头的钱够撑几天
  if (days >= 20) return "flush";
  if (days >= 10) return "comfortable";
  if (days >= 5) return "ok";
  if (days >= 2) return "tight";
  if (days >= 0.5) return "broke";
  return "destitute";
}

const FINANCE_CN: Record<FinanceBand, string> = {
  flush: "宽裕", comfortable: "宽松", ok: "够用", tight: "手头紧", broke: "拮据", destitute: "揭不开锅",
};

/** 财务状态中文标签（前端/广播用），传 income 自动折算日开销 */
export function financeLabel(gold: number, income: number | undefined): string {
  return FINANCE_CN[financeBand(gold, dailyUpkeep(income))];
}

/** prompt 身体感受的财务一句话：只在偏紧时提醒，够用/宽裕不啰嗦 */
export function financeFeeling(gold: number, income: number | undefined): string {
  switch (financeBand(gold, dailyUpkeep(income))) {
    case "destitute": return `口袋快空了（${gold}金币），再不挣钱就要为下一顿发愁了。`;
    case "broke": return `手头很拮据（${gold}金币），这几天得省着花，最好多接点活。`;
    case "tight": return `手头有点紧（${gold}金币），花钱得掂量掂量。`;
    default: return "";
  }
}

/** 破产焦虑 moodlet（每 tick 检查，短时效，随情境刷新/过期） */
export function financeMoodlet(state: CharacterState, tick: number): void {
  const band = financeBand(state.gold, dailyUpkeep(state.life?.income));
  if (band === "destitute") addMoodlet(state, "anxious", 3, "身无分文，为钱发愁", 4, "need", tick);
  else if (band === "broke") addMoodlet(state, "anxious", 2, "手头拮据，心里有点为钱打鼓", 4, "need", tick);
}

// ── 季节市场价格：应季便宜、反季贵，给市场一点"活"的纹理 ──

/** ItemType → 季节 → 价格系数（缺省 1.0） */
const SEASON_PRICE_MULT: Record<string, Partial<Record<Season, number>>> = {
  consumable: { autumn: 0.82, winter: 1.22 },   // 秋收食物便宜、寒冬食物贵
  gift:       { spring: 0.88, winter: 1.15 },    // 春花礼便宜、冬季礼品俏
};

export function seasonalPriceMultiplier(itemType: string | undefined, season: Season): number {
  const row = itemType ? SEASON_PRICE_MULT[itemType] : undefined;
  return row?.[season] ?? 1.0;
}

/** 结合季节的到手价（最低 1 金币） */
export function effectivePrice(basePrice: number, itemId: string, season: Season): number {
  const type = getItemDef(itemId)?.type;
  return Math.max(1, Math.round(basePrice * seasonalPriceMultiplier(type, season)));
}
