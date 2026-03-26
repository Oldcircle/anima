/**
 * Item Types — 物品系统类型定义
 *
 * 物品不是装备，是角色生活、关系和事件的媒介。
 * 物品是"可携带的可供性"——你身上有什么决定你能做什么。
 */

export type ItemType = 'consumable' | 'tool' | 'gift' | 'material' | 'keepsake' | 'quest';

/**
 * 物品定义（共享，从 YAML/配置加载）。
 * 描述一类物品的属性，不绑定具体角色。
 */
export interface ItemDef {
  id: string;              // "bread_red_bean", "notebook", "guitar"
  name: string;            // "红豆面包", "笔记本", "吉他"
  type: ItemType;
  description?: string;    // "灯最拿手的面包，红豆馅甜而不腻"
  /** consumable: 使用时的需求效果 */
  effects?: Record<string, number>;
  /** tool: 持有时解锁的工具 ID */
  enables?: string[];
  /** material: 被哪些行为消耗 */
  usedBy?: string[];
  /** 金币价值（买入价） */
  value?: number;
  /** 可堆叠（同类物品合并数量） */
  stackable?: boolean;
  /** 标签（用于事件触发和 prompt 描述） */
  traits?: string[];       // ["romantic", "handmade", "fragile", "seasonal"]
}

/**
 * 物品实例（每个角色持有的具体物品）。
 * 同一个 ItemDef 可以有多个 ItemInstance（如 3 个面包）。
 */
export interface ItemInstance {
  defId: string;           // 引用 ItemDef.id
  quantity: number;        // 堆叠数量（不可堆叠的 = 1）
  /** 谁给的（gift/keepsake 有情感价值） */
  giftedBy?: string;
  /** 什么时候获得的 */
  obtainedTick?: number;
  /** 自定义描述（手工制作、LLM 生成的特殊描述） */
  customDesc?: string;
  /** 记忆标签（"春种节那天送的", "第一次见面时买的"） */
  memoryTag?: string;
}

/**
 * 地点商店物品（定义在地点 YAML 的 shop 段）
 */
export interface ShopItem {
  id: string;     // 引用 ItemDef.id
  name: string;   // 显示名
  price: number;  // 金币价格
}
