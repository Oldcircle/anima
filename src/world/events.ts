/**
 * Random Events — 随机事件系统
 *
 * 每 tick 有小概率触发随机事件，影响角色状态和世界。
 * 事件注入到相关角色的记忆中，影响后续决策。
 */

import type { Season, Weather } from "./types.js";

export interface RandomEvent {
  id: string;
  name: string;
  description: string;
  /** 事件描述模板，{character} 会被替换为角色名 */
  template: string;
  /** 触发条件 */
  conditions?: {
    season?: Season[];
    weather?: Weather[];
    hourRange?: [number, number]; // [start, end)
    minCharactersAtLocation?: number;
  };
  /** 对被影响角色的效果 */
  effects: Array<{
    field: "hunger" | "energy" | "social" | "fun" | "hygiene";
    delta: number;
  }>;
  /** 影响范围: self=只影响一个人, location=影响同地点所有人 */
  scope: "self" | "location";
  /** 每 tick 触发概率 (0-1) */
  probability: number;
}

export const RANDOM_EVENTS: RandomEvent[] = [
  {
    id: "found_wildflowers",
    name: "发现野花",
    description: "在路边发现了一丛漂亮的野花",
    template: "{character}在路边发现了一丛漂亮的野花，心情变好了",
    conditions: { season: ["spring", "summer"], weather: ["sunny", "cloudy"] },
    effects: [{ field: "fun", delta: 10 }],
    scope: "self",
    probability: 0.03,
  },
  {
    id: "rain_surprise",
    name: "突然下雨",
    description: "突然下起了小雨，没带伞的人被淋湿了",
    template: "突然下起了小雨，{character}被淋了一身",
    conditions: { weather: ["rainy", "cloudy"] },
    effects: [{ field: "fun", delta: -8 }, { field: "hygiene", delta: -10 }],
    scope: "self",
    probability: 0.04,
  },
  {
    id: "delicious_smell",
    name: "飘来香味",
    description: "面包店飘来诱人的香味",
    template: "面包店飘来诱人的香味，{character}觉得肚子更饿了",
    conditions: { hourRange: [7, 12] },
    effects: [{ field: "hunger", delta: -10 }],
    scope: "location",
    probability: 0.05,
  },
  {
    id: "beautiful_sunset",
    name: "美丽的日落",
    description: "今天的日落格外美丽",
    template: "{character}看到了格外美丽的日落，驻足欣赏了一会儿",
    conditions: { hourRange: [17, 19], weather: ["sunny", "cloudy"] },
    effects: [{ field: "fun", delta: 12 }],
    scope: "self",
    probability: 0.06,
  },
  {
    id: "stray_cat",
    name: "流浪猫",
    description: "一只流浪猫走过来蹭了蹭腿",
    template: "一只流浪猫走过来蹭了蹭{character}的腿",
    conditions: {},
    effects: [{ field: "fun", delta: 8 }, { field: "social", delta: 5 }],
    scope: "self",
    probability: 0.02,
  },
  {
    id: "lively_plaza",
    name: "广场热闹",
    description: "广场上有人在演奏音乐",
    template: "广场上有人在演奏音乐，{character}停下来听了一会儿",
    conditions: { hourRange: [14, 20] },
    effects: [{ field: "fun", delta: 10 }, { field: "social", delta: 8 }],
    scope: "location",
    probability: 0.04,
  },
  {
    id: "cold_wind",
    name: "寒风",
    description: "一阵冷风吹来",
    template: "一阵冷风吹来，{character}打了个寒颤",
    conditions: { season: ["autumn", "winter"] },
    effects: [{ field: "energy", delta: -5 }, { field: "fun", delta: -3 }],
    scope: "self",
    probability: 0.04,
  },
  {
    id: "found_coin",
    name: "捡到硬币",
    description: "在地上捡到一枚硬币",
    template: "{character}在地上捡到一枚硬币，觉得今天运气不错",
    conditions: {},
    effects: [{ field: "fun", delta: 5 }],
    scope: "self",
    probability: 0.02,
  },
];

/** 检查事件是否满足触发条件 */
function meetsConditions(
  event: RandomEvent,
  hour: number,
  season: Season,
  weather: Weather,
): boolean {
  const c = event.conditions;
  if (!c) return true;
  if (c.season && !c.season.includes(season)) return false;
  if (c.weather && !c.weather.includes(weather)) return false;
  if (c.hourRange) {
    const [start, end] = c.hourRange;
    if (hour < start || hour >= end) return false;
  }
  return true;
}

/** 每 tick 滚动随机事件 */
export function rollRandomEvents(params: {
  hour: number;
  season: Season;
  weather: Weather;
}): RandomEvent[] {
  const triggered: RandomEvent[] = [];
  for (const event of RANDOM_EVENTS) {
    if (!meetsConditions(event, params.hour, params.season, params.weather)) continue;
    if (Math.random() < event.probability) {
      triggered.push(event);
    }
  }
  return triggered;
}
