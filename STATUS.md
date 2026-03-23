# Anima — 开发状态

## 当前：信箱系统已完成，准备验证

**最后更新**：2026-03-23

## 第一性原理

> 每个角色（包括玩家）是独立 Agent。通过工具自主决策。没有特殊机制。

## 已完成的重构

信箱（Inbox）系统已替代阻塞式对话系统：

- [x] 实现 Inbox 系统（`CharacterState.inbox` + `World.sendMessage/consumeInbox`）
- [x] 修改 talk 工具（写信箱，不阻塞，参数改为 `target` + `message`）
- [x] 修改 prompt-builder（注入 `## 有人对你说` 段落）
- [x] 修改 agent-loop（消费信箱、存记忆、信箱有消息时强制调 LLM）
- [x] 修改 simulation.ts（移除对话特殊逻辑，talk 只触发关系变化）
- [x] 删除 conversation.ts
- [x] 修改 server.ts（玩家 talk 改为信箱方式）
- [x] 更新所有测试（76 通过）

## 当前：反应轮实现

信箱已验证可用（Emily 给 Maria 发了 3 条消息），但缺少同 tick 内的连续对话。

需要实现反应轮（Reaction Rounds）：
- [ ] simulation.ts：正常决策后，循环检查信箱有新消息的角色
- [ ] 给他们额外 LLM 决策机会
- [ ] 最多 3-4 轮，直到没有新消息
- [ ] 测试：同 tick 内 A→B→A 来回对话
- [ ] Live 验证对话质量

后续：
- [ ] 玩家成为完整 Agent
- [ ] 前端：玩家操作 → 工具调用

## 已完成的基础设施

- 时间系统、事件总线、世界状态
- 需求系统、关系系统、经济系统
- 天气、随机事件、节日、八卦
- 12 种行为工具（talk 已改为信箱模式）
- 短期记忆、反思机制
- 存档/读档、Failover
- 前端 + WebSocket + API
- 76 单元测试
