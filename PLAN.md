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

## 当前：Live 验证 + 玩家系统

- [ ] **Live 验证跨 tick 对话**（`pnpm test:live`）
  - Alice talk("bob", "你好") → Bob 下一个 tick 看到 → 自主回应或无视
  - 广场 3 人互相 talk，不阻塞

- [ ] **玩家成为完整 Agent**
  - 有 CharacterState（位置、需求、金币、关系）
  - 前端操作 → WebSocket → 转化为工具调用
  - 点击地点 = go_to，输入文字 = talk
  - 和 AI 角色走完全相同的执行管道

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
- [ ] 7 天模拟测试

### 规模扩展
- [ ] 更多角色（8-10）
- [ ] 更多模型提供商
- [ ] 角色成长机制
