# Anima — 实现分期计划

> 详细架构设计见 [DESIGN.md](./DESIGN.md)
>
> **第一性原理：每个角色是独立 Agent，通过工具自主决策。没有特殊机制。玩家 = Agent。**

---

## 已完成

### Phase 0: 基础骨架 ✅
项目初始化、时间系统、事件总线、世界状态、记忆模块、多 provider 抽象

### Phase 1: 单角色验证 ✅
角色卡 YAML、需求系统、行为工具、Agent 决策循环、DeepSeek 集成

### Phase 3 部分: 世界系统 ✅
天气、经济、随机事件、节日、八卦传播、夜间休息、存档/读档

### Phase 4: 前端 ✅
WebSocket + HTTP API + Web UI（地图/面板/事件流/速度控制）

---

### 架构重构：信箱系统 ✅

用 Inbox 替代了阻塞式 Conversation 系统：
- 引入信箱（`CharacterState.inbox`），`talk` = 写信箱，不阻塞
- 删除 `conversation.ts`，talk 和 eat/work 完全平等
- prompt-builder 注入"## 有人对你说"，信箱有消息时强制调 LLM
- server.ts 玩家 talk 也走信箱
- 76 测试通过

---

## 已完成：修复第一性原理违规 ✅

- [x] 删除夜间强制睡觉
- [x] 添加 `wash` 工具
- [x] 修复 sleep hygiene bug
- [x] 反应轮 Live 验证

---

## 已完成：工具约束 + 灰色行为 ✅

- [x] ActionContext 扩展（gold/needs/locationType）
- [x] ActionResult success 字段 + 失败存记忆
- [x] 6 个约束（eat/drink/give_gift/work/wash/sleep）
- [x] 3 个灰色行为（argue/steal/beg）
- [x] 16 个约束单元测试 + 96 个总测试通过
- [x] Live 7 日模拟（sim-7day-log.txt）

---

## 已完成：Prompt 强化 + 角色卡重写 ✅

- [x] Prompt 注入：金币余额、位置类型、社交饥渴、困境引导、约束预提醒
- [x] 角色卡扩展：appearance、core_traits、psychology、stress_response、speech examples、backstory
- [x] 6 个角色 YAML 重写（含新增丰川祥子）
- [x] Live 1 日验证：约束失败 0 次，对话 28+ 次，祥子人格完整

---

## 已完成：活人感重构 ✅

- [x] `daily_routine` → `preferences`（硬日程 → 软偏好）
- [x] `relationships` 初始归零（关系从社交中涌现）
- [x] 删除日程兜底（每 tick 必调 LLM）
- [x] 96 个测试全部通过

---

## 已完成：玩家系统 ✅

- [x] 玩家 = 完整 CharacterState（位置/需求/金币/关系/信箱）
- [x] 前端操作 → WebSocket `player_action` → `executePlayerAction()` → 同一管道
- [x] 和 AI 角色完全相同的执行/约束/效果/关系/记忆管道
- [x] 113 个测试全部通过

---

## 已完成：第一性原理收口（第一阶段） ✅

- [x] Prompt 分层：将“可见事实”和“主观感觉/印象”拆开，弱化直接关系数值暴露
- [x] `CharacterState.currentIntent`：引入会自然过期的短期意图，保留跨 tick 连续性
- [x] `talk` 明确为同场当面说话，不再只是抽象“发消息”
- [x] 社交事件的旁观者会留下 observation 记忆，世界开始积累“我看见了什么”
- [x] `pnpm build` 通过
- [x] `pnpm test` 通过（149 tests）

---

## 当前：活人感深度改造

详见 [DESIGN.md 第七章](./DESIGN.md#七行为自然度下一阶段重点)

核心洞察：对比 SillyTavern（夏瑾预设），Anima 的问题不是架构而是**给 Agent 的世界太贫瘠**。真实人类决策时有丰富上下文（环境感知、对人的标签、心理猜测），Agent 也需要。五层改进方案：让角色真正"看到"更丰富的世界。分析笔记见 `~/Opensource/notes/Anima活人感分析-酒馆对比与五层改进方案.md`。

### 当前优先级调整

- [x] 先做“局部感知 + 短期意图 + 旁观观察”的第一阶段收口
- [x] 印象更新与半天 live 报告链路收稳（等待后台任务、日志结构化、解析回退）
- [ ] 继续推进 P1：人物印象系统从“可注入”走向“稳定更新 + 更强主观性”
- [ ] 继续推进 P2：观察与社会推理，从“看到”走向“解读”

### 当前攻坚：生活惯性 + 世界痕迹

核心判断：当前“不像活人”不是因为角色不会说话，而是因为角色缺少跨 tick 的生活惯性，行为也没有留下足够可被他人感知的痕迹。角色更像被身体需求推着走的状态机，而不是带着未完事务继续活下去的人。

- [x] `currentIntent` 真正接入 agent 主循环
  - 失败行为、被打断的行为、收到消息、主动计划都写入短期意图
  - prompt 注入“你现在还挂着的事”
  - 合适时清除/更新意图，避免永远执念
- [x] `observableState` 成为行为执行后的一级产物
  - `ActionResult` 增加 `observableState`
  - `CharacterState` 记录当前可观察状态及其来源
  - prompt-builder / observation-reasoning 不再只看粗粒度 action name
- [x] 丰富更多行为的 `observableState` 细节（独处发呆、离席、分享食物、工作姿态）
- [x] 前端时间线 / 角色面板优先展示 `observableState`，避免 UI 把生活片段重新压扁成工具名
- [x] 同一对角色的每 tick 对话上限真正生效（主轮 `talk` 也计入反应轮配额）
- [x] `go_to` 拒绝不存在的地点，避免模型幻觉地点混入世界状态
- [x] 跨 tick 社交冷却接入主决策，让“先缓一缓”成为世界约束而不是 prompt 建议
- [ ] 让 `observableState` 带入更多关系语气（熟人/陌生人/同事在场时的差异）
- [ ] 用修补后的 half-day / unit tests 继续验证“行为像生活而不是像工具调用”

### P0-a：环境感知 + 内心独白分级

- [ ] 地点 YAML 加 `atmosphere` 字段（morning/afternoon/evening/rainy 四段感官描写）
- [ ] `prompt-builder.ts`：根据时间/天气注入环境描写，替代干巴巴的地点名
- [ ] 附近角色从 `[stranger]` 改为可观察状态描述（当前行为 + 朝向）
- [ ] 社交场景（附近有人/信箱有消息）maxTokens 512 → 1024，思考指令扩展
- [ ] system prompt 加入社交引导（犹豫/改口/言不由衷/转移话题/沉默）
- [x] 动态 backstory 注入（根据当前位置/状态/时间选择相关 backstory 条目）
- [ ] Live 一日验证

### P0-b：对话模式

- [ ] 设计对话触发检测逻辑（同地点 + 2 tick 内互相 talk 2+ 次）
- [ ] 新建 `conversation-mode.ts`：对话上下文管理 + 叙事 prompt 构建
- [ ] 对话模式 prompt：完整历史 + 环境 + 印象 + 叙事风格指引
- [ ] 对话输出格式：innerThought / action / dialogue / observation
- [ ] `agent-loop.ts` 集成：检测触发 → 进入对话模式 → 结束恢复
- [ ] 对话模式不阻塞其他角色的 tick 循环
- [ ] Live 验证：Maria↔Sakiko 对话质量对比

### P1：人物印象系统

- [x] `CharacterImpression` 数据结构（summary/observations/mentalLabel/unresolved）
- [x] `ImpressionStore`：存储/合并/格式化，替代 CharacterState 内联
- [x] 互动后反思步骤：LLM 生成/更新印象（`impression-updater.ts`）
- [x] `prompt-builder.ts` 注入印象替代纯数字关系
- [x] 首次印象阈值降低：2 条交换即可触发首次印象（更新仍需 4 条）
- [x] 未解疑惑驱动对话：prompt 注入"你心里好奇的事"引导自然探索
- [x] 独处时回忆：社交需求低时，prompt 提示记忆中的人
- [ ] Live 验证：角色首次 vs 第五次见面的差异

### P2：观察与社会推理

- [x] 观察触发逻辑：空闲 + 同地点有可观察行为的角色 + 4 tick 冷却
- [x] 轻量级观察 LLM 调用（一句话推理，maxTokens 128，temperature 0.7）
- [x] 观察存入记忆（type: "observation"，importance 6）
- [x] 目标选择策略：优先有已有印象的人（能深化理解）
- [x] 集成 simulation.ts：fire-and-forget，不阻塞 tick 循环
- [x] 7 个单元测试（shouldObserve 边界条件）
- [ ] Live 验证：涌现基于观察的无声关怀行为

---

## 后续计划

### 长期记忆 ✅

- [x] SQLite 持久化层扩展：`impressions` 表 + `long_term_memories` 表
- [x] 印象持久化：save/load 时保存和恢复所有角色印象
- [x] 长期记忆：高重要性记忆（importance >= 7）自动存入长期记忆表
- [x] 跨天记忆检索：按角色、按相关角色、按关键词三种检索方式
- [x] 读档时恢复：长期记忆注入短期记忆（前 10 条最重要的），反思洞察跨天生效
- [x] 2 个新增单元测试（印象持久化 + 长期记忆检索）
- [ ] 未来：embedding 向量搜索（需接入 embedding API）

### 对话系统修复 ✅

- [x] **对话并行交错**：反应轮内串行执行（不用 Promise.all），每个 reactor 执行后立即处理 talk 效果
- [x] **单句蹦词**：talk 工具描述 + prompt 引导"你可以一口气说完想说的"
- 约束：不引入对话管理器，不违反第一性原理

### 感知重构（高优先级）

两项核心改造，让 Agent 从"看数据选菜单"变成"感受身体+感知环境→自然行动"。
详见 DESIGN.md §2.2 和 §3.1。

#### A. 需求感受化

- [ ] `prompt-builder.ts`：`formatNeeds()` → `formatBodyFeelings()`
  - 需求值转为分级感受描述（>60 不提，30-60 轻度，15-30 中度，<15 紧急）
  - 组合成自然段落，不再是列表
  - 满的需求不出现在 prompt 中
- [ ] 约束警告自然化：金币不足时在感受中自然提及
- [ ] 删除 `formatNeeds()` 数值面板和 `buildConstraintWarnings()`
- [ ] 对话模式 `buildConversationPrompt` 同步更新
- [ ] 测试更新：prompt-builder.test.ts 适配新格式

#### B. 情境工具系统（Affordance-based Tools）

- [ ] 地点 YAML 新增 `tools` 字段：每个地点定义可用工具
  - beach: swim, collect_shells, fish
  - bakery: eat(buy bread), buy_bread
  - cafe: drink_coffee, eat
  - library: read, study
  - home_*: sleep, wash, cook
  - bar: drink
  - 等等
- [ ] `LocationToolDefinition` 类型 + 地点工具加载器
- [ ] `buildToolList(state, location, nearbyChars)` 动态组装工具列表
  - 通用工具（go_to 动态描述, hobby）
  - 地点工具（从当前地点 YAML 读取，检查 condition/cost）
  - 社交工具（附近有人时：talk 动态列出对象, gossip, comfort, give_gift）
  - 极端工具（gold=0 时 beg，gold=0+hunger<20 时 steal）
  - 工作工具（当前地点是角色工作地点时 work）
- [ ] `go_to` 参数动态化：列出所有地点 + 每个地点能做什么（摘要）
- [ ] `talk` 参数动态化：只列出当前在场的角色
- [ ] 删除 prompt 中的 `## 可前往的地点` 章节（信息移入 go_to 工具描述）
- [ ] 删除 `buildConstraintWarnings()`（约束通过工具是否出现来体现）
- [ ] 重构 `agent-loop.ts`：调用 buildToolList 而非传全局 actions
- [ ] 重构 `basic-actions.ts`：拆分为通用工具 + 迁移地点工具到 YAML
- [ ] 测试更新
- [ ] Live 半天验证：确认行为多样性和决策质量

### 心智系统

- [x] **思考持久化**：LLM 内心独白存入记忆，念头跨 tick 延续
- [ ] **心情系统**：happiness 衰减 + 情境修正 + mood 注入 prompt → 移至 Phase 7D Moodlet
- [ ] **生存紧迫**：hunger/energy 极低时更强 prompt 警告 + 生物安全网

### 体验打磨

- [x] 前端重写（三栏布局：角色列表/时间线/详情面板）
- [x] 角色档案/记忆/印象展示
- [ ] 关系网络图
- [x] 7 天模拟测试（`stress-sim.test.ts`）

### 规模扩展
- [ ] 更多角色（8-10）
- [ ] 更多模型提供商
- [x] 角色成长机制 → 移至 Phase 7

---

## 当前：角色系统深化（模拟人生启发）

> **目标：让 AI 可以自由生活的世界。角色不只是"有性格的对话机器"，而是有工作、有成长、有人生目标、有社会关系的完整个体。**
>
> 借鉴模拟人生：技能成长、职业阶梯、关系类型化、愿望系统、Moodlet 情绪。
> 详见 DESIGN.md §2.2-2.4。

### Phase 7A：生活状态层（Life State）— 地基

**目标**：角色知道自己在哪上班、有什么技能、追求什么。

- [ ] `CharacterCard` 新增 `life` 段 + `LifeState` 类型
  - occupation（可变）、workplace、age、income、skills、aspiration
  - currentGoal / currentConcern（从反思涌现）
- [ ] `CharacterState` 挂载 `life: LifeState`
- [ ] `character/loader.ts` 加载 YAML `life` 段
- [ ] 5 个角色 YAML 新增 `life` 段（含 workplace、初始技能、aspiration）
- [ ] `prompt-builder.ts` 改造：
  - 第一行从 `life` 读取（不再硬编码 age/occupation）
  - 注入工作认知："你在海风面包坊当面包店学徒"
  - 注入技能认知："你的烘焙技能还在学习基础"
  - 注入抱负："你一直想找到一个能理解自己的人"
  - 注入 currentGoal / currentConcern（如有）
- [ ] `work` action 新增 skill_up effect
- [ ] `simulation.ts` 处理 `skill_up` effect，更新 `life.skills`
- [ ] 测试：types、loader、prompt-builder、skill growth
- [ ] Live 半天验证：角色行为是否体现工作认知和目标感

### Phase 7B：关系类型化 + 社交动作

**目标**：关系有友谊/浪漫双轴，有告白/绝交等关系转变动作。

- [ ] `relationships.ts` 改造：
  - `level` → `friendship`（改名）
  - 新增 `bond?: BondType`
  - 新增 `RomanticFeelings` 单向存储
- [ ] 新文件 `actions/relationship-actions.ts`：
  - `confess`（告白）: friendship >= 30, romantic +30
  - `invite_out`（邀请出去）: friendship >= 30
  - `share_secret`（分享秘密）: friendship >= 60
- [ ] `prompt-builder.ts`：关系深度影响社交认知描述
  - 区分友谊/浪漫/bond 给出不同引导
- [ ] 社交工具条件浮现：invite_out 只在 friend+ 时出现
- [ ] 印象系统 + 关系类型联动
- [ ] 测试：双轴关系、bond 转变、工具条件浮现
- [ ] DB 持久化：romantic_feelings 表
- [ ] Live 半天验证：观察关系类型是否影响对话风格

### Phase 7C：愿望系统（从反思涌现）

**目标**：角色有持续的内在驱动力，不只是"饿了就吃、困了就睡"。

- [ ] `reflection.ts` 改造：
  - prompt 新增"最想做的事"和"担心的事"
  - `ReflectionResult` 新增 `wish` / `concern`
- [ ] 反思结果回写 `life.currentGoal` / `life.currentConcern`
- [ ] `prompt-builder.ts` 注入愿望/担忧到 user prompt
- [ ] 职业晋升检查（每日反思时）：
  - 技能达标 → 更新 occupation/income → 记忆"升职了"
- [ ] 测试：反思愿望提取、职业晋升、prompt 注入
- [ ] Live 一日验证：角色是否表现出目标驱动行为

### Phase 7D：Moodlet 情绪叠加

**目标**：情绪有原因、有时效、有层次，替代单一 happiness。

- [ ] 新文件 `src/world/moodlets.ts`：
  - `Moodlet` 类型（emotion/intensity/reason/expiry/source）
  - `MoodletManager`：add/tick/getDominant/format
- [ ] `CharacterState` 新增 `moodlets: Moodlet[]`
- [ ] 行为效果产生 moodlet 而非直接改 happiness：
  - talk → happy moodlet
  - confess 被拒 → embarrassed moodlet
  - 晋升 → confident moodlet
  - 长期 social 低 → lonely moodlet
- [ ] 需求级联：极低需求产生负面 moodlet + 行为效率影响
- [ ] `prompt-builder.ts`：注入情绪列表 + 主导情绪
- [ ] 测试：moodlet 生命周期、叠加、主导情绪、级联
- [ ] Live 半天验证：情绪是否影响决策风格

### 实施顺序与依赖

```
Phase 7A (Life State) ← 地基，所有后续依赖它
    ↓
Phase 7B (关系类型化) ← 依赖 7A 的 skills（social 技能影响关系）
    ↓
Phase 7C (愿望系统) ← 依赖 7A 的 life state + 7B 的关系事件
    ↓
Phase 7D (Moodlet) ← 依赖 7A-7C 的各种事件源
```

---

## 当前：Phase 8 — 需求系统重设计 + 工具系统重设计

> **目标：让角色从"看数据选菜单"变为"感受身体+感知环境→自然行动"。**
>
> 两大改造：(A) 需求从 5 维固定 struct 变为 6 维数据驱动；(B) 工具从"按钮→数值"变为"情境入口→有代价的行为选择"。
>
> 详见 DESIGN.md §2.5 和 §3.1。

### Phase 8A：数据驱动需求系统

**目标**：CharacterNeeds 从硬编码 5 字段变为 `Record<string, number>` + 配置驱动。删 happiness，加 fun、bladder。

- [ ] 新建 `src/world/need-definitions.ts`
  - `NeedDefinition` / `FeelingLevel` 接口
  - 6 维需求定义（hunger/energy/social/hygiene/fun/bladder）
  - 每个维度的感受化文案（3 级：mild/moderate/urgent）
  - `getDefaultNeeds()` / `getAllNeedIds()` / `getFeelings()` 等工具函数
- [ ] 重构 `src/world/types.ts`
  - `CharacterNeeds` 从 interface 改为 `Record<string, number>`
  - 删除 `happiness` 字段引用
  - 新增 `fun` 和 `bladder`
- [ ] 重构 `src/world/world.ts`
  - `DEFAULT_NEEDS` 从 need-definitions 读取
  - `NEED_DECAY` 从 need-definitions 读取
  - `decayNeeds()` 遍历定义列表而非硬编码字段
- [ ] 重构 `src/agent/prompt-builder.ts`
  - `formatBodyFeelings()` 改为从 NeedDefinition.feelings 读取
  - 删除 happiness 相关感受
  - 新增 fun/bladder 感受
  - social 高值感受保留
- [ ] 全局搜索替换 `needs.happiness` → 适配（部分改为 moodlet、部分改为 fun）
- [ ] 更新 `src/world/moodlets.ts`：`generateNeedMoodlets` 适配新维度
- [ ] 更新 `src/persistence/database.ts` + `save-load.ts`：needs_json 列自动适配
- [ ] 测试更新：world.test.ts / prompt-builder.test.ts / life-state.test.ts / moodlets.test.ts 等
- [ ] `pnpm build` + `pnpm test` 通过

### Phase 8B：工具系统重设计

**目标**：每个行为有代价、有 solo/social 变体、有后果涟漪。工具描述是人话不是数值表。

- [ ] 更新所有 action effects 适配 6 维需求
  - basic-actions.ts: eat/sleep/go_to/talk/work/wash 效果重映射
  - social-actions.ts: gossip/give_gift/comfort 效果重映射
  - leisure-actions.ts: read/explore/drink 效果重映射
  - gray-actions.ts: argue/steal/beg 效果重映射
  - relationship-actions.ts: invite_out/share_secret 效果重映射
- [ ] 新增行为工具
  - `use_toilet`（basic-actions）: bladder +100, 条件=有卫生间的地点
  - `nap`（basic-actions）: energy +25, fun -5, 条件=energy<60
  - `cook`（basic-actions）: hunger +60, fun +5, energy -8, hygiene -5, gold -5
  - `journal`（leisure-actions）: fun +8, social -2, 触发 reflection
  - `practice`（leisure-actions）: fun +10, energy -8, skill_up(高效)
  - `craft`（leisure-actions）: fun +8, energy -8, 产物可用于 give_gift
  - `help_work`（social-actions）: social +8(双方), energy -10, fun -5
  - `observe`（social-actions）: 深度 observation 记忆, energy -2
- [x] `SocialModifier` 机制（独立模块，17 个行为规则）
  - agent-loop 执行后自动检测同地点认识人并应用修正
  - observableState 联动：社交场景有专属描写
- [ ] 新增 `observableState` 字段
  - ActionResult 新增 `observableState?: string`
  - 各 action handler 返回可观察描述
  - observation-reasoning 从 observableState 获取信息
- [ ] 状态影响行为质量
  - agent-loop 在应用效果时计算效率因子
  - energy < 20 → 效果减半；fun < 15 → work 产出减半
- [ ] 行为链追踪 + 后果涟漪
  - CharacterState 新增 `recentActions`
  - agent-loop 检查连续行为模式 → 触发 moodlet（过劳/孤僻/宿醉等）
- [ ] 重构 tool-builder.ts
  - 工具描述改为自然语言动态生成
  - go_to destination 描述包含地点能做什么
  - talk target 描述包含在场角色的可观察状态
  - 社交语境融入工具描述
- [ ] 更新地点 YAML 工具定义（适配新维度+新工具）
- [ ] System prompt 新增"世界的常识"段（5 句话）
- [ ] 测试更新
- [ ] `pnpm build` + `pnpm test` 通过
- [ ] Live 半天验证：行为多样性和决策质量

---

## 当前：Phase 9 — 物品系统 + 行为链追踪

> **目标：物品不是装备，是角色生活、关系和事件的媒介。让世界有物质基础。**
>
> 详见 DESIGN.md §2.5 物品系统。

### Phase 9A：物品基础

- [ ] 新建 `src/world/item-types.ts`：ItemDef + ItemInstance 类型
- [ ] 新建 `src/world/item-registry.ts`：物品定义加载器
- [ ] 新建 `data/items.yml`：30-50 个基础物品定义（6 类）
- [ ] `CharacterState` 新增 `inventory: ItemInstance[]`
- [ ] `World` 新增物品管理方法（addItem/removeItem/transferItem）
- [ ] DB 持久化：`inventory_json` 列
- [ ] 角色卡 YAML 新增 `starting_items` 段
- [ ] `character/loader.ts` 加载 starting_items
- [ ] 测试：物品类型、增删改查、持久化

### Phase 9B：物品工具 + tool-builder 集成

- [ ] `buy` 工具：在有 shop 的地点浮现，列出可购买物品
- [ ] `use` 工具：背包有 consumable 时浮现（吃/喝/使用）
- [ ] `give` 工具：背包非空 + 附近有人时浮现
- [ ] `drop` 工具：放下物品到当前地点
- [ ] `pick_up` 工具：当前地点有公共物品时浮现
- [ ] tool-builder 根据背包物品启用工具（notebook→journal, guitar→practice）
- [ ] prompt-builder 注入随身物品描述（含 keepsake 记忆标签）
- [ ] 地点 YAML 新增 `shop` 段（面包店、咖啡馆、花店、杂货店、酒吧）

### Phase 9C：工作角色工具

- [ ] 地点 YAML 新增 `worker_tools` 段
- [ ] tool-builder 区分员工/客人工具集
- [ ] 删除旧 `work` 黑盒（8 tick 一次性）
- [ ] 收入改为通过 serve/make 等具体动作逐步获得
- [ ] 员工工具含 produces/consumes（做咖啡、烤面包）

### Phase 9D：旧工具迁移

- [ ] 删除抽象 `eat`/`drink`/`give_gift` 工具
- [ ] `cook` 改为消耗 `ingredients`，产出食物到背包
- [ ] `fish` 改为需要 `fishing_rod`
- [ ] `journal` 改为需要 `notebook`
- [ ] `practice`（音乐）改为需要 `guitar` 等乐器

### Phase 9E：行为链追踪

- [ ] `CharacterState.recentActions: { actionId: string; tick: number }[]`
- [ ] 模式检测逻辑（每 tick 执行）
- [ ] 触发 moodlet：过劳（连续工作 12+ tick）
- [ ] 触发 moodlet：孤僻（无社交 8+ tick）
- [ ] 触发 moodlet：宿醉（drink_alcohol 2+次/天）
- [ ] 触发 moodlet：无聊（连续 idle 4+ tick）
- [ ] 测试 + Live 验证
