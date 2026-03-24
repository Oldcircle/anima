/**
 * Location Loader — 从 YAML 文件加载地点数据（含 atmosphere）
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";
import type { Location, LocationAtmosphere } from "./types.js";

interface RawLocation {
  id: string;
  name: string;
  type: string;
  openHours?: { open: number; close: number };
  atmosphere?: LocationAtmosphere;
}

function toLocation(raw: RawLocation): Location {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type as Location["type"],
    openHours: raw.openHours ?? null,
    presentCharacters: [],
    atmosphere: raw.atmosphere,
  };
}

export function loadLocationsFromDir(dirPath: string): Location[] {
  const files = readdirSync(dirPath).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  const locations: Location[] = [];

  for (const file of files) {
    const raw = readFileSync(join(dirPath, file), "utf-8");
    const data = parseYAML(raw);

    // residential.yml contains multiple homes under `homes` key
    if (data.homes && Array.isArray(data.homes)) {
      for (const home of data.homes) {
        locations.push(toLocation(home));
      }
    } else if (data.id) {
      // Single location file
      locations.push(toLocation(data));
    }
  }

  return locations;
}

/**
 * 根据时间和天气选择合适的 atmosphere 描述
 */
export function getAtmosphereText(
  atmosphere: LocationAtmosphere | undefined,
  hour: number,
  weather: string,
): string | undefined {
  if (!atmosphere) return undefined;

  // 雨/雪天气优先使用 rainy 描述
  if ((weather === "rainy" || weather === "stormy" || weather === "snowy") && atmosphere.rainy) {
    return atmosphere.rainy.trim();
  }

  // 按时段选择
  if (hour >= 6 && hour < 12) return atmosphere.morning?.trim();
  if (hour >= 12 && hour < 17) return atmosphere.afternoon?.trim();
  if (hour >= 17 && hour < 21) return atmosphere.evening?.trim();
  return atmosphere.night?.trim(); // 21:00-05:59
}
