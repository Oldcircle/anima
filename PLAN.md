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

## 后续计划

### 长期记忆（重构完成后）
- [ ] SQLite 向量搜索（embedding）
- [ ] 跨天记忆检索
- [ ] 反思洞察注入次日 prompt

### 体验打磨
- [ ] 前端玩家操作面板（位置/需求/金币）
- [ ] 角色记忆可视化
- [ ] 关系网络图
- [x] 7 天模拟测试（`stress-sim.test.ts`）

### 规模扩展
- [ ] 更多角色（8-10）
- [ ] 更多模型提供商
- [ ] 角色成长机制
