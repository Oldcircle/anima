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
- **当前攻坚方向**：生活惯性（currentIntent）+ 可观察生活痕迹（observableState）
- **思考持久化**：LLM 每次决策的内心独白存入记忆，念头能跨 tick 延续
- **时间系统**：Tick 驱动（1 tick = 游戏 15 分钟），支持加速/暂停

## 技术栈

- **运行时**：Node.js 24 + TypeScript 5.9
- **LLM**：DeepSeek（默认），支持 OpenAI 兼容端点
- **存储**：SQLite（世界状态 + 记忆 + 印象 + 长期记忆）
- **前端**：单 HTML 文件 + WebSocket 实时通信
- **测试**：Vitest 4（单元 / live / 模拟测试）

## 目录结构

```
anima/
├── CLAUDE.md           # 本文件（项目说明书）
├── PLAN.md             # 实现分期计划
├── DESIGN.md           # 详细架构设计
├── STATUS.md           # 当前开发状态
├── src/
│   ├── core/           # 时间系统（tick-engine）、事件总线
│   ├── world/          # 世界状态、地点、关系、经济、天气
│   ├── character/      # 角色卡类型、YAML 加载器
│   ├── agent/          # LLM agent 循环、prompt 构建、对话模式、印象、观察推理、反思
│   ├── memory/         # 短期记忆、印象存储、时间衰减、MMR
│   ├── actions/        # 行为工具（basic/social/leisure/gray）
│   ├── providers/      # LLM provider 抽象（OpenAI 兼容、failover）
│   ├── persistence/    # SQLite 持久化、存档/读档
│   ├── api/            # Express + WebSocket 服务
│   └── cli.ts          # CLI 入口
├── web/                # 前端（单 HTML）
├── data/
│   ├── locations/      # 地点 YAML（含 atmosphere 感官描写）
│   └── characters/     # 5 个角色卡 YAML（零跨角色引用）
├── test/
│   └── helpers/        # 测试工具（test-world、sim-reporter）
└── logs/               # 模拟日志（Markdown 格式）
```

## 开发命令

```bash
pnpm dev              # 启动模拟 + Web 服务 (http://localhost:3001)
pnpm build            # TypeScript 编译
pnpm test             # 单元测试（~242 tests，几秒完成）
pnpm test:watch       # 开发时 watch 模式
pnpm test:live        # Live 测试（需要 DEEPSEEK_API_KEY）
pnpm test:sim         # 一日/七日模拟测试（需要 DEEPSEEK_API_KEY）
```

## 测试说明

### 单元测试（pnpm test）
- 242 个测试，26 个文件，不需要 API key
- 覆盖：时间系统、世界状态、需求衰减、关系、记忆、印象、对话追踪、观察推理、prompt 构建、约束检查、数据库

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

`data/characters/` 下含 27 个角色 yml（多数标 disabled，由各 scenario 显式启用）。
`data/locations/` 下含 43+ 个地点 yml（含 25 个监狱地点，标 disabled，由 koukou-judgment 显式启用）。

## 活跃文档

- [PLAN.md](./PLAN.md) — 实现分期计划
- [DESIGN.md](./DESIGN.md) — 详细架构设计（需求系统、行为系统、五层活人感）
- [STATUS.md](./STATUS.md) — 当前开发状态与 Live 验证结果
- [PLAN-game-frontend.md](./PLAN-game-frontend.md) — 游戏前端设计（星露谷风格像素 RPG）
- [PLAN-frontend-redesign.md](./PLAN-frontend-redesign.md) — `web/` 管理面板重构计划（API 设置 + 角色/地点 CRUD）
- [DESIGN-narrative.md](./DESIGN-narrative.md) — 叙事架构设计（4 层结构 + scenario pack + beat engine + LLM director）
- [PLAN-narrative.md](./PLAN-narrative.md) — 叙事系统分期实施计划（N0-N7）
- [IMPORT-koukou-judgment.md](./IMPORT-koukou-judgment.md) — 扣扣审判卡导入策略（1B/2B/3C 决策记录）

## 当前迭代焦点

**N0-N6 完成，N7 收尾中**：叙事系统已完整接入。
- 规则导演 (BeatEngine) + LLM 导演 (Director) 双层架构
- scenario pack 抽象支持任意剧本切换
- koukou-judgment（魔法少女监狱审判）作为完整旗舰剧本
- 玩家通过 web 叙事面板可塞纸条、注入事件、触发 director

完整规划见 PLAN-narrative.md，当前进度见 STATUS.md。

## 环境配置

```bash
# .env 文件
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API key
DEEPSEEK_BASE_URL=https://api.deepseek.com  # 可选，默认值
PORT=3001                         # Web 服务端口，可选
```
