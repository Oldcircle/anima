/**
 * World — 世界状态管理
 */

import type { Location, Weather, WorldState, CharacterState, CharacterNeeds, InboxMessage, CharacterIntent } from "./types.js";
import type { LifeState } from "../character/types.js";
import { tickToGameTime, type GameTime } from "../core/tick-engine.js";

const DEFAULT_NEEDS: CharacterNeeds = {
  hunger: 80,
  energy: 100,
  social: 60,
  happiness: 70,
  hygiene: 90,
};

/** 每 tick 的需求衰减 */
const NEED_DECAY: Partial<CharacterNeeds> = {
  hunger: -2,
  energy: -0.5,
  social: -1,
  hygiene: -0.5,
};

export class World {
  private _state: WorldState;
  private _characters: Map<string, CharacterState> = new Map();

  constructor(locations: Location[], initialTick = 0) {
    this._state = {
      tick: initialTick,
      weather: "sunny",
      locations: new Map(locations.map((l) => [l.id, { ...l, presentCharacters: [...l.presentCharacters] }])),
    };
  }

  get tick(): number {
    return this._state.tick;
  }

  get weather(): Weather {
    return this._state.weather;
  }

  get gameTime(): GameTime {
    return tickToGameTime(this._state.tick);
  }

  setTick(tick: number): void {
    this._state.tick = tick;
  }

  setWeather(weather: Weather): void {
    this._state.weather = weather;
  }

  // --- 地点 ---

  getLocation(id: string): Location | undefined {
    return this._state.locations.get(id);
  }

  getAllLocations(): Location[] {
    return Array.from(this._state.locations.values());
  }

  getCharactersAtLocation(locationId: string): string[] {
    return this._state.locations.get(locationId)?.presentCharacters ?? [];
  }

  // --- 角色 ---

  addCharacter(id: string, name: string, locationId: string, needs?: Partial<CharacterNeeds>, life?: LifeState): void {
    const state: CharacterState = {
      id,
      name,
      locationId,
      needs: { ...DEFAULT_NEEDS, ...needs },
      gold: 100,
      life,
      moodlets: [],
      inbox: [],
    };
    this._characters.set(id, state);

    // 把角色加入地点
    const loc = this._state.locations.get(locationId);
    if (loc && !loc.presentCharacters.includes(id)) {
      loc.presentCharacters.push(id);
    }
  }

  getCharacter(id: string): CharacterState | undefined {
    return this._characters.get(id);
  }

  getAllCharacters(): CharacterState[] {
    return Array.from(this._characters.values());
  }

  /** 移动角色到新地点 */
  moveCharacter(characterId: string, newLocationId: string): boolean {
    const character = this._characters.get(characterId);
    if (!character) return false;

    const newLoc = this._state.locations.get(newLocationId);
    if (!newLoc) return false;

    // 从旧地点移除
    const oldLoc = this._state.locations.get(character.locationId);
    if (oldLoc) {
      oldLoc.presentCharacters = oldLoc.presentCharacters.filter((id) => id !== characterId);
    }

    // 加入新地点
    character.locationId = newLocationId;
    if (!newLoc.presentCharacters.includes(characterId)) {
      newLoc.presentCharacters.push(characterId);
    }

    return true;
  }

  /** 每 tick 衰减所有角色的需求值 */
  decayNeeds(): void {
    for (const character of this._characters.values()) {
      for (const [key, delta] of Object.entries(NEED_DECAY)) {
        const need = key as keyof CharacterNeeds;
        character.needs[need] = Math.max(0, Math.min(100, character.needs[need] + (delta as number)));
      }
    }
  }

  /** 修改角色需求值 */
  modifyNeed(characterId: string, need: keyof CharacterNeeds, delta: number): void {
    const character = this._characters.get(characterId);
    if (!character) return;
    character.needs[need] = Math.max(0, Math.min(100, character.needs[need] + delta));
  }

  /** 设置角色当前短期意图 */
  setIntent(characterId: string, intent?: CharacterIntent): void {
    const character = this._characters.get(characterId);
    if (!character) return;
    character.currentIntent = intent;
  }

  /** 获取当前仍有效的短期意图；过期会自动清除 */
  getCurrentIntent(characterId: string, tick = this._state.tick): CharacterIntent | undefined {
    const character = this._characters.get(characterId);
    if (!character?.currentIntent) return undefined;
    if (character.currentIntent.expiresAt < tick) {
      character.currentIntent = undefined;
      return undefined;
    }
    return character.currentIntent;
  }

  clearIntent(characterId: string): void {
    const character = this._characters.get(characterId);
    if (!character) return;
    character.currentIntent = undefined;
  }

  // --- 信箱 ---

  /** 向角色信箱投递消息 */
  sendMessage(toId: string, message: InboxMessage): void {
    const character = this._characters.get(toId);
    if (!character) return;
    character.inbox.push(message);
  }

  /** 获取并清空角色信箱 */
  consumeInbox(characterId: string): InboxMessage[] {
    const character = this._characters.get(characterId);
    if (!character) return [];
    const messages = character.inbox;
    character.inbox = [];
    return messages;
  }
}
