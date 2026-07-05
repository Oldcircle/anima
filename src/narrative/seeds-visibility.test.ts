/**
 * Seeds 秘密可见性回归测试（活人感体检 P3）
 *
 * 回归锁：loadSeeds 曾把 YAML 的 snake_case 对象直接 cast 成 camelCase 类型，
 * `visible_to` 从未被读取 → applySeeds 的 `?? "*"` 兜底把所有剧本秘密泄漏给所有角色
 * （生产存档实测：配置 [asuka] 的私生子秘密落库成 "*"）。
 */

import { describe, it, expect } from "vitest";
import { loadScenario } from "./scenario-loader.js";

describe("last-ferry seeds 的秘密可见性", () => {
  const scenario = loadScenario("last-ferry", { projectRoot: process.cwd() });

  it("明日香的私生子秘密只有明日香自己可见", () => {
    const e = scenario.seeds?.unresolvedEvents?.find((x) => x.id === "asuka_real_reason_left");
    expect(e).toBeDefined();
    expect(e!.visibleTo).toEqual(["asuka"]);
  });

  it("绫波丽的绝症诊断只有绫波丽自己可见", () => {
    const e = scenario.seeds?.unresolvedEvents?.find((x) => x.id === "rei_terminal_diagnosis");
    expect(e).toBeDefined();
    expect(e!.visibleTo).toEqual(["rei"]);
  });

  it("公开事件（征收令）仍然全员可见", () => {
    const e = scenario.seeds?.unresolvedEvents?.find((x) => x.id === "forced_eviction_announcement");
    expect(e).toBeDefined();
    expect(e!.visibleTo).toBe("*");
  });
});
