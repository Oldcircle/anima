# Anima — 开发状态

## 当前：P1 印象系统强化 + 测试改造

详见 DESIGN.md §7.3 + PLAN.md 实施任务

**最后更新**：2026-03-24

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

### 最新半天 Live 结果（2026-03-24）

日志：`logs/sim-halfday-20260324-164807.md`

| 指标 | 值 |
|---|---|
| 总行为 | 78 |
| 总跳过 | 153 |
| 对话次数 | 21 |
| 印象数 | 2 |
| 约束失败 | 1 |

观察：
- Maria ↔ Alice 形成了明显主线，对话 19 次，关系达到 `best_friend (90)`
- Bob ↔ 祥子有低强度接触，已出现 `acquaintance (10)`
- 角色并非全部平均活跃，Emily / 老陈在社交上仍偏安静，后续适合从“观察与社会推理”切入补强

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

### 下次继续入口

1. **Live 验证**：跑一日模拟（`pnpm test:sim`），验证 P1+P2 完整效果：印象深化、疑惑驱动对话、观察推理
2. **长期记忆**：SQLite 向量搜索、跨天记忆检索、反思洞察注入次日 prompt
3. 可选：印象持久化（SQLite 存储，跨存档保留）
4. 可选：前端玩家操作面板（位置/需求/金币/对话输入）

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
