# Anima — 开发状态

## 当前状态：Phase 9 — 物品系统 + 行为链追踪

**分支**：`feature/item-system`

**最后更新**：2026-03-27

### 当前加开主线：活人感攻坚（生活惯性 + 世界痕迹）

最新判断：项目现在“不像活人”不在于角色不会聊天，而在于两处断点：

1. **缺少生活惯性**：`currentIntent` 类型已经存在，但还没真正驱动主循环。角色每个 tick 更像重新做人一次。
2. **缺少可见痕迹**：行为更多停留在日志和工具名上，别的角色看见的是“在工作/在吃东西”，而不是“端着半凉的拿铁发呆”“低头把可颂推给别人”。

本轮优先级上调：
- `currentIntent` 接入 prompt 和行为执行链路
- `observableState` 从设计稿落到代码，成为观察/印象系统的输入
- 用测试和 half-day 验证“状态机感”是否下降

### 本轮已完成：currentIntent + observableState 第一轮接线 ✅

- [x] `currentIntent` 真正接入主循环
  - 被打断的多 tick 行为会留下 `recover` 意图
  - 收到消息但没回复会留下 `reply` 意图
  - 成功对话会留下 `follow_up` 意图
  - 刚到新地点会留下短暂 `plan` 意图
  - prompt 新增“你现在还挂着的事”
- [x] `observableState` 数据链路接通
  - `ActionResult` / `CharacterState` 新增可观察状态字段
  - agent-loop 在执行后为角色写入可观察状态
  - prompt-builder / observation-reasoning 优先读取 `observableState`
  - API / 前端角色列表与详情页改为展示可观察生活片段
- [x] 测试补强
  - `world.test.ts`：可观察状态过期清理
  - `prompt-builder.test.ts`：短期意图注入 prompt
  - `agent-loop.test.ts`：reply 意图、observableState 落地
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（239 tests）
- [ ] Live half-day 还未重跑：当前环境没有配置 API key，本轮先以单元测试和全量构建验证收口

### 本轮已完成：observableState 第二轮细化 ✅

- [x] 动态工具层补充更细粒度的可观察状态
  - `talk` 会保留说话方式和话题片段
  - `comfort` / `argue` / `give` / `buy` / `prepare` / `eat` / `cook` 都会留下更像生活现场的状态
  - 地点工具覆盖 `rest` / `sit` / `walk` / `sleep` / `wash` / `use_toilet` / `knead_dough` / `make_coffee` / `shelve_books` 等高频行为
- [x] 旧动作定义补齐 `observableState`
  - `basic-actions.ts` / `social-actions.ts` / `leisure-actions.ts` / `relationship-actions.ts` / `gray-actions.ts`
- [x] prompt 与观测链路继续受益
  - 附近角色不再只像“在工作/在吃东西”，而更像“坐在窗边发呆”“正把东西递给别人”“低声安慰某人”
- [x] 测试补强
  - `agent-loop.test.ts` 新增：说话语气与话题片段、把附近角色细节状态注入 prompt、give 的可观察状态
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（242 tests）

### 本轮新增：前端回显 + 对话节奏上限修补 ✅

- [x] 前端时间线不再只展示工具名
  - `server.ts` 的 tick 事件新增 `observableState`
  - `web/index.html` 时间线优先展示“别人能看到的生活片段”，把执行描述降为次级说明
  - 角色侧栏 / 档案页在没有 `observableState` 时也会用更自然的动作文案兜底，而不是直接显示 `journal` / `prepare` 这类工具名
- [x] 对话显示细节打磨
  - 前端对话气泡会去掉模型偶尔自带的外层引号，避免出现 `「「...」」` 这种视觉破功
- [x] 修复“同一对角色在同一 tick 里聊过头”的节奏 bug
  - 之前 `pairExchangeCount` 只统计反应轮，正常决策阶段的 `talk` 没算进去
  - 结果是代码注释写着“每对角色每 tick 最多交换 2 次”，实际仍可能出现 4 句往返
  - 现在主轮成功 `talk` 也会计入配额，并在达到上限时写入冷却
- [x] 测试补强
  - `simulation.test.ts` 新增：同一对角色在同一 tick 内最多只交换两句
- [x] 世界边界修补
  - live 里出现过 `go_to kitchen` 这种模型幻觉地点
  - 之前 `world.moveCharacter()` 虽然会拒绝非法地点，但上层仍把这次行为当成功，造成“世界没动、日志却说动了”
  - 现在 `go_to` 工具会先校验目标地点，不存在就直接返回失败
  - 如果模型对当前地点再次调用 `go_to`，现在会明确提示“你已经在这里了”，不再误报成“不存在的地点”
- [x] 跨 tick 社交冷却接入主决策
  - 之前冷却只挡反应轮，主轮里同一对人仍可能隔 tick 连续聊天
  - 现在主轮会把处于冷却中的对象标记为“先缓一缓比较自然”
  - 模型就算仍然硬选 `talk`，也会得到自然失败，而不是 “未知工具”
- [x] 测试补强
  - `agent-loop.test.ts` 新增：`go_to` 不存在地点时明确失败且角色位置不变
  - `agent-loop.test.ts` 新增：`go_to` 当前地点时明确提示已在此处
  - `agent-loop.test.ts` 新增：社交冷却下 `talk` 工具描述会显式提示“先缓一缓”
  - `simulation.test.ts` 新增：跨 tick 冷却下继续搭话会变成自然失败，而不是继续连聊
- [x] 验证
  - `pnpm test src/agent/simulation.test.ts src/agent/agent-loop.test.ts src/agent/prompt-builder.test.ts` 通过（30 tests）
  - `pnpm build` 通过
  - 后续补跑：`pnpm test src/agent/agent-loop.test.ts src/agent/simulation.test.ts` 通过（24 tests）
  - 再次补跑：`pnpm test src/agent/agent-loop.test.ts src/agent/simulation.test.ts` 通过（28 tests）

### 本轮 Live 观察（2026-03-26，修补前侦察）

这轮 half-day live 的作用主要是“找假感来源”，不是最终验收。观察到两类非常明确的问题：

1. **工作现场已经比之前自然很多**
   - 爱音 ↔ 祥子的清晨互动有了“同事打招呼后继续干活”的节奏，不再一上来就无限连聊
   - 睦 ↔ 灯、素世 ↔ 灯也开始出现围绕买面包/店内停留而生长的情境对话，不只是凭空寒暄
2. **仍有两个破功点**
   - 前端时间线仍主要显示 `action + description`，没有把 `observableState` 当作一等信息，导致 UI 上的“活人感”被重新压扁
   - 同一对角色在同一 tick 里仍可能出现 4 句往返；根因是主轮 `talk` 没被记入反应轮配额

以上两点都已在本轮代码中修补；**但修补后的 full half-day live 还没重跑完**，下次继续时应优先复验。

### 本轮 Live 复验（2026-03-26，2 角色 half-day）

- [x] 复验命令：`pnpm exec vitest run --config vitest.live.config.ts src/agent/simulation.live.test.ts -t "2 角色跑半天（24 tick = 6 小时）"`
- [x] 结论
  - 非法地点不再直接穿透世界；live 中已经出现明确失败文案，而不是“日志说走了、世界却没动”
  - 跨 tick 连续聊天开始出现“刚和对方聊过，先缓一缓比较自然”的自然失败，节奏比之前更有停顿
  - 修补前会出现的 `talk` → “未知工具” 现象，在最后一轮 live 中已经消失
- [ ] 仍需继续观察
  - 两人世界里对话热度仍然偏高，只是现在会穿插停顿和别的行为；接下来可以继续考虑“社交饱和”或“场景目标优先级”来进一步降温

### Phase 9 概述

物品系统 + 工作角色工具 + 行为链追踪。目标：让世界有物质基础，物品是生活痕迹、事件载体和关系的物化。

核心改造：
1. **物品系统**：ItemDef + ItemInstance，6 类物品，buy/use/give 流转
2. **工作角色工具**：员工和客人看到不同工具，工作不再是黑盒
3. **行为链追踪**：连续行为模式检测 → moodlet 触发

设计文档：DESIGN.md §2.5 物品系统
实施计划：PLAN.md Phase 9A-9E

### Phase 9 进度 — 全部完成 ✅

- [x] **9A 物品基础**：ItemDef/ItemInstance 类型、30+ 基础物品定义（6 类）、背包操作函数、19 个测试
- [x] **9B 物品工具 + 集成**：buy/eat/give 工具、tool-builder 根据背包启用工具、prompt 注入随身物品
- [x] **9B 商店系统**：6 个商业地点新增 shop 段
- [x] **9C 工作角色工具**：4 个地点新增 worker_tools（含 income）、tool-builder 区分员工/客人
- [x] **9D 角色起始物品**：4 个角色 starting_items（灯:笔记本、睦:吉他等）
- [x] **9E 行为链追踪**：5 种模式检测 → moodlet 触发
- [x] **旧工具迁移完成**：删除所有旧 eat/drink/work，完全用 buy+eat+worker_tools 替代
- [x] **记忆系统优化**：自然语言回忆 + 时间戳 + 连续行为压缩 + "你刚刚"重复提醒
- [x] **前端适配**：6 维需求条 + 背包显示 + API inventory 字段
- [x] **物品验证加固**：give/cook handler 验证背包、resolveItem 双向查找、类型提示
- [x] **工具描述纯中文**：模型不再看到 item ID
- [x] **save-load 适配**：inventory + recentActions 读档恢复
- [x] DB 持久化：inventory_json + recent_actions_json 列
- [x] Live 半天验证通过（9 tests, 5 files）
- [x] 234 单元测试全部通过

### 本轮完成（2026-04-01）

- [x] **记忆质量优化**：formatForPrompt 条数提升到 12、target ID 转显示名、thought 截断放宽到 200 字符、对话记忆保留 60 字符
- [x] **SocialModifier 实现**：17 个行为的社交修正规则
  - eat/walk/drink/read/rest 等行为在有认识的人在场时自动调整效果
  - 额外 social/fun 增益 + 同伴也获得增益
  - observableState 联动：社交场景专属描写（”和爱音一起吃着东西”）
  - 8 个单元测试 + 1 个端到端集成测试
- [x] **社交饱和机制**：
  - social > 75 时 prompt 提示”聊了不少，想安静一会儿”
  - social > 90 时更强：”脑子转不动，很想一个人安静待着”
  - talk 工具描述随 social 值动态变化
  - fun > 90 时提示”心情很好，不用特地找乐子”
- [x] **需求感受化强化**：
  - 累+饿同时极低时组合警告
  - 3 项以上中度需求同时存在时提醒处理最紧急的
- [x] **动态 backstory 注入**：
  - 根据地点/状态/时间触发相关过往回忆（每 tick 最多 1 条）
  - 关键词匹配评分选择最相关条目
- [x] **对话模式 prompt 增强**：
  - 完整的 formatBodyFeelings 替代简化检查
  - Moodlet 注入、随身物品展示
  - 对话场景 backstory 动态注入
- [x] **go_to 地点人物信息**：
  - location 描述中显示各地点在场人物（"千早爱音在那里"）
  - 让移动决策有社交考量
- [x] **261 tests passing, build clean**

### 下次继续入口

1. **优先复验一轮新的 half-day live**
   - 确认 SocialModifier 在 live 中生效（一起吃饭/散步是否有不同叙事）
   - 确认社交饱和后角色是否自然转向其他行为
   - 确认 backstory 注入不会过于频繁或干扰
2. **currentIntent 第二轮**：让意图与物品/地点/人物绑定得更深，不只围绕消息和移动
3. **合并分支到 main**
4. **P0-a 剩余**：地点 atmosphere 已有，但 system prompt 社交引导还可以加强
5. **P0-b 对话模式**：多轮对话检测与叙事 prompt（大块工作）

### Phase 8A 进度：数据驱动需求系统 ✅

- [x] `src/world/need-definitions.ts`：NeedDefinition 接口 + 6 维定义 + 感受化文案
- [x] `src/world/types.ts`：CharacterNeeds 改为 Record<string, number>
- [x] `src/world/world.ts`：衰减循环改为通用遍历
- [x] `src/agent/prompt-builder.ts`：formatBodyFeelings 迁移到 need-definitions.ts
- [x] 全模块 happiness → fun/moodlet 适配（30+ 文件）
- [x] 数据库 needs_json 列适配
- [x] 207 tests passing, build clean

### Phase 8B 进度：工具系统重设计 ✅（核心完成）

- [x] action effects 适配 6 维需求（所有行为有代价）
- [x] 新增工具：use_toilet、nap、cook、journal、practice
- [x] tool-builder.ts 自然语言动态描述（一句人话，不是数值表）
- [x] 12 个地点 YAML 全面更新（happiness→fun、新工具、代价体系）
- [x] system prompt 新增"世界的常识"段
- [x] go_to 描述包含角色认知（"家——能休息、做饭、洗澡"）
- [x] sim-reporter 适配动态需求维度
- [x] Live 半天验证通过（5 test files, 9 tests, 251s）
- [ ] SocialModifier 自动应用（设计完成，实现留后续）
- [ ] observableState 字段（设计完成，实现留后续）
- [ ] 状态影响行为质量 + 行为链追踪（设计完成，实现留后续）

### Live 半天验证结果（2026-03-26）

日志：`logs/sim-halfday-20260326-192416.md`

| 角色 | 饿 | 力 | 社 | 净 | 乐 | 厕 | 行为次数 |
|------|-----|-----|-----|-----|-----|-----|---------|
| 爱音 | 88 | 79 | 100 | 86 | 44 | 94 | 23 |
| 睦 | 70 | 97 | 97 | 72 | 73 | 28 | 22 |
| 祥子 | 73 | 48 | 42 | 92 | 39 | 99 | 17 |
| 素世 | 73 | 44 | 55 | 72 | 3 | 88 | 21 |
| 灯 | 74 | 87 | 29 | 62 | 24 | 84 | 20 |

亮点：
- **bladder 在运作**：睦 bladder=28（一直工作没上厕所），角色自然使用 use_toilet
- **fun 驱动行为**：素世 fun=3（图书馆工作一整天）、灯 fun=24，会驱动寻找娱乐
- **印象精准**：6 条——爱音→素世「优雅淑女」、素世→爱音「阳光自来熟」、祥子→睦「沉默观察者」
- **对话自然**：灯和爱音交换面包/三明治、睦寡言特征完美、祥子保持距离感
- **新工具被自然使用**：use_toilet、cook、nap 都出现在行为日志中
- **argue 工具在 fun 低时自然浮现**（但未被选择——角色选择更合理的行为）

### 本轮最新修复（2026-03-27）

- [x] **社交冷却不再硬拦截 talk**：模型自己判断要不要继续聊，不被系统强制打断
- [x] **员工精力耗尽隐藏工作工具**：energy < 15 时 worker_tools 不显示
- [x] **go_to 疲惫提示**：energy < 20 时描述变成"你很累了，也许该回家休息了"
- [x] **stress-sim 全面适配**：SmartMockLLM 支持 buy/eat/worker_tools，248→247 tests passing

### 下次继续入口

1. **SocialModifier 实现**：行为效果根据同地点有人自动调整
2. **合并分支到 main**：feature/needs-tools-redesign + feature/item-system
3. **Live 验证**：跑 halfday 确认员工休息、对话节奏等修复效果
4. **前端玩家操作面板**：位置选择、行为按钮、对话输入

### 前置：Phase 7A-7D 全部完成 ✅

### 背景

角色卡全部字段（age/occupation/home）都是静态写死的，角色不知道自己在哪上班，没有技能成长，没有人生目标。借鉴模拟人生的设计思路，将角色卡拆分为"灵魂层（不变）"和"生活状态层（可变）"，让角色有工作认知、技能成长、职业阶梯、愿望驱动、关系类型化、情绪层次。

详见 DESIGN.md §2.2-2.4，PLAN.md Phase 7A-7D。

### Phase 7A：生活状态层（Life State）— 进行中

- [x] `LifeState` 类型定义（`src/character/types.ts`）
- [x] `CharacterState` 挂载 `life`（`src/world/types.ts`）
- [x] `character/loader.ts` 加载 YAML `life` 段
- [x] 5 个角色 YAML 新增 `life` 段（workplace、初始技能、aspiration）
- [x] `prompt-builder.ts` 改造：
  - [x] system prompt 从 life 读取 age/occupation
  - [x] 注入工作认知："你在海风面包坊当面包店学徒"
  - [x] 注入技能认知："烘焙（在学习）、观察力（有基础）"
  - [x] 注入抱负："你内心深处一直想：找到能理解我的人"
  - [x] user prompt 注入 currentGoal / currentConcern
- [x] `ActionEffect` 新增 `skill_up` type
- [x] `work` action 产生 `skill_up` effect
- [x] `agent-loop.ts` 处理 `skill_up` effect，更新 `life.skills`
- [x] work 收入从 `life.income` 读取（优先于旧 occupation 映射表）
- [x] `World.addCharacter` 支持传入 `life`
- [x] cli.ts + 4 个 sim 测试文件适配
- [x] `pnpm build` 通过
- [x] `pnpm test` 通过（176 tests）

**同步修复（全模块适配）**：
- [x] observation-reasoning.ts: occupation 从 life 读取
- [x] impression-updater.ts: age/occupation 从 life 读取
- [x] conversation-mode.ts: 对话对象信息从 life 读取 + workplaceName 传递
- [x] simulation.ts: 对话模式传 workplaceName
- [x] server.ts: API 暴露 life 数据
- [x] database.ts: life_json 列持久化
- [x] save-load.ts: 存档/读档包含 life state
- [x] stress-sim.test.ts: 5 个内联角色添加 life 段

**Phase 7C 部分：愿望系统**：
- [x] reflection.ts: 反思提取愿望/担忧 + 抱负注入
- [x] simulation.ts: 反思结果回写 life.currentGoal/currentConcern
- [x] prompt-builder.ts: user prompt 注入"你心里挂着的事"

**测试**：
- [x] life-state.test.ts（14 tests）
- [x] reflection.test.ts（6 tests）
- [x] database.test.ts 新增 2 个 life 持久化测试
- [x] Live 半天验证通过

### Live 半天验证结果（2026-03-25，life state 后）

日志：`logs/sim-halfday-20260325-213343.md`

| 指标 | 修复前(isWorkplace) | 修复后(社交引导) | 对话修复后基准(03-25) |
|---|---|---|---|
| 总行为 | 64 | 75 | 82 |
| 对话次数 | 0 | 10 | 44 |
| 印象数 | 0 | 2 | 8 |
| talk 占比 | 0% | 13% | 54% |

亮点：
- 爱音↔祥子 10 轮对话，同事关系自然涌现（都在 cafe 工作）
- 印象标签精准：「神秘前辈」vs「阳光后辈」
- 角色知道自己的工作地点，主动去上班
- 灯最终来到 cafe（社交引导起效）
- 对话量比 0 对话大幅恢复，但比基准（44 次）少——因为角色分散到各自工作地点，相遇机会减少。这是正确行为（真实感更强），后续可通过更多地点互动和下班后聚集来改善

### 本轮已完成：对话跳跃修复 + Phase 7B 关系类型化

**对话跳跃**：对话模式 prompt 新增"对方刚刚说的是"提示，引导 LLM 回应最后一句话。

**需求感受化收尾**：清理了 conversation-mode 和 reflection 中残留的亲密度数值暴露。

**Phase 7B 关系类型化**：
- [x] Relationship 新增 `bond` 字段（colleague/roommate/partner/ex/mentor/rival）
- [x] `setBond()` 方法 + 自动检测同事关系（共享 workplace）
- [x] 新增 `invite_out`（friend+）和 `share_secret`（close_friend+）工具
- [x] tool-builder 根据关系深度条件浮现
- [x] prompt 注入 bond 描述
- [x] DB 持久化 bond 列

**Phase 7C 职业晋升**：
- [x] 地点 YAML 新增 career_track（bakery/cafe/flower_shop/library 各 2-3 级）
- [x] `career.ts`: checkPromotion + applyPromotion
- [x] simulation 每天反思时自动检查晋升
- [x] 晋升 → 更新 occupation/income + 记忆 + confident moodlet

**Phase 7D Moodlet 情绪系统**：
- [x] `moodlets.ts`: add/tick/getDominant/format/generateNeedMoodlets
- [x] CharacterState 新增 `moodlets` 字段
- [x] 社交产生 happy moodlet，需求极低产生负面 moodlet
- [x] prompt 注入"你现在的心情"段 + 主导情绪
- [x] 207 tests 全部通过

### 一日模拟结果（2026-03-24）

538 秒完成 72 tick 完整一天，6 条印象。日志：`logs/sim-1day-20260324-221817.md`

亮点：
- 爱音向祥子请假 5 分钟去面包店买三明治，遇到灯
- 灯注意到咖啡馆竹帘影子"像水面的波纹"，爱音惊叹"这个比喻好美"
- 睦直接问祥子"胃疼吗"，祥子找借口走开（标签互评：「敏锐的观察者」vs「克制者」）
- 素世独自在酒吧喝到深夜（社交值 0）
- 灯完整生活节奏：面包店→吃饭→工作→咖啡馆→海边→回家→睡觉

### 本轮已完成：对话系统两大问题修复（2026-03-25）

**1. 对话并行交错 → 反应轮串行执行 ✅**
- 原因：反应轮用 `Promise.all` 并行执行，角色看不到同轮其他角色刚说的话
- 修复：`simulation.ts` 反应轮改为 `for...of` 串行执行，每个 reactor 执行后立即处理 talk 效果（信箱投递、关系变化、对话记录），下一个 reactor 能看到最新信箱
- 不违反第一性原理：没有引入对话管理器，只是让"物理世界"的信息传递更即时

**2. 单句蹦词 → 允许多句话 ✅**
- 原因：prompt/工具描述没有明确引导，LLM 默认每次只说一句
- 修复：talk 工具 description + message 字段 description 明确"可以一口气说完想说的"；system prompt 行为规则新增引导；对话模式 prompt message 说明扩展
- 不增加新工具或新机制，纯 prompt 层面引导

验证：`pnpm build` 通过，`pnpm test` 通过（149 tests）

### 本轮已完成：角色卡重写 + 对话叙事化

- [x] **角色卡完全重写**：5 个 MyGO!!!!! 适配角色（灯/爱音/祥子/睦/素世），零跨角色引用
- [x] **对话叙事化**：talk 工具 manner 字段 + prompt 白描指引 + 社交饱和度
- [x] Location 去旧角色名（面包店→海风面包坊、花店→潮声花店）
- [x] 18 个测试文件机械替换，160 tests 全部通过
- [x] 2 次 Live 验证通过：涌现行为有差异，性格差异鲜明，印象系统精准

### 本轮已完成：P1 印象系统深化 + 测试可读性改造

- [x] **SimReporter 共享工具**：`test/helpers/sim-reporter.ts`，实时 per-tick 输出、ID→名字解析、进度条、彩色终端、统计收集、Markdown 日志生成
- [x] **重构 3 个模拟测试**：full-day / halfday / seven-day 全部改用 SimReporter，每个 tick 实时输出决策，不再等到最后才 dump
- [x] **首次印象阈值降低**：2 条交换即可触发首次印象生成（更新仍需 4 条 + 冷却）
- [x] **未解疑惑驱动对话**：prompt 注入"你心里有些好奇的事"，引导角色自然探索对他人的疑惑
- [x] **独处回忆**：社交需求低时，prompt 提示记忆中的人（带印象摘要），引导主动社交
- [x] **角色名解析**：prompt-builder 接受 characterNames 映射，回忆中的人用名字而非 ID
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（151 tests）

### 本轮已完成：P2 观察与社会推理

- [x] `observation-reasoning.ts`：观察触发判断 + 轻量 LLM 推理（maxTokens 128）
- [x] 触发条件：空闲 + 同地点有可观察行为的角色 + 4 tick 冷却
- [x] 目标选择：优先有已有印象的人（能深化理解）
- [x] 集成 simulation.ts：fire-and-forget，不阻塞 tick 循环
- [x] 观察结果存入记忆（type: "observation"，importance 6，含推理内容）
- [x] 7 个单元测试（shouldObserve 边界条件）
- [x] observation.live.test.ts：2 个 Live 测试（无印象/有印象时的观察推理）
- [x] 修复 simulation.live.test.ts 断言（反应轮 results > 2）和超时
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（158 tests）

### 已完成：第一性原理收口（第一阶段）

- [x] Prompt 改成“可见事实 / 主观感觉 / 短期挂念”三层结构
- [x] 关系不再在 prompt 里直接暴露亲密度数值，优先改为主观感觉描述
- [x] `CharacterState.currentIntent`：消息、失败动作、移动会留下可过期的短期意图
- [x] `talk` 明确为同场当面说话，在场角色可通过 observation 记忆“看见了什么”
- [x] 新增测试：`prompt-builder.test.ts`
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（149 tests）

### 本轮已完成：印象稳定性 + 半天报告改进

- [x] `generateImpression()` 增加更宽松的解析 + 启发式回退，避免模型格式轻微漂移时直接丢失印象
- [x] `Simulation.waitForBackgroundTasks()`：测试/日志可明确等待后台印象任务，不再靠 `sleep(5s)` 盲等
- [x] `sim-halfday.live.test.ts` 改为生成 markdown 日志到 `logs/sim-halfday-*.md`
- [x] 半天日志按“概要 / 行为分布 / 主要对话对 / 对话摘录 / 印象 / 关系 / 风险 / 时间线”组织，便于扫读
- [x] 新增测试：`impression-updater.test.ts`
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（151 tests）

### 最新半天 Live 结果（2026-03-25，对话修复后）

日志：`logs/sim-halfday-20260325-113800.md`

| 指标 | 修复前(03-24) | 修复后(03-25) | 变化 |
|---|---|---|---|
| 总行为 | 78 | 82 | +5% |
| 对话次数 | 21 | 44 | +110% |
| 印象数 | 2 | 8 | +300% |
| 对话对 | 1 组 | 4 组 | +300% |
| talk 占比 | ~27% | 54% | +100% |

亮点：
- 爱音 ↔ 灯 25 轮深度对话（面包推荐→说错工作地点→尴尬改口→一起去海边），关系达到 best_friend(100)
- 睦 ↔ 灯 12 轮买面包对话（可颂+橙汁，灯反复确认价格和”小心烫”），关系达到 friend(55)
- 祥子 ↔ 爱音 4 轮对话，祥子维持礼貌距离感（”请容我婉拒”）
- 素世 ↔ 睦 3 轮对话，素世主动搭话询问食物
- 印象标签精准：灯→爱音「慌张向日葵」、爱音→灯「面包侦探」、祥子→爱音「自来熟」、灯→睦「耐心顾客」
- 串行反应轮效果验证：对话不再交错，B 能看到 A 刚说的话再回复
- 多句话效果验证：角色不再单句蹦词，一口气说完想说的话

### 背景

与 SillyTavern（夏瑾 Pro 预设）深度对比后发现：Anima 对话质量差距的根因不是架构，而是**给 Agent 的世界太贫瘠**。角色看到的是报表（数值+标签），不是世界。真实人类决策时有环境感知、对人的标签、心理猜测等丰富上下文，Agent 也需要。

分析笔记：`~/Opensource/notes/Anima活人感分析-酒馆对比与五层改进方案.md`

### 五层方案概要

| 层 | 内容 | 优先级 | 状态 |
|---|---|---|---|
| 环境感知 | 地点感官描写 + 可观察状态 | P0 | ✅ 完成 |
| 内心独白分级 | 社交场景 token 扩容 + 思考指令 | P0 | ✅ 完成 |
| 对话模式 | 连贯叙事对话流 | P0 | ✅ 完成 |
| 人物印象系统 | 叙事性印象替代数字关系 | P1 | ✅ 完成 |
| 观察与社会推理 | 解读他人行为 → 无声关怀 | P2 | ✅ 完成 |

### P0 完成清单（2026-03-24）

**P0-a: 环境感知 + 内心独白**
- [x] 10 个地点 YAML 文件（`data/locations/*.yml`），每个含 5 段 atmosphere 描写
- [x] `LocationAtmosphere` 类型 + `location-loader.ts` + `getAtmosphereText()`
- [x] `cli.ts` 改用 YAML 加载器（不再硬编码地点）
- [x] `prompt-builder.ts`：`## 你现在看到的` + atmosphere 替代 `位置: XX（商业区）`
- [x] 附近角色加可观察状态：`——在吧台前张望` 替代纯标签
- [x] 社交场景 maxTokens 512→1024 + 思考指令扩展（"详细说说你的内心活动"）
- [x] System prompt 新增 `## 社交行为指引`（犹豫/改口/言不由衷/转移话题）

**P0-b: 对话模式**
- [x] `ConversationTracker`：追踪角色间对话历史，检测活跃对话
- [x] `buildConversationPrompt()`：完整对话历史 + 环境 + 叙事风格指引
- [x] `buildConversationRequest()`：temperature 1.0，maxTokens 1536
- [x] `agent-loop.ts` 新增 `conversationRequest` 参数（复用执行逻辑）
- [x] `simulation.ts` 反应轮集成：检测活跃对话 → 使用对话模式 prompt
- [x] 对话记录 + 自动清理过期对话

**测试：149 个全部通过**（`pnpm test` + `pnpm build` 全绿）
Live/模拟测试已改名为 `*.live.test.ts`，不被默认 `pnpm test` 包含，通过 `pnpm test:live` 单独跑。

### Live 验证结果（2026-03-24）

日志：`logs/sim-1day-20260324-134227.md`

| 指标 | P0 前 | P0 后 | 变化 |
|---|---|---|---|
| 对话次数 | 22 | 36 | +64% |
| talk 占比 | 13.8% | 21.6% | +56% |
| Alice talk | 2 | 12 | +500% |
| Alice↔Maria 亲密度 | 18 | 63 (close_friend) | +250% |
| 对话质量 | 单句简短、重复自我介绍 | 多轮深度叙事、有机话题递进 | 质变 |

亮点：
- Bob↔Maria 8 轮自然对话（从面包聊到钓鱼再到人生）
- Alice↔Maria 从可颂聊到向日葵种子到郁金香到感情，完全有机发展
- Sakiko 对 Emily 的回应保持角色距离感（"请容我说...失礼了"）
- 老陈对 Alice 的关心体现父辈关怀（"你最近是不是又没好好吃饭？"）

### 本轮已完成：长期记忆 + 印象持久化

- [x] SQLite 扩展：`impressions` 表 + `long_term_memories` 表
- [x] 印象 save/load：保存和恢复所有角色间叙事印象
- [x] 长期记忆：高重要性记忆自动持久化，支持按角色/关键词/相关角色检索
- [x] 读档恢复：长期记忆最重要的 10 条注入短期记忆，反思洞察跨天延续
- [x] 2 个新增 DB 测试
- [x] 验证：`pnpm build` 通过，`pnpm test` 通过（160 tests）

### Live 验证结果（2026-03-24）

半天模拟（36 tick, 06:00→15:00）通过，393 秒完成。

| 指标 | 值 |
|------|-----|
| 印象生成 | 2 条（Maria→Alice「静默园丁」/ Alice→Maria「共鸣者」） |
| 印象观察 | 丰富细节（"重复说'你知道吗'时停顿"、"推荐花束注重情感意义"） |
| 疑惑驱动 | "提到妈妈种的花时停顿"、"从城市带来的多肉语气变化" |
| 角色状态 | Alice 社交 99 / Emily 社交 24（安静角色）/ Bob 居中 |
| 角色交互 | Alice↔Maria 深度叙事、Bob→祥子 性格差异鲜明（豪爽 vs 克制） |

### 本轮已完成：对话叙事化改造

- [x] talk 工具新增 `manner` 字段（身体语言白描）
- [x] 对话模式 prompt 完全重写（白描手法、台词要像说话、节奏感、允许沉默）
- [x] 对话轮次提示（8 轮以上提醒"也许该做点别的了"）
- [x] 社交回报降低（+12/+8 → +5/+3）
- [x] manner 纳入对话历史（后续对话可见身体语言）
- [x] system prompt 新增说话风格指引（抑制比喻、引导 manner）
- [x] 半天模拟通过（319 秒，4 条印象，质量提升）

### Live 验证对比

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| 耗时 | 393s | 319s |
| 印象数 | 2 | 4 |
| 对话对 | 1 组 | 2 组 |
| 对话风格 | 连续诗歌 | 有节奏感（出现"嗯。"等短回复） |
| 话题功能性 | 纯抒情 | 有功能性（吃早饭、喝茶、去面包店） |

仍需改进：DeepSeek 倾向于使用比喻，需要更强的 prompt 抑制或换模型测试。

### 下次继续入口

**感知重构**（两项并行，详见 DESIGN.md §2.2 和 §3.1，PLAN.md 实施清单）：

1. **需求感受化**：`formatNeeds()` 数值面板 → `formatBodyFeelings()` 自然语言
   - 核心改动在 `prompt-builder.ts`
   - 满的需求不提，偏低的用身体感受描述，极低的用紧急措辞
2. **情境工具系统**：全局 16 工具 → 地点定义工具 + 动态组装
   - 地点 YAML 新增 `tools` 字段
   - `go_to` 参数动态列出地点+能力摘要
   - `talk` 参数动态列出在场角色
   - 社交/极端工具按条件浮现
   - 预期效果：行为从"选菜单"变为"感受+环境→自然涌现"

**已知问题**：
- 截断：已确认不是 token 限制（finish_reason=tool_calls, 使用率<10%），是 DeepSeek 工具参数生成的模型行为
- 对话重复：已加 prompt 去重指令，待观察效果

可选：关系网络图、embedding 向量搜索

## 第一性原理

> 每个角色（包括玩家）是独立 Agent。通过工具自主决策。没有特殊机制。

## 压力测试发现（2026-03-23）

1日 + 7日 Mock 模拟（`stress-sim.test.ts`）暴露 3 个违反第一性原理的问题：

### 已修复（2026-03-23）

- [x] **夜间强制回家睡觉是特殊机制**
  - 删除 `simulation.ts` 的 `isNight` 强制逻辑
  - Live 验证：角色自主选择不同时间入睡（Alice 16:30, Bob 17:45, Maria 22:45）
- [x] **缺少 `wash` 工具**
  - `basic-actions.ts` 新增 `washAction`: hygiene +100, duration 2
- [x] **sleep 降低卫生值是 bug**
  - `sleepAction` 去掉了 `hygiene: -5` effect

### 不修的（Mock LLM 局限，非系统问题）

- 位置固化 — Mock 决策的采样问题
- 反应轮未触发 — Mock 的 talk target 解析不匹配
- 经济失衡 — Mock 行为分布不均

## 已完成（本轮）

### 工具约束（世界规则）✅
- [x] `ActionContext` 扩展：加入 `gold`, `needs`, `locationType`
- [x] `ActionResult` 扩展：加入 `success` 字段
- [x] agent-loop：失败 action 存入记忆（importance 8，带 [失败] 前缀）
- [x] 约束实现：eat/drink（金币）、give_gift（金币）、work（精力）、wash/sleep（在家）
- [x] 工具描述加约束提示

### 灰色行为 ✅
- [x] `argue`：关系-10、双方happiness-15、social+5
- [x] `steal`：20~40金币、40%被发现（全镇关系-20）
- [x] `beg`：5~15金币、happiness-10

### 测试 ✅
- [x] 16 个约束单元测试全部通过
- [x] Live 1 日验证通过（约束正常：LLM 学会先回家再 sleep）
- [x] 96 个测试全部通过

## 已完成：活人感重构 ✅

### 1. daily_routine → preferences ✅
- [x] `CharacterCard` 类型：删除 `dailyRoutine`，新增 `preferences`（可选的软偏好）
- [x] `character/loader.ts`：读取 preferences
- [x] `prompt-builder.ts`：`formatRoutineHint` → `formatPreferencesHint`，注入"生活习惯"段落
- [x] 6 个角色 YAML 改写为性格化的生活习惯描述

### 2. relationships 初始归零 ✅
- [x] 6 个角色 YAML：relationships 全部清空 `{}`
- [x] backstory 保留动机线索（已有的 backstory 结构天然适合）
- [x] `simulation.ts`：删除从角色卡初始化关系的逻辑
- [x] `prompt-builder.ts`：删除 `card.relationships[c.id]?.context` 的预设关系上下文

### 3. 删除日程兜底 ✅
- [x] `agent-loop.ts`：删除 `needsLLM` 判断 + 日程兜底分支 + `handleFallback` 函数
- [x] LLM 失败时简单返回 skipped，不再按日程执行
- [x] 所有测试文件同步更新，删除 `dailyRoutine` 和预设 `relationships`

### 验证
- [x] 102 个测试全部通过

## 对话纠缠修复 ✅（2026-03-24）

- [x] `MemoryEntry` 新增 `relatedCharacterId`：talk 发出/收到时记录对方 ID
- [x] `formatForPrompt` 检测纠缠模式：连续 2+ 次 talk 同一人且无回复 → 标注"对方没有回应你"
- [x] `agent-loop.ts`：存记忆时填入 relatedCharacterId
- [x] 6 个新增单元测试通过

## 精力系统修复 ✅（2026-03-24）

- [x] 精力衰减 -1/tick → -0.5/tick
- [x] eat 新增 energy +10（吃饱恢复精神）
- [x] drink 新增 energy +5（饮料提神）
- 效果：睡眠时间从 14:00-18:00 推迟到 20:45-23:45，作息正常

## Live 一日模拟对比

| 版本 | 日志 | 总行为 | 关系涌现 | 睡眠时间 |
|------|------|--------|----------|----------|
| 修复前 | `logs/sim-1day-20260324-103810.md` | 89 | 2 对 | 14:00-18:00 |
| 精力修复后 | `logs/sim-1day-20260324-112325.md` | 159 | 5 对 | 20:45-23:45 |

已知问题（暂不修）：
- Emily 社交偏低（21），但已有首次主动搭话（→Sakiko）
- Alice 睡眠略早（18:30），因大量 work 消耗

## 已完成

- 对话纠缠修复（记忆标注未回复模式）
- 活人感重构（daily_routine→preferences / relationships归零 / 删日程兜底）
- 信箱系统替代阻塞式对话
- 反应轮已验证可用（Alice↔Maria 多轮对话）
- 压力测试框架（stress-sim.test.ts）
- 第一性原理修复（删强制睡觉 / 加 wash / 修 sleep hygiene）
- 工具约束 + 灰色行为（argue/steal/beg）
- Prompt 强化（金币/位置类型/社交饥渴/困境引导/约束预提醒）
- 角色卡重写（6 个角色含丰川祥子，深度人格描写）
- Live 1 日验证：约束失败 0 次，对话 28+ 次，祥子人格完整
- Live 7 日模拟完成（sim-7day-log.txt）
- 102 个测试全部通过

## 已完成：玩家系统 ✅（2026-03-24）

- [x] 玩家 CharacterState：有位置、需求、金币、信箱，需求随 tick 衰减
- [x] `SimulationConfig.playerId`：玩家跳过 LLM 决策，由前端操控
- [x] `Simulation.executePlayerAction()`：走和 AI 完全相同的 executeAction 管道
- [x] 约束检查一致：sleep/wash 必须在家，eat/drink 需要金币，和 AI 角色同规则
- [x] talk → 信箱 + 关系变化 + 记忆：和 AI 角色完全对等
- [x] Server API：`player_action` WebSocket + `POST /api/player/action` HTTP
- [x] 玩家角色卡 `data/characters/player.yml`
- [x] 11 个新增测试通过（含 AI 反应玩家消息）
- [x] 113 个测试全部通过

## 后续

- [ ] 前端玩家操作面板（位置选择、行为按钮、对话输入）
- [ ] 玩家信箱消息推送到前端

## 已完成的基础设施

- 时间系统、事件总线、世界状态
- 需求系统、关系系统、经济系统
- 天气、随机事件、节日、八卦
- 16 种行为工具（含 wash、argue、steal、beg），带前置条件约束
- 短期记忆、反思机制
- 存档/读档、Failover
- 前端 + WebSocket + API
