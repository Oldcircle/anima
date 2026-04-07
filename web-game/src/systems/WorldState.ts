/** Frontend world state — updated by WSClient, read by scenes. */

import { LOCATIONS, TILE, type LocDef } from "../config";
import type { CharacterSnapshot, GameTime, Relationship, SnapshotData, TickData, TickEvent } from "../types";

export class WorldState {
  tick = 0;
  gameTime: GameTime = { year: 1, month: 1, day: 1, hour: 6, minute: 0 };
  formattedTime = "06:00";
  weather = "sunny";

  characters = new Map<string, CharacterSnapshot>();
  prevLocations = new Map<string, string>();
  relationships: Relationship[] = [];
  nameMap = new Map<string, string>();
  latestEvents: TickEvent[] = [];

  private locMap = new Map<string, LocDef>();

  constructor() {
    for (const loc of LOCATIONS) this.locMap.set(loc.id, loc);
  }

  applySnapshot(data: SnapshotData): void {
    this.tick = data.tick;
    this.gameTime = data.gameTime;
    this.formattedTime = data.formattedTime;
    this.weather = data.weather;
    this.relationships = data.relationships;
    for (const [k, v] of Object.entries(data.nameMap)) this.nameMap.set(k, v);
    for (const ch of data.characters) this.characters.set(ch.id, ch);
  }

  applyTick(data: TickData): void {
    for (const ch of this.characters.values()) this.prevLocations.set(ch.id, ch.locationId);
    this.tick = data.tick;
    this.gameTime = data.gameTime;
    this.formattedTime = data.formattedTime;
    this.weather = data.weather;
    this.relationships = data.relationships;
    this.latestEvents = data.events;
    for (const [k, v] of Object.entries(data.nameMap)) this.nameMap.set(k, v);
    for (const ch of data.characters) this.characters.set(ch.id, ch);
  }

  /** Get pixel position for a character at a location */
  getSpawnPixel(locationId: string, characterId: string): { x: number; y: number } {
    const loc = this.locMap.get(locationId);
    if (!loc) return { x: 400, y: 300 };

    const cx = loc.col * TILE + TILE / 2;
    const cy = loc.row * TILE + TILE / 2;

    // Deterministic spawn based on character index
    const present = [...this.characters.values()].filter((c) => c.locationId === locationId);
    const idx = Math.max(0, present.findIndex((c) => c.id === characterId));
    const spawn = loc.spawns[idx % loc.spawns.length];

    return { x: cx + spawn.dx, y: cy + spawn.dy };
  }

  didMove(charId: string): boolean {
    const prev = this.prevLocations.get(charId);
    const curr = this.characters.get(charId)?.locationId;
    return prev !== undefined && prev !== curr;
  }

  getName(id: string): string {
    return this.nameMap.get(id) ?? id;
  }

  getLoc(id: string): LocDef | undefined {
    return this.locMap.get(id);
  }
}
