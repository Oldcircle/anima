import { describe, it, expect } from "vitest";
import {
  getItemDef,
  getAllItemDefs,
  getItemsByType,
  addToInventory,
  removeFromInventory,
  hasItem,
  getItemCount,
  formatInventory,
} from "./item-registry.js";
import type { ItemInstance } from "./item-types.js";

describe("Item Registry", () => {
  it("getItemDef 能获取已注册物品", () => {
    const bread = getItemDef("bread_red_bean");
    expect(bread).toBeDefined();
    expect(bread!.name).toBe("红豆面包");
    expect(bread!.type).toBe("consumable");
    expect(bread!.effects?.hunger).toBe(45);
  });

  it("getItemDef 对未知 ID 返回 undefined", () => {
    expect(getItemDef("nonexistent")).toBeUndefined();
  });

  it("getAllItemDefs 返回所有物品", () => {
    const all = getAllItemDefs();
    expect(all.length).toBeGreaterThan(20);
    // 包含各类型
    const types = new Set(all.map(i => i.type));
    expect(types.has("consumable")).toBe(true);
    expect(types.has("tool")).toBe(true);
    expect(types.has("gift")).toBe(true);
    expect(types.has("material")).toBe(true);
    expect(types.has("keepsake")).toBe(true);
  });

  it("getItemsByType 按类型过滤", () => {
    const tools = getItemsByType("tool");
    expect(tools.length).toBeGreaterThan(2);
    expect(tools.every(i => i.type === "tool")).toBe(true);
  });
});

describe("Inventory Operations", () => {
  it("addToInventory 添加物品到背包", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 2);
    expect(inv.length).toBe(1);
    expect(inv[0]!.defId).toBe("bread_plain");
    expect(inv[0]!.quantity).toBe(2);
  });

  it("addToInventory 堆叠同类物品", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 2);
    addToInventory(inv, "bread_plain", 3);
    expect(inv.length).toBe(1);
    expect(inv[0]!.quantity).toBe(5);
  });

  it("addToInventory 不堆叠不同物品", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 1);
    addToInventory(inv, "croissant", 1);
    expect(inv.length).toBe(2);
  });

  it("addToInventory 有 giftedBy 的物品不堆叠", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 1);
    addToInventory(inv, "bread_plain", 1, { giftedBy: "anon" });
    expect(inv.length).toBe(2); // 普通面包 + 爱音给的面包
  });

  it("addToInventory 不可堆叠物品独立存在", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "home_cooked_meal");
    addToInventory(inv, "home_cooked_meal");
    expect(inv.length).toBe(2); // 家常饭不可堆叠
  });

  it("removeFromInventory 减少数量", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 5);
    const removed = removeFromInventory(inv, "bread_plain", 2);
    expect(removed).toBeDefined();
    expect(inv[0]!.quantity).toBe(3);
  });

  it("removeFromInventory 数量归零时删除", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 2);
    removeFromInventory(inv, "bread_plain", 2);
    expect(inv.length).toBe(0);
  });

  it("removeFromInventory 不存在的物品返回 null", () => {
    const inv: ItemInstance[] = [];
    expect(removeFromInventory(inv, "bread_plain")).toBeNull();
  });

  it("hasItem 检查物品存在", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "notebook");
    expect(hasItem(inv, "notebook")).toBe(true);
    expect(hasItem(inv, "guitar")).toBe(false);
  });

  it("hasItem 检查数量", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 3);
    expect(hasItem(inv, "bread_plain", 3)).toBe(true);
    expect(hasItem(inv, "bread_plain", 4)).toBe(false);
  });

  it("getItemCount 返回总数量", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 3);
    expect(getItemCount(inv, "bread_plain")).toBe(3);
    expect(getItemCount(inv, "guitar")).toBe(0);
  });
});

describe("formatInventory", () => {
  it("空背包返回空字符串", () => {
    expect(formatInventory([])).toBe("");
  });

  it("列出物品名称和数量", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "bread_plain", 3);
    addToInventory(inv, "notebook");
    const result = formatInventory(inv);
    expect(result).toContain("白面包 ×3");
    expect(result).toContain("笔记本");
    expect(result).toContain("## 你身上带着的东西");
  });

  it("显示赠送者信息", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "flower_bouquet", 1, { giftedBy: "爱音" });
    const result = formatInventory(inv);
    expect(result).toContain("爱音送的");
  });

  it("显示记忆标签", () => {
    const inv: ItemInstance[] = [];
    addToInventory(inv, "seashell", 1, { memoryTag: "和睦在海边捡的" });
    const result = formatInventory(inv);
    expect(result).toContain("和睦在海边捡的");
  });
});
