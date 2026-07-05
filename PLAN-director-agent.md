# PLAN — Director Agent 化改造

> 把 LLM Director 从"贫血单步反射"升级为"有视野、有反馈、有规划"的真正 agent。

## 背景与痛点

当前 director（`src/narrative/director.ts`）已是 LLM agent，但是个**贫血 agent**：
- **看不见**：只能读 prompt 里塞的 `buildWorldSnapshot`（角色 id + 事件摘要 + tension 数字），看不到角色具体在干什么/想什么
- **没反馈**：inject_intent 完成后不知道角色是否接住，下一次决策时没有 observed → expected 的对照
- **没记忆**：每次 invoke 都是 cold start，不知道自己昨天为什么推过那个 beat
- **写工具粒度太硬**：只有 inject_intent / add_unresolved_event 这种重锤，没有"软推"档位

用户在 2026-04-09 讨论里直接定调：「对世界现状判断不好，对世界的扰动不对，也没有长久的规划」。

## 设计原则

1. **先读后写**：任何写操作前必须至少调用 1 次 read 工具
2. **arc 必须 pin 到 beat**：除最多 1 条 freelance arc 外，其他都必须服务于一个具体 beat_id
3. **历史窗口 8 tick**：read 历史固定看最近 8 tick（≈2 小时游戏内）
4. **软档位优先**：能用 amplify_event/seed_topic 的不用 inject_intent
5. **每一步独立可关**：每个 Phase 都有 feature flag，回退安全

## 4 个 Phase

### Phase D1 — Director 看得见 + tool loop

**目标**：让 director 能主动调查世界，prompt 瘦身。

- 新增 `src/narrative/director-read-tools.ts`
  - `read_character(id)` → 最近 8 tick action / 3 条内心独白 / 当前 currentIntent / observableState / top 3 印象
  - `read_scene(location_id)` → 当前 occupants / 最近 10 条事件 / 最近对话摘要
  - `read_arc_status(arc_id)` → 占位（D4 真正落地，先返回 stub 让 schema 稳定）
- 改 `DirectorToolContext`：注入 `memory: ShortTermMemory` + `impressions: ImpressionStore`
- 改 `Director` 构造：接受 memory + impressions 引用
- 改 `simulation.enableDirector`：透传引用
- 改 `Director.invoke`：单次 LLM 调用 → **tool loop（最多 5 轮）**
  - 每轮把上一轮 tool result append 到 messages
  - 写工具调用次数硬上限 2
  - 强制规则：第一次调用必须是 read 类，否则 prompt 里给警告并要求重新决策
- `buildWorldSnapshot` 砍到只剩：角色 id + 一行位置、tension 数字、unresolved event 标题（不含 summary 全文）

**验证**：
- 单测：3 个 read 工具的 schema + handler，覆盖空状态 / 正常 / 角色不存在
- live：跑 last-ferry mini，导出 director call log，断言每次 invoke 至少 1 次 read 调用
- token：对比改造前后单次 director invoke 的 prompt+output token 消耗

---

### Phase D2 — Pulse 反馈闭环

**目标**：让 director 知道自己上次推完之后世界发生了什么。

- SQLite 新表 `director_pulses`：
  ```
  id TEXT PK, tick INT, arc_id TEXT, tool_name TEXT,
  target_char TEXT, args_json TEXT,
  expected TEXT, observed TEXT, observed_at_tick INT
  ```
- 所有 write 工具自动落库（在 handler 包装层）
- 新增工具 `read_pulse_outcome(pulse_id)` → 返回 expected + observed + 后续 8 tick 的 target_char action 摘要
- `observed` 字段由轻量 reducer 自动回填（**不调 LLM**）：tick 推进时扫描相关 char 后续 action，提取摘要
- Director 写工具 schema 增加可选 `expected: string` 字段（"我期望发生什么"）

**验证**：
- 单测：pulses 表 round-trip + observed 回填
- live：跑 last-ferry 一整天，导出 pulses 表，人工看 expected/observed 对照是否合理

---

### Phase D3 — 软档位工具

**目标**：给 director 比 inject_intent 更轻的档位。

- 新增 2 个写工具：
  - `amplify_event(event_id, target_chars[], reason)` → 往指定角色 short-term memory 注入"你今天反复想起 {event.summary}"
  - `seed_topic(char_id, topic, urgency)` → 写到角色 currentIntent 的 want_to_discuss 字段
- 角色 prompt-builder 端小改：读取 want_to_discuss 并提示"如果进入对话场景，可以考虑提起 X"
- prompt 规则更新：明确告知 director "amplify/seed 是首选，inject_intent 是大锤"

**验证**：
- 单测：两个工具的 handler
- live：手动触发，断言下一 tick 角色 prompt 里出现 want_to_discuss 段

---

### Phase D4 — DirectorAgenda 持久化

**目标**：让 director 有跨 invoke 的工作记忆与长期规划。

- SQLite 新表 `director_arcs`：
  ```
  id PK, beat_id TEXT, goal TEXT, target_day INT,
  status TEXT (setup|brewing|climax_ready|resolved|abandoned),
  watch_chars_json, notes TEXT, created_at_tick, updated_at_tick
  ```
- 新增 2 个工具：
  - `create_arc({beat_id, goal, target_day, watch_chars})` → arc_id
  - `update_agenda(arc_id, patch)`
- 自动注入：每次 invoke 在 prompt 头部塞 active arc 摘要（director 不需要主动 read）
- `read_arc_status(arc_id)` 真正实现：返回 arc + 关联 pulses
- 硬约束：
  - active arc ≤ 3
  - freelance arc ≤ 1，超过 2 游戏日强制 abandon
  - resolved arc 归档到 `director_arcs_archive`
- 节奏检查（daily 06:00）改成 "agenda review"：先决定 arc 增删，再决定行动

**验证**：
- 单测：agenda 表 round-trip + 约束执行
- live：跑完整 3 天 last-ferry，导出 director_arcs + director_pulses 时间线，人工看是否形成连贯的"我在做什么、为什么、下一步"链条

---

## 依赖图

```
D1 (read 工具 + tool loop)            ← 必须先做
  ↓
D2 (pulse 反馈)                       ← 依赖 D1 的 ctx
  ↓
D3 (软档位工具)                       ← 复用 D2 的 pulse 落库
  ↓
D4 (agenda 持久化)                    ← 依赖 D2 的 pulse schema
```

## Rollback 策略

每个 Phase 都通过 `DirectorConfig` 上的 feature flag 控制：
- `useReadTools?: boolean`（D1）
- `usePulseFeedback?: boolean`（D2）
- `useSoftTools?: boolean`（D3）
- `useAgenda?: boolean`（D4）

默认全开，但任何一个出问题都可以单独关掉退回旧路径。

## 决策记录

- **D-Agent-1**：read 工具历史窗口 = 8 tick（≈2 小时游戏内），不可配置
- **D-Agent-2**：tool loop 上限 5 轮，写工具上限 2 次/轮
- **D-Agent-3**：active arc 上限 3 条，freelance ≤ 1 且 ≤ 2 游戏日
- **D-Agent-4**：软档位只做 amplify_event + seed_topic，hint_mood/fade_event 暂不做（YAGNI）
- **D-Agent-5**：observed 字段用 reducer 自动回填，不消耗 LLM 调用
