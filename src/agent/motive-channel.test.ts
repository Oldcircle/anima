import { describe, expect, it } from "vitest";
import { parseMotiveChannel } from "./motive-channel.js";

describe("motive-channel（私有通道两层动机行解析）", () => {
  it("解析标准全角分隔行", () => {
    const text = `他此刻又累又不想回家。
【表面】我就是想再坐一会儿，咖啡还没喝完。｜【真心】他在躲夜神月——刚才那句话让他觉得自己被看穿了。
所以他会留在咖啡馆。`;
    const m = parseMotiveChannel(text);
    expect(m).toBeDefined();
    expect(m!.surface).toBe("我就是想再坐一会儿，咖啡还没喝完。");
    expect(m!.hidden).toContain("躲夜神月");
    expect(m!.twoLayer).toBe(true);
  });

  it("容错半角 | 分隔", () => {
    const m = parseMotiveChannel("【表面】我去帮她搬东西。|【真心】他想在绫波面前刷存在感。");
    expect(m).toBeDefined();
    expect(m!.surface).toBe("我去帮她搬东西。");
    expect(m!.twoLayer).toBe(true);
  });

  it("「与表面一致」是诚实豁免：解析成功但 twoLayer=false", () => {
    for (const same of ["与表面一致", "与表面一致。", "同表面", "没有第二层", "无"]) {
      const m = parseMotiveChannel(`【表面】我饿了，去买个面包。｜【真心】${same}`);
      expect(m).toBeDefined();
      expect(m!.twoLayer).toBe(false);
    }
  });

  it("真心层只取到行尾，不吞后续正文", () => {
    const m = parseMotiveChannel(`【表面】我想去图书馆看书。｜【真心】他想避开明日香。
接下来他会调用 go_to。`);
    expect(m!.hidden).toBe("他想避开明日香。");
    expect(m!.hidden).not.toContain("go_to");
  });

  it("没有动机行 / 残缺行 → undefined（降级 legacy）", () => {
    expect(parseMotiveChannel("我今天想去海边走走，顺便看看有没有贝壳。")).toBeUndefined();
    expect(parseMotiveChannel("【表面】我想散步。")).toBeUndefined();
    expect(parseMotiveChannel("【表面】｜【真心】空表面。")).toBeUndefined();
  });

  it("实义的长真心层不会被误判为豁免", () => {
    const m = parseMotiveChannel("【表面】我只是顺路。｜【真心】他其实特意绕了两条街，就为了碰见她，但绝不会承认。");
    expect(m!.twoLayer).toBe(true);
  });
});
