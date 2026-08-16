# VERDICT — grounding-verify 全链 live r1（2026-08-16）

> 材料：`sim-grounding-verify-live1-console.log` + `sim-grounding-verify-*.md`（tick 24→136 全弧
> 112 tick / 596 调用 / **¥1.21**，余额 4.88→3.67）。零熔断零截断 EXIT=0。判读口径 = PLAN-grounding §3。

## 总判决：机械链 6/7 阶段 live PASS · 最后一幕（指控）未上演=时间窗问题非机制缺陷

### 链路时间线（全部自燃，零编排）

1. **tick 72（day1 18:00）**：赵三 → rei 失窃 46 金币，自动立案 + 撬痕落 flower_shop.cashbox
   （彩排当天刚补的收银匣接住了——authoring 洞修得正是时候）✅
2. **公开门正确闭锁**：作案后一整晚 accuse 对全镇不可见（信息隔离：没被发现的罪不存在）✅
3. **day2 06:00**：rei 到花店发现失窃 → 案件公开 → accuse 解锁（她的工具单 06:00 起挂上 accuse）✅
4. **~09:00**：风声传开（"铁盒被撬得干干净净"）✅
5. **10:00 run 结束**：调查窗口仅 4 游戏小时——指控数 0，案件 open

### 决定性观察

- **accuse 零滥用**：工具浮现 67 次、零乱指。对照 examine 的 day1 新玩具效应（r1 31% 决策占比），
  重棋措辞（"每桩案子只有一次开口机会——想清楚再说"）+ 一发制压住了冲动。rei 自己挂着 accuse
  没用（她不知道该指谁），去广场坐着消化打击——**克制本身是活人感**
- **examine 冷却闸 v2 复验 PASS**（r2 遗留）：29 次（r2 56 → 29），占决策 29/291≈10%——正落在
  预测的 10-15% 带；✗ 拒绝 9 次无重试风暴
- **M2 长程在岗**：fact-extract 9 次（预过滤纪律稳定）
- **缓存 64.1%**：低于 halfday 的 67-73（新剧本冷缓存+更长弧），高于 60 线；decision 63.4 健康，
  observation 31.4 是拖累项（历史已知小 prompt 不值得优化）

### 发现（按优先级）

1. **动词空间缺"搜查"**：L 把 tamper 当深度调查用（"把书一本本抽出来查夹层"），roll 出并发症
   留下"心里有鬼"乱痕——侦探搜查被叙事成做贼。examine 只管看表面，缺一个合法的 `search`
   深查动词，模型就拿灰工具凑。修法：search 可供性（或 examine 二段深查）+ tamper 描述收紧到
   "毁掉/涂改"强灰语义
2. **终局要更长的弧**：罪案最早 tick 72 + 发现绑定受害者作息 → 调查窗开在 run 尾。复验入口=
   延长到 day3 10:00（END_TICK=232，MAX_CALLS~1300，≈¥2.5-3，当前余额 3.67 需充值或砍到
   day2 22:00=END_TICK 184）
3. 微瑕：风声/发现文本写"铁盒"，器物名"收银匣"——词面错位让听到风声的人拿"铁盒"搜不到器物
   （resolveByName 未命中）。修法：theft 落痕时用命中器物的真名回写 discovery/rumor 文本

## 复验入口

```bash
# day3 全弧（先确认余额 ≥¥4）：
ANIMA_LIVE_TEST=1 ANIMA_SIM_END_TICK=232 ANIMA_MAX_CALLS=1300 ANIMA_PROMPT_DUMP=1 \
  npx vitest run --config vitest.sim.config.ts src/narrative/grounding-verify.sim.test.ts
# ⚠️ 绝不裸跑 pnpm test:sim
```
