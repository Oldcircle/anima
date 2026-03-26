/**
 * Item Registry — 物品定义注册表
 *
 * 管理所有物品定义。基础物品从代码中定义，
 * 后续可扩展为从 YAML 加载。
 */

import type { ItemDef, ItemInstance } from "./item-types.js";

// ─── 基础物品定义（按 6 类分组） ───

const CONSUMABLES: ItemDef[] = [
  // 面包店
  { id: "bread_plain", name: "白面包", type: "consumable", value: 5, stackable: true, effects: { hunger: 25 }, traits: ["food", "basic"] },
  { id: "bread_red_bean", name: "红豆面包", type: "consumable", value: 8, stackable: true, effects: { hunger: 35, fun: 3 }, traits: ["food", "sweet"] },
  { id: "croissant", name: "可颂", type: "consumable", value: 10, stackable: true, effects: { hunger: 30, fun: 5 }, traits: ["food", "pastry"] },
  // 咖啡馆
  { id: "coffee_latte", name: "拿铁", type: "consumable", value: 8, stackable: true, effects: { energy: 12, fun: 5, bladder: -15 }, traits: ["drink", "hot"] },
  { id: "coffee_americano", name: "美式咖啡", type: "consumable", value: 6, stackable: true, effects: { energy: 15, fun: 2, bladder: -15 }, traits: ["drink", "hot", "bitter"] },
  { id: "sandwich", name: "三明治", type: "consumable", value: 12, stackable: true, effects: { hunger: 40, fun: 3 }, traits: ["food"] },
  { id: "cake_slice", name: "蛋糕", type: "consumable", value: 15, stackable: true, effects: { hunger: 15, fun: 10 }, traits: ["food", "sweet", "treat"] },
  // 酒吧
  { id: "beer", name: "啤酒", type: "consumable", value: 10, stackable: true, effects: { fun: 15, social: 5, energy: -3, bladder: -20 }, traits: ["drink", "alcohol"] },
  { id: "juice", name: "果汁", type: "consumable", value: 6, stackable: true, effects: { hunger: 5, fun: 5, bladder: -10 }, traits: ["drink", "sweet"] },
  // 杂货店
  { id: "bento", name: "便当", type: "consumable", value: 10, stackable: true, effects: { hunger: 45, fun: 3 }, traits: ["food", "prepared"] },
  { id: "water_bottle", name: "矿泉水", type: "consumable", value: 3, stackable: true, effects: { energy: 3, bladder: -5 }, traits: ["drink", "basic"] },
  { id: "onigiri", name: "饭团", type: "consumable", value: 5, stackable: true, effects: { hunger: 20 }, traits: ["food", "basic", "portable"] },
  // 自制
  { id: "home_cooked_meal", name: "家常饭", type: "consumable", value: 5, stackable: false, effects: { hunger: 60, fun: 5 }, traits: ["food", "homemade"] },
  { id: "fresh_fish", name: "鲜鱼", type: "consumable", value: 8, stackable: true, effects: { hunger: 20 }, traits: ["food", "raw", "fresh"], description: "刚钓上来的鱼" },
];

const TOOLS: ItemDef[] = [
  { id: "notebook", name: "笔记本", type: "tool", value: 10, enables: ["journal"], traits: ["writing", "personal"], description: "写满了字的笔记本，封面有点磨损" },
  { id: "guitar", name: "吉他", type: "tool", value: 80, enables: ["practice_music"], traits: ["music", "personal"], description: "一把旧木吉他，琴弦换过几次了" },
  { id: "fishing_rod", name: "鱼竿", type: "tool", value: 25, enables: ["fish"], traits: ["outdoor", "leisure"], description: "一根朴素的鱼竿" },
  { id: "art_supplies", name: "画具", type: "tool", value: 15, enables: ["draw"], traits: ["art", "creative"] },
  { id: "umbrella", name: "雨伞", type: "tool", value: 10, traits: ["weather", "daily"] },
  { id: "camera", name: "相机", type: "tool", value: 50, enables: ["photograph"], traits: ["creative", "hobby"] },
];

const GIFTS: ItemDef[] = [
  { id: "flower_bouquet", name: "花束", type: "gift", value: 15, traits: ["romantic", "fragile", "seasonal"], description: "混合花束，有向日葵和雏菊" },
  { id: "flower_single", name: "一朵花", type: "gift", value: 5, traits: ["romantic", "simple"] },
  { id: "handmade_cookies", name: "手工饼干", type: "gift", value: 8, traits: ["handmade", "sweet", "food"], effects: { hunger: 10, fun: 8 }, description: "用心做的饼干，形状不太规则" },
  { id: "letter", name: "信", type: "gift", value: 0, traits: ["personal", "emotional"], description: "一封手写的信" },
  { id: "scarf", name: "围巾", type: "gift", value: 20, traits: ["warm", "wearable", "handmade"] },
  { id: "charm", name: "幸运符", type: "gift", value: 5, traits: ["spiritual", "small"] },
];

const MATERIALS: ItemDef[] = [
  { id: "ingredients", name: "食材", type: "material", value: 5, stackable: true, usedBy: ["cook"], traits: ["food", "raw"] },
  { id: "flower_materials", name: "花材", type: "material", value: 8, stackable: true, usedBy: ["craft_bouquet"], traits: ["flower", "raw"] },
  { id: "baking_supplies", name: "烘焙材料", type: "material", value: 8, stackable: true, usedBy: ["bake"], traits: ["food", "raw"] },
];

const KEEPSAKES: ItemDef[] = [
  { id: "seashell", name: "贝壳", type: "keepsake", value: 0, traits: ["nature", "beach", "small"], description: "海边捡到的贝壳，内侧有珍珠色的光泽" },
  { id: "photo", name: "照片", type: "keepsake", value: 0, traits: ["memory", "personal"] },
  { id: "pressed_flower", name: "压花书签", type: "keepsake", value: 0, traits: ["flower", "handmade", "delicate"] },
  { id: "old_ticket", name: "旧票根", type: "keepsake", value: 0, traits: ["memory", "small"] },
];

const QUEST: ItemDef[] = [
  { id: "lost_key", name: "遗失的钥匙", type: "quest", value: 0, traits: ["mystery", "small"] },
  { id: "notice", name: "公告", type: "quest", value: 0, traits: ["information", "public"] },
  { id: "package", name: "包裹", type: "quest", value: 0, traits: ["delivery"] },
];

// ─── 注册表 ───

const ALL_ITEMS: ItemDef[] = [
  ...CONSUMABLES,
  ...TOOLS,
  ...GIFTS,
  ...MATERIALS,
  ...KEEPSAKES,
  ...QUEST,
];

const ITEM_MAP = new Map<string, ItemDef>(ALL_ITEMS.map(i => [i.id, i]));

/** 根据 ID 获取物品定义 */
export function getItemDef(id: string): ItemDef | undefined {
  return ITEM_MAP.get(id);
}

/** 获取所有物品定义 */
export function getAllItemDefs(): ItemDef[] {
  return ALL_ITEMS;
}

/** 获取指定类型的物品 */
export function getItemsByType(type: ItemDef["type"]): ItemDef[] {
  return ALL_ITEMS.filter(i => i.type === type);
}

// ─── 背包操作工具函数 ───

/** 向背包添加物品（堆叠同类） */
export function addToInventory(inventory: ItemInstance[], defId: string, quantity = 1, extra?: Partial<Omit<ItemInstance, "defId" | "quantity">>): void {
  const def = getItemDef(defId);
  if (!def) return;

  // 只有两者都没有特殊标记时才堆叠
  if (def.stackable && !extra?.giftedBy && !extra?.memoryTag) {
    const existing = inventory.find(i => i.defId === defId && !i.giftedBy && !i.memoryTag);
    if (existing) {
      existing.quantity += quantity;
      return;
    }
  }

  inventory.push({
    defId,
    quantity,
    ...extra,
  });
}

/** 从背包移除物品（减少数量或删除） */
export function removeFromInventory(inventory: ItemInstance[], defId: string, quantity = 1): ItemInstance | null {
  const idx = inventory.findIndex(i => i.defId === defId);
  if (idx === -1) return null;

  const item = inventory[idx]!;
  if (item.quantity <= quantity) {
    inventory.splice(idx, 1);
    return item;
  } else {
    item.quantity -= quantity;
    return { ...item, quantity };
  }
}

/** 检查背包是否有某物品 */
export function hasItem(inventory: ItemInstance[], defId: string, quantity = 1): boolean {
  const item = inventory.find(i => i.defId === defId);
  return !!item && item.quantity >= quantity;
}

/** 获取背包中某物品的数量 */
export function getItemCount(inventory: ItemInstance[], defId: string): number {
  return inventory.filter(i => i.defId === defId).reduce((sum, i) => sum + i.quantity, 0);
}

/**
 * 格式化背包内容为自然语言（用于 prompt 注入）
 */
export function formatInventory(inventory: ItemInstance[]): string {
  if (inventory.length === 0) return "";

  const lines: string[] = [];
  for (const item of inventory) {
    const def = getItemDef(item.defId);
    if (!def) continue;

    let desc = def.name;
    if (item.quantity > 1) desc += ` ×${item.quantity}`;
    if (item.giftedBy) desc += `（${item.giftedBy}送的）`;
    if (item.memoryTag) desc += `（${item.memoryTag}）`;
    if (item.customDesc) desc += `（${item.customDesc}）`;
    lines.push(`- ${desc}`);
  }

  return lines.length > 0 ? `## 你身上带着的东西\n${lines.join("\n")}` : "";
}
