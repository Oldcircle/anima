/**
 * Character Loader — 从 YAML 文件加载角色卡
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";
import type { CharacterCard, LifeState } from "./types.js";

export function loadCharacterFromYAML(filePath: string): CharacterCard {
  const raw = readFileSync(filePath, "utf-8");
  const data = parseYAML(raw);

  const personality = data.personality ?? {};

  // 解析 life 段（如有）
  let life: LifeState | undefined;
  if (data.life) {
    life = {
      occupation: data.life.occupation ?? data.occupation ?? "",
      workplace: data.life.workplace ?? "",
      age: data.life.age ?? data.age ?? 20,
      income: data.life.income ?? 15,
      skills: data.life.skills ?? {},
      aspiration: data.life.aspiration ?? "",
      currentGoal: data.life.current_goal,
      currentConcern: data.life.current_concern,
    };
  }

  return {
    id: data.id,
    name: data.name,
    age: data.age,
    occupation: data.occupation,
    home: data.home,
    appearance: data.appearance,
    personality: {
      traits: personality.traits ?? [],
      interests: personality.interests ?? [],
      dislikes: personality.dislikes ?? [],
      speechStyle: personality.speech_style ?? personality.speechStyle ?? "",
      coreTraits: personality.core_traits,
      psychology: personality.psychology,
      stressResponse: personality.stress_response,
      speech: personality.speech ? {
        style: personality.speech.style ?? "",
        habits: personality.speech.habits ?? [],
        examples: personality.speech.examples ?? [],
      } : undefined,
    },
    background: data.background ?? "",
    backstory: data.backstory,
    preferences: data.preferences,
    life,
    relationships: data.relationships ?? {},
  };
}

export function loadCharactersFromDir(dirPath: string): CharacterCard[] {
  const files = readdirSync(dirPath).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  return files.map((f) => loadCharacterFromYAML(join(dirPath, f)));
}
