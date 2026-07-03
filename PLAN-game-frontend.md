# PLAN — 游戏前端（Godot + Ninja Adventure 像素小镇）

> 给 Anima 补一个"看得见的活小镇"前端。后端零改动，Godot 当**观看窗口**：
> 消费现有 WebSocket 流，把"谁在哪个地点"渲染成像素小镇里走动的精灵。

- **状态**：**P0 + P1a + P1b + P2 + 昼夜 完成**（P1b 于 2026-07-03 完成，`--shot` 日/夜双版验证 0 错误）：
  - P0 端到端连通（Godot 4.6.1 收 snapshot）
  - P1a 小镇布局（18 地点 + 7 角色随 locationId 移动）
  - **P1b 真美术**：美术从原计划 Tinyswords 改为 **Ninja Adventure**（CC0，和风 JRPG 像素，
    题材完全对口）：TileMapLayer 地形（草地/沙滩/海/土路）+ 日式建筑图章（拉面店/居酒屋/
    鸟居/茅顶图书馆）+ 樱花树/码头小船/农田；角色 16px 四方向行走动画 + 影子 + 像素 emote；
    全局中文像素字体（缝合像素 12px，OFL）。素材许可见 `godot/assets/README.md`
  - P2 有灵魂（想法/对话气泡 JRPG 样式 + 情绪 emote + 动作标签 + 详情面板带像素头像）
  - **昼夜氛围**（P3 部分）：按 `formattedTime` 时段词全镇染色（清晨/白天/傍晚/晚上/深夜），
    夜里暖窗光/灯笼辉光（灯光层不吃夜色染色）
  - **离线演示**：3 秒没连后端 → 假数据预览（零 LLM 成本）+ 1.4s 后假 tick 走动演示；
    `godot --path . -- --shot`（夜）/ `--shot --day`（昼）渲染 `shot.png`，参考图 `shot_night.png` / `shot_day.png`
  - **世界 2.0（2026-07-03 同日第二轮，响应"用完整游戏标准做"）**：72x40 大地图（树墙边界，
    无屏幕边裁切）+ 13 个室内场景（点建筑进入/ESC 返回/占位小人徽章）+ AStarGrid2D 寻路
    （建筑/树/水/家具为障碍）+ 相机拖拽缩放跟随（跟随自动进出室内）+ 栈桥/吊机/渔船/围栏农田/
    池塘/noren + beat 横幅 + 详情面板离线可用。`--shot [--day|--wide|--room <id>]` 四种验证截图
  - **同日第三轮（贴图自检 + 完整度）**：全图切块自检修掉所有半截贴图（杂货店实为 4 格宽、
    面包坊在 23..25、面包篮是 2x2 大图碎块、石柱 1x3、完整圆岩 (13,8)、海面误用"沉底沙丘
    圆圈"装饰水块→换纯水、叶簇误当灌木→换完整圆灌木）；新增 BGM（昼 Calm Village / 夜 Chill，
    M 键开关）、天气特效（雨幕/雪花/阴天压暗 + 中文天气显示）、JRPG 底部对话框（头像+名字+台词）、
    **P4 调速面板**（暂停/1x/2x/5x，speed_changed 回执高亮）
  - **图集经验（重要）**：图集里建筑/道具紧挨着排，任何新 region 必须先用 PIL 裁片放大
    人工确认边界再用；"看起来半截"的两种成因 = ①区域坐标裁到邻居 ②贴图本身是组合件的碎块
  - **同日第四轮（live 回归 + P4 收官 + 行为可视化 + 剧本适配）**：
    - live 回归通过（12 真实 tick / 零 SCRIPT ERROR / `--probe` 探针每 30s 自动截图）；
      据此把徽章移出地名标签、时钟改「春 第1天 · 清晨 06:15」格式
    - P4 叙事干预面板（N 键：塞纸条/散布流言/注入事件/推进导演，HTTP，接口已 curl 冒烟）
    - **行为可视化**：talk/gossip/comfort/argue/share_secret/invite_out/give_gift 触发
      "凑近对方 + 面对面"；give_gift 飞包裹 + 对方冒爱心 + 底部对话框播报；argue 怒/心碎；
      sleep/nap 困；skipped 冒"…"
    - **mygo-seaside 适配 + 通用住宅槽位**：未知 home_* 自动复用默认七宅空位（含室内/徽章），
      海边小镇类剧本零配置可用；MyGO 5 人皮肤入库
    - 修复：`godot --import` 必须搭配 `--path`，此前 BGM/新素材从未真正导入（M 键音乐是哑的）
  - 待办：koukou-judgment 监狱地图（25 专属地点，独立场景设计，另行立项）
- **决策基线**（2026-07-03 与用户确认；美术项已按用户"要日式 RPG 像素风"更新）：
  1. 美术：~~先纯 Tinyswords 出原型~~ → **Ninja Adventure（CC0）**，2026-07-03 已落地
  2. 地理：**Godot 自己造地图**，后端不加坐标
  3. 定位：**先做纯观看**，控制/CRUD 留给现有 `web/` HTML 面板

---

## 1. 第一性原理

后端是 **24 个命名地点的图**（默认剧本启用 18 个），角色只持有 `locationId`，
移动是 `go_to` 的**地点间跳转**，**没有任何 x/y 坐标、没有地图、没有寻路**。

> 所以：**后端权威 = "谁在哪个地点"；Godot 权威 = "地点在屏幕哪里、精灵怎么走过去"。**

Godot 把每个抽象地点摆成小镇里一栋楼/一片区域，tick 里 `locationId` 的变化
= 一次"有人搬家了"的动画事件。sim 不描述"在咖啡馆的哪个角落"，那些**店内微行为由 Godot 自己编**。

---

## 2. 工程落位

- **Godot 版本**：4.3+（用 `TileMapLayer`、`NavigationRegion2D`）
- **项目根**：`anima/godot/`（与后端同仓，方便同步；`.gitignore` 加 `godot/.godot/`）
- **后端**：不动。Godot 连 `ws://localhost:3001`（与现有 HTML 面板同一条 WS）
- **联调**：`pnpm dev` 起后端 → Godot 编辑器里跑 `Main.tscn`

---

## 3. 场景树结构

```
Main (Node2D)
├── World (Node2D)
│   ├── TownTileMap (TileMapLayer)        # Tinyswords 手工搭的镇
│   ├── NavRegion (NavigationRegion2D)    # 道路可走区域（供寻路）
│   ├── LocationZones (Node2D)            # 18 个 LocationZone 子节点
│   │   ├── zone_plaza (LocationZone)     # Area2D + 若干 Marker2D 站位
│   │   ├── zone_cafe  (LocationZone)
│   │   └── ...
│   └── Characters (Node2D)               # 运行时动态 spawn 的 CharacterView
├── DayNight (CanvasModulate)             # 昼夜染色
├── WeatherLayer (CanvasLayer)            # 下雨/阴天覆盖层
├── Camera2D                              # 拖拽/缩放 + 跟随
├── UI (CanvasLayer)
│   ├── Clock (Label)                     # formattedTime + 天气
│   ├── BeatBanner (Panel)                # beat_ready 横幅
│   └── CharacterPanel (Panel)            # 点角色弹出的详情
└── Net (Node)                            # WebSocketClient.gd（核心）
```

**可复用子场景**：
- `CharacterView.tscn` = `AnimatedSprite2D`（idle/walk/work…）+ `NameLabel` + `BubbleAnchor`(Marker2D) + `Area2D`(点击命中)
- `LocationZone.tscn` = `Area2D`（区域高亮/悬停）+ N 个 `Marker2D` 站位锚点 + `SignLabel`
- `Bubble.tscn` = 想法/对话气泡（`NinePatchRect` + `RichTextLabel`），带淡入淡出

---

## 4. WebSocket 消息 → 节点映射（**集成契约，核心**）

后端消息在 `src/api/server.ts`。**下行**（后端→Godot）：

| 消息 `type` | 时机 | 关键字段 | Godot 侧动作 |
|---|---|---|---|
| `snapshot` | 连接时一次 | `characters[]`、`locations[].presentCharacters`、`weather`、`gameTime` | 初始化：为每个角色 spawn `CharacterView`，直接放到其 `locationId` 对应 zone 的空站位 |
| `tick` | 每 tick | 见下方拆解 | 主循环：diff 位置→移动动画；刷新气泡/表情/时钟 |
| `beat_ready` | 剧情触发 | `beatId`、`description` | `BeatBanner` 弹 3–5 秒横幅 |
| `speed_changed` | 调速后回执 | `speed` | 更新 UI 调速状态（P4） |
| `character_detail` | 请求后返回 | 角色全量 + `memories`+`relationships`+`impressions` | 填充 `CharacterPanel` |

**`tick.data` 字段拆解**（每 tick 免费拿到的东西）：

| 字段 | → 表现 |
|---|---|
| `characters[].locationId` | **驱动移动**：与上一 tick 比对，变了就寻路走过去 |
| `characters[].currentAction` / `observableState.summary` | 精灵头顶动作标签 + 播对应动画 |
| `characters[].moodlets[]`（emotion+intensity） | 头顶表情图标（😊😠😢…），intensity 控大小/停留 |
| `characters[].needs` / `gold` / `life` | 点开 `CharacterPanel` 时展示 |
| `events[].thought` | **内心独白气泡**（sim 已生成，直接显示） |
| `events[].action == "talk"` + `args`/`targetId` | 对话气泡：说话者头顶显示，可连线到目标 |
| `events[].skipped` / `skipReason` | 可选：精灵头顶 "…" 表示这 tick 没动 |
| `gameTime` / `formattedTime` | `Clock` 文本 + `DayNight` 染色插值 |
| `weather` | `WeatherLayer`：rainy/stormy 下雨粒子，cloudy 压暗 |
| `relationships[]` | 关系图谱（P4 可视化，可选） |
| `nameMap` | id→名字兜底 |

**上行**（Godot→后端，仅 P4 控制需要）：
- `{type:"get_character", data:{id}}` → 触发 `character_detail`（点角色时用，P2 就要）
- `{type:"set_speed", data:{speed}}` → 调速（P4）
- 塞纸条 / 注入事件 / 触发 director 是 **HTTP** 路由（`registerNarrativeRoutes`，见 `src/api/narrative-routes.ts`），不是 WS —— P4 再接，v1 不碰

---

## 5. 地点分区表（18 地点 → 屏幕布局 + Tinyswords 资源）

海边小镇，海在南侧。**布局是 Godot 手工摆的，不来自后端**。

| locationId | 名称 | 类型 | 屏幕大致方位 | Tinyswords 资源 |
|---|---|---|---|---|
| `dock` | 码头 | nature | 南·水面 | 桥/木板 tile 伸入水中 |
| `beach` | 海边 | nature | 南·沙滩带 | 沙地 tile + 水+浪花 |
| `plaza` | 广场 | public | **正中心** | 草地/石板铺地 + 装饰 |
| `cafe` | 咖啡馆 | commercial | 中心环·东 | House 变体 + 招牌 |
| `bar` | 酒吧 | commercial | 中心环·东南 | House 变体 + 招牌 |
| `bakery` | 海风面包坊 | commercial | 中心环·西 | House 变体 + 招牌 |
| `shop` | 杂货店 | commercial | 中心环·西南 | House 变体 + 招牌 |
| `flower_shop` | 潮声花店 | commercial | 中心环·北 | House + 花丛装饰 |
| `library` | 图书馆 | public | 中心环·东北 | 最大建筑（Castle 改绿顶） |
| `farm` | 农田 | nature | 内陆·西北 | 栅栏围草地 + 树/羊（无耕地 tile，见风险） |
| `forest` | 森林 | nature | 内陆·北 | 密集 Tree 资源 |
| `home_*`（×7） | 各角色住宅 | 虚拟 | 住宅区·东侧一排 | 7 栋小 House（不同颜色顶） |

> `home_asuka / home_l / home_lelouch / home_light / home_rei / home_senjougahara / home_shinji`
> 是后端为 7 角色动态生成的家，不是 yml 文件；Godot 侧同样建 7 个 zone。

每个 zone 内放 **3–6 个 `Marker2D` 站位**（角色扎堆时用；不够就动态挤）。

---

## 6. 角色精灵映射（7 位 → Tinyswords 占位）

Tinyswords 人形单位有限（Warrior / Archer / Pawn + 蓝/红/紫/黄 队色 + 哥布林）。
**v1 用它们当占位**，不追求神似；P3 再决定是否换动漫人物包。

| 角色 id | 名称 | 占位精灵（示意，可调） |
|---|---|---|
| `asuka` | 明日香 | Warrior · 红 |
| `l_lawliet` | L | Pawn · 紫 |
| `lelouch` | 鲁鲁修 | Archer · 紫 |
| `light` | 夜神月 | Warrior · 黄 |
| `rei` | 绫波丽 | Pawn · 蓝 |
| `senjougahara` | 战场原黑仪 | Archer · 蓝 |
| `shinji` | 碇真嗣 | Pawn · 红 |

需要的动画状态（`AnimatedSprite2D`）：`idle` / `walk` / 通用 `action`（做事时播）。
Tinyswords 单位自带 idle/walk/attack 帧，attack 可复用为"做事"。

---

## 7. 移动与节奏（**唯一要小心的动态问题**）

sim tick 可被加速，角色可能"连跳"多个地点，比动画还快。方案：

- 每角色一个**移动队列**；`locationId` 变化入队。
- 用 `NavigationAgent2D` 沿 `NavRegion` 走"路"到目标 zone 的空站位，播 walk。
- 动画时长设**上限**（如 ≤1.2s）；若下一 tick 已到而还在走 → 直接 snap 到位再处理新目标，避免堆积。
- 到位后播 `action`/`idle`，弹当 tick 的 thought/talk 气泡。

> P1 可先用直线 `Tween`（不寻路）验证管线，P2 再换 `NavigationAgent2D` 走道路。

---

## 8. 分期里程碑

| 阶段 | 目标 | 交付 |
|---|---|---|
| **P0 · 连上** | Godot 连 WS，打印 `snapshot`/`tick` JSON | `WebSocketClient.gd` + 控制台可见世界心跳 |
| **P1 · 会动** | 手工搭镇 + 18 zone；角色 spawn；`locationId` 变化→直线 tween 移动 | 能看到小人在楼之间移动的最小可玩 |
| **P2 · 有灵魂** | thought/talk 气泡 + moodlet 表情 + 动作标签 + 点角色弹 `CharacterPanel` | "活起来"的观看体验（核心价值达成） |
| **P3 · 有观感** | 昼夜染色 + 天气层 + beat 横幅 + 相机 + 美术打磨（此处决定是否混包换皮） | 像样的 demo，可录屏分享 |
| **P4 · 能操控**（可选） | 调速 / 叙事控制接 WS+HTTP，或干脆嵌现有 HTML 面板 | 从"看"到"玩" |

**MVP 分界 = P2 完成**：能看着 7 个角色在小镇里走动、冒想法气泡、聊天、露表情——数据流全打通。

---

## 9. P0 起步骨架（GDScript 示意）

`godot/net/WebSocketClient.gd`：

```gdscript
extends Node
signal snapshot(data: Dictionary)
signal tick(data: Dictionary)
signal beat_ready(data: Dictionary)
signal character_detail(data: Dictionary)

var _ws := WebSocketPeer.new()
var _url := "ws://localhost:3001"

func _ready() -> void:
    _ws.connect_to_url(_url)

func _process(_dt: float) -> void:
    _ws.poll()
    var state := _ws.get_ready_state()
    if state == WebSocketPeer.STATE_OPEN:
        while _ws.get_available_packet_count() > 0:
            var txt := _ws.get_packet().get_string_from_utf8()
            var msg = JSON.parse_string(txt)
            if typeof(msg) == TYPE_DICTIONARY:
                _dispatch(msg)
    elif state == WebSocketPeer.STATE_CLOSED:
        # 断线重连
        _ws = WebSocketPeer.new()
        _ws.connect_to_url(_url)

func _dispatch(msg: Dictionary) -> void:
    match msg.get("type", ""):
        "snapshot": snapshot.emit(msg.get("data", {}))
        "tick": tick.emit(msg.get("data", {}))
        "beat_ready": beat_ready.emit(msg.get("data", {}))
        "character_detail": character_detail.emit(msg.get("data", {}))

func request_character(id: String) -> void:
    _ws.send_text(JSON.stringify({"type": "get_character", "data": {"id": id}}))

func set_speed(speed: float) -> void:
    _ws.send_text(JSON.stringify({"type": "set_speed", "data": {"speed": speed}}))
```

`Main.gd` 消费 `tick` 的骨架（伪代码级）：

```gdscript
func _on_tick(data: Dictionary) -> void:
    $UI/Clock.text = "%s  %s" % [data.formattedTime, data.weather]
    for c in data.characters:
        var view := _ensure_view(c.id, c.name)       # 没有就 spawn
        if view.location_id != c.locationId:          # 位置变了 → 移动
            view.move_to_zone(c.locationId)
        view.set_action_label(c.get("observableState", {}).get("summary", ""))
        view.set_moodlets(c.get("moodlets", []))
    for e in data.events:                             # 想法/对话气泡
        if e.thought: _spawn_thought_bubble(e.characterId, e.thought)
        if e.action == "talk": _spawn_talk_bubble(e.characterId, e)
```

---

## 10. 风险 / 待定

1. **美术题材错配**（最大观感风险）：Tinyswords 是中世纪奇幻 RTS 风，项目是现代海边动漫社交。
   - v1 接受"占位感"，P3 再决定：ⓐ 拥抱奇幻风重设定 / ⓑ Tinyswords 地形打底 + 混现代人物&建筑包（Ninja Adventure、Modern Interiors、LPC…）。
2. **农田无专用 tile**：Tinyswords 没有耕地贴图 → `farm` 只能栅栏+草+作物装饰凑，或后期补包。
3. **节奏解耦**：加速时"连跳"，见 §7 的移动队列 + 动画上限方案。
4. **站位拥挤**：一个热门地点可能挤很多人 → 站位锚点不够时动态环形排布。
5. **Godot 授权限制**：本机 computer-use 对 Godot 编辑器可能是 "click" 层（不能代打字），联调以人工操作为主，AI 出代码/配置。
6. **住宅是虚拟地点**：`home_*` 无 yml，Godot 侧要硬编码这 7 个 zone（或从 snapshot 的 `locations[]` 动态建——更稳，推荐）。

---

## 附：相关后端文件

- WS/HTTP 服务与广播 payload：`src/api/server.ts`
- 世界/地点/角色类型：`src/world/types.ts`
- 地点 yml：`data/locations/*.yml`（11 活跃公共 + prison 系列 disabled）
- 角色 yml：`data/characters/*.yml`（默认 7 个活跃）
- 叙事 HTTP 路由（P4 控制用）：`src/api/narrative-routes.ts`
