# Anima — AI 生命模拟器

> LLM 驱动的自主生活模拟。5 个独立 AI Agent 在海边小镇自主决策、生活、社交。

- **GitHub**: https://github.com/Oldcircle/anima (私有仓库)

## 第一性原理

> **每个角色是独立 Agent，通过工具自主决策。没有特殊机制。关系从互动中涌现。**

## 项目概述

Anima 是一个 AI 生命模拟项目，灵感来自星露谷物语 + Stanford Generative Agents。

- **可切换剧本（Scenario Pack）**：默认 `default` 剧本启用 7 个混搭角色（asuka/L/lelouch/light/rei/senjougahara/shinji），`mygo-seaside` 剧本启用 5 个 MyGO!!!!! 角色。`pnpm dev --scenario <id>` 切换。
- **Tool-based Agent**：每个角色的行为空间由工具定义（talk/eat/work/go_to 等），LLM 自主选择
- **零预设关系**：角色卡不包含任何跨角色引用，所有关系从零涌现
- **五层活人感**：环境感知 + 印象系统 + 内心独白分级 + 对话模式 + 观察推理
- **破线提示词（`src/agent/break-config.ts`）**：解锁"下行通道"——让关系会变差、会 argue、印象态度
  会出负，而非只有真善美。核心是**决策前强制 COT 自检脚手架**（态度/旧账/语气/走向），非许可散文。
  三档 `off`(纯和谐)/`mild`(默认,允许摩擦)/`strong`(戏剧化冲突)，经 `ANIMA_BREAK_LEVEL` 或 scenario
  `break_level` 调。所有破线文本集中在 break-config.ts，`off` 档保证 A/B 基线。写法参考酒馆破限预设
  （`reference/tavern-presets/`）
- **生活主线**：晨间打算（每天 06:00 基于昨日反思定今日打算）+ 约定系统
  （arrange_meet 说定→分级提醒→赴约/爽约结算）——反思→打算→行动→回顾的日循环闭环
- **生活节律**：饭点感知、上班节律、居家可供性（rest/tidy_up）、
  重要性感知记忆（反思比琐事活得久）、跨天时间标注（"昨天23:00"）
- **记忆检索重排（`src/memory/{mmr,temporal-decay}.ts`）**：注入 prompt 的记忆按「重要性 × 时间衰减」
  加权 + MMR 多样性重排——只在最近窗口内重排（不碰长期记忆），重要反思不被琐事挤出、雷同记忆不刷屏。
  `ANIMA_MEM_RERANK=0` 可关（= 纯 recency 行为，用于 A/B）
- **气候系统（`src/world/climate.ts`）**：天气×四季×时辰 → 体感温度；露天暴露在
  恶劣气候会额外耗 needs + 生 moodlet（催人躲屋里），室内免疫；温度/气候提示/季节氛围注入 prompt；
  Godot 四季换装（季节染色 + 樱花/落叶/雪絮粒子 + 时钟温度）
- **经济系统（`src/world/economy.ts`）**：生计压力（每天 07:00 扣房租/杂用 `applyDailyUpkeep`，
  付不起→焦虑+生计记忆）+ 财务体感（按"撑得了几天"分档 financeBand，进 prompt）+ 季节市场价格
  （`effectivePrice` 应季便宜反季贵，buy 工具三处一致）；Godot 名册/详情显示金币+财务档、头顶飘金币
- **社交可视化**：`godot/ui/RelationWeb.gd` 关系网（R 键，圆环 + 关系连线按类型上色 + bond 标注）
- **思考持久化**：LLM 每次决策的内心独白存入记忆，念头能跨 tick 延续
- **时间系统**：Tick 驱动（1 tick = 游戏 15 分钟），支持加速/暂停
- **提示词缓存纪律**：DeepSeek 自动前缀缓存按逐字节匹配——工具表/system prompt 只随「角色×地点」变化，
  每 tick 抖动的状态走 user prompt 末尾"此刻区"（环境快照）；由 `src/agent/prompt-cache-discipline.test.ts`
  回归锁定，命中率按调用类型分桶打印（`[LLM cache]` 日志）

## 技术栈

- **运行时**：Node.js 24 + TypeScript 5.9
- **LLM**：DeepSeek（默认），支持 OpenAI 兼容端点
- **存储**：SQLite（世界状态 + 记忆 + 印象 + 长期记忆）
- **前端**：① `web/` 管理面板（单 HTML + WebSocket）② `godot/` 游戏化观看前端（Godot 4.6，同一条 WS，日式 RPG 像素小镇 + 昼夜氛围 + **四季换装** + 天气特效，美术 = Ninja Adventure CC0；HUD 面板：**Tab 镇民状态名册**（生存血条+金币）、**R 关系网**、**L 生活记录**（对话/内心/行为/反思/流言时间线）、生存告警徽章、头顶飘金币、叙事干预、调速；**角色走路（跨室内外走门淡出过渡）+ 场景内自动闲逛**，不再瞬移；见 godot/README.md）
- **测试**：Vitest 4（单元 / live / 模拟测试）

## 目录结构

```
anima/
├── CLAUDE.md           # 本文件（项目说明书）
├── PLAN-appointments.md    # 分期：约定系统（已实施）
├── PLAN-tool-feedback.md   # 分期：Tool Feedback Loop（已实施）
├── PLAN-game-frontend.md   # 分期：Godot 夜景前端
├── src/
│   ├── core/           # 时间系统（tick-engine）、事件总线
│   ├── world/          # 世界状态、地点、关系、经济、天气、气候(climate)、约定（appointments）
│   ├── character/      # 角色卡类型、YAML 加载器
│   ├── agent/          # LLM agent 循环、prompt 构建、对话模式、印象、观察推理、反思、晨间打算
│   ├── memory/         # 短期记忆、印象存储、时间衰减、MMR
│   ├── actions/        # 行为工具（basic/social/leisure/gray）
│   ├── providers/      # LLM provider 抽象（OpenAI 兼容、failover）
│   ├── persistence/    # SQLite 持久化、存档/读档
│   ├── api/            # Express + WebSocket 服务
│   └── cli.ts          # CLI 入口
├── web/                # 管理面板前端（单 HTML）
├── godot/              # 游戏化观看前端（Godot 4.6，日式 RPG 像素小镇，见 godot/README.md）
├── data/
│   ├── locations/      # 地点 YAML（含 atmosphere 感官描写）
│   └── characters/     # 27 个角色卡 YAML（多数 disabled，由 scenario 启用；零跨角色引用）
├── test/
│   └── helpers/        # 测试工具（test-world、sim-reporter）
└── logs/               # 模拟日志（Markdown 格式）
```

## 开发命令

```bash
pnpm dev              # 启动模拟 + Web 服务 (http://localhost:3001)
pnpm build            # TypeScript 编译
pnpm test             # 单元测试（几秒完成）
pnpm test:watch       # 开发时 watch 模式
pnpm test:live        # Live 测试（需要 DEEPSEEK_API_KEY）
pnpm test:sim         # 一日/七日模拟测试（需要 DEEPSEEK_API_KEY）
```

## 测试说明

### 单元测试（pnpm test）
- 不需要 API key，几秒跑完（测试数/文件数随开发增长，以实际运行为准）
- 覆盖：时间系统、世界状态、需求衰减、关系、记忆、印象、对话追踪、观察推理、prompt 构建、约束检查、数据库、约定系统、晨间打算

### Live 测试（pnpm test:live）
- 需要 `.env` 中配置 `DEEPSEEK_API_KEY`
- 测试文件：`*.live.test.ts`
- 包含：单角色决策、双角色对话、印象生成、观察推理
- 超时：600 秒

### 模拟测试（pnpm test:sim）
- 需要 `DEEPSEEK_API_KEY`
- `full-day.sim.test.ts`：5 角色跑完整一天（72 tick，约 10-15 分钟）
- `seven-day.sim.test.ts`：5 角色跑 7 天（672 tick，约 30-60 分钟）
- `stress-sim.test.ts`：用 SmartMockLLM 压力测试（不需要 API key，几秒完成）
- 输出 Markdown 日志到 `logs/` 目录

### 半天模拟（pnpm test:live 中的 sim-halfday）
- `sim-halfday.live.test.ts`：5 角色跑 36 tick（06:00→15:00，约 5 分钟）
- 这是最常用的验证测试：快速验证对话、印象、观察推理完整链路
- 输出实时 per-tick 行为 + 最终摘要 + Markdown 日志

## 剧本系统（Phase N1 引入）

通过 `data/scenarios/<id>/manifest.yml` 声明启用哪些角色和地点。

| Scenario | 角色 | 用途 |
|---|---|---|
| `default` | asuka, L, lelouch, light, rei, senjougahara, shinji（7 个） | CLI 默认 |
| `mygo-seaside` | tomori, anon, sakiko, mutsumi, soyo（5 个 MyGO） | 备用剧本 |
| `koukou-judgment` | 14 个魔法少女（艾玛/希罗/雪莉/诺亚/蕾雅/...） | 弹丸论破式审判，含 seeds + beats + trial 工具 |
| `kira-incident` | default 同款 7 人 | 死亡笔记非致死移植：诅咒之册 + kira_strike 夜书 + 怪病应验 + 委托人到期日（见 PLAN-kira.md） |

另有 `last-ferry`（3 角色狗血版，3 重 climax + 全 beat auto_seeds）与 `seaside-trio`；完整清单以 `data/scenarios/` 为准。

`data/characters/` 下含 27 个角色 yml（多数标 disabled，由各 scenario 显式启用）。
`data/locations/` 下含 43+ 个地点 yml（含 25 个监狱地点，标 disabled，由 koukou-judgment 显式启用）。

## 活跃文档

- [STATUS.md](./STATUS.md) — **会话交接文档**（当前进度 + 下次入口 + 跨会话教训），进项目先读这个
- [PLAN-kira.md](./PLAN-kira.md) — kira-incident 剧本包（死亡笔记非致死移植）：正典解剖 + 诅咒之册机制 + 信息图/到期日设计
- [AUDIT-aliveness-20260704.md](./AUDIT-aliveness-20260704.md) — **活人感全面体检报告**（93 条验证后发现：6 个实锤 bug + 六大结构性根因 + quick wins/deep work 修复路线），「过家家感」问题以此为准
- [PLAN-appointments.md](./PLAN-appointments.md) — 约定系统（arrange_meet 工具 + 到点结算赴约/爽约 + 记挂/愧疚钩子），已实施
- [PLAN-tool-feedback.md](./PLAN-tool-feedback.md) — Tool Feedback Loop 改造（✅ 已实施，保留作设计依据）
- [PLAN-game-frontend.md](./PLAN-game-frontend.md) — Godot 游戏前端（日式 RPG 像素小镇）。P0~P4 全部完成 + 行为可视化（对话凑近/送礼飞道具）+ mygo 剧本适配；运行见 godot/README.md

> ⚠️ 教训：叙事系统(N0-N6) 与 Director Agent(D1-D4) 的旧规划文档曾因 gitignore 未入仓而丢失过一次。
> **2026-07-03 起 PLAN/STATUS/DESIGN/IMPORT 系列全部入仓**（仓库已转 private）。
> 叙事/导演系统的要点见 STATUS.md「后端 / 模拟核心」节 + 代码本身（`src/narrative/`、`src/agent/`），不必再找。

## 环境配置

```bash
# .env 文件
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API key
DEEPSEEK_BASE_URL=https://api.deepseek.com  # 可选，默认值
DEEPSEEK_THINKING=disabled        # 思考模式（auto/disabled/enabled），仅 deepseek-v4-* 生效
ANIMA_BREAK_LEVEL=mild            # 破线强度 off/mild/strong（下行通道解锁），默认 mild；scenario manifest break_level 优先级更高
ANIMA_DECISION_POV=first          # 决策视角 first/third，默认 first。third=作者预测框架（深翻顶块+决策指令）+ 私有通道：两层动机行【表面】｜【真心】经 motive-channel.ts 解析，真心层只走观看者通道（WS motive 字段/🎭 日志）、本人记忆只回流表面层。与 BREAK_LEVEL 正交，见 STATUS
ANIMA_PROMPT_DUMP=1               # 可选调试：把每次 LLM 请求体落盘 logs/prompt-dumps/<kind>/，供相邻请求 diff 前缀断点
PORT=3001                         # Web 服务端口，可选
```

## DeepSeek V4 思考模式适配

默认模型为 `deepseek-v4-flash`（1M context，tool_use 友好）。V4 系列默认开启思考链——
对 anima 这种"工具调用 + 角色扮演 + 项目自带内心独白"的场景纯属浪费 token + 增加延迟。

实现要点（`src/providers/openai-compatible.ts`）：

- `OpenAICompatibleConfig.thinking?: "enabled" | "disabled" | "auto"`，默认 `auto`
- `auto`：模型名匹配 `deepseek-v4` 时自动加 `thinking: {type: "disabled"}`，其他模型不发参数（向后兼容 deepseek-chat / OpenAI / OpenRouter / Ollama 等）
- `disabled`：始终发 `{type: "disabled"}`
- `enabled`：发 `{type: "enabled"}`，并主动**不发** `temperature`（DeepSeek 文档：思考模式下 temperature/top_p/presence_penalty/frequency_penalty 会被服务端忽略）
- `data/settings.json` 的 `llm.thinking` 字段（前端 Settings 页可设）优先级高于 env

如果将来切回 `deepseek-reasoner` 或 OpenAI o1 之类原生 reasoning 模型，这套机制不会干扰它们（auto 模式只识别 v4 前缀）。

## 首次运行记录

- **日期**: 2026-04-27
- **机器**: macOS Apple Silicon, Node 24.14.0, pnpm 10.32.1
- **状态**: 成功
- **耗时**: `pnpm install` ~3s（lockfile 命中），`better-sqlite3` 原生模块编译 ~30s，单元测试 1.2s
- **测试结果**: `pnpm test` → 40 文件 / 406 用例全通过（README 上写的 266 已过期）
- **启动**: `pnpm dev` → http://localhost:3001 ，加载 18 个地点 + 7 个角色（默认 scenario）+ 5 个 beats，LLM Director 启用（每天 5 次预算），WebSocket 实时推送
- **踩坑点**:
  - `pnpm install` 默认会拒绝执行 `better-sqlite3` 和 `esbuild` 的 install 脚本（pnpm 10+ 安全策略），出现 `Ignored build scripts` 警告。手动到 `node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3` 跑 `npm run install` 才能编译出 `better_sqlite3.node`。或者用 `pnpm approve-builds`（交互式）。
- **已知现象**:
  - 启动时 dotenv 提示 "🔐 prevent building .env in docker" 是正常营销文案
  - tick 启动后会立即 scan beats，例如 `🎬 [beat] scan @ day 1 tick 24: 1 beat(s) ready` 是预期行为
