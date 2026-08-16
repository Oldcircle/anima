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
  Appointment,
} from "./types.js";
import type { LifeState } from "../character/types.js";
import { tickToGameTime, type GameTime } from "../core/tick-engine.js";
import { getDefaultNeeds, getDecayRates } from "./need-definitions.js";
import { NarrativeState } from "../narrative/narrative-state.js";
import { WorldObjectStore } from "./world-objects.js";

export class World {
  private _state: WorldState;
  private _characters: Map<string, CharacterState> = new Map();
  /** 叙事状态命名空间（N2 引入）。与 needs/relationships 平级。 */
  readonly narrative: NarrativeState;
  /** 器物层（PLAN-grounding M0）：地点招牌器物的 ground truth 存储 */
  readonly objects: WorldObjectStore;

  /**
   * kira-incident 剧本状态（诅咒之册）。瞬态不入档（v1：一次 sim 跑完整个事件，
   * 中途存读档丢 pending 可接受——只丢一夜未应验的打击，TODO 若剧本转常驻再补列）。
   * - pending：已写下、待次日 06:00 应验的名字
   * - total/victims：已应验计数（升级钩子用）；lastStrikeDay：每晚一次冷却
   */
  readonly kira = {
    pending: [] as { by: string; target: string; judgment: string; writtenDay: number }[],
    total: 0,
    victims: [] as string[],
    lastStrikeDay: -1,
    /** 真名保护（正典核心张力）：这些角色的镇上称呼是化名，写不动（manifest kira.alias_protected） */
    aliasProtected: new Set<string>(),
  };

  constructor(locations: Location[], initialTick = 0) {
    this._state = {
      tick: initialTick,
      weather: "sunny",
      locations: new Map(locations.map((l) => [l.id, { ...l, presentCharacters: [...l.presentCharacters] }])),
    };
    this.narrative = new NarrativeState();
    this.objects = new WorldObjectStore();
    for (const l of locations) this.objects.registerLocation(l);
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
    // 器物层同步登记（幂等：已有动态状态保留）
    this.objects.registerLocation(loc);
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

  /**
   * 每 tick 衰减所有角色的需求值（数据驱动，遍历定义列表）
   *
   * 睡眠时身体需求衰减减半（hunger/bladder/hygiene）—— 模拟真人睡觉时
   * 代谢变慢。energy 不变（睡觉本来就是为了恢复 energy）。
   */
  decayNeeds(): void {
    const decayRates = getDecayRates();
    const SLEEP_SLOWDOWN_NEEDS = new Set(["hunger", "bladder", "hygiene"]);
    for (const character of this._characters.values()) {
      // B3/§4.5 NPC 生存豁免：世界注入的静态 NPC 不掉 needs
      // （否则恶人 NPC 一天内饿倒瘫痪，变成全镇围观的可怜人）
      if (this.narrative.isStaticNpc(character.id)) continue;
      const isAsleep = character.currentAction?.name === "sleep";
      for (const [needId, delta] of Object.entries(decayRates)) {
        if (character.needs[needId] === undefined) continue;
        let effectiveDelta = delta;
        if (isAsleep && SLEEP_SLOWDOWN_NEEDS.has(needId)) {
          effectiveDelta = delta * 0.5; // 睡眠时减半
        }
        character.needs[needId] = Math.max(0, Math.min(100, character.needs[needId] + effectiveDelta));
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

  /** D3: 给角色塞一个"想聊的话题"，talk prompt 会引导围绕它展开 */
  addWantToDiscuss(
    characterId: string,
    topic: string,
    urgency: "low" | "med" | "high",
    targetChar: string | undefined,
    tick: number,
    expiresIn = 12,
  ): boolean {
    const character = this._characters.get(characterId);
    if (!character) return false;
    if (!character.wantToDiscuss) character.wantToDiscuss = [];
    // 上限 3 个话题
    if (character.wantToDiscuss.length >= 3) character.wantToDiscuss.shift();
    character.wantToDiscuss.push({
      topic,
      urgency,
      targetChar,
      createdTick: tick,
      expiresAt: tick + expiresIn,
    });
    return true;
  }

  /** D3: 获取仍有效的话题列表（自动清理过期的） */
  getWantToDiscuss(
    characterId: string,
    tick = this._state.tick,
    talkingTo?: string,
  ): import("./types.js").WantToDiscuss[] {
    const character = this._characters.get(characterId);
    if (!character?.wantToDiscuss) return [];
    character.wantToDiscuss = character.wantToDiscuss.filter((w) => w.expiresAt >= tick);
    return character.wantToDiscuss.filter(
      (w) => !w.targetChar || w.targetChar === talkingTo,
    );
  }

  // --- 约定系统 ---

  private _appointments: Appointment[] = [];

  /**
   * 记录一个约定。同一对角色只保留最新的 pending（新约替换旧约）；
   * 每人最多 3 个 pending（防工具滥用堆积）。
   */
  addAppointment(a: Appointment): boolean {
    const pendingCount = this._appointments.filter(
      (x) => x.status === "pending" && (x.proposerId === a.proposerId || x.targetId === a.proposerId),
    ).length;
    if (pendingCount >= 3) return false;
    // 同一对角色的旧 pending 被新约替换
    const pairKey = (x: { proposerId: string; targetId: string }) =>
      [x.proposerId, x.targetId].sort().join(":");
    this._appointments = this._appointments.filter(
      (x) => !(x.status === "pending" && pairKey(x) === pairKey(a)),
    );
    this._appointments.push(a);
    return true;
  }

  /** 该角色参与的、还没结算的约定（prompt 注入用），按时间先后排序 */
  getUpcomingAppointments(characterId: string, tick = this._state.tick): Appointment[] {
    return this._appointments
      .filter((a) => a.status === "pending")
      .filter((a) => a.proposerId === characterId || a.targetId === characterId)
      .filter((a) => a.atTick + 2 >= tick) // 宽限窗内仍提醒
      .sort((a, b) => a.atTick - b.atTick);
  }

  /** 到点需要结算的约定（含宽限窗内的） */
  getDueAppointments(tick = this._state.tick): Appointment[] {
    return this._appointments.filter((a) => a.status === "pending" && tick >= a.atTick);
  }

  /** 提前兑现窗内（还没到点）的约定：双方提前碰上聊上了可以直接算兑现 */
  getEarlyWindowAppointments(tick: number, windowTicks: number): Appointment[] {
    return this._appointments.filter(
      (a) => a.status === "pending" && tick < a.atTick && tick >= a.atTick - windowTicks,
    );
  }

  markAppointment(id: string, status: "kept" | "missed", missedBy?: string): void {
    const a = this._appointments.find((x) => x.id === id);
    if (a) {
      a.status = status;
      // 只在单方爽约时记缺席者（双爽约/角色缺失不填——压力图爽约计数据此排除）
      a.missedBy = status === "missed" ? missedBy : undefined;
    }
  }

  /** 全部约定（测试/面板用） */
  getAllAppointments(): ReadonlyArray<Appointment> {
    return this._appointments;
  }

  /** 读档：直接替换约定列表（跳过 addAppointment 的配额/替换校验） */
  restoreAppointments(list: Appointment[]): void {
    this._appointments = [...list];
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
