# 美术素材来源与许可

## ninja_adventure/ — Ninja Adventure Asset Pack

- 作者：[pixel-boy](https://pixel-boy.itch.io/ninja-adventure-asset-pack)（与 Anato Finnstark 合作）
- 许可：**CC0 1.0**（公有领域，可商用，无需署名——但作者欢迎署名）
- 来源：itch.io 官方页下载的完整包（2026-07-03），只保留本项目用到的子集：
  - `tilesets/` — 地形/建筑/自然物图集（16px tile）
  - `characters/<皮肤名>/` — 角色四方向精灵（`Idle.png` 64x16 四朝向单帧；`Walk.png` 64x64 列=朝向[下上左右] 行=4帧）+ `Faceset.png` 头像
  - `characters/Shadow.png` — 脚底影子
  - `emotes/` — 30 个情绪气泡（约 16px）
  - `items/` — 物品图标（送礼飞行动画等）
- 需要更多角色/怪物/音乐时回原包取（完整包 ~90MB，含 Actor/Audio/FX/Items/Ui）。

## fonts/ — 缝合像素字体 Fusion Pixel Font

- 作者：[TakWolf/fusion-pixel-font](https://github.com/TakWolf/fusion-pixel-font)
- 文件：`fusion-pixel-12px-proportional-zh_hans.otf`（12px 比例宽度、简中字库）
- 许可：**SIL OFL 1.1**（见同目录 `OFL.txt`）；字号用 12 的整数倍才不糊
- 用法：`project.godot` 的 `gui/theme/custom_font` 指到它，全部 Label/RichTextLabel 生效
