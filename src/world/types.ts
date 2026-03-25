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
}

export type Weather = "sunny" | "cloudy" | "rainy" | "stormy" | "snowy";
export type Season = "spring" | "summer" | "autumn" | "winter";

export interface WorldState {
  tick: number;
  weather: Weather;
  locations: Map<string, Location>;
}

export interface CharacterNeeds {
  hunger: number;    // 0-100, 低 = 饿
  energy: number;    // 0-100, 低 = 累
  social: number;    // 0-100, 低 = 孤独
  happiness: number; // 0-100
  hygiene: number;   // 0-100
}

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

export interface CharacterState {
  id: string;
  name: string;
  locationId: string;
  needs: CharacterNeeds;
  gold: number;
  /** 当前正在执行的行为（多 tick 行为） */
  currentAction?: { name: string; remainingTicks: number };
  /** 当前还挂在心上的短期意图/未完事务，会自然过期 */
  currentIntent?: CharacterIntent;
  /** 消息信箱：其他角色发来的消息 */
  inbox: InboxMessage[];
}
