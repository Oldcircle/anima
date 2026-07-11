# 酒馆 Fixtures 库

真实 SillyTavern 预设 / 角色卡 / 世界书，作为 ST 兼容重构的**符合性测试靶子**与**默认资源**。
loader/assembler/character-card 模块直接吃这些文件（见 `src/preset/`）。

## 目录

- `tavern-presets/`（11）— ST Chat Completion 预设（`prompts` + `prompt_order` + 采样参数）
  - 主力：`TGbreak-v3.1.1.json`(122)、`夏瑾 Pro 比邻星 1.90`(131)、`【明月秋青】5.2.2`(125)、
    `【Femiris】咕咕咕`(117)、`命定之诗 Kemini5`(89)、`Kemini 5.17`(79)、`Ark - Light V3.0`(66)、
    `【小猫之神】3.10`(60)、`Default`(12)
- `tavern-cards/`（12）— ST 角色卡（V3 PNG + JSON）：`魔法少女的扣扣审判1.1` / `魔法少女…恶堕` /
  `人生模拟器·诡异修仙界2.0` / `房东模拟器Z4.1` / `万域界修仙手札`(×2) / `Sgw_7`(+fable适配json) /
  `Ver_1.1` / `DOL` / `Seraphina`
- `tavern-worldbooks/`（7）— lorebook（marker `worldInfoBefore/After` 用）：`扣扣审判1.1` /
  `魔法少女…v2.7 ZOD` / `DOL` / `Eldoria` / `人生模拟器2.0` / `万域修仙` / `房东模拟器Z4.1`

## 来源与纪律

- 预设/卡/世界书**从 `projects/ai/fable/docs/resources/` 复制而来**（那是活跃的 ST 兼容项目，
  其 `scripts/playtest.ts` 依赖这些路径且文件未入 git）——**故此处是副本，勿反向删 Fable 原件**。
- `TGbreak-v3.1.1.json` / `Seraphina.png` 另外也来自本机 `vendor/ST`（SillyTavern 1.15.0 安装）。
- 这些是"真实酒馆产物"，可当 ground truth 输入；但**字节级"和 ST 完全一致"仍需对 live ST 跑 diff**
  （见 PLAN-tavern.md「验证口径」）。
