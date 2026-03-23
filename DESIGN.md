# Anima — 详细架构设计

## 设计理念

每个 AI 角色 = 一个 Agent，拥有：
- **人格**（系统提示词，不变）
- **感知**（当前世界状态、周围环境、附近的人）
- **记忆**（长期记忆 + 短期记忆 + 反思）
- **行为空间**（一组 tool，LLM 选择调用哪个）
- **需求**（饥饿、精力、社交、快乐等数值，驱动决策倾向）

---

## 一、核心系统

### 1.1 时间系统（Tick Engine）

```
现实时间 × 速率倍数 = 游戏时间
```

- **基础比率**：现实 1 分钟 = 游戏 1 小时
- 即：现实 24 分钟 = 游戏 1 天，现实 ~10 小时 = 游戏 1 年
- **速度控制**：
  - 暂停（0x）— 世界冻结
  - 减速（0.25x / 0.5x）— 观察细节
  - 正常（1x）— 默认速率
  - 加速（2x / 5x / 10x）— 快进跳过
- **Tick 粒度**：每个 tick = 游戏 15 分钟 = 现实 15 秒（1x 速率下）
- 一个游戏日 = 96 个 tick = 现实 24 分钟（1x 速率下）
- 暂停时所有 agent 停止决策，加速时 tick 间隔缩短

### 1.2 世界状态（World State）

参考星露谷，小镇包含：

**地点系统：**
- 住宅区（每个角色有自己的家）
- 公共场所：广场、咖啡馆、酒吧、图书馆、杂货店
- 自然区域：海边、森林、山丘、农田
- 特殊地点：诊所、学校、教堂

**环境系统：**
- 天气：晴/雨/雪/暴风（影响角色行为决策）
- 季节：春夏秋冬（影响可用作物、节日、对话话题）
- 日夜：6:00-24:00 活动时间，影响地点开放和角色作息
- 节日/事件：随机事件 + 固定节日

**经济系统（简化）：**
- 角色有金币
- 可以买卖物品
- 商店有库存和价格波动

### 1.3 事件总线（Event Bus）

所有行为产生事件，事件驱动世界变化：

```typescript
interface WorldEvent {
  id: string;
  tick: number;              // 发生的游戏 tick
  type: string;              // "social.chat" | "work.harvest" | "mood.change"
  actorId: string;           // 谁做的
  targetId?: string;         // 对谁做的
  locationId: string;        // 在哪里
  description: string;       // 叙事性描述
  effects: Effect[];         // 对世界状态的影响
  witnesses: string[];       // 谁看到了（传播八卦的基础）
}
```

---

## 二、角色系统

### 2.1 角色卡（Character Card）

每个角色一个 YAML 文件：

```yaml
id: "alice"
name: "Alice Chen"
age: 28
occupation: "花店老板"
home: "residential_east_2"

personality:
  traits: ["温柔", "内向", "细心", "固执"]
  interests: ["园艺", "阅读", "烘焙"]
  dislikes: ["噪音", "浪费"]
  speech_style: "说话轻声细语，经常用花的比喻"

background: |
  从城市搬来三年了，开了镇上唯一的花店。
  和 Elliott 有过一段感情但已经结束。
  最好的朋友是面包店的 Maria。

daily_routine:
  "06:00": "起床，照料花园"
  "08:00": "开门营业"
  "12:00": "午餐，通常在咖啡馆"
  "13:00": "继续营业"
  "18:00": "关门，散步到海边"
  "20:00": "在家阅读或烘焙"
  "23:00": "睡觉"

relationships:
  maria: { level: 8, type: "best_friend" }
  elliott: { level: 3, type: "ex_partner" }
  player: { level: 0, type: "stranger" }
```

### 2.2 需求系统

每个角色有 0-100 的需求值，随时间变化，影响行为优先级：

| 需求 | 衰减速度 | 满足方式 |
|------|---------|---------|
| 饥饿 | 每 tick -2 | 吃饭 +40~60 |
| 精力 | 每 tick -1 | 睡觉 +全满，咖啡 +20 |
| 社交 | 每 tick -1 | 聊天 +10~30（取决于关系） |
| 快乐 | 不自动衰减 | 做喜欢的事 +5~15，不愉快事件 -10~30 |
| 卫生 | 每 tick -0.5 | 洗澡 +全满 |

**需求驱动决策**：当某项需求低于阈值（如饥饿<30），该需求相关行为在 LLM prompt 中被强调。

### 2.3 关系系统

```typescript
interface Relationship {
  characterA: string;
  characterB: string;
  level: number;          // -100 到 100
  type: string;           // "stranger" | "acquaintance" | "friend" | "close_friend" | "rival" | "romantic"
  history: string[];      // 关键事件摘要
  lastInteraction: number; // 上次互动的 tick
}
```

关系通过互动自然演化，LLM 在行为结果中返回关系变化值。

---

## 三、Agent 系统

### 3.1 行为工具（Action Tools）

每个工具 = 一个可选行为，LLM 通过 tool_use 调用：

**日常类：**
- `eat(location, food?)` — 吃饭
- `sleep()` — 回家睡觉
- `wash()` — 洗漱
- `cook(recipe?)` — 做饭

**工作类：**
- `work()` — 在工作地点工作
- `farm(crop?)` — 种植/收获
- `fish(location)` — 钓鱼
- `craft(item)` — 制作物品
- `trade(target, item, price)` — 交易

**社交类：**
- `go_to(location)` — 移动到某地
- `talk(target, intent, opening_line)` — 发起对话（见 3.4 对话系统）
- `give_gift(target, item)` — 送礼物
- `invite(target, activity)` — 邀请某人做某事
- `gossip(target, about)` — 说八卦
- `argue(target, reason)` — 争吵
- `comfort(target)` — 安慰某人
- `flirt(target)` — 调情

**休闲类：**
- `read(book?)` — 阅读
- `explore(area)` — 探索
- `drink(location)` — 喝酒
- `hobby(activity)` — 做爱好相关的事

**内省类：**
- `reflect()` — 反思近期经历，生成高层洞察存入长期记忆
- `plan_day()` — 规划今天要做什么
- `recall(topic)` — 主动回忆某个话题相关的记忆

### 3.2 Agent 决策循环

每个 tick 对每个角色执行：

```
1. 构建 prompt:
   - 系统提示词（人格 + 行为规则）
   - 当前状态（时间、位置、需求值、周围的人和物）
   - 近期记忆（最近 5 个 tick 的事件摘要）
   - 相关长期记忆（根据当前情境搜索）
   - 日程提示（如果有默认日程）
   - 可用工具列表

2. LLM 返回:
   - 内心独白（思考过程，不对外展示）
   - 选择的工具调用（行为）

3. 执行工具:
   - 更新世界状态
   - 生成叙事性事件描述
   - 广播事件到事件总线
   - 更新需求值和关系

4. 存储记忆:
   - 短期：本次行为记录
   - 如果触发反思条件：调用 reflect 生成长期记忆
```

### 3.3 对话系统（Character Conversations）

角色之间不只是"发生了聊天"的叙事摘要，而是真实的多轮对话。

**触发方式：**
角色 A 调用 `talk(target="alice", intent="打听新种子", opening_line="嘿 Alice，听说你进了新品种？")`

**对话流程：**

```
1. 角色 A 调用 talk → 系统创建一个 Conversation 会话
2. 角色 A 的 opening_line 作为第一句
3. 切换到角色 B 的 agent：
   - 注入 B 的人格 + 与 A 的关系 + 当前心情/需求
   - B 的 LLM 生成回复
4. 切换回角色 A → 看到 B 的回复 → 生成下一句
5. 循环 3-8 轮（由 LLM 自然结束，或达到轮次上限）
6. 对话结束 → 双方各自存储记忆 + 更新关系
```

**对话是阻塞行为**：对话期间双方不处理其他 tick，对话结束后恢复各自的 tick 循环。

**对话产物：**
```typescript
interface Conversation {
  id: string;
  participants: [string, string];  // 两个角色 ID
  locationId: string;
  startTick: number;
  messages: ConversationMessage[];  // 完整对话记录
  summary?: string;                 // LLM 生成的摘要（存入双方记忆）
  relationshipDelta: number;        // 关系变化值
  mood: Record<string, string>;     // 对话后双方心情变化
}

interface ConversationMessage {
  speakerId: string;
  content: string;                  // 角色说的话（角色扮演风格）
  innerThought?: string;           // 内心想法（不对对方展示）
}
```

**玩家参与对话：**
玩家也可以发起或被卷入对话。区别是玩家的回复由真人输入（前端对话框），AI 角色的回复由 LLM 生成。对话期间世界自动暂停或减速，等待玩家输入。

**Token 优化：**
- 日常寒暄（关系 < 3）限制 2-3 轮
- 深度对话（关系 > 6 或有重要话题）允许 5-8 轮
- 对话 prompt 只注入双方相关记忆，不注入全局世界状态

### 3.4 Token 优化策略

5-10 个角色每 tick 都调 LLM 成本很高，优化方案：

- **惰性决策**：如果角色在执行多 tick 行为（如工作 4 小时），跳过中间 tick 的 LLM 调用
- **日程兜底**：没有特殊事件时，按 daily_routine 执行，不调 LLM
- **事件触发**：只在有新事件（有人来、天气变化、需求低于阈值）时才调 LLM
- **批量处理**：同一地点的多个角色可以合并为一次 LLM 调用
- **模型分层**：日常决策用轻量模型，重要社交和对话用强模型（见 3.5）

### 3.5 模型提供商系统（Multi-Provider）

参考 OpenClaw 的多提供商架构，支持丰富的模型选择：

**支持的 API 协议：**
- `openai-compatible` — OpenAI 兼容接口（覆盖大部分提供商）
- `anthropic-messages` — Anthropic Claude API
- `google-generative-ai` — Google Gemini API
- `ollama` — 本地 Ollama 推理

**内置提供商：**

| 提供商 | 典型模型 | 用途 |
|--------|---------|------|
| Anthropic | Claude Opus/Sonnet/Haiku | 高质量对话和决策 |
| OpenAI | GPT-4o/4o-mini | 通用决策 |
| Google | Gemini 2.5 Pro/Flash | 长上下文记忆处理 |
| DeepSeek | DeepSeek V3/R1 | 高性价比日常决策 |
| Ollama | Llama/Qwen/Mistral 本地 | 离线运行，零 API 成本 |
| Together AI | 开源模型托管 | 开源模型云端推理 |
| 自定义 | 任意 OpenAI 兼容端点 | 用户自行配置 |

**模型配置结构（参考 OpenClaw）：**
```typescript
interface ModelConfig {
  id: string;
  name: string;
  api: "openai-compatible" | "anthropic-messages" | "google-generative-ai" | "ollama";
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number };  // $ per 1M tokens
}

interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  models: ModelConfig[];
}
```

**模型分层策略：**
```yaml
# 配置文件示例
models:
  decision:       # 日常行为决策（高频，需要便宜）
    provider: "deepseek"
    model: "deepseek-chat"
  conversation:   # 角色对话（中频，需要质量）
    provider: "anthropic"
    model: "claude-sonnet-4-6"
  reflection:     # 记忆反思（低频，需要深度）
    provider: "anthropic"
    model: "claude-opus-4-6"
  embedding:      # 记忆向量化
    provider: "openai"
    model: "text-embedding-3-small"
```

**Failover 机制（参考 OpenClaw run.ts）：**
- 主模型失败 → 自动切换到备选模型
- 速率限制 → 降级到更便宜的模型
- 全部失败 → 回退到日程兜底行为（不调 LLM）

---

## 四、记忆系统

从 OpenClaw 提取，适配为角色记忆：

### 4.1 短期记忆
- 当前游戏日的事件列表
- 滑动窗口，保留最近 20 条
- 每天结束时压缩为日摘要

### 4.2 长期记忆
- SQLite + sqlite-vec 向量搜索
- 每条记忆：内容、embedding、重要性评分、时间戳
- 搜索时结合语义相似度 + 重要性 + 时间衰减（复用 OpenClaw 的 hybrid + temporal-decay + mmr）

### 4.3 反思（Reflection）
- 触发条件：累计重要性超过阈值 或 一天结束时
- 过程：取最近 N 条记忆 → 让 LLM 总结为 3-5 条高层洞察
- 洞察存入长期记忆，重要性设为高
- 参考论文：Park et al. "Generative Agents: Interactive Simulacra of Human Behavior"

---

## 五、前端

### 5.1 布局

```
┌─────────────────────────────────────────────────┐
│  时间控制栏: [◀◀ ▶ ▶▶] 速度:2x  春 第5天 14:30  │
├──────────────────────┬──────────────────────────┤
│                      │  角色面板               │
│   小镇地图           │  ┌──────────────────┐   │
│   (简易 2D)          │  │ 👩 Alice Chen     │   │
│                      │  │ 📍 咖啡馆         │   │
│   🏠🏠 🏪 🏫        │  │ 😊 心情:开心      │   │
│   🏠🏠 ☕ 📚        │  │ 🍽 饥饿:65       │   │
│   🌳🌳 🎣           │  │ ⚡ 精力:80       │   │
│   🌾🌾🌾            │  │                   │   │
│                      │  │ 正在: 和Maria聊天 │   │
│   (头像在地图移动)    │  │                   │   │
│                      │  └──────────────────┘   │
│                      │                          │
│                      │  最近事件                │
│                      │  14:15 Alice走进咖啡馆  │
│                      │  14:20 和Maria打招呼    │
│                      │  14:25 聊起了新到的种子  │
├──────────────────────┴──────────────────────────┤
│  对话/交互区（玩家加入时激活）                    │
│  > 你走向 Alice 的桌子...                        │
└─────────────────────────────────────────────────┘
```

### 5.2 核心视图

1. **世界视图** — 全局地图，看所有角色位置和动态
2. **聚焦视图** — 选中某角色，看其状态/记忆/关系/行为历史
3. **玩家视图** — 以玩家身份在世界中移动和互动
4. **时间线视图** — 事件流，可筛选角色/地点/类型

### 5.3 通信

- WebSocket 实时推送世界事件
- 前端订阅感兴趣的角色/地点
- 玩家操作通过 WebSocket 发送到后端

---

## 六、测试体系

参考 OpenClaw 的测试架构，边开发边测试。

**测试框架**：Vitest（与 OpenClaw 一致）

### 6.1 测试分层

| 层级 | 测什么 | LLM 调用 | 运行频率 |
|------|--------|---------|---------|
| 单元测试 | 时间系统、需求衰减、关系计算、事件总线 | 无 | 每次改动 |
| 集成测试 | Agent 循环 + mock LLM、记忆存取、世界状态持久化 | Mock | 每次改动 |
| Live 测试 | 真实 LLM 调用的 agent 决策、对话质量 | 真实 API | 手动触发 |
| 模拟测试 | 跑 N 个 tick 观察涌现行为、检查世界一致性 | 真实 API | 里程碑时 |

### 6.2 Mock 策略

```typescript
// LLM Mock — 返回预设的 tool_use 响应
const mockLLM = vi.fn().mockResolvedValue({
  content: "我觉得该去吃午饭了",
  tool_calls: [{ name: "eat", arguments: { location: "cafe" } }]
});

// 世界状态 Mock — 固定的小镇快照
function createTestWorld(): WorldState {
  return {
    tick: 48, // 中午 12:00
    weather: "sunny",
    locations: [/*...*/],
    characters: [createTestCharacter("alice"), createTestCharacter("bob")]
  };
}
```

### 6.3 测试命令

```bash
pnpm test              # 单元 + 集成（快速，无 LLM）
pnpm test:live         # Live 测试（需要 API key）
pnpm test:sim          # 模拟测试（跑 N tick，观察行为）
pnpm test:watch        # 开发时 watch 模式
pnpm test:coverage     # 覆盖率报告
```

### 6.4 测试文件组织

测试文件与源文件 colocated（参考 OpenClaw）：
```
src/core/tick-engine.ts
src/core/tick-engine.test.ts     ← 紧挨源文件
src/agent/agent-loop.ts
src/agent/agent-loop.test.ts
```

### 6.5 模拟测试（Simulation Test）

最重要的验证手段——跑一个完整的小世界，观察是否出现合理行为：

```typescript
// test/simulation/basic-day.live.test.ts
test("角色能过完合理的一天", async () => {
  const world = createSmallTown({ characters: ["alice", "bob"] });
  const engine = new TickEngine(world, { speed: 10 }); // 10x 加速

  // 跑 96 个 tick = 1 天
  await engine.runTicks(96);

  // 验证基本合理性
  const alice = world.getCharacter("alice");
  expect(alice.needs.hunger).toBeGreaterThan(20); // 不应该饿死
  expect(alice.eventLog.some(e => e.type === "eat")).toBe(true); // 吃过饭
  expect(alice.eventLog.some(e => e.type === "sleep")).toBe(true); // 睡过觉

  // 输出行为日志供人工 review
  console.log(formatDayLog(alice));
}, 300_000); // 5 分钟超时
```
