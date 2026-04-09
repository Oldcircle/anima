/**
 * 一次性导入脚本：扣扣审判酒馆角色卡 → Anima scenario
 *
 * Usage:
 *   pnpm tsx scripts/import-koukou-card.ts
 *
 * 输入: /tmp/card_chara.json (从 PNG 解出来的卡 JSON，~1.3MB)
 * 输出: data/scenarios/koukou-judgment/__generated__/ 下的 yml 骨架
 *
 * 设计原则:
 * - 只做"机器能稳定做"的事：从已结构化的字段直接转 yml
 * - 不试图自动生成 beats / lore / world.yml — 那些需要人工设计
 * - 输出全部带 # AUTO-GENERATED 头注释，便于区分手工 vs 自动
 *
 * 后续 N6.1-N6.3 步骤会在 __generated__ 之外的位置手工补充正式文件，
 * __generated__ 是参考素材库，不被 CLI 直接加载。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CARD_PATH = "/tmp/card_chara.json";
const OUTPUT_DIR = join(ROOT, "data", "scenarios", "koukou-judgment", "__generated__");

const HEADER = `# AUTO-GENERATED from /tmp/card_chara.json by scripts/import-koukou-card.ts
# 不要手工编辑这里的文件 — 它们是参考素材。
# 正式 scenario 文件在 data/scenarios/koukou-judgment/ 根目录下。
`;

interface BookEntry {
  comment?: string;
  keys?: string[];
  content?: string;
  position?: string;
  constant?: boolean;
}

interface CardData {
  data: {
    name?: string;
    character_book?: { entries?: BookEntry[] };
  };
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeFile(relPath: string, content: string) {
  const full = join(OUTPUT_DIR, relPath);
  ensureDir(dirname(full));
  writeFileSync(full, HEADER + "\n" + content);
  console.log(`  📄 ${relPath} (${content.length} bytes)`);
}

// ── id 映射 ──
// 14 角色按原卡日文姓 → 拼音 id
const CHARACTER_ID_MAP: Record<string, string> = {
  艾玛: "ema",
  希罗: "hiro",
  雪莉: "shelly",
  安安: "anan",
  米莉亚: "milia",
  奈叶香: "nayaka",
  玛格: "marg",
  梅露露: "melulu",
  诺亚: "noah",
  蕾雅: "leya",
  亚里沙: "arisa",
  汉娜: "hanna",
  月代雪: "yukio",  // 月代 = surname, 雪 = name
  可可: "coco",
};

function characterEntryName(comment: string): string | null {
  // "1️⃣角色详情 - 艾玛" → "艾玛"
  const m = comment.match(/角色详情\s*-\s*(.+)$/);
  if (!m) return null;
  // 处理 "橘雪莉" "城崎诺亚" "紫藤亚里沙" "夏目安安" 等姓名组合 — 取最后一段名字做匹配
  const fullName = m[1].trim();
  for (const [key, id] of Object.entries(CHARACTER_ID_MAP)) {
    if (fullName.includes(key)) return id;
  }
  return null;
}

function entryById(entries: BookEntry[], comment: string): BookEntry | undefined {
  return entries.find((e) => e.comment === comment);
}

// ── 主流程 ──

async function main() {
  console.log("📖 读取扣扣审判卡...");
  const raw = readFileSync(CARD_PATH, "utf-8");
  const card: CardData = JSON.parse(raw);
  const entries = card.data?.character_book?.entries ?? [];
  console.log(`  ${entries.length} 条 character_book entries\n`);

  ensureDir(OUTPUT_DIR);
  writeFile("README.md", `# 扣扣审判 — 自动生成参考素材

由 \`scripts/import-koukou-card.ts\` 从 \`/tmp/card_chara.json\` 一次性生成。

## 内容

- \`characters/\` — 14 个角色的原卡 yml 内容（带注释，便于人工改写）
- \`locations.raw.yml\` — 监狱洋馆原始结构
- \`world.raw.yml\` — 世界观原始内容
- \`chapters/A1_C1.raw.yml\` — 第一章原始大纲（日常+案发+审判+处刑）
- \`metadata.raw.yml\` — 角色 id 映射 + 章节列表

## 使用方式

人工写正式 scenario 文件时**对照**这里的内容。**不要**直接 cp 到正式目录。
`);

  // ── 1. 角色 ──
  console.log("👥 提取角色...");
  let charCount = 0;
  for (const e of entries) {
    if (!e.comment) continue;
    const id = characterEntryName(e.comment);
    if (!id) continue;
    if (!e.content) continue;

    const md = `# 角色: ${id}
# 原卡 entry: ${e.comment}

${e.content.trim()}
`;
    writeFile(`characters/${id}.raw.md`, md);
    charCount++;
  }
  console.log(`  共 ${charCount} 个角色卡导出到 characters/\n`);

  // ── 2. 地点（监狱公馆） ──
  console.log("🏠 提取地点...");
  const prison = entryById(entries, "1️⃣监狱公馆");
  if (prison?.content) {
    writeFile("locations.raw.yml", prison.content);
  }

  // ── 3. 世界观 ──
  console.log("🌍 提取世界观...");
  const world = entryById(entries, "1️⃣世界观[mvu_plot]");
  const stage = entryById(entries, "1️⃣舞台背景[mvu_plot]");
  let worldOut = "";
  if (world?.content) worldOut += "## 世界观\n" + world.content + "\n\n";
  if (stage?.content) worldOut += "## 舞台背景\n" + stage.content + "\n";
  if (worldOut) writeFile("world.raw.yml", worldOut);

  // ── 4. 监管者 ──
  console.log("👁️  提取监管者...");
  for (const c of ["1️⃣典狱长", "1️⃣看守"]) {
    const e = entryById(entries, c);
    if (e?.content) {
      const id = c.includes("典狱长") ? "warden" : "guard";
      writeFile(`npcs/${id}.raw.md`, `# NPC: ${id}\n# 原 entry: ${c}\n\n${e.content}`);
    }
  }

  // ── 5. 第一章大纲 ──
  console.log("📜 提取第一章 (A1_C1)...");
  const c1Entries = ["A1_C1_总览", "A1_C1_日常", "A1_C1_案发搜查", "A1_C1_审判", "A1_C1_处刑尾声"];
  let chapterOut = "";
  for (const c of c1Entries) {
    const e = entryById(entries, c);
    if (e?.content) {
      chapterOut += `\n# ====== ${c} ======\n\n${e.content}\n`;
    }
  }
  if (chapterOut) writeFile("chapters/A1_C1.raw.yml", chapterOut);

  // ── 6. 牢房分配 + 食物 + 衣物等结构性设定 ──
  console.log("📋 提取结构性设定...");
  const structural = ["1️⃣牢房分配[mvu_plot]", "1️⃣食物[mvu_plot]", "1️⃣衣物设定[mvu_plot]", "1️⃣审判规则[mvu_plot]", "1️⃣证据搜查规则[mvu_plot]"];
  let structOut = "";
  for (const c of structural) {
    const e = entryById(entries, c);
    if (e?.content) structOut += `\n# ====== ${c} ======\n${e.content}\n`;
  }
  if (structOut) writeFile("rules.raw.yml", structOut);

  // ── 7. metadata ──
  const characterIds = Object.values(CHARACTER_ID_MAP);
  writeFile(
    "metadata.raw.yml",
    `# 角色 id 映射（中文 → anima id）
character_id_map:
${Object.entries(CHARACTER_ID_MAP).map(([k, v]) => `  ${k}: ${v}`).join("\n")}

# 全部角色 id 列表
all_character_ids: [${characterIds.map((id) => `"${id}"`).join(", ")}]

# 第一周目章节顺序
first_loop_chapters:
  - A1_C1  # 一周目第一章 — 诺亚之死
  - A1_C2
  - A1_C3
  - A1_C4
  - A1_C5

# 阶段顺序（每章）
phase_order:
  - peaceful   # 日常
  - investigation  # 案发搜查
  - trial   # 审判
  - execution  # 处刑尾声

# 第一章关键信息
A1_C1_summary:
  victim: noah
  culprit: leya
  murder_method: 临时长枪刺杀（扫帚柄+剑+剑鞘+弩箭+发带组合）
  core_trick: 视线固定魔法制造密室假象
  duration_days: 5  # 日常 5 天
`,
  );

  console.log("\n✅ 导入完成。");
  console.log(`输出目录: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("❌ 导入失败:", err);
  process.exit(1);
});
