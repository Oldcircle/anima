/**
 * Economy — 简单经济系统
 *
 * 角色工作赚金币，在商店/酒吧/咖啡馆消费。
 */

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
