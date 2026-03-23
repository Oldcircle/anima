# Anima — AI 生命模拟器

> LLM 驱动的自主生活模拟，AI 角色在小镇中自主生活，玩家可随时加入。

## 项目概述

Anima 是一个 AI 生命模拟项目，灵感来自星露谷物语 + Stanford Generative Agents。核心特点：

- **自主生活**：5-10 个 AI 角色在虚拟小镇中自主决策、生活、社交
- **玩家参与**：用户作为角色加入世界，与 AI 居民建立关系
- **Tool-based Agent**：每个角色的行为空间由工具定义（吃饭、社交、工作、娱乐等），LLM 自主选择
- **记忆系统**：长短期记忆 + 向量搜索 + 时间衰减
- **时间系统**：Tick 驱动，支持加速/暂停/减速

## 技术栈

- **后端**：Node.js + TypeScript
- **LLM**：多提供商支持（Anthropic / OpenAI / Google / DeepSeek / Ollama / Together AI / 自定义 OpenAI 兼容端点）
- **存储**：SQLite（世界状态 + 记忆 + 向量搜索）
- **前端**：React + 简易 2D 地图 + WebSocket 实时通信
- **测试**：Vitest（单元 / 集成 / live / 模拟测试）
- **复用**：从 OpenClaw 提取记忆系统、Context Book、工具目录、多 provider 模式等模块

## 目录结构

```
anima/
├── CLAUDE.md          # 本文件
├── PLAN.md            # 架构设计
├── STATUS.md          # 开发状态
├── package.json
├── src/
│   ├── core/          # 时间系统、世界状态、事件总线
│   ├── world/         # 地图、地点、物品、天气
│   ├── character/     # 角色定义、人格、需求系统
│   ├── agent/         # LLM agent 循环、工具执行
│   ├── memory/        # 记忆系统（从 OpenClaw 提取）
│   ├── actions/       # 行为工具定义（社交、工作、休闲等）
│   ├── narrative/     # 叙事引擎、事件描述生成
│   └── api/           # WebSocket API 供前端消费
├── web/               # React 前端
│   ├── components/    # 地图、角色面板、对话框
│   └── stores/        # 前端状态管理
└── data/
    ├── town.yml       # 小镇地图定义
    ├── characters/    # 角色卡 YAML
    └── items/         # 物品/作物定义
```

## 开发命令

```bash
pnpm dev              # 启动模拟 + Web 服务 (http://localhost:3001)
pnpm test             # 单元 + 集成测试
pnpm test:watch       # 开发时 watch 模式
pnpm test:live        # Live 测试（需要 DeepSeek API key）
pnpm test:coverage    # 覆盖率报告
```

## 活跃文档

- [PLAN.md](./PLAN.md) — 实现分期计划（稳定，按阶段推进）
- [DESIGN.md](./DESIGN.md) — 详细架构设计（系统设计、数据结构、接口定义）
- [STATUS.md](./STATUS.md) — 当前开发状态

## OpenClaw 复用清单

从 `~/Opensource/forks/openclaw` 提取的模块：

| 模块 | 源文件 | 复用方式 |
|------|--------|---------|
| 时间衰减 | `src/memory/temporal-decay.ts` | 直接复制，零修改 |
| MMR 多样性排序 | `src/memory/mmr.ts` | 直接复制，零修改 |
| 混合搜索 | `src/memory/hybrid.ts` | 直接复制，零修改 |
| 记忆管理器 | `src/memory/manager.ts` | 适配 SQLite schema，去掉 OpenClaw 日志 |
| 搜索管理器 | `src/memory/search-manager.ts` | 替换 QMD 后端为游戏后端 |
| Context Book | `src/agents/context-books.ts` | 适配为角色知识书 |
| 身份解析 | `src/agents/identity.ts` | 替换频道层级为地点/阵营 |
| 工具目录 | `src/agents/tool-catalog.ts` | 重建为角色行为注册表 |
| Agent 循环 | `src/agents/pi-embedded-runner/run.ts` | 提取模式，简化重写 |
