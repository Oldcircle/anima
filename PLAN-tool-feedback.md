# PLAN — Tool Feedback Loop 改造

> **状态**: ✅ 已全部实施（2026-07-03 核查确认）
> Layer B（go_to 位置锚点）/ C（resolveLocation 收紧）/ E（do_nothing 兜底）在 `src/agent/tool-builder.ts`；
> Layer D（tick 内 ToolResult 重试循环）在 `src/agent/agent-loop.ts`，实际 `MAX_TOOL_RETRY = 2`（比本文设计的 1 更宽），
> hint 生成在 `src/agent/tool-feedback.ts`。本文档保留作设计依据。
> **目标**: 让 LLM agent 失败后能立即自纠错，参考 Claude Code 的 ToolResult `is_error` + `<system-reminder>` 设计

---

## 0. 问题陈述

观察到的现象（半天模拟日志，截止 tick 31）：

| 错误 | 角色 | 频次 | 原因 |
|---|---|---|---|
| `✗ 你已经在 X 了` | L、明日香 | 每个角色 ≥4 次 | go_to 当前位置，模糊匹配 + "家" 关键字 |
| `✗ 想吃东西但没想好吃什么` | 明日香 | 1 次 | eat 不带 food 参数 |
| `⚠️ 不存在的工具: talk` | shinji | 2 次 | 离开人群后还在 talk |

根因：**Anima 当前每 tick 单次 LLM → 一次工具执行，没有反馈循环**。失败描述只通过 memory 进入下一 tick 的 prompt，被埋在十几条记忆里，模型看不到"上一步失败"。

## 1. Claude Code 的对应设计（参考 `~/Opensource/vendor/claude-code`）

| 模式 | 文件 | 做什么 |
|---|---|---|
| **`is_error: true` 的 ToolResult 同 turn 反馈** | `src/query.ts:140` | 工具失败立即包成 `tool_result` 回喂，模型必须基于失败结果继续 |
| **Zod schema 入口校验 + 友好错误** | `src/services/tools/toolExecution.ts:631` + `src/utils/toolErrors.ts:66` | 缺参数/类型不对/未知字段都给针对性中文/英文 hint |
| **动态 description 注入运行时上下文** | `src/utils/api.ts:171` | `tool.prompt(ctx)` 每 turn 重建，cwd / 已开文件等显式锚点 |
| **`<system-reminder>` meta-instruction** | `src/utils/messages.ts:3148` | 和 tool error 区分开的 LLM 行为提示 |
| **deferred-loading hint** | `src/services/tools/toolExecution.ts:579` | 失败时附"该怎么改"的具体步骤 |

核心思想：**失败必须**在模型当前的注意力窗口内；不能让"失败"变成被忽略的历史噪音。

## 2. Anima 落地设计（4 层组合拳）

### Layer B — 动态 description 锚点（防御层，5 分钟）

`src/agent/tool-builder.ts` 的 `buildGoToTool`：description 顶部加：

```
你当前在【{ctx.location.name}】(id={ctx.location.id})。
不要传当前所在地点。如果你已经在家就别 go_to "家"。
```

让 LLM 在 token 级看到当前位置 + 红线，覆盖 ~80% 的"误调当前地点"。

### Layer C — 收紧 resolveLocation（防御层，5 分钟）

`buildGoToTool` 的 `resolveLocation`：

```ts
if (input === "家" || input === "回家" || input === "home") {
  // 在家就别再 go_to "家"——返回 undefined 让上层报"unknown_location"
  if (myHome === ctx.state.locationId) return undefined;
  return ctx.allLocations.find(l => l.id === myHome);
}
```

把"已在 X"软提示降级为"unknown_location"硬错误，模型更不容易当背景噪音忽略。

### Layer D — Tick 内 ToolResult 反馈循环（核心层，2-3 小时）

**对齐 Claude Code 的 `is_error: true` 模式**。改 `src/agent/agent-loop.ts`：

```
当前流: prompt → LLM → tool 调用 → 执行 → 失败/成功 → tick 结束
改后流: prompt → LLM → tool 调用 → 执行
        if 失败 and retries < MAX_TOOL_RETRY (默认 1):
          messages.push(assistant: tool_calls=[toolCall])
          messages.push(tool: { tool_call_id, content: `✗ ${desc}\n\n${hint}` })
          → LLM 第二次调用 → 新工具调用 → 执行 → 结束
```

要点：
- 失败的 `tool_result.content` 不只是 description，**附带可执行 hint**（例如"试试 sit 或 do_nothing；可去地点：A,B,C"）
- 重试上限 `MAX_TOOL_RETRY = 1`（最多重试一次，避免雪崩 + 控制成本）
- 重试时 thinking 仍 disabled（V4 Flash 默认）
- 重试也按工具调用计费——但比起浪费整个 tick + 玩家看到一堆 ✗ 体验更好

实现钩子：
- `executeAction` 已经返回 `result.result.success === false` 的明确信号
- OpenAI tool-calling 协议天然支持 multi-turn assistant↔tool 消息
- 现有 provider 的 `LLMRequest.messages` 不支持 tool_call_id 字段——需要扩展类型

### Layer E — `do_nothing` 兜底工具（防御层，10 分钟）

`src/agent/tool-builder.ts:46` 的 `buildToolList`：末尾无条件 push 一个 `do_nothing`：

```ts
tools.push({
  tool: {
    name: "do_nothing",
    description: "什么都不做，发呆/等待。当你不知道做什么、或周围没有合适的事可做时选这个。",
    parameters: { type: "object", properties: { thought: { type: "string", description: "你在想什么" } }, required: ["thought"] },
  },
  handler: () => ({ description: "发了一会儿呆", effects: [], duration: 1, observableState: "若有所思地停了下来。" }),
});
```

L 在自家房间这种"工具池贫瘠"场景永远有出路，不会被迫 go_to 兜圈子。

## 3. Layer 间关系

```
              LLM 决策
                ↓
        Layer B（schema 锚点：你在哪里）
                ↓
        Layer C（resolver 严：在家不准 go "家"）
                ↓
        executeAction
                ↓
              失败？
              ↓ 是
        Layer D（同 turn 喂 ToolResult + hint）→ LLM 重试
              ↓ 仍失败 / 成功
        Layer E（最坏情况 do_nothing 兜底）
              ↓
            tick 结束
```

## 4. 实施顺序

1. **B + C + E**（30 分钟）：纯防御，不动架构。先验证日志里 ✗ 是否锐减。
2. **D**（2-3 小时）：架构改动，需要：
   - 扩展 `LLMRequest.messages` 支持 tool_calls / tool_call_id
   - 改 `OpenAICompatibleProvider.chat` 拼 messages 时透传
   - 改 `executeAgentTick` 主循环成 retry-aware
   - 写单元测试覆盖：tool 失败 → 重试 → 成功 / 重试也失败 / 重试不再失败但仍带 hint
3. 跑 `pnpm test:live` 看 5 角色一日模拟里 ✗ 数量变化。

## 5. 不做的事

- **不引入完整 ReAct loop**：单 tick 只允许 1 次重试，避免 LLM 在一个 tick 里磨蹭半天
- **不改 director 的 read/write 工具**：director 自己有 budget + tool loop，不在本次 scope
- **不改成"失败不计 tick"**：那会改变游戏时间语义，太大

## 6. 成功标准

- 半天模拟（36 tick）里 `✗` 标记数量从当前 ~10 降到 ≤ 3
- 单 tick 平均 LLM 调用数从 1 升到 ≤ 1.3（每 ~3 tick 才发生一次重试）
- 现有 406 个单元测试全部仍通过
- 新增 ≥ 4 个针对 retry loop 的单元测试

## 7. 失败回滚

每层独立可回滚。如果 D 引入回归，单独 revert agent-loop 即可，B/C/E 留下来就有显著改善。
