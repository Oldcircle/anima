/**
 * World — 世界状态管理
 */

import type {
  Location,
  Weather,
  WorldState,
  CharacterState,
  CharacterNeeds,
  InboxMessage,
  CharacterIntent,
  CharacterObservableState,
} from "./types.js";
import type { LifeState } from "../character/types.js";
import { tickToGameTime, type GameTime } from "../core/tick-engine.js";
import { getDefaultNeeds, getDecayRates } from "./need-definitions.js";

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

  /** 新增或更新地点。已有地点会保留 presentCharacters。 */
  upsertLocation(loc: Location): void {
    const existing = this._state.locations.get(loc.id);
    if (existing) {
      this._state.locations.set(loc.id, {
        ...loc,
        presentCharacters: [...existing.presentCharacters],
      });
    } else {
      this._state.locations.set(loc.id, { ...loc, presentCharacters: [...(loc.presentCharacters ?? [])] });
    }
  }

  /**
   * 删除地点。如果当前还有角色站在这里，会拒绝删除并返回 false。
   * 调用方负责先疏散角色。
   */
  removeLocation(id: string): boolean {
    const loc = this._state.locations.get(id);
    if (!loc) return false;
    if (loc.presentCharacters.length > 0) return false;
    this._state.locations.delete(id);
    return true;
  }

  /** 删除角色（连带从所在地点的 presentCharacters 移除）。 */
  removeCharacter(id: string): boolean {
    const c = this._characters.get(id);
    if (!c) return false;
    const loc = this._state.locations.get(c.locationId);
    if (loc) {
      loc.presentCharacters = loc.presentCharacters.filter((cid) => cid !== id);
    }
    this._characters.delete(id);
    return true;
  }

  // --- 角色 ---

  addCharacter(id: string, name: string, locationId: string, needs?: Record<string, number>, life?: LifeState, gender?: string): void {
    const merged: CharacterNeeds = { ...getDefaultNeeds() };
    if (needs) {
      for (const [k, v] of Object.entries(needs)) {
        if (v !== undefined) merged[k] = v;
      }
    }
    const state: CharacterState = {
      id,
      name,
      gender,
      locationId,
      needs: merged,
      gold: 100,
      life,
      moodlets: [],
      inbox: [],
      inventory: [],
      recentActions: [],
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

  /** 每 tick 衰减所有角色的需求值（数据驱动，遍历定义列表） */
  decayNeeds(): void {
    const decayRates = getDecayRates();
    for (const character of this._characters.values()) {
      for (const [needId, delta] of Object.entries(decayRates)) {
        if (character.needs[needId] !== undefined) {
          character.needs[needId] = Math.max(0, Math.min(100, character.needs[needId] + delta));
        }
      }
    }
  }

  /** 修改角色需求值 */
  modifyNeed(characterId: string, need: string, delta: number): void {
    const character = this._characters.get(characterId);
    if (!character) return;
    if (character.needs[need] === undefined) return;
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

  /** 设置角色当前可观察状态 */
  setObservableState(characterId: string, observableState?: CharacterObservableState): void {
    const character = this._characters.get(characterId);
    if (!character) return;
    character.observableState = observableState;
  }

  /** 获取当前仍有效的可观察状态；过期会自动清除 */
  getObservableState(characterId: string, tick = this._state.tick): CharacterObservableState | undefined {
    const character = this._characters.get(characterId);
    if (!character?.observableState) return undefined;
    if (character.observableState.expiresAt < tick) {
      character.observableState = undefined;
      return undefined;
    }
    return character.observableState;
  }

  clearObservableState(characterId: string): void {
    const character = this._characters.get(characterId);
    if (!character) return;
    character.observableState = undefined;
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
