/**
 * World State — 世界状态类型定义
 */

export interface Location {
  id: string;
  name: string;
  type: "residential" | "commercial" | "public" | "nature" | "special";
  /** 开放时间（小时），null = 24 小时开放 */
  openHours?: { open: number; close: number } | null;
  /** 当前在此地点的角色 ID */
  presentCharacters: string[];
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

export interface CharacterState {
  id: string;
  name: string;
  locationId: string;
  needs: CharacterNeeds;
  gold: number;
  /** 当前正在执行的行为（多 tick 行为） */
  currentAction?: { name: string; remainingTicks: number };
  /** 消息信箱：其他角色发来的消息 */
  inbox: InboxMessage[];
}
