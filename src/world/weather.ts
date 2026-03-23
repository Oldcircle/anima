/**
 * Weather System — 天气系统
 *
 * 每天凌晨随机生成天气，季节影响概率。
 */

import type { Weather, Season } from "./types.js";

const WEATHER_WEIGHTS: Record<Season, Record<Weather, number>> = {
  spring: { sunny: 40, cloudy: 30, rainy: 25, stormy: 3, snowy: 2 },
  summer: { sunny: 50, cloudy: 25, rainy: 15, stormy: 10, snowy: 0 },
  autumn: { sunny: 30, cloudy: 35, rainy: 25, stormy: 5, snowy: 5 },
  winter: { sunny: 20, cloudy: 30, rainy: 15, stormy: 5, snowy: 30 },
};

export function rollWeather(season: Season): Weather {
  const weights = WEATHER_WEIGHTS[season];
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;

  for (const [weather, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return weather as Weather;
  }
  return "sunny";
}

export function weatherDescription(weather: Weather): string {
  const desc: Record<Weather, string> = {
    sunny: "阳光明媚",
    cloudy: "多云",
    rainy: "下着小雨",
    stormy: "暴风雨",
    snowy: "下雪了",
  };
  return desc[weather];
}

/** 天气对行为的影响提示 */
export function weatherHint(weather: Weather): string {
  switch (weather) {
    case "sunny": return "";
    case "cloudy": return "天色有些阴沉。";
    case "rainy": return "外面在下雨，出门需要带伞，大部分人更愿意待在室内。";
    case "stormy": return "暴风雨天气！最好不要出门，待在室内比较安全。";
    case "snowy": return "外面下着雪，地上积了一层白。出门会比较冷。";
  }
}
