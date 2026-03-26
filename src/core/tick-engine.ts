/**
 * Tick Engine — 游戏时间系统
 *
 * 基础比率：现实 1 分钟 = 游戏 1 小时
 * 每个 tick = 游戏 15 分钟 = 现实 15 秒（1x 速率下）
 * 一个游戏日 = 96 个 tick
 */

export type TickSpeed = 0 | 0.25 | 0.5 | 1 | 2 | 5 | 10;

export interface TickEngineOptions {
  /** 初始游戏 tick（默认 0） */
  startTick?: number;
  /** 初始速率（默认 1） */
  speed?: TickSpeed;
  /** 每 tick 的回调 */
  onTick?: (tick: number, gameTime: GameTime) => void | Promise<void>;
}

export interface GameTime {
  /** 当前 tick */
  tick: number;
  /** 游戏天数（从 0 开始） */
  day: number;
  /** 游戏小时（0-23） */
  hour: number;
  /** 游戏分钟（0, 15, 30, 45） */
  minute: number;
  /** 季节（每季 28 天） */
  season: "spring" | "summer" | "autumn" | "winter";
  /** 季节内的天数（1-28） */
  seasonDay: number;
  /** 年份（从 1 开始） */
  year: number;
}

const TICKS_PER_DAY = 96;
const TICKS_PER_HOUR = 4;
const DAYS_PER_SEASON = 28;
const SEASONS: GameTime["season"][] = ["spring", "summer", "autumn", "winter"];

/** 1x 速率下每 tick 的现实毫秒 */
const BASE_TICK_INTERVAL_MS = 15_000;

export function tickToGameTime(tick: number): GameTime {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const tickInDay = tick % TICKS_PER_DAY;
  const hour = Math.floor(tickInDay / TICKS_PER_HOUR);
  const minute = (tickInDay % TICKS_PER_HOUR) * 15;

  const year = Math.floor(day / (DAYS_PER_SEASON * 4)) + 1;
  const dayInYear = day % (DAYS_PER_SEASON * 4);
  const seasonIndex = Math.floor(dayInYear / DAYS_PER_SEASON);
  const seasonDay = (dayInYear % DAYS_PER_SEASON) + 1;

  return {
    tick,
    day,
    hour,
    minute,
    season: SEASONS[seasonIndex]!,
    seasonDay,
    year,
  };
}

function timeOfDayLabel(hour: number): string {
  if (hour >= 0 && hour < 5) return "深夜";
  if (hour >= 5 && hour < 7) return "清晨";
  if (hour >= 7 && hour < 9) return "早上";
  if (hour >= 9 && hour < 12) return "上午";
  if (hour >= 12 && hour < 14) return "中午";
  if (hour >= 14 && hour < 17) return "下午";
  if (hour >= 17 && hour < 19) return "傍晚";
  if (hour >= 19 && hour < 22) return "晚上";
  return "深夜";
}

export function formatGameTime(gt: GameTime): string {
  const h = String(gt.hour).padStart(2, "0");
  const m = String(gt.minute).padStart(2, "0");
  const label = timeOfDayLabel(gt.hour);
  return `Y${gt.year} ${gt.season} D${gt.seasonDay} ${label} ${h}:${m}`;
}

export class TickEngine {
  private _tick: number;
  private _speed: TickSpeed;
  private _running = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _onTick?: (tick: number, gameTime: GameTime) => void | Promise<void>;

  constructor(options: TickEngineOptions = {}) {
    this._tick = options.startTick ?? 0;
    this._speed = options.speed ?? 1;
    this._onTick = options.onTick;
  }

  get tick(): number {
    return this._tick;
  }

  get speed(): TickSpeed {
    return this._speed;
  }

  get running(): boolean {
    return this._running;
  }

  get gameTime(): GameTime {
    return tickToGameTime(this._tick);
  }

  setSpeed(speed: TickSpeed): void {
    this._speed = speed;
    // 如果正在运行且不是暂停，重新调度下一个 tick
    if (this._running && speed > 0) {
      this._scheduleNext();
    }
  }

  /** 启动 tick 循环 */
  start(): void {
    if (this._running) return;
    this._running = true;
    if (this._speed > 0) {
      this._scheduleNext();
    }
  }

  /** 暂停 */
  pause(): void {
    this._speed = 0;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** 完全停止 */
  stop(): void {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** 手动推进 N 个 tick（用于测试和快进） */
  async runTicks(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this._executeTick();
    }
  }

  private _scheduleNext(): void {
    if (this._timer) {
      clearTimeout(this._timer);
    }
    if (this._speed === 0 || !this._running) return;

    const intervalMs = BASE_TICK_INTERVAL_MS / this._speed;
    this._timer = setTimeout(async () => {
      if (!this._running || this._speed === 0) return;
      await this._executeTick();
      if (this._running && this._speed > 0) {
        this._scheduleNext();
      }
    }, intervalMs);
  }

  private async _executeTick(): Promise<void> {
    this._tick++;
    const gameTime = tickToGameTime(this._tick);
    if (this._onTick) {
      await this._onTick(this._tick, gameTime);
    }
  }
}
