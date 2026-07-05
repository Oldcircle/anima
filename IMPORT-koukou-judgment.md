# 扣扣审判 卡导入策略

> **Source**: `/Users/yb/Opensource/projects/ai/fable/docs/resources/characters/魔法少女的扣扣审判1.1.png`
> 解出位置：`/tmp/card_chara.json`（character book 153 entries，~1.3MB JSON）
>
> **Target**: `data/scenarios/koukou-judgment/`
>
> **导入策略**：1B（素材化吸收，不忠实移植线性脚本）+ 2B（与 mygo 并存）+ 3C（NSFW 全部剥离）

---

## 1. 卡的本质（导入前的诚实评估）

这张卡是一个 **"魔法少女 + 弹丸论破式 Class Trial + 轮回叙事"** 的混合体，结构上明确借鉴弹丸论破：

```
每章 = 4 阶段循环
  日常 phase    → 角色自由生活，建立关系
  案发 phase    → 凶杀案发生，进入搜查
  审判 phase    → Class Trial 式辩论
  处刑 phase    → 凶手被处刑，进入下一章
```

- **A1 篇**: 5 章（C1-C5）完整 4 阶段循环
- **A2 篇**: 4 章
- **A3 篇**: 2 章（仅审判 + 处刑，节奏加速）
- **后日谈**: 学校 / 孤岛两个 AU 时间线
- **轮回结构**: 一周目艾玛视角 → 二周目希罗视角 → 三周目真结局

153 个 character_book entries 大致分类：

| 类型 | 数量 | 处理 |
|---|---|---|
| 角色详情（14 角色） | ~14 | 提取，转 yaml |
| 监管者（典狱长 / 看守 / 特雷德基姆） | 3 | 提取，特殊 NPC |
| 世界观 / 舞台 / 监狱公馆 | ~6 | 提取到 world.yml + locations |
| 章节大纲（A1-A3 各章 4 阶段） | ~50 | **不直接导入**，提取成 beats（见 §5） |
| mvu_plot 状态规则 | ~10 | 不导入（属于酒馆专属变量系统） |
| 输出格式 / 正文 tag | ~10 | **完全丢弃**（酒馆专属） |
| 插画路径 | ~14 | **完全丢弃**（依赖外部素材） |
| 后日谈相关 | ~30 | **不在 N6 范围**，留作后续 scenario |
| 特殊规则（论破 / 色情 / 隐藏凶手） | ~5 | 选择性提取（NSFW 类全丢） |

**结论**：直接可用的内容大约占卡总量的 30-40%，剩下是酒馆专属机制 + NSFW + 后日谈，全部不要。

---

## 2. 与 Anima 架构的根本张力

| 卡的设定 | Anima 的设定 | 解决方案 |
|---|---|---|
| 20 个场景必须按编号顺序，禁跳跃禁回溯 | 涌现优先，beat 是触发器 | 把"必须发生"映射为**带 deadline 的 beat**，到点强制；过程内容由角色 emergent，不脚本化 |
| user 是固定主角（卡内称呼） | 5+ 角色平权，玩家是隐形作者 | 不给 user 主角位，玩家以 inject_observation 形式介入，14 角色平权 |
| LLM 兼任演员 + 导演 + 进度管理 | 演员/规则/导演三层分离 | 导演用 director agent，进度用 narrative_state.world.active_phase |
| 强 NSFW 设定（mvu_plot 中状态、插画路径） | 当前无 NSFW 处理 | 全部剥离，N6 期完全跳过 |
| 多周目轮回 | 单世界单存档 | 一周目作为 koukou-judgment scenario，二/三周目暂不实现 |
| 14 角色同时活跃 | 当前默认 5 角色 | 接受成本上升，token 预算重做 |

**最关键的妥协**：卡的"线性场景必须按序"我们**不照搬**。我们只保留"哪些事必须发生"+"什么前置条件"+"latest deadline"，怎么发生让世界自己演。这意味着导入后的扣扣审判**不会和原卡 100% 一致**——这是有意为之。

**但偏离必须合理**（用户决策 D2）：
- 允许：发生方式不同（坦白方式、相遇地点、对话内容、案发细节顺序）
- 允许：次要角色的次要决定有不同走向
- **不允许**：违反世界观（魔女因子规则、监狱物理结构、原罪设定）
- **不允许**：违反人物核心性格（艾玛突然变得冷酷、希罗主动示好等无前置过渡）
- **不允许**：跳过关键 beat（凶杀案不能不发生、审判不能不开庭）
- **不允许**：剧情走向纯随机/无因果（每个偏离都必须有可追溯的角色动机或玩家干预）

实现层面，这意味着 director 在 inject_intent / inject_observation 时，必须遵守"合理性约束"——它的 prompt 里要明确：你的工作不是制造反转，是让必发生的事**以符合当前世界状态的方式**发生。如果当前状态下原卡的发生方式仍然合理，优先沿用；只在状态偏离原卡前提时才创造新的发生方式。

---

## 3. 导入清单（什么留，什么丢）

### ✅ 完整导入

- **14 个角色卡**（艾玛、希罗、雪莉、安安、米莉亚、奈叶香、玛格、梅露露、诺亚、蕾雅、亚里沙、汉娜、月代雪、可可）
  - public/private 双层身份 → `identity.public` + `secrets[]`
  - 原罪设定 → `core_traits.original_sin`
  - 性格描述 → `personality`
  - 社交关系 → **折中导入**（用户决策 D3 = B）：
    - **公开/双方都知的关系**导入到角色 yml 的 `known_relationships` 字段，作为 prompt 注入的初始关系上下文（如"艾玛和希罗是童年好友，希罗最近态度冷淡"——艾玛和希罗都知道）
    - **私密/单方面的关系/秘密** 留在 `secrets` 池或 lore.yml（如"希罗其实记得艾玛遗忘的那段过去"——希罗知道，艾玛不知道）
    - 关系初始 trust/familiarity 数值预置一个起点（如童年好友 = familiarity 0.8 trust 0.5），但仍会被后续互动更新
    - 这样既保留了对剧情发展关键的羁绊网，又给了涌现空间
  - 魔法能力 → 新增 `abilities` 字段
- **监管者**: 典狱长（猫头鹰）+ 看守 + 特雷德基姆
  - 作为 special NPC，不参与日常 agent 循环，由 director 在特定 beat 触发其登场
- **监狱公馆地点**：B1F 监房 + 1F 公共区 + 2F 文化区 + 外部
- **世界观**: 魔女因子、监狱岛、500 年历史
- **每日时刻表**: 06:00 / 10:00 / 12:00 / 15:00 / 17:00 / 22:00 这套节奏，作为 schedule 规则
- **魔女审判机制**：作为 phase transition 规则
- **第一章核心剧情骨架**：诺亚之死 + 6 轮辩论的关键 evidence/conclusion → 转 beats

### 🚫 完全丢弃

- 所有 `mvu_plot` / `mvu_update` 变量系统（酒馆专属）
- 所有插画 entries（依赖 fable 资源，且很多 NSFW）
- 所有 "正文输出格式" / customize_format / 标签规范
- 所有 NSFW 设定（色情事件、特殊衣物变化等）
- 后日谈（学校 / 孤岛）—— 留作后续独立 scenario
- 多周目机制（一周目跑通再说）

### 🟡 选择性吸收

- 章节大纲：只取"必须发生的关键事件"，不取"按 20 场景顺序演"
- 论破机制：作为 trial phase 的 trial-specific 工具实现（vote / present_evidence / accuse / counter）
- 牢房分配：只用 C1 的初始分配，作为 seeds.yml 的 location_assignment

### ❓ 待决策

- 14 角色是否全部一开始上场？还是分批入场？
  - **暂定**：全部一开始上场（卡设定就是 11 人开场，加 user 后续）
- 监狱手机系统（`【魔女图鉴】app`）要不要做？
  - **暂定**：作为 inbox 系统的扩展，allow 角色之间的"私聊"独立于 talk 工具
- 玩家在这个剧本里是观察者还是参与者？
  - **暂定**：观察者（与原卡 user-as-protagonist 不同）。通过塞纸条 / 注入事件影响

---

## 4. 角色卡映射（以艾玛为例）

原卡片段：
```yaml
樱羽艾玛:
  age: 15
  identity:
    public: 刚从初中毕业的少女，魔女监狱囚犯编号658
    private: 错误地记忆为自己遭受过校园霸凌（实际是目睹好友月代雪被霸凌...）
  original_sin:
    罪名: 忌み嫌われるもの
  魔法能力:
    表现: 在开头阶段始终无法使用任何魔法
    真相: 拥有"杀死魔女的魔法"
  social_connections:
    二阶堂希罗: 童年好友，复杂的羁绊
    橘雪莉: 监狱中的第一个朋友
```

映射到 Anima character yml：
```yaml
id: ema
name: 樱羽艾玛
age: 15
job: prisoner_658
location_start: cell_b1_a1
appearance: ...
core_traits:
  - 笨拙易亲近，渴望被爱
  - 紧张时按胸口
  - 内里坚韧，关键时刻冷静
psychology:
  fear: 被讨厌、独自一人
  defense: 故意失败博取关注
  original_sin: 被厌恶之物（叙事用，不直接 prompt）
secrets:                           # ← 新增字段，喂给 narrative_state
  - id: ema_distorted_memory
    content: 把"袖手旁观好友被霸凌"扭曲为"自己被霸凌"
    awareness: false               # 自己也不知道
  - id: ema_anti_witch_magic
    content: 她拥有杀死魔女的魔法
    awareness: false
abilities:
  magic_available: false           # 开局不可用
  magic_type: anti_witch           # 内部字段，trial 阶段才解锁
known_relationships:                # ← D3 折中：公开关系预置
  hiro:
    type: 童年好友
    public_status: 重逢后希罗态度冷淡敌视
    initial_familiarity: 0.8
    initial_trust: 0.5
  # ... 其他公开关系
backstory: |
  ...（公开经历，不含被遗忘的真相）
speech_examples: |
  ...
# 注意：不写 social_connections 字段，遵守 Anima 第一性原理
```

**关键修订**（D3 = B 折中方案）：原卡的 `social_connections` 字段**部分导入**。把字段拆成两半：

```yaml
# 角色 yml 内（公开层）
known_relationships:
  hiro:
    type: 童年好友
    public_status: 关系冷淡（希罗最近态度敌视）
    initial_familiarity: 0.8
    initial_trust: 0.5     # 因冷淡态度而下降
  shelly:
    type: 监狱中第一个朋友
    public_status: 友好
    initial_familiarity: 0.3
    initial_trust: 0.6
```

```yaml
# lore.yml 或 secrets（私密层，仅特定角色知道）
- id: ema_hiro_true_history
  known_to: [hiro]                     # 只有希罗知道
  content: |
    艾玛、希罗、月代雪三人是童年好友。希罗留学后，艾玛和小雪走得很近。
    小雪后来遭受霸凌时艾玛选择旁观，导致小雪自杀。
    艾玛把这段记忆扭曲为"自己被霸凌"，遗忘了小雪。
    希罗记得真相，所以对艾玛敌视。
```

这样：
- **公开关系参与角色的初始 prompt**，让 sim 一开始角色之间不是陌生人
- **私密真相只对持有者可见**，避免艾玛 LLM 一开始就"知道自己其实有罪"
- **关系数值会被后续互动更新**，不是冻结的

---

## 5. Beats 映射（第一章）

原卡 A1_C1 4 个阶段 + 20 个日常场景 + 详细审判流程 → 转换为 ~12 个 beats。

```yaml
# data/scenarios/koukou-judgment/beats.yml (节选)

# ── 阶段转移 ──
- id: phase_c1_to_investigation
  description: 诺亚被发现死亡，进入搜查阶段
  preconditions:
    all:
      - "world.day == 2"            # 卡里是第二天早晨
      - "world.active_phase == 'peaceful'"
  fallback:
    deadline_day: 3                 # 必发生
  on_trigger:
    director_hint: |
      安安去医务室回来时第一发现诺亚尸体。现场关键要素：
      - 纯白色喷漆房间
      - 蝴蝶血画
      - 弩枪箭刺穿胸口
      - 无足迹、有划痕
      让 director 注入一个 special_event "noah_corpse_discovered"
      被 anan 和 ema observed，然后 emit phase_change → investigation
    new_phase: investigation
    inject_unresolved_event:
      id: noah_murder
      summary: 城崎诺亚被发现死于自己房间，胸口中箭，现场充满谜题
      visible_to: "*"

- id: phase_c1_to_trial
  preconditions:
    all:
      - "world.active_phase == 'investigation'"
      - "tick_since_phase_change > 24"  # 至少给一天搜查时间
      - "OR(any_char_has_collected_evidence > 3, day == 3)"
  on_trigger:
    new_phase: trial

- id: phase_c1_to_execution
  preconditions:
    all:
      - "world.active_phase == 'trial'"
      - "narrative_state.trial.verdict_reached == true"
  on_trigger:
    new_phase: execution

# ── 关键剧情 beat（不强制，但有 hint） ──
- id: ema_meets_hiro_first_hostile
  description: 艾玛在牢房外遇到希罗，希罗冷淡敌视
  preconditions:
    all:
      - "world.day == 1"
      - "characters.ema.has_met[hiro] == false"
  fallback:
    deadline_day: 2
  on_trigger:
    director_hint: |
      让两人在某个公共空间相遇。希罗的厌恶不是对艾玛本人，
      而是因为她记得一些艾玛不记得的事。
      不要直接说出真相，留作伏笔。

- id: shelly_teaches_ema_phone
  description: 雪莉教艾玛加手机好友
  preconditions:
    all:
      - "characters.ema.relationships[shelly].familiarity > 0.2"
  fallback:
    deadline_day: 2

# ── trial 子 beats（按辩论回合） ──
- id: trial_c1_round1_butterfly_painting
  description: 第一轮辩论：蝴蝶画的含义
  preconditions:
    all:
      - "world.active_phase == 'trial'"
      - "narrative_state.trial.current_round == 1"
  on_trigger:
    director_hint: |
      雪莉主张蝴蝶画指向玛格，艾玛反驳出示安安的素描本作证。
      让 LLM 演员自由演绎，但确保 evidence 'butterfly_sketch' 被提及。
    required_evidence: butterfly_sketch
    expected_outcome:
      ruled_out_suspect: marg

# ... round 2-6 类似
```

**核心设计**：
- 阶段转移有 fallback deadline，确保剧情会推进（不会卡死在 peaceful 阶段）
- 角色相遇 / 关键道具揭示等是软 beats，有 hint 但不强制台词
- Trial 的 6 轮辩论作为子 beats，每轮有"必须出现的证据"和"期望排除的嫌疑人"
- 实际辩论内容由角色 LLM 自由演，director 只在某轮 deadlock 超时才介入

---

## 6. 工具扩展（仅本 scenario 启用）

### Trial Phase 专属工具

```ts
// 仅在 active_phase == 'trial' 时可用
present_evidence({
  evidence_id: string,
  argues_against: char_id,
  reasoning: string
})

vote({
  target: char_id,           // 谁是凶手
  confidence: 0-1
})

accuse({
  target: char_id,
  reasoning: string
})

counter({
  against_argument_id: string,
  reasoning: string
})
```

### Investigation Phase 专属工具

```ts
collect_evidence({
  location: string,
  description: string,
  evidence_id: string
})

interview({
  target: char_id,
  topic: string
})
```

### Phase 工具白名单

通过 `actions/registry.ts` 加 phase gating：peaceful 阶段不允许 vote/accuse；trial 阶段不允许 work/eat（除非休庭）。

### 监狱手机系统

扩展现有 inbox 系统，加 `private_message` 工具，区别于 `talk`：
- talk = 当面说，被同地点角色观察
- private_message = 手机私聊，仅收件人看到（但记录可被监管者审查）

---

## 7. 监管者 NPC 处理

典狱长 + 看守不是普通角色，不进 agent 循环：

```yaml
# data/scenarios/koukou-judgment/npcs/warden.yml
id: warden
type: special_npc
controlled_by: director       # 由 director agent 触发其行动
appearances:
  - trigger: phase == 'investigation' && tick_since == 0
    say: 唉……结果还是发生了凶杀案……今晚将举行魔女审判。
  - trigger: phase == 'trial' && round == 0
    say: 那么，魔女审判，开庭。
  - trigger: rule_violation_detected
    action: dispatch_guard
```

director 在 beat 触发时检查 NPC 是否需要登场，登场即 inject_observation 给在场角色。

---

## 8. NSFW 剥离清单

明确不导入的 entries（按 comment 列出）：
- `1️⃣特殊 - 色情事件主动性强化[mvu_plot]`
- `1️⃣⚙变量输出格式[mvu_update]` 中所有 NSFW 字段
- 所有 `插画 - <角色>[mvu_plot]` entries
- `_插画列表开始` ~ `_插画列表结束`
- `1️⃣⚙格式要求[mvu_plot]` 中关于 NSFW 模板的部分
- 所有 `<pic>NSFW/...` 路径引用
- "扣扣转化" entry（涉及处刑细节，过于黑暗，可后续审视）

明确丢弃的角色字段：
- 所有 `appearance` 中超出"普通描述"的部分
- 所有 `special_kink` / `weakness_sexual` 类字段
- 衣物设定中"只有囚服"是结构性设定，保留；其他细节丢弃

---

## 9. 导入工具脚本

建议在 Phase N6 开头写一个一次性脚本：

```
scripts/import-koukou-card.ts
  - 输入：/tmp/card_chara.json
  - 输出：data/scenarios/koukou-judgment/ 目录骨架
  - 工作：
    1. 读 character_book entries
    2. 按 comment 模式匹配，分类
    3. 自动生成 14 个角色 yml 骨架（人工再补充）
    4. 自动生成 location yml 骨架
    5. world.yml / lore.yml 直接从 entries 翻译
    6. beats.yml 不自动生成（人工写，配合脚本生成的"原卡章节大纲摘要"参考文件）
```

脚本只生成骨架 + 人工填充。**不追求一键完整导入**——这是内容工程，需要审稿。

---

## 10. 验收标准

第一章 sim 跑通的最低标准：
- [ ] 14 角色全部就位，各自的 personality 在 sim 中可识别
- [ ] Day 1 peaceful 阶段，至少出现 5 段非脚本对话
- [ ] Day 2 触发诺亚之死，进入 investigation
- [ ] Investigation 阶段，至少 3 个角色调用 collect_evidence
- [ ] Day 2-3 触发 trial
- [ ] Trial 阶段至少跑完 3 轮辩论（不要求 6 轮）
- [ ] 投票阶段所有角色都 vote
- [ ] 若投出正确凶手 → execution + 进入 C2 入口

不要求：
- 6 轮辩论完整复刻
- 角色台词与原卡一致
- 玩家干预流程
- 多角色同时长篇对话的舞台调度完美

---

## 11. 风险与红线

### 红线（绝不做）

1. 任何 NSFW 内容（即使原卡有）
2. 让 director 直接生成角色台词（破坏 Anima 第一性原理）
3. 不允许跨 scenario 数据污染（mygo 角色不会出现在 koukou 里，反之亦然）
4. 不引入需要外部素材（图片、音频）的依赖

### 主要风险

1. **审判阶段崩盘**：14 角色多轮辩论是 LLM 最难场景。缓解：trial 阶段调用频率限制 + director 强介入兜底
2. **token 成本爆炸**：14 角色 × 长 prompt × trial 多轮 = 单次 sim 可能比 mygo 贵 5-10 倍。缓解：trial 阶段强制 prompt 裁剪，只注入最相关 5-7 个角色的状态
3. **第一性原理被现实压垮**：当原卡明确说"必须出现 X 证据"时，可能被迫破坏 emergent。缓解：required_evidence 通过 director inject_observation 实现，不直接 inject 台词
4. **导入工作量超预期**：14 角色卡 × 详细字段 = 大量人工誊写。缓解：N6.1 优先做 5 个核心角色，其他用占位卡跑通流程再补

---

## 12. 不在本期范围（明确推迟）

- 后日谈（学校 AU、孤岛 AU）
- 二周目（希罗视角）/ 三周目
- 多周目记忆继承机制
- 监狱外的世界
- NSFW 任何形式
- 完整 6 轮辩论模板复刻
- 与 fable 项目的资源共享
