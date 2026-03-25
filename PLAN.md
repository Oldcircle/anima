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

### P0-a：环境感知 + 内心独白分级

- [ ] 地点 YAML 加 `atmosphere` 字段（morning/afternoon/evening/rainy 四段感官描写）
- [ ] `prompt-builder.ts`：根据时间/天气注入环境描写，替代干巴巴的地点名
- [ ] 附近角色从 `[stranger]` 改为可观察状态描述（当前行为 + 朝向）
- [ ] 社交场景（附近有人/信箱有消息）maxTokens 512 → 1024，思考指令扩展
- [ ] system prompt 加入社交引导（犹豫/改口/言不由衷/转移话题/沉默）
- [ ] 动态 backstory 注入（根据当前位置/附近角色选择相关 backstory 条目）
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

### 心智系统（高优先级）

- [x] **思考持久化**：LLM 内心独白存入记忆，念头跨 tick 延续
- [ ] **心情系统**：happiness 衰减 + 情境修正 + mood 注入 prompt
- [ ] **生存紧迫**：hunger/energy 极低时更强 prompt 警告 + 生物安全网

### 体验打磨

- [ ] 前端重做
- [ ] 角色记忆可视化
- [ ] 关系网络图
- [x] 7 天模拟测试（`stress-sim.test.ts`）

### 规模扩展
- [ ] 更多角色（8-10）
- [ ] 更多模型提供商
- [ ] 角色成长机制
