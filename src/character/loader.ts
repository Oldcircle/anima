/**
 * Character Loader — 从 YAML 文件加载角色卡
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";
import type { CharacterCard } from "./types.js";

export function loadCharacterFromYAML(filePath: string): CharacterCard {
  const raw = readFileSync(filePath, "utf-8");
  const data = parseYAML(raw);

  return {
    id: data.id,
    name: data.name,
    age: data.age,
    occupation: data.occupation,
    home: data.home,
    personality: {
      traits: data.personality?.traits ?? [],
      interests: data.personality?.interests ?? [],
      dislikes: data.personality?.dislikes ?? [],
      speechStyle: data.personality?.speech_style ?? "",
    },
    background: data.background ?? "",
    dailyRoutine: data.daily_routine ?? {},
    relationships: data.relationships ?? {},
  };
}

export function loadCharactersFromDir(dirPath: string): CharacterCard[] {
  const files = readdirSync(dirPath).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  return files.map((f) => loadCharacterFromYAML(join(dirPath, f)));
}
