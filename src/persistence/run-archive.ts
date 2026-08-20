/**
 * Run Archive — 让 sim 长跑的世界活下来
 *
 * 缺口：`*.sim.test.ts` 那套 runner 跑完只写一份 markdown 战报，**世界本身不存**。
 * 于是一趟 40-60 分钟、烧 ¥2 的长跑，跑完编年史/器物/正典/案件全部蒸发——
 * 判读只能靠人肉翻 log，更不可能"打开这趟跑继续往下跑"。
 *
 * 这里把 runner 的世界存进 `data/runs/<label>-<时间戳>.db`，于是：
 * - **能用面板看**：`pnpm dev --load data/runs/xxx.db` 起服务，编年史/世界/提示词页直接读这趟跑
 * - **能续跑**：同一条命令就是"打开记录继续跑"
 * - **不打架**：写的是带时间戳的新文件，绝不碰主存档 `data/save.db`
 *
 * 存档失败绝不让长跑失败——跑都跑完了，不能因为写文件出错把战报也搭进去。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { saveGame } from "./save-load.js";
import type { Simulation } from "../agent/simulation.js";

/** 归档目录（相对项目根） */
export const RUNS_DIR_NAME = join("data", "runs");

/** 文件名安全的时间戳：20260820-152004 */
export function runStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把一趟 sim 跑的世界归档。返回存档路径；失败返回 undefined（不抛）。
 *
 * `label` 用来认出这是哪趟跑（如 `grounding-verify-r3`）。
 * `scenarioId` 必须传对——读档时有跨剧本护栏，标错了下次打不开。
 */
export function archiveRun(
  sim: Simulation,
  label: string,
  scenarioId: string,
  opts?: { projectRoot?: string; stamp?: string },
): string | undefined {
  try {
    const root = opts?.projectRoot ?? join(import.meta.dirname, "..", "..");
    const dir = join(root, RUNS_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    // 中文标签要留住（`[^\w-]` 会把汉字全吃成连字符，归档名就认不出是哪趟跑了）
    const safe = label.replace(/[^\w一-龥-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "run";
    const file = join(dir, `${safe}-${opts?.stamp ?? runStamp()}.db`);
    saveGame(sim, file, scenarioId);
    console.log(`\n💾 世界已归档：${file}`);
    console.log(`   打开它继续跑： pnpm dev --load ${file}`);
    return file;
  } catch (e) {
    console.error("💾 世界归档失败（战报仍在，只是这趟跑不能续）:", e);
    return undefined;
  }
}
