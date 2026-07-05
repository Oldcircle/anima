# Anima — 叙事系统实施计划

> 配套设计文档：[DESIGN-narrative.md](./DESIGN-narrative.md)
> 配套导入文档：[IMPORT-koukou-judgment.md](./IMPORT-koukou-judgment.md)
>
> **节奏原则**：每个 phase 必须可以独立验证。任一 phase 完成后即使停下，也是一个有价值的中间状态，不留半成品。

---

## 总体路线

```
Phase N0: 准备（分支 + 快照）
Phase N1: Scenario Pack 抽象 + 把现状包成 mygo-seaside     ← 不引入新功能，纯重构
Phase N2: narrative_state 命名空间 + 工具语义标签           ← 状态层接入
Phase N3: BeatEngine + 表达式求值器                         ← 规则导演
Phase N4: LLM Director Agent                                ← LLM 导演
Phase N5: 玩家干预层 + UI 暴露                              ← 玩家入口
Phase N6: 扣扣审判 scenario pack 完整导入                   ← 大规模内容
Phase N7: 全链路调优 + 跨剧本回归                           ← 收尾
```

每个 phase 的"完成定义"必须包括：单元测试 + 至少一次 live 半天 sim 验证 + STATUS.md 更新。

---

## Phase N0 — 准备 (~半天)

**目标**：建分支、快照当前能跑通的状态、把决策记录冻结。

**任务**：
- [ ] 切分支 `feat/narrative-engine`（基于当前 main）
- [ ] 跑一次 `pnpm test` + `pnpm test:live` (sim-halfday) 作为基线，把日志归档到 `logs/baseline-pre-narrative.md`
- [ ] STATUS.md 增加段落"叙事系统重构开始 - baseline"
- [ ] 把 DESIGN-narrative.md / PLAN-narrative.md / IMPORT-koukou-judgment.md commit 到分支

**完成条件**：分支存在，baseline 日志归档，三份文档在分支上。

**风险**：无。这是纯准备 phase。

---

## Phase N1 — Scenario Pack 抽象 (~1-2 天)

**目标**：把现有 `data/characters/` + `data/locations/` 包成一个剧本包 `mygo-seaside`，引入 scenario loader，但**功能 0 变化**。

### 任务

- [ ] 定义 `ScenarioManifest` 类型
- [ ] 实现 `narrative/scenario-loader.ts`：读 `data/scenarios/<id>/manifest.yml`，解析 characters/locations 引用
- [ ] 创建 `data/scenarios/mygo-seaside/`：
  - `manifest.yml`（启用现有 5 角色 + 现有所有地点）
  - 软引用现有 yml（不复制，用相对路径或 id 引用）
- [ ] CLI / dev server 加 `--scenario` 参数，默认 `mygo-seaside`
- [ ] 现有 character-loader / location-loader 改为接收 scenario，从 scenario 拿 id 列表
- [ ] 单测：`scenario-loader.test.ts` 覆盖加载、引用、错误剧本
- [ ] Live sim：跑 sim-halfday，确认行为与 baseline 一致

### 完成条件

- 现有所有测试通过
- sim-halfday 输出与 baseline 行为可比（不要求字节级一致）
- `pnpm dev --scenario mygo-seaside` 等价于现有 `pnpm dev`

### 风险

- 现有代码可能多处直接引用 `data/characters` 路径，需要全量审计
- 存档兼容性：现有存档没有 scenario_id 字段 → 默认填 mygo-seaside

---

## Phase N2 — narrative_state + 工具语义标签 (~2 天)

**目标**：在世界状态里加 narrative_state 命名空间；改造现有工具支持可选语义标签；让标签流向 narrative_state。

### 任务

- [ ] 在 `world/state.ts` 加 `narrativeState: NarrativeState`
- [ ] 持久化层（SQLite）加 narrative_state 表，落库 + 读档
- [ ] 改造工具 schema（`talk` / `give_item` / `go_to`）增加可选字段：
  - `topic_tags?: string[]`
  - `intent?: string`
  - `reveals?: string[]`
  - `references_event?: string`
- [ ] 工具执行器把这些字段翻译成 narrative_state 写入
- [ ] Prompt builder：注入"语义标签使用说明"段落 + 当前 unresolved_events 摘要
- [ ] 引擎：每 tick 末尾算一次 `tension_index`
- [ ] 单测：narrative-state.test.ts、tool-tags.test.ts
- [ ] Live sim：跑 sim-halfday，**人工检查**日志中是否有自然产生的语义标签

### 完成条件

- LLM 在没有强制要求的情况下，半天 sim 至少出现 ≥3 次语义标签自填
- narrative_state 落库读档无丢失
- 现有测试全通过

### 验证拐点

如果 LLM 完全不填语义标签，说明 prompt 引导不够；调 prompt 重跑，直到自填率 OK。这是 N3 的前置条件——如果 N2 不出标签，N3 的 beat 永远触发不了。

### 风险

- prompt 注入过多 → token 涨 → 慢 + 贵。控制 unresolved_events 摘要长度（最多 5 条，每条 1 行）
- 标签自填率低 → 进入兜底：N3 的 precondition 必须有"非标签"备用路径

---

## Phase N3 — BeatEngine + 表达式求值器 (~2-3 天)

**目标**：纯规则的 beat 引擎跑起来，能从 narrative_state 触发 beat 并 emit 事件。**不接 LLM**。

### 任务

- [ ] 选型并接入表达式 DSL（倾向 jexl）
- [ ] 实现 `narrative/expression.ts`：包装 jexl，注入 narrative_state context，提供 `does_not_contain` / `top_trust_target` 等自定义函数
- [ ] 实现 `narrative/beat-engine.ts`：
  - 加载 `scenarios/<id>/beats.yml`
  - 维护 `triggered_beats` 已触发集合
  - `scan(worldState) -> BeatReadyEvent[]`
  - cooldown / repeatable / fallback deadline 支持
- [ ] tick-engine 每天结束时调 BeatEngine.scan，emit `beat_ready` 事件到 event bus
- [ ] 给 mygo-seaside 写 5-10 个 demo beats（坦白、争吵、重逢等）
- [ ] 单测：expression.test.ts（边界值、错误处理）、beat-engine.test.ts（触发、cooldown、fallback）
- [ ] Live sim：跑 sim-1day，看 beats.yml 中至少 1-2 个 beat 自然触发

### 完成条件

- 所有 demo beats 中至少 30% 在 1 日 sim 中触发
- 触发链可在日志里追溯（哪个字段满足了哪个 precondition）
- 0 个 beat 误触发（precondition 不满足却触发）

### 风险

- 表达式 DSL 出现"看似简单但写起来很别扭"的情况 → 留好自定义函数的扩展点
- beat 之间相互竞争（同一 tick 多个 beat 同时 ready） → 加优先级字段，排序触发

---

## Phase N4 — LLM Director Agent (~3-4 天)

**目标**：实现导演 agent，订阅 `beat_ready` 事件，调用 director toolset 改世界状态。

### 任务

- [ ] 定义 director toolset（DESIGN-narrative §3.4 中 8 个工具）
- [ ] 实现 `narrative/director.ts`：
  - prompt 模板（输入：beat ready 信息 + 当前世界摘要 + tension 指标）
  - LLM 调用循环（最多 3 步工具调用）
  - 输出 = world state mutations
- [ ] 接入 event bus：监听 `beat_ready`、监听每天 06:00 节奏检查
- [ ] director 调用频率限制：默认每天最多 5 次 LLM 调用，超出 do_nothing
- [ ] 调用日志单独落 `logs/director-<date>.md`，便于审查
- [ ] 单测：director-tools.test.ts（mock LLM）
- [ ] Live test：director.live.test.ts，单 beat ready → 验证产出合理 mutation
- [ ] Live sim：跑 sim-1day，人工 review director 日志

### 完成条件

- Director 至少有 80% 的调用产出"非 do_nothing"的合理动作
- Director 从未让任何角色直接说话或做动作（仅通过 inject_intent 间接影响）
- 每日 LLM 调用预算控制在 ≤5 次
- sim-1day 主观感受：世界比 N3 之前"更有事发生"

### 风险

- Director 越权（试图直接生成台词） → prompt 里硬约束 + 工具集本身不暴露 say 能力
- Director 过度干预 → 节奏调控时优先 do_nothing
- 成本失控 → 调用预算 + 短 prompt

---

## Phase N5 — 玩家干预层 + UI (~2 天)

**目标**：玩家从 Web UI 可以查看 narrative_state、向世界注入扰动。

### 任务

- [ ] HTTP API：
  - `GET /api/narrative/state` 当前 narrative_state 快照
  - `GET /api/narrative/beats` 已触发 / 待触发 beat 列表
  - `POST /api/narrative/inject-event` 玩家手动加 unresolved_event
  - `POST /api/narrative/inject-rumor`
  - `POST /api/narrative/nudge` （触发一次 director 节奏检查）
- [ ] WebSocket 推送：beat_ready / beat_resolved 实时事件
- [ ] Web UI：新增"叙事面板"标签
  - 当前阶段 / tension / 未解决事件列表
  - 已触发 beats 时间线
  - "塞纸条"按钮（玩家干预入口）
- [ ] 单测：API e2e 几个核心端点

### 完成条件

- 玩家能在 UI 看到一个有未解决事件、有 tension 曲线、有 beat 时间线的世界
- "塞纸条" 操作能在下个 tick 被某角色感知（通过 inject_observation 路径）

### 风险

- UI 设计会消耗时间 → 第一版极简，纯文本列表即可，美化留到 N7

---

## Phase N6 — 扣扣审判 Scenario Pack 导入 (~5-7 天)

**目标**：把扣扣审判卡按 IMPORT-koukou-judgment.md 的策略，导入为 `data/scenarios/koukou-judgment/`，可独立 sim。

这一期是**内容工程**，工作量主要在 yaml 写作而不是代码。

### 子阶段

#### N6.1 角色 + 地点 (~1.5 天)
- [ ] 14 个魔法少女角色 yml（按 IMPORT 文档的字段映射）
- [ ] 监管者：典狱长 + 看守（特殊 NPC，可能需要新 character type）
- [ ] 监狱洋馆地点 yml：B1F/1F/2F + 外部，~15 个 location

#### N6.2 世界观 + 规则 (~1 天)
- [ ] world.yml：魔女因子、监狱岛背景
- [ ] lore.yml：500 年历史 + 关键传说
- [ ] schedule 规则注入（自由时间 / 监房滞留 / 外出禁止）

#### N6.3 第一章 beats (~1.5 天)
- [ ] seeds.yml：开场未解决事件（艾玛的扭曲记忆、希罗的敌意、诺亚的画……）
- [ ] beats.yml：第 1 章核心 beats
  - phase_transition: peaceful → investigation（诺亚之死触发条件）
  - phase_transition: investigation → trial
  - phase_transition: trial → execution
  - 关键剧情 beats（艾玛与希罗第一次对话、雪莉教艾玛加好友、等）

#### N6.4 工具扩展 (~1 天)
- [ ] 新增 narrative-specific 工具（仅本 scenario 启用）
  - `vote(target)` / `present_evidence(...)` / `accuse(...)`
- [ ] phase 专属工具白名单（peaceful 阶段不允许 accuse 等）

#### N6.5 Live sim (~1.5 天)
- [ ] 跑 sim-day，验证第一章前半（peaceful → 诺亚之死触发）
- [ ] 跑 sim-day，验证 investigation 阶段
- [ ] 跑 sim-day，验证 trial 阶段（这一段最复杂，可能要多轮调优）
- [ ] 整章 logs 归档审查

### 完成条件

- 一次 sim 能跑通：peaceful → 案发 → 搜查 → 审判 → 处刑（即使内容粗糙）
- 与 mygo-seaside 不串扰
- 所有第一章 beats 可触发

### 风险

- **最大风险期**。审判阶段的多角色辩论是 LLM 难度最高的场景，可能要多次返工
- 14 个角色同时活跃 → token 成本高，需要严格 prompt 裁剪
- 14 个角色卡的人设充实度参差 → 优先 5 个核心（艾玛、希罗、雪莉、诺亚、亚里沙），其余先用占位

---

## Phase N7 — 调优 + 回归 (~2-3 天)

- [ ] mygo-seaside 跑 7 日 sim，对比 baseline 看是否回归
- [ ] koukou-judgment 跑 3 日 sim
- [ ] 抓 director 日志的低质量调用，迭代 prompt
- [ ] 性能：BeatEngine scan 耗时、director 调用预算
- [ ] STATUS.md 更新到当前
- [ ] CLAUDE.md "活跃文档"列表清理（废弃文档移除）
- [ ] 合并 PR review

### 完成条件

- 两个 scenario 都能跑通完整一日，无崩溃
- LLM 调用成本不高于 baseline 的 1.5 倍
- 用户主观验收

---

## 总计

| Phase | 估时 | 关键产出 |
|---|---|---|
| N0 | 0.5 d | 分支 + baseline |
| N1 | 1-2 d | scenario pack 重构 |
| N2 | 2 d | narrative_state + 标签 |
| N3 | 2-3 d | beat engine |
| N4 | 3-4 d | director |
| N5 | 2 d | 玩家入口 + UI |
| N6 | 5-7 d | 扣扣审判导入 |
| N7 | 2-3 d | 调优 |

**理论最短**：~3 周专注开发  
**实际预期**：会更长，因为 N4/N6 都是 LLM-heavy，需要反复调 prompt

---

## Phase 间的硬依赖

```
N0 → N1 → N2 → N3 → N4 → N5
                ↓       ↓
                N6 ─────┘
                ↓
                N7
```

- N6 依赖 N3 + N4（导入需要 beat engine 和 director 可用）
- N5 不阻塞 N6，可并行（如果有人手）

---

## 中止策略

每个 phase 完成都是有价值的中间态，可以随时停下：

- 停在 N1：项目获得了 scenario pack 抽象，未来可手工写新剧本
- 停在 N3：项目获得了规则触发器系统，可写脚本化剧情，没有"涌现感"
- 停在 N4：项目有了完整双层导演，但只有 mygo 一个剧本
- 停在 N6：完整功能 + 扣扣审判，未调优
- 跑完 N7：发布候选

---

## 检查清单（每个 phase 完成时回答）

- [ ] 单测通过？
- [ ] Live sim 通过？
- [ ] STATUS.md 更新？
- [ ] 这个 phase 引入的新文件 / 新概念是否需要补到 DESIGN-narrative.md？
- [ ] 是否有发现需要修改 PLAN-narrative.md 的地方？
- [ ] 用户审查通过？
