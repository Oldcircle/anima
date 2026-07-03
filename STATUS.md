# STATUS — 会话交接文档

> 每次有实质进展时更新。记录当前进度和下次继续的入口，不是日志。
> （旧 STATUS.md 因 gitignore 未入仓而丢失，本文件 2026-07-03 重建，开发文档已全部入仓）

## 当前状态（2026-07-03）

### 后端 / 模拟核心

**叙事系统 N0-N6 + Director Agent 化 D1/D2/D4 全部完成并合并 main。**

- 规则导演 (BeatEngine) + LLM 导演 (Director) 双层架构
- Director Agent 化：4 个 read 工具 + tool loop + pulse 反馈闭环 + agenda 跨 invoke 工作记忆 + seed_topic 话题注入
- scenario pack 5 剧本可切换（default / mygo-seaside / koukou-judgment / last-ferry / seaside-trio）
- 玩家可通过 web 叙事面板塞纸条、注入事件、触发 director
- 下一个后端方向：PLAN-tool-feedback.md（Tool Feedback Loop 改造，未开工）

### Godot 游戏前端（godot/）——「世界 2.0」

P0~P4 主干完成（详见 [PLAN-game-frontend.md](./PLAN-game-frontend.md) 状态区 + [godot/README.md](./godot/README.md)）：

- **美术**：Ninja Adventure（CC0）日式 RPG 像素风 + 缝合像素字体（OFL）
- **世界**：72x40 大地图（树墙边界/沙滩/海/池塘/围栏农田/栈桥吊机渔船/鸟居樱花广场）
- **室内**：13 个房间（6 商铺公共 + 7 住宅），点建筑进入、ESC 返回、占位小人徽章
- **系统**：AStarGrid2D 寻路、相机拖拽缩放跟随（自动跟进室内）、昼夜染色 + 夜景灯光、
  BGM 昼夜双曲、天气特效（雨/雪/阴）、JRPG 底部对话框、调速面板（P4）、详情面板离线可用
- **验证**：`godot --path godot -- --shot [--day] [--wide] [--rain] [--room <id>]` 离线渲染（零 LLM 成本）

### 未完成 / 下次入口

1. **live 回归**（优先）：`pnpm dev` 起真后端 + Godot F5，验证寻路/室内/徽章/对话框在真实
   tick 流下的表现。⚠️ tick 烧 DeepSeek token，看完必须 `lsof -ti:3001 | xargs kill -9`
2. **叙事控制进 Godot**（P4 剩余）：塞纸条/注入事件/触发 director（HTTP `src/api/narrative-routes.ts`），
   做成 JRPG 菜单
3. **其他剧本前端适配**：mygo-seaside / koukou-judgment 的角色皮肤映射（`Main.gd CHAR_SKINS`）
   与地图布局（`Town.gd LAYOUT/ROOMS`），未知角色/地点现在走兜底（哈希皮肤 + 沙滩排开）
4. 后端：PLAN-tool-feedback.md 的 Tool Feedback Loop 改造

## 关键教训（跨会话必读）

- **图集裁片必须先验证**：Ninja Adventure 图集里建筑/道具紧挨着排，新 region 必须先 PIL
  裁片放大确认边界；"半截贴图"两种成因 = 区域裁到邻居 / 贴图本身是组合件碎块
- **停后端按端口杀**：`lsof -ti:3001 | xargs kill -9`（pkill 匹配不到 pnpm 真实进程名会残留偷跑烧钱）
- **Godot CLI 用绝对路径**：`godot --path <绝对路径>`（shell cwd 会被重置，`--path .` 指错会开
  项目管理器空转卡死）
