# Anima — AI 生命模拟器

> LLM 驱动的自主生活模拟。5 个独立 AI Agent 在海边小镇自主决策、生活、社交。

- **GitHub**: https://github.com/Oldcircle/anima (私有仓库)

## 第一性原理

> **每个角色是独立 Agent，通过工具自主决策。没有特殊机制。关系从互动中涌现。**

## 项目概述

Anima 是一个 AI 生命模拟项目，灵感来自星露谷物语 + Stanford Generative Agents。

- **5 个 AI 角色**：高松灯（面包店学徒）、千早爱音（咖啡馆店员）、丰川祥子（咖啡馆兼职）、若叶睦（花店店主）、长崎素世（图书馆管理员）
- **Tool-based Agent**：每个角色的行为空间由工具定义（talk/eat/work/go_to 等），LLM 自主选择
- **零预设关系**：角色卡不包含任何跨角色引用，所有关系从零涌现
- **五层活人感**：环境感知 + 印象系统 + 内心独白分级 + 对话模式 + 观察推理
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
pnpm test             # 单元测试（~149 tests，几秒完成）
pnpm test:watch       # 开发时 watch 模式
pnpm test:live        # Live 测试（需要 DEEPSEEK_API_KEY）
pnpm test:sim         # 一日/七日模拟测试（需要 DEEPSEEK_API_KEY）
```

## 测试说明

### 单元测试（pnpm test）
- 149 个测试，18 个文件，不需要 API key
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

## 角色（MyGO!!!!! 适配）

| ID | 名字 | 职业 | 性格核心 |
|----|------|------|---------|
| tomori | 高松灯 | 面包店学徒 | 极度内向，断断续续，笔记本写满心里话 |
| anon | 千早爱音 | 咖啡馆店员 | 社交达人，爱面子，内心空虚 |
| sakiko | 丰川祥子 | 咖啡馆兼职 | 前大小姐，用礼貌当盔甲 |
| mutsumi | 若叶睦 | 花店店主 | 沉默寡言，面无表情，暗地弹吉他 |
| soyo | 长崎素世 | 图书馆管理员 | 温柔周到，控制欲藏在善意下 |

## 活跃文档

- [PLAN.md](./PLAN.md) — 实现分期计划
- [DESIGN.md](./DESIGN.md) — 详细架构设计（需求系统、行为系统、五层活人感）
- [STATUS.md](./STATUS.md) — 当前开发状态与 Live 验证结果

## 环境配置

```bash
# .env 文件
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API key
DEEPSEEK_BASE_URL=https://api.deepseek.com  # 可选，默认值
PORT=3001                         # Web 服务端口，可选
```
