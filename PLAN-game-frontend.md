# Anima — 游戏前端设计文档 v4

> 星露谷风格像素 RPG 前端。使用 [Sunnyside World Asset Pack](https://danieldiggle.itch.io/sunnyside) (4.8/5 评分，作者 Daniel Diggle) 的官方示例地图。

## 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 模式 | 观察者优先，后续加玩家操控 | 先看 AI 涌现行为 |
| 引擎 | Phaser 3 | 原生 tilemap + sprite + camera |
| 构建 | Vite + TypeScript | 和后端一致 |
| 素材 | Sunnyside World V2.1 (16×16) | 4.8/5 评分、商用免费、星露谷风、自带示例地图 |
| 地图 | Sunnyside Room1 转 Tiled JSON | 作者亲手画的精美 86×48 地图，13 层 |
| 移动 | 后端 tile 坐标 + 前端逐帧插值 | 角色真正"在路上"，不是瞬移 |
| UI | HTML overlay | 面板/日志用 DOM，游戏画面用 Phaser |

## 素材来源

### 主素材：Sunnyside World V2.1
- 来源：https://danieldiggle.itch.io/sunnyside
- 协议：免费商用，可修改，附作者署名
- 位置：`web-game/assets/sunnyside/`

```
sunnyside/
├── Tileset/
│   ├── spr_tileset_sunnysideworld_16px.png    # 主 tileset (1024×1024, 64×64 个 16px tile)
│   └── spr_tileset_sunnysideworld_forest_32px.png  # 森林扩展
├── Characters/
│   ├── Human/  (IDLE/WALKING/RUN/SWIMMING/FISHING/MINING/...20+ 动作)
│   ├── Goblin/
│   └── Skeleton/
├── Elements/  (Plants/Crops/Animals/VFX)
└── UI/        (9-slice 框、图标)
```

### 角色 Spritesheet

`Characters/Human/WALKING/` 含 8 种发型 × 8 帧侧视行走（768×64 strip）：
- `base_walk_strip8.png` — 无发型基底
- `bowlhair_walk_strip8.png`, `curlyhair_walk_strip8.png`, `longhair_walk_strip8.png`, etc.
- `tools_walk_strip8.png` — 工具图层

**限制**：默认只有侧视方向。需要：
- 左/右行走 → 直接用 strip + 镜像
- 上/下行走 → 暂用 idle 帧 + 平移
- 未来可用 BETA `.aseprite` 源文件导出 4 方向（需 Aseprite 软件）

### 角色映射

| Anima 角色 | 发型 | 备注 |
|-----------|------|------|
| 灯 (tomori) | shorthair | 朴素 |
| 爱音 (anon) | curlyhair | 活泼 |
| 祥子 (sakiko) | longhair | 优雅 |
| 睦 (mutsumi) | bowlhair | 沉默 |
| 素世 (soyo) | mophair | 温柔 |

## 地图设计

### 来源：Sunnyside Room1 → Tiled JSON

转换脚本：`web-game/scripts/convert-room1-to-tiled.py`
输出：`web-game/assets/maps/seaside-town.json`

86×48 tile (1376×768 px)，13 个图层，由 `Sunnyside Room1.yy` 解码 GameMaker 压缩 tile 数据后转 Tiled 格式：

| 层 | 类型 | 用途 |
|----|------|------|
| clouds_02 | 背景 | 远景云 |
| land | 地面 | 草地、沙地、水（基础地形） |
| paths | 路径 | 石板/泥路 |
| shadows | 阴影 | 物体投影 |
| decoration_01 | 装饰 | 花、小物件 |
| forest | 树木 | 森林区 |
| building | 建筑 | 房屋主体 |
| walls | 墙壁 | 建筑墙 |
| decoration_02 | 装饰 | 桌椅、小物 |
| decoration_03 | 装饰 | 顶层小物 |
| cloud_shadow | 云影 | 云的阴影 |
| clouds_01 | 前景 | 飘动云 |
| Collisions | 碰撞 | 用户在 Tiled 中手动标注 |

### 16 个地点 tile 坐标

每个 location 在 Tiled 地图上有精确的 tile 坐标，后端 `go_to` 将基于这些坐标实现多 tick 行走。

```
森林 (forest)       — 左上角林区
农场 (farm)         — 右上角耕地
5 栋住宅 (home_*)   — 中部住宅区
图书馆 (library)    — 中左
花店 (flower_shop)  — 商业街
面包坊 (bakery)     — 商业街
咖啡馆 (cafe)       — 商业街
杂货店 (shop)       — 商业街
酒吧 (bar)          — 商业街
广场 (plaza)        — 中央
沙滩 (beach)        — 下方海岸
码头 (dock)         — 右下角
```

## 移动系统设计（前后端联动）

### 后端改动

1. Location YAML 新增 `tile` 字段：`tile: { x: 24, y: 15 }`
2. `CharacterState` 新增 `tileX`, `tileY` 字段
3. `go_to` 从瞬移改为设定 `destination`，每 tick 移动若干格
4. 到达目标 tile 范围后才切换 `locationId`
5. WebSocket tick 消息新增角色 tile 坐标

### 前端渲染

借鉴 agentic_collab 的逐帧插值：
- 每 tick 收到新 tile 坐标 `[x, y]`
- 精灵从当前位置向目标位置以 4px/帧 速度移动
- 根据移动方向播放对应行走动画（left/right/up/down-walk）
- 到达后停止动画，显示 idle 帧（朝最后移动方向）
- 头顶 emoji/状态 + 名字标签跟随移动

## 16 个 Location 坐标

存于地图 properties.locations（JSON 字符串），后端读取后用作 `go_to` 目标：

```
forest        (8,  8)    farm          (70, 8)
home_tomori   (12, 18)   home_anon     (22, 18)
home_sakiko   (35, 18)   home_mutsumi  (50, 18)
home_soyo     (65, 18)
library       (10, 28)   flower_shop   (25, 28)
bakery        (38, 28)   cafe          (50, 28)
shop          (68, 28)   bar           (68, 36)
plaza         (40, 36)   beach         (30, 42)
dock          (65, 42)
```

⚠️ 这些是初始猜测坐标。Sunnyside Room1 是作者画的固定地图，需要在 Tiled 里看实际建筑位置后调整。

## 旧版素材索引（已弃用，保留参考）

<details>
<summary>Kenney 16px 素材（v2 方案，已切换到 CuteRPG 32px）</summary>

### Tiny Town tilemap_packed.png (192×176, 12×11 grid, 16×16/tile)

见 git 历史 PLAN-game-frontend.md v2。

### Tiny Dungeon 角色 sprite

```
tile_0084: 紫帽法师(女) → 素世 (soyo)
tile_0085: 棕发少女     → 灯 (tomori)
tile_0086: 红棕发角色   → 祥子 (sakiko)
tile_0088: 棕发活泼     → 爱音 (anon)
tile_0098: 棕色安静     → 睦 (mutsumi)
```

</details>

## 目录结构

```
web-game/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── assets/
│   ├── kenney/                    ← 旧 16px 素材（保留）
│   ├── cuterpg/                   ← 新 32px 素材（从 agentic_collab 复用）
│   │   ├── tilesets/              ← CuteRPG tileset PNG 文件
│   │   └── characters/            ← 角色 spritesheet + atlas.json
│   └── maps/
│       └── seaside-town.json      ← Tiled 格式地图
└── src/
    ├── main.ts              # Phaser 初始化
    ├── config.ts            # 游戏配置（32px tile, 新地图尺寸）
    ├── types.ts             # WS 协议类型
    ├── tiles.ts             # tile 索引常量（适配 CuteRPG tileset）
    ├── scenes/
    │   ├── BootScene.ts     # 加载 CuteRPG tileset + 角色 atlas
    │   ├── TownScene.ts     # 主场景：Tiled 地图 + 角色 + camera + 碰撞
    │   └── UIScene.ts       # HUD：时间/面板/日志
    ├── objects/
    │   └── Character.ts     # 角色 sprite + 行走动画 + 名字 + 气泡
    └── systems/
        ├── WSClient.ts      # WebSocket 客户端
        └── WorldState.ts    # 前端世界状态（含 tile 坐标）
```

## 实施计划

### Phase 0: 素材与地图准备 ← 当前
- [ ] 拷贝 CuteRPG tileset 到 `assets/cuterpg/tilesets/`
- [ ] 拷贝角色 spritesheet + atlas 到 `assets/cuterpg/characters/`
- [ ] 研究 tileset 内容，确定各 tile 用途
- [ ] 程序化生成 Tiled JSON 海边小镇地图（含碰撞层）
- [ ] 选定 5 个角色精灵
- [ ] 用 Tiled 编辑器微调地图（用户手动）

### Phase 1: 前端升级
- [ ] BootScene 改为加载 CuteRPG tileset + Tiled JSON
- [ ] TownScene 改为 Tiled 地图渲染 + 碰撞层
- [ ] Character 改为 atlas spritesheet + 4 方向行走动画
- [ ] 移动系统：逐帧插值（4px/帧, 方向感知动画）
- [ ] 相机：拖拽平移 + 滚轮缩放 + 点击跟随
- [ ] HUD 保持现有 UIScene

### Phase 2: 后端物理化
- [ ] Location YAML 新增 `tile: {x, y}`
- [ ] CharacterState 新增 `tileX`, `tileY`
- [ ] `go_to` 改为多 tick 行走（每 tick 移动若干格）
- [ ] WebSocket tick 消息新增 tile 坐标
- [ ] 前端按 tick 坐标驱动移动（替代 locationId 变化触发）

### Phase 3: 打磨
- [ ] 建筑室内场景
- [ ] 天气粒子效果
- [ ] 角色 idle 动画
- [ ] 音效 / BGM

### Phase 4: 玩家模式
- [ ] WASD 移动
- [ ] 点击 NPC 对话
- [ ] 玩家 Agent 接口
