# Anima Town — Godot 前端（观看窗口）

Anima 的可视化前端：消费后端 WebSocket，把 AI 角色渲染成**日式 RPG 像素小镇**里走动的精灵。
**后端零改动**——Godot 只是又一个 WS 客户端（与 `web/` HTML 面板并存）。

- 完整设计与分期：[../PLAN-game-frontend.md](../PLAN-game-frontend.md)
- 引擎：Godot **4.6**（用 `WebSocketPeer`、`TileMapLayer`）
- 后端消息定义：`../src/api/server.ts`
- 美术：**Ninja Adventure**（CC0）+ 缝合像素字体（OFL），来源与许可见 [assets/README.md](assets/README.md)

## 当前阶段：P0 + P1a + P1b + P2 + 昼夜

- **P0** 数据流：连后端收 `snapshot`/`tick`
- **P1a** 小镇布局：18 地点 + 7 角色随 `locationId` 移动
- **P1b 真美术（2026-07-03）**：Ninja Adventure 像素小镇——瓦片地形（草地/沙滩/海/土路）、
  日式建筑（拉面店/居酒屋/鸟居/茅顶图书馆）、樱花树、码头小船、干草农田；
  角色 = 16px 四方向行走动画精灵 + 影子 + 像素情绪 emote；全局中文像素字体
- **P2 有灵魂**：想法/对话气泡（JRPG 对话框样式）+ 情绪 emote + 动作标签 + 点角色弹详情（带像素头像）
- **昼夜氛围**：按后端 `formattedTime` 时段词染色（白天/清晨/傍晚/晚上/深夜），夜里亮暖窗光与灯笼辉光
- **待办**：P4 控制（调速/叙事）、角色走路寻路（现在是直线 tween）

## 跑起来

**方式 A — 离线预览（不用后端，看美术）**
1. Godot 4.6 打开本 `godot/` 目录
2. `F5` 运行 → 3 秒后自动用假数据渲染小镇（零 LLM 成本），1.4 秒后有两人走动演示

**方式 B — 接真后端（看活的模拟）**
1. 仓库根 `pnpm dev`（默认 `http://localhost:3001`）
2. Godot `F5` → 角色随真实剧情移动、冒真实内心独白/对话
3. 看完停后端：**`lsof -ti:3001 | xargs kill -9`**（别用 pkill，匹配不到会残留偷跑烧 token）

**截图（给开发看效果）**：
- `godot --path . -- --shot` → 渲染一张夜晚 `shot.png` 后自动退出
- `godot --path . -- --shot --day` → 白天版
- 效果参考：[docs/shot_night.png](docs/shot_night.png) / [docs/shot_day.png](docs/shot_day.png)

## 现在能看到什么

海边小镇：南边是沙滩和海（有码头和小船），中间广场（樱花树 + 鸟居 + 石灯笼），
四周拉面店/居酒屋/杂货铺/面包坊/图书馆/农田/森林，东侧两列住宅。
7 个像素角色四方向走动，头顶冒 JRPG 风想法/台词气泡 + 情绪 emote，脚下有动作标签；
点角色右侧弹详情面板（像素头像 + 需求/情绪/关系/记忆/印象）。晚上全镇染蓝、暖光亮起。

## 文件

| 文件 | 作用 |
|---|---|
| `project.godot` | 工程配置：主场景、像素采样、全局中文像素字体 |
| `Main.tscn` / `Main.gd` | 入口：连 WS + 组装场景 + 角色皮肤映射 + 昼夜染色 + 离线演示 |
| `net/WebSocketClient.gd` | WS 客户端，解析后端消息 → 信号 |
| `world/Town.gd` | 小镇：瓦片地形 + 建筑/树木图章 + 灯光 + 地点站位（40x23 tile） |
| `world/CharacterView.gd` | 角色：四方向动画精灵 + 名牌 + JRPG 气泡 + emote + 点击 |
| `ui/DetailPanel.gd` | 详情面板（像素头像 + 属性/记忆/关系） |
| `assets/ninja_adventure/` | 美术素材子集（CC0，见 assets/README.md） |
| `assets/fonts/` | 缝合像素字体 12px 简中（OFL） |

## 换剧本 / 加角色皮肤

- 已知 7 角色的皮肤映射在 `Main.gd` 的 `CHAR_SKINS`；未知角色自动从 `FALLBACK_SKINS` 按 id 哈希取
- 未知地点自动沿沙滩排开（不至于崩，但建议给新剧本在 `Town.gd` 的 `LAYOUT` 补布局）
- 加皮肤：从 Ninja Adventure 完整包复制 `<角色>/{Idle,Walk,Faceset}.png` 到
  `assets/ninja_adventure/characters/<皮肤名>/`（Idle 64x16、Walk 64x64，列=下/上/左/右）
