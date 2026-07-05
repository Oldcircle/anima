# Anima — 叙事架构设计 (Narrative Engine)

> 在现有"5 角色自主生活"基础上，加一层叙事系统，让世界有"未完成的事"和"该发生的事"。
>
> 与现有 [DESIGN.md](./DESIGN.md) 平行：DESIGN.md 描述角色 agent 与世界 tick，本文档描述叙事层。
>
> 第一性原理（叙事层）：**规则定结构，LLM 演血肉，角色演自己。三层各管各的，互不越权。**

---

## 1. 为什么需要这一层

当前 Anima 的问题不是细节不够，是**没有"为什么我要看下去"**：
- 角色都过自己的日子，互相无关，世界没有未解决的事
- 没有任何实体在做"导演"工作，纯涌现会塌成无聊日常循环
- 玩家是上帝视角观察者，缺少介入位置

叙事层要解决的问题：
1. 让世界一开始就有"待解决的状态"（叙事引力）
2. 让关键剧情有"该发生但不强制"的机制（结构化但不脚本化）
3. 让玩家有"隐形作者"的位置，介入而不操控
4. 让 5 个角色之外，有一只"导演"的手轻推世界

---

## 2. 四层结构总览

```
┌─────────────────────────────────────────────────┐
│ L0  玩家（最高编剧，可选介入）                    │
│     - 注入事件、塞纸条、调整天气                  │
│     - 直接修改 narrative_state（开发模式）        │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ L1  LLM 导演 Agent（决定 beat 怎么发生）          │
│     - 接收 BeatEngine 的 beat_ready 信号          │
│     - 决定触发方式：注入 intent / 生成观察 / 改   │
│       observableState / emit narrative_event     │
│     - 也负责低频"节奏调控"（每天 1-2 次）         │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ L2  Beat Engine（决定 beat 该不该发生）          │
│     - 加载 scenario.beats.yml                    │
│     - 每 N tick 扫一遍 preconditions（纯字段比较）│
│     - 触发即 emit beat_ready 事件                │
│     - 完全无 LLM，~150 行代码                    │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ L3  角色 Agent（演员，自主生活）                  │
│     - 现有架构不变                                │
│     - 工具调用时顺手填 narrative tags             │
│     - 工具执行器把 tags 翻译成 narrative_state    │
└─────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│        World State（被所有层共同改写）            │
│        + narrative_state（新增命名空间）          │
└─────────────────────────────────────────────────┘
```

**核心断言**：上层只读下层产生的状态字段，从不解析下层的自然语言输出。所有跨层通信都走结构化 state，不走 NLP。

---

## 3. 关键概念

### 3.1 Scenario Pack（剧本包）

一个剧本包 = 一个世界 if 线的初始条件。可热切换。

```
data/scenarios/<scenario-id>/
├── manifest.yml      # 元数据 + 启用的角色/地点/规则
├── world.yml         # 世界观、时代、超自然规则
├── characters/       # 该剧本启用的角色卡 YAML（可引用 data/characters/ 下的）
├── locations/        # 该剧本的地点 YAML（可引用 data/locations/ 下的）
├── lore.yml          # 公共背景（传说、历史、谣言）
├── seeds.yml         # 初始未解决事件 + 初始关系/状态种子
├── beats.yml         # 主线锚点（触发器集合）
└── narrative_schema.yml  # 该剧本声明它需要哪些 narrative_state 字段
```

**当前 MyGO 海边小镇** = `data/scenarios/mygo-seaside/`，作为默认剧本包。

**新剧本（扣扣审判）** = `data/scenarios/koukou-judgment/`，与 MyGO 并存。

CLI 启动时通过 `--scenario` 选参选择，不指定则用 manifest 默认。

### 3.2 narrative_state（叙事状态命名空间）

世界状态里新增的一个命名空间，专门承载叙事相关的结构化字段。它**和现有 character.relationships / impressions / needs 平级**，不替代它们。

最小必需字段集（v1）：

```ts
interface NarrativeState {
  // ── 世界级 ──
  world: {
    day: number;                            // 已有
    unresolved_events: UnresolvedEvent[];   // 未解决事件池
    triggered_beats: string[];              // 已触发的 beat id
    active_phase?: string;                  // 当前阶段（剧本可选用）
    tension_index: number;                  // 0-100，由引擎算
    rumors: Rumor[];                        // 流通中的谣言
  };

  // ── 角色级 ──
  characters: Record<CharId, {
    disclosed_secrets: string[];            // 已对他人坦白的秘密 id
    known_facts: string[];                  // 已知的世界事实 id
    unresolved_with: Record<CharId, string[]>; // 与某人之间的未结束的事
    pressure: number;                       // 0-100，叙事压力（不同于 needs.stress）
    secrets: string[];                      // 角色卡定义的秘密池（只读）
  }>;

  // ── 地点级 ──
  locations: Record<LocId, {
    events_witnessed: WitnessedEvent[];     // 这里发生过什么
    rumor_seeds: string[];                  // 八卦发源
  }>;
}

interface UnresolvedEvent {
  id: string;
  summary: string;             // 给 LLM 看的自然语言
  involved: CharId[];
  visible_to: CharId[] | "*";  // 谁知道这事存在
  created_tick: number;
  resolves_when?: string;      // precondition 表达式
}

interface WitnessedEvent {
  tick: number;
  summary: string;
  actors: CharId[];
  visibility: "private" | "overheard" | "public";
}
```

**关键约束**：narrative_state 不存自然语言剧情，只存**事实字段**。自然语言用于喂给 LLM 看，不用于解析。

### 3.3 Beat（剧情节点）

```yaml
- id: sakiko_reveal_past
  description: 祥子向某人坦白家境真相
  preconditions:
    all:
      - "world.day > 14"
      - "characters.sakiko.disclosed_secrets does_not_contain 'family_background'"
    any:
      - "characters.sakiko.relationships[anon].trust > 0.7"
      - "characters.sakiko.relationships[soyo].trust > 0.7"
  cooldown_after_trigger: never   # 一次性
  on_trigger:
    emit: beat_ready
    payload:
      beat_id: sakiko_reveal_past
      hint_for_director: |
        祥子准备好坦白了。她最信任的对象是 ${top_trust_target(sakiko)}。
        让坦白以一种符合她"礼貌当盔甲"性格的方式发生——
        不是哭着说，更可能是某次对话里突然轻描淡写。
  fallback:
    deadline_day: 45              # 兜底：第 45 天还没触发就强制
```

precondition 是**纯表达式**，由一个简单求值器跑（参考 jexl/jsonata）。**完全不调 LLM**。

### 3.4 LLM Director（导演 Agent）

**何时跑**：
1. BeatEngine emit `beat_ready` 时（事件驱动）
2. 每天 06:00 跑一次"节奏检查"（定时驱动）
3. 玩家通过 UI 主动请求"推一下"时（手动）

**它能用的工具**（director toolset，与角色 toolset 完全隔离）：

| 工具 | 作用 |
|---|---|
| `inject_intent(char, intent_text)` | 给角色注入 currentIntent，下个 tick 优先 |
| `inject_observation(observer, summary)` | 让某角色"看到"了某事（写入其记忆） |
| `add_unresolved_event(...)` | 给世界加一个未解决事件 |
| `add_rumor(content, source, spread_to)` | 注入八卦 |
| `set_observable_state(char, key, value)` | 改某角色的可观察痕迹 |
| `mark_beat_resolved(beat_id, outcome)` | 关闭一个 beat（成功/失败/变形） |
| `nudge_weather(...)` | 改天气，间接施压 |
| `do_nothing(reason)` | 显式选择不干预 |

**关键约束**：导演**不能让角色说话**，只能改世界状态、注入意图、加观察。说什么、怎么说，永远是角色 agent 自己决定。这条边界保证导演不会替角色演戏。

### 3.5 工具的语义标签（让角色行为流向 narrative_state）

现有工具如 `talk` 改造为：

```ts
talk({
  target: "anon",
  content: "...",
  // ── 新增可选语义标签 ──
  topic_tags?: string[];        // ["family", "past"]
  intent?: string;              // "disclose" | "comfort" | "probe" | "lie" | ...
  reveals?: string[];           // 揭示的秘密 id（来自角色卡 secrets 池）
  references_event?: string;    // 引用的 unresolved_event id
})
```

这些字段**LLM 自愿填**，不填也能跑（向后兼容）。Prompt 里加一段说明：
> 当你在做有叙事意义的事（坦白秘密、揭露真相、做出承诺、撒谎）时，请填写对应字段。这能让世界更好地记住这些时刻。

工具执行器在 success 路径上把 tags 翻译成 narrative_state 写入。

---

## 4. 信息流示例：祥子坦白家境

```
Day 18, Tick 73 — sakiko 与 anon 在 cafe 对话
  ↓
sakiko 的 LLM 调用 talk({
  target: "anon",
  content: "其实……我家以前不是普通人家",
  intent: "disclose",
  reveals: ["family_background"],
  topic_tags: ["family", "past"]
})
  ↓
talk 工具执行器:
  - 写入信箱（现有逻辑）
  - 新增: narrative_state.characters.sakiko.disclosed_secrets += "family_background"
  - 新增: narrative_state.characters.anon.known_facts += "sakiko_family_background"
  ↓
Tick 结束，BeatEngine 扫描:
  - beat sakiko_reveal_past 的 preconditions:
    - day > 14 ✓
    - disclosed_secrets does_not_contain 'family_background' ✗  ← 已不满足
  - 但是检测到状态变化：刚加入 disclosed_secrets
  - 触发 on_resolve（如果 beat 配置了）→ emit beat_resolved
  ↓
LLM Director 接收 beat_resolved:
  - 看到这是 sakiko_reveal_past 的自然达成
  - 决定调用 add_unresolved_event(
      id: "anon_processing_sakiko_reveal",
      summary: "anon 知道了祥子的过去，但还没消化",
      involved: [anon, sakiko],
      visible_to: [anon, sakiko]
    )
  - 同时 inject_intent(anon, "想找个时间和祥子单独聊聊")
  ↓
新的引力诞生，世界继续。
```

注意整个流程里：
- BeatEngine 不调用 LLM
- Director 调用 LLM 但只改 state
- 角色 agent 不知道 director 存在，只知道收到了一个 intent

---

## 5. 与现有系统的接口

| 现有模块 | 改动 | 影响面 |
|---|---|---|
| `world/state.ts` | 加 `narrativeState` 字段 | 类型扩展，向后兼容 |
| `actions/social.ts` (talk 等) | 加可选语义标签字段 + 写 narrative_state | tool schema 扩展 |
| `agent/prompt-builder.ts` | 注入 unresolved_events 摘要 + 语义标签使用说明 | prompt 长度 +几百 token |
| `core/tick-engine.ts` | 每 N tick 调一次 BeatEngine.scan | 单点接入 |
| `persistence/` | narrative_state 落库 | 加表 |
| `api/` | 暴露 narrative state 查询 + 玩家干预端点 | 新接口 |
| **新增** `narrative/` | beat-engine.ts, director.ts, expression.ts, scenario-loader.ts | 全新模块 |
| `data/locations`, `data/characters` | 不动 | 只是被 scenario 引用 |
| **新增** `data/scenarios/` | mygo-seaside/, koukou-judgment/ | 新目录 |

---

## 6. 关键设计决策与理由

### 为什么 BeatEngine 不调用 LLM？
**可调试 + 便宜 + 可预测**。触发条件是字段比较，出问题能定位到具体表达式。如果要 LLM 判断"事件有没有发生"，就回到了酒馆模式——慢、贵、不可控、难复现。

### 为什么 Director 不能让角色说话？
**保护角色 agent 的自主性是 Anima 的第一性原理**。Director 只改世界、注入念头，台词和行动永远由角色 LLM 自己产出。这条边界一旦破，Anima 就退化成"角色 = director 的傀儡"。

### 为什么语义标签是可选的？
**渐进式采用 + 不破坏现有 sim**。第一版 LLM 可能填不准，先让它跑，看哪些字段有用、哪些字段是噪声，再迭代。强制必填会让现有测试全挂。

### 为什么 narrative_state 和 relationships/impressions 平级而不是合并？
**关注点分离**。relationships 是过程量（每次互动都在变），narrative_state 是离散事件量（坦白发生过/没发生过）。混在一起会让 BeatEngine 的查询条件变得复杂且脆弱。

### 为什么是 4 层不是 3 层？
玩家必须有专属层。如果把玩家放进 Director 层，Director 就会被玩家的临时 hack 污染（玩家可以做规则不允许 LLM 做的事，比如直接 mark_beat_resolved）。把玩家单独抽出，能给开发模式留一个干净的"god mode"通道。

---

## 7. 不在本文档范围

- **NSFW 处理**：本期不做（见 IMPORT-koukou-judgment.md 决策记录）
- **角色 reflection / long-term memory**：现有系统继续，不重设计
- **前端如何展示 narrative**：留给 PLAN-narrative.md 中的某个 phase
- **多人同时跑**：不考虑

---

## 8. 待解决的开放问题

| # | 问题 | 暂定方案 |
|---|---|---|
| O1 | 表达式 DSL 选型：自写 vs jexl vs jsonata | 倾向 jexl（轻量、维护活、JS 表达式语法直观） |
| O2 | Director prompt 怎么写才能不啰嗦 | Phase 2 实测，先上 baseline |
| O3 | tension_index 公式 | unresolved_events 数 × 0.4 + 关系波动 × 0.3 + 距上次 beat 的 tick 数 × 0.3，归一化 |
| O4 | beat 触发频率：每 tick 扫 vs 每天扫 | 默认每天扫，关键 beat 可标 `realtime: true` 走每 tick |
| O5 | scenario 切换时，现有 sim 数据怎么办 | 每个存档绑定一个 scenario_id，不允许跨剧本读档 |
