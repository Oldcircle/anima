# Anima — 开发状态

## 当前：行为自然度提升

详见 DESIGN.md 第七章 + PLAN.md 实施任务

**最后更新**：2026-03-24

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
