# DESIGN — Agent 版复活调优 v3（评审后定稿）：压力图谱 + 第二幕机器 + 活人感质感

> 2026-08-02。用户指令：恢复 agent 版本并整体调优——必须有活人感、剧情能推进而非平淡日常；
> 可用图谱解法、剧情注入与 agent 结合。本文档 = 定稿实施规格（v1→4 视角对抗评审 36 findings→v3）。
> 证据底座：7 路深度体检（/tmp/anima-audit-full.txt）+ AUDIT-aliveness-20260704.md + r4 长跑转录 + 评审 findings（/tmp/anima-review1-findings.txt）。

## 0. 诊断结论（三个支点）

1. **点火不缺，缺记账**。三种点火通路实证活着（卡执念×seeds 自燃 / 纯涌现拆穿 / beat 机器）；死的是交锋之后的账：拆穿零代价退场、失窃一天蒸发、grudge 3 天自动清、argue 上菜 17 次被选 0 次。系统是均值回归设计。
2. **行为硬墙真实形状 = "对无够格之罪的具名者动手"**（KIRA_INJECT_CRIME 探针：真恶人 NPC+真罪 → light 首窗即动笔）。解法是供罪与世界落账，不是攻墙。**但注意**：探针只证明了"NPC 真凶+裁决者"链；cast 成员当真凶从未被证明——行为主权是红线。
3. **default 剧本是空壳**（无 seeds/beats/secrets），七卡戏剧资产睡在 prose 里。

## 1. A 件：戏剧压力图谱

新模块 `src/narrative/pressure-graph.ts`。确定性、零 LLM、每 tick 重算。

**边与来源**：friction/grudge（印象疙瘩+relationships grudge）、debt（含逾期天数）、promise（爽约累计）、secret（disclosedSecrets/knownFacts/visibleTo）、stance（B1 立场账）、bond（负 level 敌意）。

**前置子任务（评审实锤）**：
- **frictions 持久化**：impressions 表加 frictions 列，save/load 双向接通 + round-trip 单测（现状 saveImpression 丢弃该字段 database.ts:297-320——不修则读档后压力图塌 0）
- 爽约累计：resolveAppointments 结算分支回写 pair 计数（挂 narrative world 层 map）
- lastBeatTriggeredTick、valence/疙瘩近窗水位线**明确列入随档计数器**（挂 narrative_state；瞬态不入档陷阱前科：_nextFateAt/_starvingSince）
- **narrative_state 读档 normalize**：逐角色/逐 pair 回填缺失新字段默认值（旧档直灌会 NaN；replaceSnapshot narrative-state.ts:104 整体替换不补字段）；配旧档快照单测锁 NaN 回归

**三路输出**：
1. per-char pressure → `setPressure`（narrative-state.ts:136 现成）
2. 补 computeTensionIndex 两个恒 0 插座（tension.ts:36-37）→ tension 上限回 100；pacing 判据分档语义化
3. 压力对热点摘要 → 导演 worldSnapshot + BeatContext.extras

公式 v1（单测锁形状不锁数值；clamp 0-100；char = max(pairs)*0.7 + avg(top3)*0.3 + personal）：
`pair = 8*frictions + 25*grudge + 6*debtOverdueDays + 12*missedAppointments + 4*max(0,-level) + 18*activeOpenStances`
tension = 0.35*unresolved 项 + 0.45*top3 pair 均值 + 0.20*beat 干旱项；**stance 项只计近 3 天内有活动的**（防饱和失真）。

## 2. B 件：第二幕机器

### B1 立场落账（对话结束抽取管线第三兄弟）
- **witnesses 机械化**：talk 结算处把当刻同地点在场者写进 exchange（新 witnesses 字段）；公开性由引擎按 witnesses 计算，**抽取 LLM 不判公开性**（对话结束后 9+ tick 无法回溯在场者）
- **假阳性防线（全条采纳）**：①预过滤 AND（摊牌类词 且 本窗口负 valence≤-2）②schema 强制 no_stance 默认项 + evidence 字段须逐字命中转录（代码 substring 校验，不命中即丢）③严重度阶梯：break/threaten 必须有明示原话 ④每对每天 ≤1 条 ⑤break/threaten 需双边印象佐证
- **双向账本**：类型含敌对（expose/accuse/threaten/vow/break/side_with）**与和解（apologize/reconcile/clarify——命中即清对应 openStance）**；openStance TTL 7 游戏天无 refresh 自动降档归档
- 落账：unresolvedWith + openStance 边 + 双方 LTM imp8 + 有 witnesses 才进流言 + 疙瘩/怀疑计分 + 双方 obsession
- off 档不启用；坏 JSON 不落账不崩

### B1.5 阻尼器豁免（评审 blocker：账本必须顶得住均值回归）
- 有 activeOpenStance/未 settled 事件的对：**暂停 grudge 3 天自动清（simulation.ts:418-421）与 idleDecay（:425）**
- stance type∈{break,threaten}：取消疙瘩期负向减半（agent-loop.ts:690-695）
- 摊牌 beat 点火的对：本场对话闸临时抬升（MAX_CONVERSATION_TURNS 8→16、argue 豁免 Jaccard 重复拦截），场景结束恢复

### B2 导演硬事件原语
- **安全通路（评审 blocker）**：DirectorToolContext 扩 `enqueueMutation` 回调；硬事件 handler **只入队**（导演 fire-and-forget 后台任务，同步直写必竞态）；软写维持现状
- `inject_world_event` v1 菜单：`theft_with_perp`（**真凶只允许两种：npc 模式注入的 NPC，或锚定某 cast 成员真实执行过的 steal（即 B3 放大器路径）——世界绝不从 cast 挑真凶塞赃物**（二轮评审 blocker：那等于替 agent 写行为+伪造证据链诱导裁决者打击具名 cast，双重红线违反）。**延迟发现制**：真金转移+赃物入真凶背包（持久物证）+受害者"去取货款"intent→到场才落"铁盒空了"发现记忆；风声必须晚于 ≥1 个发现记忆；现场短时氛围才用 observableState）/ `accident_damage` / `letter_arrival`（必带实体信物品+cause；**须同步给真实边界块加剧本门控豁免行**——现状 system 写死"镇外之人不会出现也联系不上"，不豁免则信与物理法则打架）。**public_expose 撤下**——改为注意力供给（给知情者 high-urgency wantToDiscuss 让他在场真说出口，台词进 log 才算表面化；无人说出口却有目击记忆=穿帮）
- `surface_grudge`（催化 pressure≥阈值 的已有旧账）、`set_active_phase`（setActivePhase 工具封装）
- 配额：周池 2 次+每类冷却，**计数挂 narrative_state.world 随档**（导演内存态重启即失控）
- prompt 手术：心灵直写排序反转；pacing 分档（<25 播种 / 25-60 催化热点 / >60 收手看戏）；worldSnapshot 注入压力图摘要 + **recent-motive 环形缓冲**（内存 buffer 存近期真心层，只给导演；default-verify manifest 须声明 decision_pov: third 否则 motive 为空集）

### B3 罪行供给器（crime-supply.ts，manifest 门控 mode: cast|npc|off）
- `cast` = **放大器不是供罪器**：只监听 agent 自己真选过的灰行为（steal/赖账 2 天+/陪酒被目击），世界只补被发现链（物证/目击窗口/风声）。近 N 天无候选则空转。**从不替 cast 写行为、从不塞"你偷了"记忆**（r4 反证：shinji 面对无主案全天道歉螺旋——无辜人设背不动世界写的罪）
- `npc` = 够格之罪：静态 NPC + visibleTo 情报 + 风声（探针产品化）。**NPC 登记进 narrative_state.world 随档，读档时重建 addCharacter**（现状 save-load.ts:158-161 静默蒸发留悬空真凶）；NPC 对话不进抽取管线（无 _configs.card），设计接受
- 产 unresolvedEvent（带 status）

### B4 beat 引擎升级
- 实现 cooldown_after_trigger；beat-engine 记 lastTriggerTick（A 的干旱项数据源）
- BeatContext.extras：压力对/char pressure/kira 计数器/金币/约定/曝光计数/event status
- unresolvedEvent 增 `status: fresh|investigating|confronted|settled`（B1/B3/工具标签驱动；suspicion 边随 settled 过期）
- on_trigger 扩机械载荷：`new_phase`（应用之，koukou 审判线复活）+ `auto_events`（触发即世界落账，走 fate 包装+enqueue）
- **beat 表达式 lint**：加载时 compile+合成 context dry-run，fail loud（现状求值失败静默 false——写错=烧掉 live 预算）；每条出货 beat 配"构造应触发状态→必触发"单测

### B5 多日执念载体
`CharacterNarrativeState.obsessions: [{id, summary, createdDay, decayDays, source}]`。
登记：kira 应验、B1 立场双方、罪案受害/嫌疑、同对爽约≥2。消费：晨间打算输入 + 此刻区 1 行（≤2 条）+ 反思回顾。5 天衰减、settled 即清。只配注意力不写结果。

## 3. C 件：活人感质感

- C1 talk schema **v1 只补 intent/topic_tags/references_event**（tag-applier 链复活；静态 schema 不抖缓存）——**提前到第 1 步**。**reveals 缓做**：secretsPool 全库零生产者、prompt 无秘密 id 词表，补参数也只会让模型编 id（二轮评审）；等 D 件秘密管线（seeds→setSecretsPool→prompt id 词表）接通后再上
- C2 对话所求注入（此刻区 1 行）：**来源含正向/中性项**（bond 高→想分享/邀约、aspiration→请教/炫耀、临近约定→期待）；**敌对所求限额：每角色只对压力 top-1 对注入且 pair≥阈值**——其余对话保留无所求底噪（评审：全敌对来源=谍战腔制度化）
- C3 二级 prompt 人设加深（reflection/morning-plan/observation 补 speech.style+psychology）
- C4 疑惑槽节流（未解≥2 次才注回）+ 印象反"试探"措辞
- C5 群聊 v1【实验开关 ANIMA_GROUP_SCENE=1】：同地点时间线合并块**只允许追加在『## 你现在的状态』之后尾部此刻区**（评审：插对话记录前会砸对话桶 68.5% 命中）；"pendingInbox"实现=conversationRequest 构建时读 char.inbox 过滤注入；同地点近似=双方当前同地点+3 tick 窗（Tracker 无地点字段）；**配对话路径 cache-discipline 回归测试**（相邻两轮分歧点必须在对话记录之后）
- C6 独处 tick 轻量人格锚
- C7 开场白反模板 + 食物话题对冲

## 4. D 件：剧本包

- default 本体：seeds（asuka 被弃真相挪出卡文 visible_to 不含本人 / senjougahara 到期日 / lelouch 密文线 / shinji 父亲钩子）+ 4-6 状态反应型 beats（配 cooldown）+ 1-2 deadline 保底 + manifest（break_level: mild + decision_pov: third + crime_supply: cast）
- **default-verify 验收剧本（≠default 本体）**：seeds 预热 2 对负向关系+初始疙瘩+逾期债（borrowedTick 设过去制造逾期）+未了结立场；**预热标定在阈值下方**（种到 ~40、阈值 45——种满≥阈值会让 beat 首扫即火、变成假绿灯只验了表达式求值器；信号②要求点火时压力显著高于种子初值，增量须来自 run 内事件）；同对爽约类 beat 不入 halfday 验收（36 tick 死配置，下沉离线多日断言）；crime day1 强制投放走 **deadline beat 的 auto_events 机械注入**（不赌导演 LLM 选工具）；含一个 auto_seeds high-urgency 定向摊牌 beat（保证 B1 有账可记——halfday-story 实测半日自发立场=0）
- **seeds 扩展工作项（二轮评审 blocker，入 §6 步骤 5）**：applySeeds + scenario-loader 手工映射 + DSL 支持 frictions/debts/openStance 预热（现状只支持 activePhase/unresolvedEvents/characterRelationships/initialRumors，验收剧本按原稿搭不起来）
- kira：后续幕 beats（应验后/拆穿后）；light 卡与 seeds 正典矛盾只记录不动卡

## 4.5 二轮评审补丁（实施时同权重生效）

- **valence 近窗信号**：valence 是印象小调用瞬态值，应用后即丢——在 impression-updater 关系落地处加回调，把 (pair, valence, tick) 记入压力图内存环形缓冲（A 的 volatility 与 B1 预过滤的数据源）；声明为内存态短窗信号、重启归零可容忍
- **NPC 生存豁免**：crime-supply 注入 NPC 带 `isStatic` 标志——needs 衰减/07:00 upkeep/饿倒循环/随机事件抽选全部跳过（否则恶人 NPC 一天内饿倒瘫痪变全镇围观的可怜人）
- **爽约计数改派生**：_appointments 的 missed 记录全量保留且随档——压力图直接 filter status==='missed' 按 pair 分组计数，**不加新计数器**；双爽约（双方都没到）不计入
- **beatLastTrigger 随档**：cooldown 型 beat 需要 `beatLastTrigger: Record<beatId, tick>`（narrative world 层，随档）；cooldown 型不进 triggeredBeats 一次性集合；旧档 migrate 补默认
- **kira 计数器**：world.kira 声明瞬态不入档——B4 extras 暴露它时明示仅单次连续 sim 有效（v1 接受，不迁移）
- **新结构一律 Record 不用 Map**（JSON 序列化往返会把 Map 变 {}）；所有新字段读取处强制 ?? 默认值
- **C5 明确出验收基线**：实验开关默认关，活人感三信号在 C5=off 下测（回归面=当前唯一稳定的两两对话质量）

## 5. 红线（实施 agent 必读）

1. 缓存纪律：工具表/system prompt 只随角色×地点慢变；动态进 user prompt 尾部此刻区；prompt-cache-discipline.test.ts + 新增对话路径回归必须绿
2. off 档 = 治愈系 A/B 基线：B1/B1.5/B2/B3/B5、C2 压力注入全部 off 档关闭
3. 只造处境不写结果；**cast 成员行为主权不可侵犯**（世界代写行为仅限无 agent 的 NPC）
4. 运行期改世界走 enqueueMutation（导演工具经新回调入队）；抽取器 fire-and-forget 走 _trackBackgroundTask；跨日状态随档
5. seeds 结构变更必须动 scenario-loader 手工映射（visible_to 泄漏教训）
6. 不攻行为硬墙（不改 kira_strike 判定去"劝"模型）
7. 经济平衡基线不打破
8. 单测绿是底线；每件按 §8 形状清单配单测

## 6. 实施顺序（评审修订版）

1. **C1 + A**（A 顺手给 beat-engine 加 lastTriggerTick；含 frictions 持久化+normalize+计数器）
2. **B4 + 验收 harness**（scenario-aware halfday runner：scenario-loader+applySeeds+loadBeats+Director+crime_supply；SmartMock 升级后离线彩排全部信号）
3. **B2**（含 enqueueMutation 接线+motive 环形缓冲）
4. **B1 + B1.5**
5. **D**（default + default-verify + kira 后续幕；beat lint）
6. **C2/C4/C7**
7. **B3 + B5 + C3/C6**；C5 实验开关
8. 离线验证 + 对抗代码审查
9. live 验收 + VERDICT

**收缩序（预算/时间不足时）**：保 A、B4、B2 减配（theft+surface_grudge+set_active_phase+prompt 手术）、B1+B1.5、C1/C2/C4/C7、D 减配、验收 harness；砍 B3 整模块、B5、letter_arrival/accident_damage、C3/C6；C5 保持实验开关。被砍件标 deferred 不删除。

## 7. 验收口径（评审修订版）

**离线为主（多日现象全下沉 SmartMock）**：SmartMock 按 kind 分支返回合法 JSON（decision/conversation/impression/stance/director）+ 剧本化冲突脚本 + 导演 mock 首 invoke 必调硬事件 + 中途 save/load 往返断言新状态存活 + 3 天推进断言（stance 跨天在 prompt、cooldown beat 二次点火、grudge 豁免生效、pressure 曲线形状）。

**live（成本闸）**：模型锁 deepseek-chat（sim 测试路径，非 settings.json 的 v4-pro）；跑前查余额 ≥¥6 才起跑；sim 加调用数/token 硬顶接近即主动停跑保数据（杜绝第三次 402 死档）；跑 **1 次 2 天**（估 ¥4-6）于 default-verify，而非 2 次半日。
- 剧情推进：①立场落账≥1 且后续 prompt 可见 ②状态 beat 被涌现点火≥1 ③罪案投放后 N tick 内出现调查/指控跟进 ④**day2 专项：昨日之账在今日对话中被主动提及≥1 次**
- 活人感：①对话所求可见但寒暄底噪保留 ②"试探"占比降 ③交锋退出有代价（立场/疙瘩/风声任一落账）
- 底盘：缓存≥60%、零崩溃、经济不归零、off 档逐字节回归
- **声明边界**：7 天尺度主张（cooldown 循环供给、执念衰减、棘轮饱和）本轮离线验证，live 长跑待充值

## 8. 单测形状清单（每件锁什么）

- A：单边注入→pair 单调不减；clamp 0-100；char 公式形状；幂等；pressure 落 narrative_state 且 jexl 可读；计数器 save/load round-trip；tension 可达>40（杀 director.ts:518 永假回归）；注入只进此刻区（cache 绿）
- B1：<4 句/off 档不调用；坏 JSON 不落账；落账形状（unresolvedWith+openStance+双方 LTM imp8+有 witnesses 才流言）；同对话不重复；evidence substring 校验丢弃路径；和解清账
- B1.5：openStance 对不清 grudge/不 idleDecay；break/threaten 不减半；场景闸恢复
- B2：配额随档+拒绝路径；无 cause 拒绝；theft 金币守恒+赃物真入包+延迟发现；off 禁用；不直写关系/印象；set_active_phase 翻转+phase 工具上架；prompt 分档快照
- B4：cooldown 二次触发；extras 形状；status 只前向；new_phase 应用；auto_events 走 fate 包装；旧 beat 语义回归
- C1：schema 新参+cache 绿+reveals→disclosedSecrets 回归
- C2：≤1 行、位于分歧点后、off 关、敌对限额 top-1
- D：每条 beat 表达式 lint+应触发单测；seeds 映射回归
