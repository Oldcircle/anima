import { describe, it, expect } from "vitest";
import { TickEngine, tickToGameTime, formatGameTime } from "./tick-engine.js";

describe("tickToGameTime", () => {
  it("tick 0 = Y1 spring D1 00:00", () => {
    const gt = tickToGameTime(0);
    expect(gt.day).toBe(0);
    expect(gt.hour).toBe(0);
    expect(gt.minute).toBe(0);
    expect(gt.season).toBe("spring");
    expect(gt.seasonDay).toBe(1);
    expect(gt.year).toBe(1);
  });

  it("tick 48 = 中午 12:00", () => {
    const gt = tickToGameTime(48);
    expect(gt.hour).toBe(12);
    expect(gt.minute).toBe(0);
  });

  it("tick 96 = 第二天 00:00", () => {
    const gt = tickToGameTime(96);
    expect(gt.day).toBe(1);
    expect(gt.hour).toBe(0);
    expect(gt.seasonDay).toBe(2);
  });

  it("tick 2688 = 第 28 天结束，进入夏季", () => {
    // 28 天 * 96 tick = 2688
    const gt = tickToGameTime(2688);
    expect(gt.season).toBe("summer");
    expect(gt.seasonDay).toBe(1);
  });

  it("一年 = 4 季 × 28 天 × 96 tick = 10752 tick", () => {
    const gt = tickToGameTime(10752);
    expect(gt.year).toBe(2);
    expect(gt.season).toBe("spring");
    expect(gt.seasonDay).toBe(1);
  });

  it("tick 5 = 01:15", () => {
    const gt = tickToGameTime(5);
    expect(gt.hour).toBe(1);
    expect(gt.minute).toBe(15);
  });
});

describe("formatGameTime", () => {
  it("格式化为可读字符串", () => {
    const gt = tickToGameTime(48);
    expect(formatGameTime(gt)).toBe("Y1 spring D1 中午 12:00");
  });
});

describe("TickEngine", () => {
  it("初始 tick 为 0", () => {
    const engine = new TickEngine();
    expect(engine.tick).toBe(0);
  });

  it("可以设置初始 tick", () => {
    const engine = new TickEngine({ startTick: 100 });
    expect(engine.tick).toBe(100);
  });

  it("runTicks 推进指定步数", async () => {
    const ticks: number[] = [];
    const engine = new TickEngine({
      onTick: (tick) => { ticks.push(tick); },
    });

    await engine.runTicks(5);

    expect(engine.tick).toBe(5);
    expect(ticks).toEqual([1, 2, 3, 4, 5]);
  });

  it("gameTime 正确反映当前 tick", async () => {
    const engine = new TickEngine();
    await engine.runTicks(48);
    expect(engine.gameTime.hour).toBe(12);
    expect(engine.gameTime.minute).toBe(0);
  });

  it("pause 设置速度为 0", () => {
    const engine = new TickEngine({ speed: 2 });
    engine.pause();
    expect(engine.speed).toBe(0);
  });

  it("setSpeed 改变速度", () => {
    const engine = new TickEngine();
    engine.setSpeed(5);
    expect(engine.speed).toBe(5);
  });

  it("onTick 回调接收正确的 gameTime", async () => {
    let lastGameTime: any;
    const engine = new TickEngine({
      onTick: (_tick, gt) => { lastGameTime = gt; },
    });

    await engine.runTicks(1);
    expect(lastGameTime.tick).toBe(1);
    expect(lastGameTime.hour).toBe(0);
    expect(lastGameTime.minute).toBe(15);
  });
});
