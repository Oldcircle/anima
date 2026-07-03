# Anima Town — Godot 前端（观看窗口）

Anima 的可视化前端：消费后端 WebSocket，把 AI 角色渲染成**日式 RPG 像素小镇**里走动的精灵。
**后端零改动**——Godot 只是又一个 WS 客户端（与 `web/` HTML 面板并存）。

- 完整设计与分期：[../PLAN-game-frontend.md](../PLAN-game-frontend.md)
- 引擎：Godot **4.6**（用 `WebSocketPeer`、`TileMapLayer`）
- 后端消息定义：`../src/api/server.ts`
- 美术：**Ninja Adventure**（CC0）+ 缝合像素字体（OFL），来源与许可见 [assets/README.md](assets/README.md)

## 当前阶段：世界 2.0（P0~P3 完整游戏化）

- **P0** 数据流：连后端收 `snapshot`/`tick`
- **P1 大地图**：72x40 瓦片小镇，树墙边界 + 草地/沙滩/海面/土路/池塘，
  日式建筑（拉面店/居酒屋/鸟居/茅顶图书馆）+ noren 布帘 + 围栏农田 + 长栈桥/吊机/渔船
- **P2 有灵魂**：想法/对话气泡（JRPG 样式）+ 情绪 emote + 动作标签 + 点角色弹详情（像素头像，离线也可用）
- **P3 完整游戏化（2026-07-03）**：
  - **室内场景 ×13**：咖啡馆/酒吧/图书馆/杂货店/面包坊/花店/7 栋住宅，各有墙面/地板/家具
    （书架、吧台、床铺、货架…）；点建筑进室内，ESC/按钮返回；建筑右上角挂"谁在里面"小人徽章
  - **寻路碰撞**：AStarGrid2D 网格寻路，建筑/树木/水面/家具是障碍，角色沿路网绕行
  - **相机系统**：拖拽平移 + 滚轮缩放 + 点角色跟随（跟随对象进出室内时镜头自动切换）
  - **昼夜氛围**：按 `formattedTime` 时段词染色，夜里暖窗光/灯笼辉光；室内始终亮灯
  - **BGM**：白天 Calm Village / 夜晚 Chill（Ninja Adventure 音乐，CC0），M 键开关
  - **天气特效**：rainy/stormy 雨幕、snowy 雪花、cloudy 压暗（跟随后端 weather 字段，中文显示）
  - **JRPG 底部对话框**：最近一条台词显示像素头像 + 名字 + 内容（7 秒自动隐藏）
  - beat 剧情横幅（JRPG 弹窗）
  - **P4 控制**：调速（暂停/1x/2x/5x，`speed_changed` 回执高亮）+ **叙事干预面板**
    （N 键或右上角"叙事"按钮：塞纸条/散布流言/注入事件/推进导演，走 HTTP，离线禁用发送）
- **待办**：其他剧本的皮肤与地图布局（mygo-seaside / koukou-judgment）

## 跑起来

**方式 A — 离线预览（不用后端，看美术）**
1. Godot 4.6 打开本 `godot/` 目录
2. `F5` 运行 → 3 秒后自动用假数据渲染小镇（零 LLM 成本），1.4 秒后有角色走动/进店演示

**方式 B — 接真后端（看活的模拟）**
1. 仓库根 `pnpm dev`（默认 `http://localhost:3001`）
2. Godot `F5` → 角色随真实剧情移动、冒真实内心独白/对话
3. 看完停后端：**`lsof -ti:3001 | xargs kill -9`**（别用 pkill，匹配不到会残留偷跑烧 token）

**截图（给开发看效果）**：`godot --path . -- --shot [--day] [--wide] [--rain] [--room <地点id>]`
→ 渲染一张 `shot.png` 后自动退出（默认夜晚广场；`--wide` 全图；`--room cafe` 咖啡馆室内）

## 操作

拖拽 = 平移相机 · 滚轮 = 缩放 · 点角色 = 跟随 + 详情面板 · 点建筑 = 进室内 ·
ESC = 关面板/返回小镇 · M = 音乐开关 · N = 叙事干预（塞纸条/流言/事件/推进导演）

## 素材坐标经验（重要）

图集里建筑/道具是紧挨着排的，**任何新 region 都必须先裁片放大人工确认边界再用**
（本项目踩过的坑：杂货店实际 4 格宽、面包坊在 23..25 不是 22..24、面包篮是 2x2 大图的碎块、
石柱是 1x3 含底座、完整圆岩在 (13,8,2,2) 而不是石堆中间）。
检查方法见仓库根 `PLAN-game-frontend.md` 或直接用 python PIL 裁片放大标注。

## 文件

| 文件 | 作用 |
|---|---|
| `project.godot` | 工程配置：主场景、像素采样、全局中文像素字体 |
| `Main.tscn` / `Main.gd` | 入口：连 WS + 相机操控 + 进出室内 + 皮肤映射 + 昼夜染色 + 离线演示 |
| `net/WebSocketClient.gd` | WS 客户端，解析后端消息 → 信号 |
| `world/Town.gd` | 世界：72x40 地形 + 建筑/树木 + 13 间室内 + AStarGrid2D 寻路 + 占位徽章 |
| `world/CharacterView.gd` | 角色：四方向动画精灵 + 沿途径点行走 + 名牌 + JRPG 气泡 + emote |
| `ui/DetailPanel.gd` | 详情面板（像素头像 + 属性/记忆/关系，离线用 tick 缓存） |
| `assets/ninja_adventure/` | 美术素材子集（CC0，见 assets/README.md） |
| `assets/fonts/` | 缝合像素字体 12px 简中（OFL） |

## 换剧本 / 加角色皮肤

- 已知 7 角色的皮肤映射在 `Main.gd` 的 `CHAR_SKINS`；未知角色自动从 `FALLBACK_SKINS` 按 id 哈希取
- 未知地点自动沿沙滩排开（不至于崩，但建议给新剧本在 `Town.gd` 的 `LAYOUT` 补布局）
- 加皮肤：从 Ninja Adventure 完整包复制 `<角色>/{Idle,Walk,Faceset}.png` 到
  `assets/ninja_adventure/characters/<皮肤名>/`（Idle 64x16、Walk 64x64，列=下/上/左/右）
