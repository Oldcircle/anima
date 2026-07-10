# VERDICT — POV 深翻 + 私有通道 v1 半日门禁（2026-07-10）

> 载体：`sim-halfday.live.test.ts`（default 7 角色，36 tick，06:00→15:00），真实 DeepSeek。
> 档位：`ANIMA_DECISION_POV=third` + `ANIMA_BREAK_LEVEL=strong`。450s，325+ 调用，217 行为，测试断言通过。
> 原始件：`logs/halfday-povdeep-20260710.console.log` + `logs/sim-halfday-20260710-181748.md`。
> 改动：①深翻——system prompt 顶块 third 档切作者/预测框架（`thirdPersonIdentityHead`），消除与决策层
> 作者视角的打架；②私有通道——决策输出契约加两层动机行`【表面】…｜【真心】…`，解析后真心层只走
> 观看者通道（`result.motive`→WS/🎭 日志），本人记忆只回流表面层（自欺不因回流坍塌）。

## 判决：PASS（放行 7 天联合复验）

| 指标 | 结果 | 对照 |
|------|------|------|
| 两层动机（真分层）| **129 条**（≈79% 决策）| 07-08 半翻实验：自欺标记 36% → 深翻后大幅上扬 |
| 动机行泄漏（台词/记忆/md）| **0** | 硬门槛 |
| 引擎失败（不存在工具）| **0** | 硬门槛 |
| 重试 / 只想不做救回 | 29 / 14 | 与 legacy 基线同族（31/12-16）|
| 约束失败 | 2/217（0.9%）| 基线 0.17-1% 区间内 |
| 缓存命中 | **63.8%** 且爬升中（decision 62.0%）| 基线 66.1%，无回归（深翻顶块静态）|
| 印象 valence | **负 8（-2×5,-1×3）: 正 3** | 下行通路在线，双向健康 |
| 对话/印象 | 64 场对话，14 条印象，质地在线 | 「像在背剧本」「逃都逃得笨拙」「用贬低试探但我没那么怕了」|

**两层动机质地（伤口驱动，非套路）**：shinji「表面：早点把准备工作做好｜真心：也许师傅会觉得我
还有点用——这样他就不会赶我走」；senjougahara「表面：按颜色排好花｜真心：只要手还在动，就不用去想
今天有没有人值得见」；lelouch「表面：确认安全状况｜真心：怕看到认出我的人」。

## 观察项（留给 7 天）

1. **79% 分层比例是否过度生产**——「与表面一致」豁免写进了契约，但模型可能偏好编第二层
   （旧「疑惑」槽位自激成谍战腔的教训）。7 天看比例走势 + 内容是否退化成模板。
2. 表面层回流记忆后，长程自我叙事是否稳定（角色会不会从别的通道"发现"自己的真心层）。
3. 与既定 5 条遗留观察项（金币曲线/约定产出/种菜链/忙到不吃饭/食物话题占比）同车。

## 7 天联合复验（已备好，等放行）

```bash
cd ~/Opensource/projects/ai/anima && nohup env ANIMA_DECISION_POV=third ANIMA_BREAK_LEVEL=strong \
  ANIMA_LIVE_TEST=1 npx vitest run --config vitest.sim.config.ts src/agent/seven-day.sim.test.ts \
  > logs/sim-7day-$(date +%Y%m%d)-console.log 2>&1 &
```

~672 tick / 2700+ 真 API 调用 / ~55 分钟 / DeepSeek 数元级。vitest 侧超时无忧（it() 自带 3600s，
覆盖 config 的 900s）；教训：必须 nohup 脱管（07-07 那次被后台超时杀掉丢了终局名册）。
统计口径：`grep -c 🎭` / 决策数 = 分层比例；负 valence 分布；5 条遗留观察项各自的 emoji 日志。
