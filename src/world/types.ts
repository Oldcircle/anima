/**
 * World State — 世界状态类型定义
 */

export interface LocationAtmosphere {
  morning?: string;
  afternoon?: string;
  evening?: string;
  night?: string;
  rainy?: string;
}

/** 地点提供的工具（从 YAML 加载） */
export interface LocationTool {
  name: string;
  description: string;
  effects: Record<string, number>;
  cost?: number;
  duration?: number;
  /** 条件：如 "energy < 80", "hygiene < 80", "isWorkplace" */
  condition?: string;
  /** 员工工具收入（每次执行获得的金币） */
  income?: number;
}

/** 职业阶梯等级 */
export interface CareerLevel {
  level: number;
  title: string;
  income: number;
  required_skill: Record<string, number>;
}

export interface Location {
  id: string;
  name: string;
  type: "residential" | "commercial" | "public" | "nature" | "special";
  /** 一句话摘要（用于 go_to 描述） */
  summary?: string;
  /** 开放时间（小时），null = 24 小时开放 */
  openHours?: { open: number; close: number } | null;
  /** 当前在此地点的角色 ID */
  presentCharacters: string[];
  /** 感官描述（按时段/天气） */
  atmosphere?: LocationAtmosphere;
  /** 地点提供的工具 */
  tools?: LocationTool[];
  /** 职业阶梯（从 YAML 加载） */
  careerTrack?: CareerLevel[];
  /** 商店物品（从 YAML 加载） */
  shop?: import("./item-types.js").ShopItem[];
  /** 员工专属工具（从 YAML 加载） */
  workerTools?: LocationTool[];
}

/** 临时情绪效果（Moodlet） */
export interface Moodlet {
  id: string;
  emotion: "happy" | "sad" | "angry" | "embarrassed" | "anxious" | "confident" | "lonely" | "grateful";
  intensity: number;        // 1-5
  reason: string;           // "和爱音聊得很开心"
  expiresAtTick: number;
  source: "social" | "work" | "need" | "event" | "memory";
}

export type Weather = "sunny" | "cloudy" | "rainy" | "stormy" | "snowy";
export type Season = "spring" | "summer" | "autumn" | "winter";

export interface WorldState {
  tick: number;
  weather: Weather;
  locations: Map<string, Location>;
}

/**
 * CharacterNeeds — 数据驱动的需求系统。
 * 键名对应 NeedDefinition.id（hunger/energy/social/hygiene/fun/bladder）。
 * 值域 0-100，低 = 该需求未被满足。
 *
 * 不再是固定的 interface——维度由 need-definitions.ts 配置决定。
 */
export type CharacterNeeds = Record<string, number>;

export interface InboxMessage {
  fromId: string;
  fromName: string;
  content: string;
  tick: number;
}

export interface CharacterIntent {
  kind: "reply" | "follow_up" | "recover" | "plan";
  summary: string;
  source: "message" | "action" | "movement";
  targetId?: string;
  createdTick: number;
  expiresAt: number;
}

export interface CharacterObservableState {
  actionName: string;
  summary: string;
  source: "action";
  targetId?: string;
  createdTick: number;
  expiresAt: number;
}

export interface CharacterState {
  id: string;
  name: string;
  locationId: string;
  needs: CharacterNeeds;
  gold: number;
  /** 可变的生活状态（职业、技能、目标等） */
  life?: import("../character/types.js").LifeState;
  /** 临时情绪效果列表 */
  moodlets: Moodlet[];
  /** 当前正在执行的行为（多 tick 行为） */
  currentAction?: { name: string; remainingTicks: number };
  /** 当前还挂在心上的短期意图/未完事务，会自然过期 */
  currentIntent?: CharacterIntent;
  /** 当前留在外界可被旁人观察到的生活痕迹 */
  observableState?: CharacterObservableState;
  /** 消息信箱：其他角色发来的消息 */
  inbox: InboxMessage[];
  /** 随身物品 */
  inventory: import("./item-types.js").ItemInstance[];
  /** 最近行为记录（用于行为链追踪） */
  recentActions: { actionId: string; tick: number }[];
}
