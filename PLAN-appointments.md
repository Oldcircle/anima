# PLAN — 约定系统（Appointments）

> **状态**: ✅ 已实施（2026-07-03 立项并完成，24 个单元测试覆盖全链路）
> live 验证：v4/v5 半天模拟零回归；arrange_meet 正确浮现但半天窗口内未被自然使用
> （约定是低频行为），已在会话 prompt 加"聊得投缘可约下次"的非强迫提示。
> **自然发生率待 7 日模拟（`pnpm test:sim`）验证** —— 观察点：📅 日志、赴约/爽约叙事链。
> **目标**: 让"明天中午在咖啡馆见"从一句台词变成世界里真实存在的约定，
> 产生赴约 / 爽约 / 记挂 / 道歉这类最像人的涌现叙事。
> **来源**: 工具充分性审计（STATUS.md 第 8 条）确认的三个系统级缺口中优先级最高的一个。

## 0. 设计原则

- **约定是世界状态，不是对话内容**：说定了就记录，时间到了就结算，谁没来世界都知道
- **不做接受/拒绝状态机**：A 发起即成立，B 不想去可以不去——爽约本身就是活人行为
- **结算产生叙事钩子**：被放鸽子的人有情绪和记忆，爽约的人有愧疚 intent（驱动道歉行为涌现）

## 1. 数据模型（world/types.ts + World 存储）

```ts
interface Appointment {
  id: string;
  proposerId: string;
  targetId: string;
  locationId: string;      // 公共地点（不允许约在别人家）
  atTick: number;          // 约定时间
  activity?: string;       // 约好做什么
  status: "pending" | "kept" | "missed";
  createdTick: number;
}
```

World 持有 `_appointments: Appointment[]`：
- `addAppointment()` — 同一对角色只保留最新 pending（新约替换旧约）；每人最多 3 个 pending
- `getUpcomingAppointments(charId, tick)` — prompt 注入用
- `getDueAppointments(tick)` / `markAppointment(id, status)` — 结算用

## 2. 创建路径：arrange_meet 工具（tool-builder）

- 浮现条件：附近有人（同 talk）
- 参数：target / location / when / activity(可选)
- when 用确定性解析器（world/appointments.ts `parseAppointmentTime`）：
  支持 "今天18:00" / "明天12:00" / 模糊词（早上8/上午10/中午12/下午15/傍晚18/晚上20）；
  已过的时间自动滚到明天；解析失败 → 失败 + hint（retry 自纠）
- handler 返回 `_appointment` 后门字段（同 `_buyItem` 模式），executeAction 落库 +
  effects 里带 inbox_message 通知对方（对方经 persistInboxContext 自动入记忆）

## 3. 提醒注入（prompt-builder「你心里挂着的事」段）

按临近程度分级：
- 远（>2 小时）："你和X约了明天中午在咖啡馆见面"
- 近（≤2 小时）："快到时间了，从这里过去要留点时间"
- 到点未到场："就是现在——你该在咖啡馆了，X可能在等你"

## 4. 结算（simulation.runOneTick 每 tick）

宽限窗 = atTick 起 2 tick（30 分钟）：
- 窗口内双方同时在场 → **kept**：双方记忆(7) + happy moodlet + 关系 +3
- 窗口过后：在场者 = 等的人，缺席者 = 爽约者
  - 等的人：记忆"你在Y等X，对方一直没来"(8) + sad moodlet + 关系 −5 +
    recover intent"被放了鸽子这事挂在心上"
  - 爽约者：记忆"你想起来和X约了见面，结果你没去"(8) +
    recover intent"你爽约了，心里过意不去"（道歉行为的涌现钩子）
  - 双方都没到 → 双向爽约扯平：轻记忆(5)，无关系变化

已知简化（v1 接受）：结算时刻才看谁在场，"等了一会儿先走了"会被判为没来。

## 5. 不做的事（v1）

- 不做接受/拒绝协商状态机（不想去就不去，爽约即表态）
- 不做持久化（同 currentIntent/wantToDiscuss 的瞬态惯例；存档丢约定可接受，后续跟
  save-load 一起补）
- 不做重复/周期约定

## 6. 成功标准

- 单元测试覆盖：时间解析、存储去重、kept/missed/双缺席三种结算、工具浮现与落库、prompt 注入
- live 半天模拟：观察 arrange_meet 是否被自然使用、赴约行为是否出现
- 现有测试全部通过
