/**
 * Festival System — 节日系统
 *
 * 每个季节有固定节日，影响角色行为和情绪。
 */

import type { Season } from "./types.js";

export interface Festival {
  id: string;
  name: string;
  season: Season;
  day: number;        // 季节内的哪一天（1-28）
  description: string;
  /** 注入所有角色 prompt 的提示 */
  promptHint: string;
  /** 对所有角色的效果 */
  effects: Array<{ field: "happiness" | "social"; delta: number }>;
}

export const FESTIVALS: Festival[] = [
  {
    id: "flower_festival",
    name: "花之祭",
    season: "spring",
    day: 13,
    description: "一年一度的花之祭！广场上摆满了鲜花，空气中弥漫着芬芳。",
    promptHint: "今天是花之祭！广场上有花展和市集，镇民们都会来逛。这是一年中最美的日子之一。",
    effects: [{ field: "happiness", delta: 15 }, { field: "social", delta: 10 }],
  },
  {
    id: "fishing_derby",
    name: "钓鱼大赛",
    season: "summer",
    day: 8,
    description: "夏日钓鱼大赛！海边和码头挤满了参赛者。",
    promptHint: "今天是年度钓鱼大赛！在海边或码头可以参加比赛，奖品丰厚。全镇的人都会去看热闹。",
    effects: [{ field: "happiness", delta: 10 }, { field: "social", delta: 15 }],
  },
  {
    id: "harvest_feast",
    name: "丰收宴",
    season: "autumn",
    day: 20,
    description: "丰收季的盛大宴会！广场上摆满了美食。",
    promptHint: "今天是丰收宴！广场上有免费的美食和饮料，大家聚在一起庆祝丰收。这是最好的社交机会。",
    effects: [{ field: "happiness", delta: 20 }, { field: "social", delta: 20 }],
  },
  {
    id: "lantern_night",
    name: "灯笼之夜",
    season: "winter",
    day: 25,
    description: "冬至灯笼之夜！小镇被温暖的灯笼照亮。",
    promptHint: "今天是灯笼之夜！入夜后广场和街道挂满了彩色灯笼，人们互赠小礼物，非常浪漫温馨。",
    effects: [{ field: "happiness", delta: 15 }, { field: "social", delta: 10 }],
  },
];

/** 获取今天的节日（如果有） */
export function getTodayFestival(season: Season, seasonDay: number): Festival | null {
  return FESTIVALS.find((f) => f.season === season && f.day === seasonDay) ?? null;
}
