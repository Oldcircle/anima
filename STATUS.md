# STATUS — 会话交接文档

> 每次有实质进展时更新。记录当前进度和下次继续的入口，不是日志。
> （旧 STATUS.md 因 gitignore 未入仓而丢失，本文件 2026-07-03 重建，开发文档已全部入仓）

## 当前状态（2026-07-03）

### 世界系统深化 · 第 1 弹「气候系统」（2026-07-03，天气×四季做成真游戏系统）

把原本纸面化的天气/四季（只有文字、无机制、无画面）升级成三位一体系统。审计结论：
天气 2/10、四季 2/10、经济 3/10、社交 6/10 —— 按"可感知 + 有生存压力 + 前端看得见"逐个补齐。
**顺序：气候 ✅ → 经济 ✅ → 社交（进行中：关系网可视化 ✅；声誉/恋爱线阶段/冲突升级待做）**。

### 世界系统深化 · 第 3 弹「社交系统」（进行中）——从"扎实"到"有戏剧张力"

社交本就是四系统里最扎实的（关系轴+bond身份+八卦+同场修正+印象+约定），先补最缺的「看得见」：

- **关系网可视化**（`godot/ui/RelationWeb.gd`，R 键 / HUD「关系」按钮）：全镇角色沿圆环排布，
  两两关系画成连线——颜色=类型（挚友绿/点头之交灰/宿敌红/暧昧恋人粉）、粗细=亲密/敌对强度，
  bond 身份（恋人/前任/宿敌…）在连线中点标注。纯前端消费 tick 已下发的 `relationships[]`；
  离线 demo 注入了假关系网，`--relweb` flag 可截图。**⚠️ 该文件踩过 GDScript 严格警告坑**：
  `var x := dict.get(...)` 会因"从 Variant 推断类型"被当错误，改 `var x: T = ...` 或无冒号 `var x =`
- **气候+经济真机验证（2026-07-04）**：跑了半天真实模拟（rainy spring 36 tick）——房租准点扣、
  金币 100→76~92（有压力没破产、零焦虑刷屏）；7 角色晨间打算全被雨影响、避雨窝室内行为涌现。
  两系统平衡良好无需调整（探针用完已删）
- **待做（社交 drama 三件套）**：声誉/名声（公共善行↑恶行↓ + 进 prompt + 前端显示）、
  恋爱线阶段（好感→暧昧→表白→在一起/被拒 状态机）、冲突升级（积怨到临界爆发）


- **后端 `src/world/climate.ts`（新，17 测试）**：体感温度 = 季节基温 + 天气修正 + 时辰摆动（±5°C，
  正午最暖凌晨最冷）；`comfortBand` 六档；`isSheltered(loc)`（residential/commercial/library/home_* 算室内）
- **有生存压力**：`simulation` 每 tick 对**露天**角色施加 `climateNeedEffects`——冷/热耗 energy、
  雨雪掉 hygiene+fun、暴风雨最狠；`applyClimateMoodlet` 露天淋雨→狼狈 moodlet、宜人晴天→舒展 moodlet。
  躲屋里就免疫 → 催生"避雨躲寒"的涌现行为
- **可感知**：`prompt-builder` 环境行加温度体感（"下着小雨，12°C（微凉）"）+ 气候提示（带伞/添衣）+
  季节氛围一句话（樱花/蝉鸣/落叶/呵气成霜）
- **看得见（Godot）**：WS 广播 `temperature`；`Main.gd` 四季换装 = 地图季节染色（春嫩绿/夏标准/
  秋金黄/冬冷白，与时段染色**相乘**，只染地面不染角色脸）+ 季节氛围粒子（樱花瓣/落叶/雪絮，preprocess
  预热整屏）+ 时钟显示温度。离线渲染 4 季 × 昼夜验证零 SCRIPT ERROR（截图见 godot/docs/shot_climate_*.png）
- 验证 flag：`godot --path godot -- --shot [--spring|--summer|--autumn|--winter] [--day] [--wide]`

### 世界系统深化 · 第 2 弹「经济系统」（2026-07-04，让钱有牙齿）

原本 gold 只涨不跌（工作+，可选消费−），没有生计压力 → 钱没有分量。深化后三位一体：

- **后端 `src/world/economy.ts` 扩写（新增 +14 测试）**：
  - **生计压力（keystone）**：`dailyUpkeep(income)` 按收入累进的每日开销（房租+杂用），
    `simulation` 每天 07:00 `applyDailyUpkeep` 扣一次；付不起 → 尽量付 + "开销没付清"焦虑
    moodlet + 生计记忆（不引 debt 字段，用压力表达）。角色起始 100 金 ≈ 5 天开销的缓冲
  - **财务体感**：`financeBand/financeLabel/financeFeeling`——按"手头的钱撑得了几天"分档
    （宽裕/宽松/够用/手头紧/拮据/揭不开锅），比裸金额更贴生活；破产 `financeMoodlet` 焦虑
  - **季节市场价格**：`effectivePrice` 应季便宜反季贵（秋收食物 0.82、寒冬 1.22…），
    `tool-builder` 的 buy 工具 filter/展示/扣款三处用同一到手价，展示带"应季实惠/反季偏贵"标注
- **可感知**：`prompt-builder` 身体感受段接入 `financeFeeling`（宽裕不啰嗦，紧才提醒"多接点活"）
- **看得见（Godot）**：WS 下发 `finance` 标签；名册每行显示金币数（按财务档上色，红=拮据）、
  详情面板「钱包 8 金币 · 揭不开锅」行、**挣钱/花钱/房租头顶飘金币**（`float_text`，绿+红−，
  diff 上一 tick gold）。离线渲染名册/详情零 SCRIPT ERROR
- 验证 flag 复用 `--roster` / `--detail <id>`；截图 godot/docs/shot_economy_*.png

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
- **验证**：`godot --path godot -- --shot [--day] [--wide] [--rain] [--room <id>] [--roster] [--detail <id>]` 离线渲染（零 LLM 成本）

**生存可视化层（2026-07-03 新增）——「让 AI 的生存被看见」**：把 needs 从详情面板的裸数字
变成一眼可读的游戏化表达，兑现"像真正的游戏、AI 在其中生存"：
- **镇民状态名册**（`ui/StatusRoster.gd`，Tab 键 / HUD「名册」按钮）：JRPG 半透明菜单，
  每行 = 像素头像 + 名字 + 当前动作 + 饿/困 迷你血条（绿/橙/红三档）+ 最紧迫需求高亮标签
- **头顶生存告警徽章**（`CharacterView.set_need_alert`）：需求跌破阈值时角色头顶挂
  「饿/困/寂/脏/闷/急」小牌，urgent（<15-20）红底脉动、moderate（<30-32）橙底，
  数据每 tick 从 needs 推导（`Main._apply_need_alerts` / `_worst_need`，阈值对齐后端 need-definitions）
- **详情面板需求条**（`ui/DetailPanel.gd`）：裸文本 "hunger 45" → 六条彩色血条 + 数值 + 中文标签
- 全部 **纯前端、零后端改动、零 LLM 成本**：消费 tick/snapshot 已下发的 `needs`（server.ts:308），
  离线 demo 数据已补 needs+动作，4 张离线渲染验证零 SCRIPT ERROR（roster/detail/on-map 徽章都对）

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
3. **其他剧本前端适配**：mygo-seaside ✅ **2026-07-03 完成** —— 5 角色皮肤
   （tomori=EggGirl / anon=Cavegirl2 / sakiko=Princess / mutsumi=Cavegirl / soyo=Woman）+
   **通用住宅槽位分配**（任何剧本的未知 home_* 自动按序复用默认七栋房子的空位，含室内房间与
   徽章，标签用后端下发的地点名）；真后端 snapshot 验证通过（0 tick 零成本流程：起服→连上抓
   snapshot→15 秒内杀）。koukou-judgment（14 角色 + 25 监狱地点）需要独立的监狱地图，另行立项
3.5 ✅ **行为可视化（2026-07-03）**：tick.events 的工具调用映射到画面——
   PAIR_ACTIONS（talk/gossip/comfort/argue/share_secret/invite_out/give_gift）触发凑近+对视；
   give_gift 飞包裹+爱心+底部对话框播报；argue 怒/心碎；comfort 爱心；sleep/nap 困；
   skipped 冒"…"。离线 demo 已含 talk 凑近 + 室内送礼 + 发呆三个演示 case
4. ~~后端：PLAN-tool-feedback.md 的 Tool Feedback Loop 改造~~ ✅ 核查确认已全部实现
   （Layer B/C/D/E 都在代码里，MAX_TOOL_RETRY=2；PLAN 文档状态已更正）
5. **前缀缓存优化（待决策，2026-07-03）**：provider 已接入 DeepSeek 缓存命中指标
   （`LLMResponse.usage.cacheHitTokens/cacheMissTokens` + 每 25 次调用输出累计命中率日志）。
   先跑一次 halfday sim 看真实命中率，再决定是否做"工具描述静态化"改造
   （把在场人名/商品清单/位置锚点等易变内容从 tool description 挪到 user prompt，
   工具集仍按情境浮现但字节稳定）。注意：这与"工具=环境可供性"设计有张力，动之前先量化收益。
6. **活人感优化第一批（2026-07-03 已落地，待 live 验证）**：
   - 短期记忆改重要性感知淘汰（`short-term.ts _evictOne`）：反思(9)/冲突(8)/对话(7) 比琐事(3-4)
     活得久，2 游戏天硬过期兜底。此前是纯 FIFO，importance 字段形同虚设
   - 记忆/念头时间戳跨天标注（"昨天23:00"），模型能分清昨晚和刚才
   - 生活节律：饭点提示（早/午/晚，肚子不满才触发，`need-definitions.ts`）+
     上班节律一句话进 system prompt（静态、缓存友好，`prompt-builder.ts formatLifeContext`）
   - 已知未接线：`memory/temporal-decay.ts` 和 `memory/mmr.ts` 有实现有测试但零生产引用（死代码），
     下次要么接进记忆检索要么删
   - 验证入口：`pnpm test:live`（sim-halfday），观察点 = 角色是否按饭点吃饭/是否记得昨天的反思/
     `[LLM cache]` 命中率日志
7. **活人感第二批：半天模拟实测驱动（2026-07-03）**。第一轮 live 实测数据（275 次调用）：
   - ✅ 饭点节律生效：6 次 eat，2 次落在早饭窗口（09:00-09:15）、4 次落在午饭窗口（11:15-12:00）
   - ✅ 前缀缓存命中率收敛在 **57.8%**（首批 17.8% 是冷启动）——system 前缀正常命中，
     "工具静态化"改造的边际收益 = 剩余 42% 里 tools 段占的部分，优先级降低
   - ❌ **21 次（约 8%）"只想不做"**：模型（多为对话模式顺着 prefill）只写内心戏/台词不调工具，
     tick 作废且台词被丢弃 → 已修：agent-loop 同 turn 追加提示救回（`💬 只想不做救回`日志）
   - ❌ 在家 go_to "家/home" 报"镇上并没有这个地方"，误导重试连撞 2 次 → 第一版修复（改清晰报错）
     被第二轮实测证伪：报错再清晰模型也学不会，重试仍选 go_to 家。**最终方案：go_to 到当前位置
     （含"家"）优雅降级为"原地歇会儿"成功**（Claude Code stay-where-you-are 容错），
     不烧重试、记忆留自然叙事，重复倾向交给 recentActions streak 提示纠正
   - 第二轮验证（300 次调用）：只想不做 21→4（救回 14 次，其中 11 次转成 talk 把台词说出口）；
     缓存命中率 57.8%→68.5%（跨 run 磁盘缓存复用）；talk"对方不在"类失败是并行决策的
     时序竞态（A 决定说话时 B 同 tick 离开），叙事自洽 + 重试可纠，视为可接受不修
8. **选错工具四大根因修复（2026-07-03 第三批，v3 半天模拟零失败验证）**：
   - ① **见=可执行一致性**（`agent-loop.ts`）：会话模式此前给模型看静态 ALL_BASIC_ACTIONS、
     执行却按情境表验证 → 模型选"看得到但执行不了"的工具报不存在，真正可用的情境工具看不见。
     修复：conversationRequest 的 tools 强制替换为 dynamicActions
   - ② **对话对象必须同地点**（`simulation.ts` 两处）：isActiveConversation 只看 3-tick 时间窗
     不看位置，B 走后 A 仍被喂"请回应对方"→ 幻觉 talk。修复：进会话模式前检查同地点
   - ③ **居家可供性**（`residential.yml`）：家里工具全部条件门控，状态好的角色在家只有
     go_to+do_nothing → "go_to 家"病急乱投医的供给根源。修复：加无条件 rest / tidy_up
   - ④ **eat 参数宽容**（`tool-builder.ts`）：缺 item 时默认背包第一个食物 > 店里最便宜的
   - **三轮对比（每轮 ~250-300 次真实调用）**：最终失败 ✗ 8→13→**0**；重试 25→41→**1**；
     未调用工具 21→4→2；不存在的工具 →**0**；tidy_up 被自发使用 5 次、rest 1 次；
     行为分布 talk 29%/go_to 20%/eat+buy 13%/工作 9%/家务休闲其余——不再全员聊天
   - 唯一一次重试：L 想吃"方糖"（人设嗜糖，物品表没有）——建议给物品表加甜食让人设落地
   - **工具充分性审计结论**：45 个工具覆盖生存/工作/社交/休闲/居家/极端六域，日常粒度足够。
     真正缺口是系统级不是工具级：跨 tick 约定兑现（"明天中午一起吃饭"）、给不在场者留言、
     共同活动（一起吃饭是两人分别 eat）——属于新系统设计，待立项
9. **约定系统 v1（2026-07-03 实现，设计见 PLAN-appointments.md）**：
   - 数据：`Appointment` 存 World（`addAppointment`/`getUpcomingAppointments`/`getDueAppointments`，
     同对角色新约替换旧约、每人最多 3 个 pending）；瞬态不持久化（同 intent 惯例，存档补齐待做）
   - 创建：`arrange_meet` 工具（tool-builder，附近有人时浮现），确定性时间解析
     （`world/appointments.ts parseAppointmentTime`：今天18:00/明天中午/18点半，过时自动滚明天），
     `_appointment` 后门落库 + inbox 通知对方
   - 提醒：prompt「你心里挂着的事」按临近分级（远期平静/临近催出发/到点紧急）
   - 结算：simulation 每 tick，宽限窗 2 tick；kept→双方记忆+happy+关系+3；
     missed→等的人（记忆8/sad/关系−5/记挂 intent）+ 爽约者（愧疚记忆8+道歉钩子 intent）；
     双缺席扯平。已知简化：结算时刻才看在场，"等了一会儿先走"判为没来
   - 24 个新单元测试，全套 461 通过
   - **v4 半天模拟验证（2026-07-03）**：质量指标保持零失败（✗=0/重试2/救回10），
     arrange_meet 正确浮现但 9 游戏小时内未被自然使用 → 判定为可发现性问题（会话 prompt
     只列了 talk/go_to/eat 选项），已在 conversation-mode 行动指令加一行"聊得投缘可约下次"
     的非强迫提示。**下次观察点：7 日模拟（`pnpm test:sim` seven-day）看约定的自然发生率
     和赴约/爽约叙事**——半天窗口太短，约定本来就是低频行为，不值得再烧半天模拟去等它
10. **晨间打算 Morning Intentions（2026-07-03 实现）**：把"反应式生存"推向"有主线的生活"——
    这是对照 Generative Agents daily planning 找出的当前最大活人感差距：
    - `agent/morning-plan.ts`：每天 06:00 各角色基于昨日反思(wish/concern/insights) +
      今日约定 + 天气生成 1-3 条"今天想做的事"（150 maxTokens 小调用，失败降级不阻塞）
    - 存 `CharacterState.todayPlan {day, items}`（跨天自动失效）；prompt 注入
      「你今天的打算」段（措辞刻意松弛"顺其自然"，防 todo 执行机器化）
    - 晚间反思回顾打算完成情况 → 闭环：反思→打算→行动→回顾→次日反思
    - 成本：7 角色 × 每天 1 次小调用，可忽略
    - 8 个新测试，全套 469 通过
    - **v5 半天模拟验证（2026-07-03）：7/7 生成成功且深度贴合人设**（真嗣"烤出完美面包让
      父亲愿意尝一口"、L"糖纸叠遮阳片+观察实习生"、夜神月"检查借书卡标记"、战场原
      "修椅子免得老太太摔了还得打急救电话"）。**打算→行为因果链直接可见**：真嗣打算
      "中午去海边听海浪"→ 12:00 go_to 海边 + walk（6 小时后兑现）；rei 打算弄花
      → arrange_flowers 成为其最高频行为(×10)；light 打算图书馆整理观察 → shelve_books。
      回归指标连续第三轮零失败（✗=0/重试1/救回6）。arrange_meet 仍 0 次，留 7 日模拟观察
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
