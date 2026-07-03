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

1. ~~live 回归~~ ✅ **2026-07-03 已跑**（12 真实 tick / 约 3 分钟 / ~130 次 LLM 调用）：
   - 零 SCRIPT ERROR；气泡每 tick 想法 3-7 条、对话 0-4 条正常渲染
   - JRPG 底部对话框吃真实长台词并换行正常（真嗣/L/战场原实测）；调速面板连上后自动启用
   - 清晨时段全员在室内 → 镇面空、徽章正确显示屋内人数（符合设计，观看时点建筑进室内看）
   - 据此迭代：徽章移出地名标签区、时钟改「春 第X天 · 清晨 06:15」格式
   - 探针工具：`godot --path godot -- --probe`（连真后端 3 分钟，每 30s 存 shot_live_N.png 自动退出）
2. ~~叙事控制进 Godot~~ ✅ **2026-07-03 完成**：`ui/NarrativePanel.gd`（N 键/按钮开关），
   塞纸条/散布流言/注入事件/推进导演四模式，HTTP 直连 3001；三个注入接口已 curl 冒烟通过，
   nudge（会调 LLM）未实测但接口简单。离线可预览、发送禁用
3. **其他剧本前端适配**：mygo-seaside / koukou-judgment 的角色皮肤映射（`Main.gd CHAR_SKINS`）
   与地图布局（`Town.gd LAYOUT/ROOMS`），未知角色/地点现在走兜底（哈希皮肤 + 沙滩排开）
3.5 ✅ **行为可视化（2026-07-03）**：tick.events 的工具调用映射到画面——
   PAIR_ACTIONS（talk/gossip/comfort/argue/share_secret/invite_out/give_gift）触发凑近+对视；
   give_gift 飞包裹+爱心+底部对话框播报；argue 怒/心碎；comfort 爱心；sleep/nap 困；
   skipped 冒"…"。离线 demo 已含 talk 凑近 + 室内送礼 + 发呆三个演示 case
4. 后端：PLAN-tool-feedback.md 的 Tool Feedback Loop 改造
5. **前缀缓存优化（待决策，2026-07-03）**：provider 已接入 DeepSeek 缓存命中指标
   （`LLMResponse.usage.cacheHitTokens/cacheMissTokens` + 每 25 次调用输出累计命中率日志）。
   先跑一次 halfday sim 看真实命中率，再决定是否做"工具描述静态化"改造
   （把在场人名/商品清单/位置锚点等易变内容从 tool description 挪到 user prompt，
   工具集仍按情境浮现但字节稳定）。注意：这与"工具=环境可供性"设计有张力，动之前先量化收益。
   **首批真实数据（2026-07-03 live 回归顺带采到，7 角色 12 tick）**：累计命中率随调用数衰减
   25次 86.3% → 50次 76.6% → 75次 71.4% → 100次 69.1% → 125次 70.2%（323840/461490 tokens）。
   即现状已有 ~70% 命中，"静态化"的可提升空间 = 未命中的 30% 里属于易变前缀的部分，收益上限有限，
   建议 halfday sim 复测后再决策。

## 关键教训（跨会话必读）

- **图集裁片必须先验证**：Ninja Adventure 图集里建筑/道具紧挨着排，新 region 必须先 PIL
  裁片放大确认边界；"半截贴图"两种成因 = 区域裁到邻居 / 贴图本身是组合件碎块
- **停后端按端口杀**：`lsof -ti:3001 | xargs kill -9`（pkill 匹配不到 pnpm 真实进程名会残留偷跑烧钱）
- **Godot CLI 用绝对路径**：`godot --path <绝对路径>`（shell cwd 会被重置，`--path .` 指错会开
  项目管理器空转卡死）
