# Anima — 开发状态

## 当前阶段：Phase 4 基础完成

**最后更新**：2026-03-23

## 完成概览

### Phase 0 ✅ 基础骨架
时间系统、事件总线、世界状态、记忆模块（OpenClaw 适配）、多 provider 抽象层

### Phase 1 ✅ 单角色验证
角色卡 YAML、5 个行为工具、Agent 决策循环、DeepSeek 集成

### Phase 2 ✅ 多角色 + 对话
- 多角色并行决策（Simulation 引擎）
- 真实多轮对话系统（5 轮深度交流，角色风格一致）
- 关系系统（RelationshipManager，对话后自动更新）
- 短期记忆（行为和对话摘要注入 prompt）
- 角色 ID 模糊匹配

### Phase 4 ✅ 前端 + API
- WebSocket 实时推送
- HTTP REST API（/api/state, /api/characters, /api/events, /api/relationships）
- Web 前端：地图视图 + 角色面板 + 事件日志 + 对话查看
- CLI 启动脚本（`pnpm dev`）

## 启动方式

```bash
cd ~/Opensource/projects/ai/anima
pnpm dev          # 启动模拟 + Web 服务
# 打开 http://localhost:3001
```

## 测试状态

```
单元+集成: 9 files, 71 tests passed
Live 测试:  2 files, 4 tests passed (DeepSeek API)
```

## 文件清单

```
src/
├── core/           tick-engine, event-bus (+tests)
├── memory/         temporal-decay, mmr, short-term (+tests)
├── world/          types, world, relationships (+tests)
├── character/      types, loader
├── actions/        types, basic-actions
├── agent/          agent-loop, prompt-builder, conversation, simulation (+tests, +live tests)
├── providers/      types, provider-registry, openai-compatible
├── api/            server (Express + WebSocket)
├── cli.ts          启动入口
web/
├── index.html      纯 HTML 前端（地图 + 面板 + 事件日志）
data/characters/    alice.yml, bob.yml
test/helpers/       mock-llm, test-world
```

## 下次继续

- Phase 3：天气系统、经济系统、随机事件
- Phase 5：玩家交互（前端对话输入框）、存档/读档
- 长期记忆（SQLite + 向量搜索）、反思机制
