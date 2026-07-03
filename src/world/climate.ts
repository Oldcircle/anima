/**
 * Climate System — 气候系统（天气 × 季节 × 时辰 → 体感温度 + 生存压力）
 *
 * 把"天气/四季"从纸面数据升级成真正的游戏系统，三位一体：
 * - 可感知：体感温度 + 气候提示 + 季节氛围注入角色 prompt
 * - 有压力：露天暴露在恶劣气候 → 每 tick 额外消耗 needs + 产生 moodlet（催人躲屋里）
 * - 看得见：温度进 WS 广播，Godot 显示 + 四季换装（见 godot/Main.gd）
 */

import type { Weather, Season, Location, CharacterState } from "./types.js";
import { addMoodlet } from "./moodlets.js";
import { weatherDescription } from "./weather.js";

/** 季节基础气温（°C，正午参考值） */
const SEASON_BASE_TEMP: Record<Season, number> = { spring: 16, summer: 29, autumn: 13, winter: 2 };
/** 天气对气温的修正 */
const WEATHER_TEMP_DELTA: Record<Weather, number> = { sunny: 2, cloudy: 0, rainy: -3, stormy: -5, snowy: -6 };

/** 一天内的气温摆动：正午 14:00 最暖、凌晨 5:00 最冷，幅度 ±5°C */
export function hourTempDelta(hour: number): number {
  return Math.round(Math.cos(((hour - 14) / 24) * Math.PI * 2) * 5);
}

/** 体感温度（整数 °C） */
export function computeTemperature(season: Season, weather: Weather, hour: number): number {
  return Math.round(SEASON_BASE_TEMP[season] + WEATHER_TEMP_DELTA[weather] + hourTempDelta(hour));
}

export type ComfortBand = "freezing" | "cold" | "cool" | "mild" | "warm" | "hot";

export function comfortBand(temp: number): ComfortBand {
  if (temp <= 2) return "freezing";
  if (temp <= 9) return "cold";
  if (temp <= 15) return "cool";
  if (temp <= 25) return "mild";
  if (temp <= 31) return "warm";
  return "hot";
}

const BAND_CN: Record<ComfortBand, string> = {
  freezing: "冰冷刺骨", cold: "很冷", cool: "微凉", mild: "凉爽宜人", warm: "温暖", hot: "闷热",
};

export function comfortLabel(temp: number): string {
  return BAND_CN[comfortBand(temp)];
}

/**
 * 地点是否有遮蔽（室内不受气候惩罚）。
 * residential/commercial 皆室内；library 是唯一室内的 public；home_* 虚拟住宅同样算室内。
 */
export function isSheltered(loc: Location | undefined): boolean {
  if (!loc) return true;   // 未知地点宁可不惩罚
  if (loc.type === "residential" || loc.type === "commercial") return true;
  if (loc.id === "library" || loc.id.includes("home")) return true;
  return false;   // public 广场 / nature 海滩码头农田森林 / special = 露天
}

/**
 * 露天暴露在恶劣气候下，每 tick 的额外需求消耗。
 * sheltered（室内）返回空对象——躲屋里就没有气候惩罚，这正是想涌现的避难行为。
 */
export function climateNeedEffects(temp: number, weather: Weather, sheltered: boolean): Record<string, number> {
  if (sheltered) return {};
  const band = comfortBand(temp);
  const eff: Record<string, number> = {};
  const add = (k: string, d: number) => { eff[k] = (eff[k] ?? 0) + d; };
  // 冷/热额外耗精力
  if (band === "freezing") { add("energy", -1.5); add("fun", -1); }
  else if (band === "cold") { add("energy", -0.8); }
  else if (band === "hot") { add("energy", -0.8); add("hunger", -0.6); }
  // 雨雪淋着 → 卫生掉、心情差
  if (weather === "stormy") { add("hygiene", -2); add("fun", -1.5); add("energy", -0.8); }
  else if (weather === "rainy") { add("hygiene", -1.2); add("fun", -1); }
  else if (weather === "snowy") { add("hygiene", -0.6); add("fun", -0.5); }
  // 温和晴天在户外 → 小确幸
  if ((band === "mild" || band === "warm") && weather === "sunny") { add("fun", 0.6); }
  return eff;
}

/**
 * 露天恶劣 / 宜人气候 → moodlet（短时效，随情境刷新/自然过期）。
 * sheltered 不触发。这条 moodlet 会进 prompt 的"心情"段，给模型精确的"我正淋着雨"信号。
 */
export function applyClimateMoodlet(
  state: CharacterState, temp: number, weather: Weather, sheltered: boolean, tick: number,
): void {
  if (sheltered) return;
  if (weather === "stormy") addMoodlet(state, "anxious", 3, "在暴风雨里淋着，狼狈又难受", 4, "event", tick);
  else if (weather === "rainy") addMoodlet(state, "sad", 2, "被雨淋得有点狼狈", 4, "event", tick);
  else if (weather === "snowy") addMoodlet(state, "sad", 2, "在雪地里冻得直搓手", 4, "event", tick);
  else if (temp <= 2) addMoodlet(state, "sad", 2, "冻得手脚冰凉", 4, "event", tick);
  else if (temp >= 32) addMoodlet(state, "anxious", 2, "热得心烦气躁", 4, "event", tick);
  else if (weather === "sunny" && temp >= 16 && temp <= 27) {
    addMoodlet(state, "happy", 2, "阳光正好，晒得人心情舒展", 6, "event", tick);
  }
}

/** prompt 环境行的天气+温度串，如"下着小雨，12°C（微凉）" */
export function climateEnvLine(season: Season, weather: Weather, hour: number): string {
  const temp = computeTemperature(season, weather, hour);
  return `${weatherDescription(weather)}，${temp}°C（${comfortLabel(temp)}）`;
}

/** 气候行为提示（温度/天气驱动，不依赖是否遮蔽——躲雨与否交给 moodlet 精确表达） */
export function climateHint(season: Season, weather: Weather, hour: number): string {
  const temp = computeTemperature(season, weather, hour);
  const parts: string[] = [];
  if (weather === "stormy") parts.push("外面是暴风雨，待在室内比较安全。");
  else if (weather === "rainy") parts.push("外面在下雨，出门得带伞，多数人更愿意待在室内。");
  else if (weather === "snowy") parts.push("外面下着雪，出门要裹紧一点。");
  if (temp <= 2) parts.push("天冷得刺骨，在外面待久了会冻得发抖。");
  else if (temp <= 9 && weather !== "snowy") parts.push("天挺冷的，出门记得添件衣服。");
  else if (temp >= 32) parts.push("天气闷热，让人只想找个阴凉处待着。");
  return parts.join("");
}

/** 季节氛围一句话（注入 prompt，让角色感到"季节的身体记忆"） */
const SEASON_AMBIENT: Record<Season, string> = {
  spring: "初春时节，空气里浮着草木回暖的湿润气息，樱花开得正好。",
  summer: "盛夏时分，蝉鸣阵阵，海风也带着暖意，白昼很长。",
  autumn: "入秋了，落叶铺了一地金黄，风里有了凉意，天黑得早了些。",
  winter: "隆冬时节，万物萧瑟，呵气成霜，人们都想守着暖处过日子。",
};

export function seasonAmbient(season: Season): string {
  return SEASON_AMBIENT[season];
}
