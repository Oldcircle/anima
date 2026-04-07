/** Frontend types — mirrors backend WS protocol */

export interface GameTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface CharacterSnapshot {
  id: string;
  name: string;
  locationId: string;
  needs: Record<string, number>;
  gold: number;
  currentAction?: { name: string; remainingTicks: number };
  observableState?: { actionName: string; summary: string; targetId?: string };
  life?: {
    occupation: string;
    workplace: string;
    age: number;
    income: number;
    skills: Record<string, number>;
    aspiration: string;
    currentGoal?: string;
    currentConcern?: string;
  };
  moodlets?: { emotion: string; intensity: number; reason: string }[];
  inventory?: { defId: string; name: string; type: string; quantity: number }[];
}

export interface Relationship {
  a: string;
  b: string;
  level: number;
  type: string;
  bond?: string;
}

export interface TickEvent {
  characterId: string;
  action: string;
  args?: Record<string, unknown>;
  description: string;
  observableState?: string;
  thought?: string;
  skipped?: boolean;
  success?: boolean;
}

export interface TickData {
  tick: number;
  gameTime: GameTime;
  formattedTime: string;
  characters: CharacterSnapshot[];
  events: TickEvent[];
  randomEvents: { name: string; description: string; affected: string[] }[];
  reflections: { characterId: string; insights: string; mood: string; wish?: string; concern?: string }[];
  weather: string;
  relationships: Relationship[];
  nameMap: Record<string, string>;
}

export interface SnapshotData {
  tick: number;
  gameTime: GameTime;
  formattedTime: string;
  weather: string;
  characters: CharacterSnapshot[];
  relationships: Relationship[];
  nameMap: Record<string, string>;
}
