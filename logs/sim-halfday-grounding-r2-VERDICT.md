# VERDICT — M2 正典裁决 live 首演 + 重复衰减复验（2026-08-16 r2）

> 材料：`sim-halfday-grounding-r2-console.log`（36 tick，7 角色，deepseek-chat，PROMPT_DUMP 取证）。
> 325 调用 / **¥1.31**（余额 6.52→5.21）。测试 PASS、EXIT=0、零崩溃。

## 总判决：M2 管线 PASS · 重复衰减 v1 证伪（冷却闸 v2 当日落地）

### M2 懒实体化正典裁决（首演，PASS）

- **成本纪律极好**：全场 350 调用里 fact-extract 只烧 2 次——预过滤（≥4 句 + 词面命中已知器物）
  的选择性符合设计
- **管线端到端活**：L↔light 聊台账/书架/阅览桌 → 进入抽取 → light 复述书架分区细节 →
  裁决 rumor 挂账（📜 传闻死胡同路径）；战场原↔真嗣聊展示柜 → LLM 判 no_claim 正确拒绝
  （防线默认项在岗）
- 观察项（M2.5 候选，不阻塞）：light 那条 rumor 实为 authored 正典的语义变体复述——
  substring 去重接不住措辞变化，语义级"复述正典"判定（restate verdict）留后续
- canonized/verified/false/contradict 四路本轮 live 无样本（单测已锁形状），等长跑

### 重复衰减 v1：证伪（r1 修复无效）

examine 总量 56（r1: 51）**不降反升**：战场原→货架 ×12、L→书架 ×7。短反馈杀掉了内容奖励，
杀不掉行为——examine 是**永远成功的廉价动作**，打算里挂着"盘货"就一直选它。
**v2 = 冷却闸（当日落地，967 单测）**：`EXAMINE_COOLDOWN_TICKS=8` 窗内对未变化器物复查
→ 执行期拒绝 +"手头该做的事还等着"指路反馈——把重复从"完成的动作"变成"被弹回的信号"；
变化过的器物随时可查（diff 通道邀请的正是这一查）。
**live 复验搭下次长跑**；看点=examine 占比回落 ~10-15%、✗ examine 重试不暴涨
（若暴涨=失败反馈通路烧调用，要换方案）。

### 底盘

- **缓存 73.3% 新高**（r1 67.1%）：decision 75.5% / morning-plan 74%（r1 为 0）——含 r1 同款
  前缀的服务端暖缓存红利，不能全记在功能头上；但至少证明器物层前缀在跨 run 尺度上稳定
- fact-extract 0% 命中=预期（每场对话唯一，prompt 小）

## 复验入口

```bash
ANIMA_PROMPT_DUMP=1 npx vitest run --config vitest.live.config.ts src/agent/sim-halfday.live.test.ts
```
