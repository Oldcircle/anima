# Anima — 开发状态

## 当前阶段：Phase 3 + 5 大部分完成

**最后更新**：2026-03-23

## 完成概览

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | 基础骨架 | ✅ |
| 1 | 单角色验证 | ✅ |
| 2 | 多角色 + 对话 | ✅ |
| 3 | 世界丰富 | 90% |
| 4 | 前端 | ✅ |
| 5 | 打磨 | 60% |

## 本轮新增

- **存档/读档**（SQLite 持久化）
  - SIGINT 自动保存世界状态、角色、记忆、关系、事件
  - 启动时自动检测并恢复存档
  - 每游戏日自动存档
- **Failover 机制**（主模型失败自动降级到备选）
- **八卦传播系统**（目击者在同地点传播事件给其他角色）
- **经济系统**（工作赚金币，消费扣金币）
- **数据库测试**（6 个单元测试）

## 测试状态

```
单元+集成: 10 files, 77 tests passed
Live 测试:  2 files, 4 tests passed
Sim 测试:   1 file, 1 test passed (5角色全天)
```

## 启动方式

```bash
cd ~/Opensource/projects/ai/anima
pnpm dev    # http://localhost:3001
# Ctrl+C 自动存档，下次启动自动读档
```

## 剩余开发项

| 优先级 | 功能 | 状态 |
|--------|------|------|
| 中 | 节日系统 | 未开始 |
| 中 | 7 天模拟测试 | 未开始 |
| 中 | 关系网络图（前端） | 未开始 |
| 中 | 记忆可视化（前端） | 未开始 |
| 低 | 长期记忆向量搜索 | 未开始 |
| 低 | 更多 LLM 提供商 | 未开始 |
| 低 | Canvas 2D 地图 | 未开始 |

## 文件清单

```
src/
├── core/           tick-engine, event-bus
├── memory/         temporal-decay, mmr, short-term
├── world/          types, world, relationships, weather, events, gossip, economy
├── character/      types, loader
├── actions/        types, basic-actions, social-actions, leisure-actions
├── agent/          agent-loop, prompt-builder, conversation, simulation, reflection
├── providers/      types, provider-registry, openai-compatible, failover
├── persistence/    database, save-load
├── api/            server
├── cli.ts          启动入口
web/                前端 HTML
data/characters/    5 个角色 YAML
test/helpers/       mock-llm, test-world
```
