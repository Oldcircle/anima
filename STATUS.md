# STATUS — 会话交接文档

> 每次有实质进展时更新。记录当前进度和下次继续的入口，不是日志。
> （旧 STATUS.md 因 gitignore 未入仓而丢失，本文件 2026-07-03 重建，开发文档已全部入仓）

## 当前状态（2026-07-08）

### 决策视角实验：第三人称作者预测解锁「自欺/两层动机」（工作树未提交）· 判决见 [logs/POV-experiment-20260708-VERDICT.md](./logs/POV-experiment-20260708-VERDICT.md)

用户假设：第一人称「成为角色」时对齐层跟角色打架（= 全员真善美的一个根），改第三人称「作者预测这个
具体的人真实会做什么、含不肯承认的动机」能松夹子 + 解锁自欺/潜台词（第一人称角色对自己全透明，写不出）。
`break-config.ts` 加正交开关 `ANIMA_DECISION_POV=first|third`（默认 first 逐字节回归，606 单测绿）。

**判决（A/B 半天 sim + POV 探针各 18tick，材料全归档）**：假设在**内心层成立、行为/valence 层平手**。
- 平手：负 valence 9(first) vs 7(third)、argue 兜底 1 vs 2——第三人称**没**制造更多下行，用 valence 判是错指标。
- **决定性**：显式「表面理由 vs 真实动机」两层结构 = **first 0 条 / third 21 条**；自欺标记 6%→36%；
  伤口浮现 1→7。实例：L「表面收集嫌疑人数据／真实是被鲁鲁修绕开话题、想找刺激重新激活思维」。
  表达层仍第一人称「我」（台词质地没退化，L↔鲁鲁修交锋照样精彩）→ 决策三/表达一两段式可行。
- **副发现**：system prompt 顶「你以第一人称完全成为角色」与决策层作者视角打架，只翻了一半（作者残留=0，
  仍用"我"写）。**下一步 = 深翻**：system prompt 顶也切作者/预测框架，跑 7 天联合复验看两层动机比例能否更稳，
  并把「真实动机」落成**私有通道**（七反转④双通道，观看者可见角色互不可见）——这才有产品价值。

### 七日联合复验已跑（部分完成）· 判决见 [logs/sim-7day-20260707-VERDICT.md](./logs/sim-7day-20260707-VERDICT.md)

### 七日联合复验已跑（部分完成）· 判决见 [logs/sim-7day-20260707-VERDICT.md](./logs/sim-7day-20260707-VERDICT.md)

2725 次调用跑到第 7 天（收尾前被后台超时杀掉，终局名册丢失；教训：**长跑必须 nohup 脱管**）。
压缩结论：**五批改动大面生效**——💱 幻觉闸 5/5 全对、饿倒/命运/翻垃圾都活了、valence 健康双向
（负36:正21，首现 -3）、缓存长程 70.8%、经济有贫富分化无归零无通胀。**抓到一个根因级缺口当日已修**：
argue 兜底 21 次 nudge 时 argue 全不在菜单（浮现门不认疙瘩），挑明 intent 现在强制上菜（606 单测绿）。
遗留观察项 5 条（金币精确曲线/约定产出坍缩/种菜动机链/忙到不吃饭/食物话题占比）在判决文件里。
**下一步：工作树全量提交**（五批改动 + 判决归档），观察项等下次跑长程时带探针验。

### 打磨批次：经济通缩 + 约定宽窗 + argue 机械兜底（2026-07-07，工作树未提交）

把 7 天基线暴露、一直挂在下次入口的四件事一次做完（**564 单测全绿 + stress-sim + 缓存纪律回归通过**）：

1. **经济通缩调参（食物单一栽培的机制根）**：主根是 **prepare（全镇最高频工作，7 天 205 次）收入为 0**
   ——员工整天补货架颗粒无收（战场原 65 次 prepare 周入 0）。现在 prepare 计件 +3/次（货架满 ≥8 不给，
   防原地刷钱，`prepare-income.test.ts` 3 测锁定）；worker_tools 收入 ~×3（serve 3→8 / bake 2→6 /
   make_coffee 2→6 / 图书馆 1→4、2→6 / 花店 1→5，杂务 knead/clean_table 0→2）；开销微降
   （BASE_UPKEEP 12→10、累进 0.35→0.30）。按 7 天真实工作频率验算：勤快角色日入 26-35 vs 全开销 ~25
   （含正经吃 2-3 餐），有小盈余买得起礼物（30 金花束 ≈ 3 天盈余）→ 打开非食物关系轴；懒散角色（L/月
   周工作 13-14 次）仍有压力但多干几单就翻身——压力有牙齿、不再全员赤贫
2. **约定结算宽窗（真守信率被低估的修复）**：新增提前兑现（到点前 4 tick 双方在约定地点**且聊上了**→kept，
   对话是硬证据防同事同店误判）+ 换地点兑现（到点双方同在别处且聊着→kept）。措辞区分三路径，
   `simulation.test.ts` +3 测
3. **argue 机械兜底（下行通路最后一环，原计划 7 天复验后加，提前落地随车验证）**：疙瘩攒满 3 条
   （或 2 条且关系 ≤−10）+ 同地点 + 无在身 intent + 无 grudge → 注入"把话挑明" recover intent
   （expiresAt+6，同对冷却 48 tick）。**只配时机与注意力不写结果**——吵不吵仍归角色。off 档不启用保
   A/B 基线；`⚡ [argue-fallback]` 日志可归因（7 天复验时数它 vs 自发 argue）。`confront-fallback.test.ts` 6 测
4. **小修**：方糖（咖啡馆 2 金）+ 水果糖（杂货店 3 金）进物品表——L 嗜糖人设落地（曾因物品表没糖重试失败）；
   绫波丽卡加"同样的话不说第二遍，用沉默/动作代替"（人设内反复读）

**第二批（同日，「让世界有牙齿」· AUDIT deep work §5.5 部分兑现，564→576 单测）**：

5. **饿倒机制（needs 归零后果补完）**：hunger ≤2 持续 8 tick → 当场倒下 6 tick 叫不醒（对称力竭昏睡，
   互不覆盖）；结束勉强缓过来（+15 hunger 灌了点水不是吃饱）+ 虚弱 moodlet + "必须马上弄吃的" intent
   （beg/steal/cook 供给都在，绝境有出口）；公共场合被目击进他人记忆。7 天基线终局全员 hunger=0 却
   谈笑风生的日子结束了——挨饿咬人，饭钱才有分量（与经济调参配套）。`starvation-collapse.test.ts` 5 测
6. **命运事件层 v1（`src/world/fate-events.ts`）**：随机事件管流浪猫级微扰，这层管**每 3-7 天一件、
   有真实状态后果的意外**——口袋破洞丢 40% 金币 / 店里失手赔钱（被目击）/ 雨雪着凉（-20 energy+想回家）/
   捡到无主钱袋（低权重横财）。importance 8 + moodlet + intent 占据注意力；**只造处境不写结果**，
   怎么应对归角色；白天落地夜里顺延；off 档不启用。`fate-events.test.ts` 7 测
7. **大件上架**：吉他 80 / 相机 50 进杂货店（enables practice_music/photograph 早就在）——新经济的
   盈余第一次有储蓄目标，"为什么要工作"多一个答案

**第三批（同日，「人↔世界交互 + 压力违背底线」· 用户点名方向，576→589 单测）**：

8. **菜园系统（世界第一次能被角色持久改造）**：杂货店买蔬菜种子（4金）→ 农田 `plant_crop` →
   跨日生长 2 游戏天（`garden_json` 新列随档，读档后还长在地里）→ `tend_crop` 照看提前 8 tick →
   `harvest_crop` 收 4 份新鲜蔬菜（能吃能送能卖）。菜地状态注入环境快照（"还要X小时熟"），
   工具按地块状态浮现（农田低频到访，前缀抖动可接受）
9. **绝境阶梯（压力把人往底线外推，每档有尊严代价）**：浮现门槛从 `gold===0`（AUDIT：现行经济不可达）
   改为 **financeBand 撑不过两天**。梯度：乞讨 → 找人借钱 → 翻垃圾找吃的（饿<30，hygiene/自尊代价）→
   卖血（**18+ 硬闸**，+30金，虚弱 moodlet 兼 3 天冷却，气色差卫生所拒收）→ 偷（饿<20 且赤贫）→
   **陪酒**（**18+ 硬闸** + 酒吧 + 晚间 + 破线档，30-45金，最重尊严代价+被目击传闲话）。
   off 档治愈小镇没有陪酒这条路；14 岁角色（rei/shinji/asuka）任何情况看不到卖血/陪酒
10. **sell 工具（物品↔金币闭环）**：杂货店半价回收随身物品——吉他/相机不再是死钱、收的菜能换钱、
    绝境时"卖掉心爱的东西"成为真实选项；keepsake（贝壳/照片）店主不收，念想天然保护
11. **borrow_money（社交债务）**：向在场者开口借钱（10-30），答不答应看交情（level≥25）+ 对方手头
    （余钱≥2倍）；借到→双向转账+欠账进**双方 LTM**（"你欠着XX的钱"活得比 48 小时长）；
    被拒→难堪 moodlet + 对方"没借，过意不去"记忆。人情账比金币账重

**第四批（同日，「现实闭环：今天种的因、过几天结的果」，589→597 单测）**：

12. **债务闭环**：欠账升格为世界状态（`debts_json` 随档，同债主累加）——借钱不再只是一句话。
    欠账挂环境快照（"这账一直压在心上"）；债主在场且钱够 → `repay_debt` 浮现（还钱销账+交情+3+
    双方 LTM"这人守信"）；**欠满 2 天撞见欠债人 → 债主起讨债念头**（每天最多催一次，只给念头不写台词，
    拖着不还自然走到疙瘩→argue 兜底那条线）。`💰` 日志
13. **店铺拉黑（偷店的余波）**：偷店被抓 → 该店 3 天拒绝服务（`location.bans` 随档，buy/eat 执行期
    "店主黑着脸把你请出去"），每天 06:00 到期解禁。小镇没有白偷的东西
14. **生病要治**：着凉 moodlet 存续期**每 tick 额外掉 1 精力**（拖着会垮）；感冒药进杂货店（12金）；
    有药且病着 → `take_medicine` 浮现（吃药清病耗药）。生病第一次有了"治不治"的经济决策
15. **食物腐坏**：鲜货有保质期（`ItemDef.perishTicks`：鲜鱼/便当/三明治/蛋糕/家常饭 1 天、面包 2 天、
    自种蔬菜 3 天），每天 06:00 清馊货+留记忆（"早知道趁新鲜吃掉"）。囤不了，得吃新鲜的——
    与菜园/prepare 产出闭环互相咬合

**第五批（同日，「幻觉修复」· 用户报告 AI 常说没发生过的事，597→604 单测）**：

实锤根因（7 天日志"牛奶债案"全链可追溯）：D1 对话里口头"给"了一盒**世界里不存在的牛奶**（无 give
调用、无 milk 物品）→ D2 讨"牛奶钱 4 金币"并口头"结算"（无金币转移机制运行）→ 印象观察层生成
"她接过金币时手指碰到我的手"目击 → 各层把虚构固化成"事实"，机制账本与叙事账本永久分叉。四道闸：

16. **口头交易落账（收编而不是禁止，`transaction-extract` 调用）**：对话结束时抽取"当场交割"的
    钱/物并机械结算——金币以身上的钱为限（空头支票账本不认，`💱` 日志）；物品须注册表存在且给的人
    真持有（"牛奶"落不了账）；对话窗口内已有真实 give/还钱则不重复结算（`_pairTransferTick` 去重）。
    预过滤（交割关键词）控成本
17. **give 支持给金币**：机制空洞补上——此前世界里没有任何"给钱"的合法路径（give 只能给物品），
    还牛奶钱在机制上无路可走，模型只能口头演。现在 give(gold) 真转账 + 对方 inbox 有感知
18. **真实边界块进 system prompt（全模式，含对话模式首句）**：记忆里没有的往事=没发生过、别顺着
    对方编造的往事接话；嘴上说"给你"≠给了、身上没有的东西给不出去；**过去认识的人不在镇上也联系
    不上**（外界实体保留为心结，但不会"出现"）。印象更新器+观察推理各加接地线（对话里提到≠亲眼
    见到交割）
19. **晨间打算可供性锚**：prompt 注入镇上真实地点/居民清单 +"打算只安排真实存在的地点和人"
    （AUDIT 实锤：曾打算过 C.C./地下室/证件系统等不存在实体，然后指挥一整天）

**半日 live 实测（strong，36 tick，375+ 调用，319s，sim 断言全过，604→605 单测）**：
- **经济质变**：半日终局全员金币 41-129（rei 129 还在涨）vs 旧基线滑向全员归零——调参生效且未通胀
- **缓存 67.2%**（vs 基线 66.1%，无回归）；负 valence 10 次 vs 正 2（下行通路持续在线）；零崩溃
- **💱 闸真的接住了幻觉**：牛奶债模式当场重演（真嗣口头卖明日香三个可颂、口头收钱，明日香后续
  真以为自己有可颂，3 次 eat 失败）——抽取器抓到但没落成账，暴露 3 缺口**当日已修**：
  ①物品名数量注释解析（`sanitizeItemName`："可颂（三个）"→可颂×3）②**柜台代买结算路径**
  （店员卖自家货架 → 按 buy 语义：买家付钱+扣库存+进背包）③eat 幻觉食物降级（11 次"速食咖喱包/
  冰箱里的东西"类失败 → 带着吃的就吃带着的，没有就明确指路）④晨间打算首日防编"昨天"
  （D1 曾编"昨天那批可颂发酵不够"）
- 饿倒/命运事件/讨债/argue 兜底本次 0 触发=时间尺度预期内（各需 2+ 天/欠账/疙瘩积累），留 7 天验

**下次入口 = 7 天联合复验，材料已全部齐车**：破线 strong + 缓存手术 + valence 常量 + 经济调参 +
argue 兜底 + 约定宽窗 + 饿倒 + 命运事件层 + 菜园 + 绝境阶梯 + sell/borrow + 债务/拉黑/生病/腐坏
四闭环 + 幻觉四道闸，一次 `ANIMA_BREAK_LEVEL=strong pnpm test:sim`（seven-day，~55 分钟真 API）全验。看点：
①金币轨迹（不再全员归零、也不通胀失控）②食物话题占比降没降（849 关键词基线）③argue/grudge 终于
>0 没有（区分 `⚡ [argue-fallback]` 催化 vs 自发）④约定 kept 率上修⑤饿倒/命运事件/绝境行为/讨债还钱
的叙事跟进（🥀/🎲/🤝/💰/🦠 日志）⑥有没有人种菜、菜有没有被收⑦缓存命中率长程稳定。通过后工作树一起提交。
**候选下一批**：声誉系统（绝境行为被目击→镇上名声→别人对你的初始态度，动 prompt 面大单独立项）；
七卡 secrets 落地；群聊（工程最重）。

### 提示词缓存手术：前缀静态化（2026-07-06，工作树未提交 · 按官方"Prompt caching is everything"原则）

实测 DeepSeek 自动前缀缓存命中率仅 ~2%，根因**不是** user prompt 里的时间戳，而是**工具表每 tick 抖动**
（go_to 描述内嵌各地点人物分布/打烊、talk 内嵌 social 提示与在场名单、buy 内嵌可负担过滤、集合本身随
营业/金币/库存/情绪增删）——工具渲染在 prompt 最前部，前缀从第 0 字节即断。手术原则一句话：**静态在前，
动态殿后**。

- **工具静态化（tool-builder.ts）**：集合只随「角色×地点」变化；描述全部去状态化；营业/金币/库存/需求
  阈值门槛下沉为**执行期校验 + 自然语言失败反馈**（交 tool-feedback 纠偏）。argue/beg/steal/物品工具保留
  低频条件浮现。新增 `buildEnvironmentSnapshot()`：挪出的动态可供性（各地点谁在/营业、店内现价库存）
  作为"## 镇上与店里的现况"注入 user prompt 末尾——即 Claude Code 的 system-reminder 模式
- **user prompt 动静分层（prompt-builder.ts）**：习惯/今日打算/季节/场景氛围前置成稳定区；时间行起进
  "此刻区"。对话模式（conversation-mode.ts）把时间/身体状态从 append-only 对话记录**前**挪到**后**，
  对话内前缀逐轮累积命中
- **观测（openai-compatible.ts）**：命中率按 kind 分桶（decision/conversation/reflection/...，LLMRequest
  新增 kind/tag）；`ANIMA_PROMPT_DUMP=1` 把请求体落盘 `logs/prompt-dumps/` 供相邻请求 diff
- **验证**：552 单测全绿；新增**永久回归测试 [prompt-cache-discipline.test.ts](./src/agent/prompt-cache-discipline.test.ts)**
  ——相邻 tick 请求 tools+system 必须逐字节一致、user prompt 分歧点必须在时间行之后（防止动态内容回流前缀）。
  自检实测：需求衰减+他人移动下 tools 2874 字符 + system 2651 字符零抖动
- **记忆注入顺序**：核实 rerankRecentForPrompt 已按 tick 正序还原（short-term.ts:98），无需改动
- 残余抖动（已知可接受）：地点迁移（天然断点）、argue 情绪窗、极端工具浮现、item 获得

**live 半天 sim 实测（36 tick 真 DeepSeek，325 次调用，sim 断言全过）**：总命中 **2.1% → 64.3%**（且随缓存
变热持续爬升），decision 62.8% / conversation 70.7% / morning-plan 57.3%；impression 10.6% / observation 0%
（小 prompt + 每对唯一，token 占比小，不值得优化）。输入侧成本约降一半（命中按 ~0.1 倍计费）。
行为面：打烊拒绝 0 次；执行期需求门槛拒绝 13 次（≈7% 决策，自然反馈兜底）；"只想不做"救回 12 次（与旧
~8% 基线相当）——无恶化信号。

**Tier1 追加（同日）——静态指令尾上移**：决策自检链/trait reminder/叙事记录从 user prompt 尾部上移至
system prompt（`buildSystemPrompt` 新增 `decisionDirective: social|solo` 变体，DeepSeek 多前缀共存所以
翻转免费）；对话模式"你要做什么"模板前移到 append-only 对话记录之前（partner 固定=对话内稳定）；impression
的 system 去掉 target 名与 valenceScope（评分范围下沉 user prompt）。破线文本逐字保留只改位置。
strong 档半日 sim 复验（326s，352 调用）：**缓存** impression 10.6%→51.7%（大头），decision 64.1%，
总体 66.1%；**活人感无退化且更好**——负 valence 10 次（含首见 -3×2）+ 有理由正分 4 次 vs 基线负 7 正 1
（双向流动更健康），印象棱角在线（「软骨头（但今天稍微硬了0.5毫米）」「绝缘体」「步步紧逼」），行为
218/跳过 50/对话 75/印象 18 全部持平或优于基线，约束失败 1、救回 16≈9% 与基线相当。注：自检合规看散文
内化不看编号标记（前后两版模型都不写编号——标记计数是假指标，已踩过一次）。

**下次入口**：① 行为质量对照放进既定的 **7 天联合复验**一起跑（与破线/经济调参同车，看执行期拒绝率长程
是否稳定）；② 长期方向：per-角色 append-only 滚动会话 + 定期 compaction（Claude Code 完整架构，另开设计，
天花板 85%+）；③ 提交：本次改动与破线重构同在工作树未提交，等联合复验通过一起合

### 破线提示词重构：下行通道解锁（2026-07-05，工作树未提交 · 参考酒馆 TGbreak 预设写法）

用户反馈"AI 只有真善美、像过家家"→ 参考酒馆破限预设 [TGbreak-v3.1.1](./reference/tavern-presets/TGbreak-v3.1.1.json)（122 模块，
已归档到 `reference/tavern-presets/`）的**写法**重构提示词。核心洞察：7 天基线证明既有 prompt 全是"许可式"
（"你可以生气"），而 DeepSeek 对齐层下"可以"= "从不"——必须把负面从**许可**升级为**强制自检**（移植预设
`基础思维/反省/npchs "至少N条"` 的写法），而非再堆许可散文。

**新增 [src/agent/break-config.ts](./src/agent/break-config.ts)——所有破线文本集中一处，三档 `off`/`mild`/`strong`（默认 mild）**：
- 读取优先级：scenario manifest `break_level` > env `ANIMA_BREAK_LEVEL` > 默认 mild。**`off` 档实测逐字节回归旧行为**
  （零 marker，A/B 基线可信，供"就想要治愈系"的用户）。cli 启动打印当前档
- **核心：强制 COT 自检脚手架**（decisionDirective）——决策前从"自由发挥想法"重构成预设式强制自检链：
  `①态度(在场每人我什么态度,允许差) → ②旧账(没消的气/被亏待/说好没做到) → ③这一手(真实语气,别默认热络) → ④走向(允许变差)`。
  对话模式有紧凑孪生版（conversationSelfCheck）
- **P0 单点最高杠杆**：`buildTraitReminder` 不再对"好人"返回 undefined——7 天基线里从不 argue 的正是这批
  没 darkTrait、拿不到任何摩擦提醒的角色。现在全员社交 tick 都拿到"普通人负面许可"锚
- **P1 印象通胀根**：态度评分改**强制自检**（"打分前必答:有没有膈应我的点"）+ 低门槛负分 + 高门槛正分（+1 必须
  有具体理由）+ strong 反安全零锚；新增 **`疙瘩` 累积字段**（impressions.ts，对称于 unresolved 最多3条，
  让"第三次放我鸽子"能攒成弧线，纯叙事不碰关系数值）
- **P4 argue 门**：关系摩擦（rival/grudge/bond/level<0）也能让 argue 浮现，破"必须先吵才能吵"鸡生蛋
- 移植 `✔️禁八股-黑名单`（antiClicheBlock，"违反即无效"点名封杀正能量套话）+ `💞活人感` roll点变异
  （livePersonVariance，strong）+ 创作框架"关系可越处越僵和越处越好同等真实" + describeRelationshipFeel 暖档摩擦分支
  + P7 observation 判断许可

**验证**：build 0 error + **551 单测全绿**（默认 mild）。**live 半天 sim @ strong（36 tick，真 DeepSeek，258s）实测质变**
（`scratchpad/halfday-strong.log`）：
- **态度从不出负 = 已修**：负 valence **7 次**（asuka↔shinji −1×2 / L↔light −2×2 / rei↔shinji −2 / lelouch↔shinji −1 /
  senjou↔shinji −1）vs 正 1 次——对比 7 天基线 Σ负=0/672tick
- **印象不再真善美**：「试探者」「黏人虫」「嘴硬心软」「编织一张无形的网」等有棱角、暧昧、在人设内的印象
- **无过度矫正**：L vs Light（死亡笔记宿敌）互给 −2 完全在人设内，明日香→真嗣「勉强算个进步」保留别扭的暖；
  小镇正常运转、needs 健康、零崩溃
- **argue/grudge 仍 = 0**：halfday 时间尺度内预期如此（关系还在形成，argue 需累积摩擦）。**根（负 valence）已流动**，
  argue 是下游——门已开（P4），需 7 天尺度确认是否触发

**下次入口**：
1. **7 天联合复验**（STATUS 纪律：valence 常量 + 经济调参 + 本次提示词改动必须在同一次 7 天 sim 里一起验，别单烧多次 55 分钟）。
   跑 `ANIMA_BREAK_LEVEL=strong pnpm test:sim` seven-day，看：①负 valence 占比是否健康双峰（非单侧负峰=过度矫正）
   ②argue/grudge 是否终于触发③小镇是否仍运转。~~若 argue 仍=0→加机械兜底~~ ✅ **兜底已提前落地（2026-07-07 顶部批次）**，随车验证
2. ~~经济通缩调参~~ ✅ **已落地（2026-07-07 顶部批次）**，与第1项一起验
3. 默认档位决策：当前默认 `mild`（更克制），跑 7 天看 mild 够不够"真"，不够就把默认提到 strong 或给 cozy 剧本单独标 mild
4. 提交：工作树含 break-config.ts + reference/ + 8 文件改动，未提交，等 7 天复验通过再合

### 日式 RPG 前端补全 + 7 天长线基线（2026-07-05，`fix/aliveness-emergence` +2 commits，已合 main）

**前端（`bab5428`）——补齐「看不到历史/内心」「瞬移不走路」「场景内不动」三缺口，全是消费后端已下发、
此前被前端丢弃的数据，零后端改动。经 4 维 17-agent 对抗评审，12 条确认级发现全修，离线 + live 探针双验。**
- **生活记录面板**（`godot/ui/ActivityLog.gd`，L 键 / 记录按钮）：滚动、带头像、按类型上色的
  对话/内心/行为/反思/流言/事件/beat 时间线。此前 `_on_tick` 只渲染 events，把 **reflections（睡前反思=最核心内心活动）/gossips/randomEvents 全静默丢弃**——现在都进记录
- **走路取代瞬移**：室内区在地图断裂的另一片区域 → 跨空间用「走到门→淡出→另一侧门口现身→走进」过渡
  （`CharacterView.run_move_plan` + `Main._transition_plan`，按「当前所在空间≠目标空间」判分支防中途改目的地遗留错位后穿墙）；同镇内寻路走
- **场景内自动闲逛**：idle 时站点附近小幅溜达（睡/力竭昏睡/对话/过渡中不逛；沿直线段采样避障）
- **JRPG 气泡**：台词加向下小尾巴、想法加云朵点、居中头顶
- live 探针实证（真后端 D1 06→09）：角色在镇内移动、走进 cafe/bakery（建筑头顶徽章亮）、真台词进底部对话框、想法气泡渲染——**不再瞬移**
- 验证 flag：`godot --path godot -- --shot [--log] [--wide] [--room <id>]`（离线）/ `--probe`（连真后端 3 分钟）

**7 天长线基线（`2ae4521` + `logs/sim-7day-20260705-140422.md`）——修复了 stale 死断言（阵容 5→7）让它第一次真跑，
SimReporter 增测三信号。5-agent 分析 workflow 已源码交叉核验，结论：**
- **约定**：创建 9 / 兑现 5 / 爽约 3（63%）/ 1 未结。**功能健康、叙事跟进优秀**（道歉+反思+印象三层留痕）。
  **但结算判「到场 slot」非「承诺兑现」**——3 次爽约有 2 次其实提前/换时段履行了被误标 → 真守信率更高（backlog）
- **积怨-和解弧线 = 0**：**7 天零 argue、零 grudge**。不是没张力——转录里满是真实摩擦（夜神月被白等 3 小时「极度不爽」、
  明日香便当四小时对峙「肯定是故意的」），但**从不转成机械 grudge 或负向 tick**。回路「和好」下半环不可达，因「闹掰」上半环从不注册
- **valence 正向通胀 = 确认为真（温和棘轮）**：Σ水位 0→587 单调、**负向和 7 天全 = 0**、日跳变全正。根因源码核验：
  **talk +1 双击**（`simulation.ts:549` 主轮 + `:839` 反应轮）× 675 次对话 vs 零对冲（0 argue/grudge/gift + **无任何 level 时间衰减**，
  `relationships.ts` 唯一时间机制是 grudge 解冻=正向）→ 关系只能涨。审查标记的风险坐实
- **总体活人感**：底子在（行为分布健康无单一 >40%、约束失败 0.17%、印象双向不对称累积、关系分层 stranger→best_friend 95），
  两红旗：①**食物单一栽培**（849 食物关键词，几乎每段关系都在面包/饥饿轴谈判，7 天像同场景换皮）②纯正向零冲突 valence

**下次入口（按杠杆，均后端涌现引擎、非前端）**：
1. **valence 正向通胀机制修复 ✅ 已落地（`19998ca`，纯机制非提示词）**：`relationships.ts` 三管齐下——
   talkGain 边际递减（<30满+1/friend0.5/close0.25/best0.1，自然 plateau 不冲95）+ registerTalk **每对每 tick 只计一次**
   （把主轮+反应轮级联折成「一次对话=一次微调」，掐断棘轮）+ applyIdleDecay（每天06:00 空窗对向0回落1.5）。
   +6单测/551全绿。**常量待与下面几项一起在一次 7 天 sim 里复验调参（别单独烧多次 55 分钟）**
2. **⚠️ 提示词侧（留给用户，「模型不冲突可能需破线提示词」）**：impression 态度从不出负 + 角色从不 argue，
   是「闹掰上半环从不注册」的根——机制通道（印象±3→关系 / argue→grudge / 爽约−5）都在且能跑，只是提示词从不喂负面。
   下行通路要真出现，靠这一侧放开负面态度/冲突许可
3. ~~经济通缩~~ ✅ **已落地（2026-07-07 顶部批次）**：主根其实是 prepare 收入=0，非 serve/prepare 铸币小
4. 低优先 backlog：~~约定结算宽窗~~ ✅ ~~绫波丽单行复读~~ ✅（均 2026-07-07 顶部批次）；
   剩：2 处「厨房」幻觉地点（0.17%，机制侧已优雅报错，残余是模型乱选，接受）
**注意**：SimReporter 的 valence 判定 + grudge 分段 + 约定 replaced 已在 `2ae4521` 修好（本次基线的 md auto-verdict 是修复前旧检测器产出的，别引用那行；原始每日表格准）。data/save.db 已删干净，护栏为代码级（loadGame 剧本不匹配拒载）

### 活人感全面修复（2026-07-05，`fix/aliveness-emergence` 分支 7 commits，已合 main）

按 AUDIT-aliveness-20260704.md 做的全面修复 + 4 台涌现引擎，全套 **545 单测绿**，
live 半天模拟已验证质变（`logs/sim-halfday-20260705-*.md`：涌现出共同吃饭/结伴出门/
劳动产出流转/困了自己散场，约束失败 0）。经 8-agent 对抗审查（27 条发现）修掉全部确认级问题。

**修复主线（7 commits，每个 commit message 有完整清单）**：
1. `b06e12e` 反馈回路：relationship_change/moodlet 效果生效、argue/comfort 可感知（inbox+angry moodlet）、steal 真转移、幽灵对话修复
2. `b00a8b5` 记忆连续性 + 持久化：反思独立类型+锚点进检索池、**LongTermMemoryStore 运行时写入**（反思/冲突/约定结算当刻落 LTM）+ 对话注入「你们之间实际发生过的」+ 防编造历史；seeds visible_to 泄漏修复、saveAll 全量覆盖（重复堆积修复）、存档 scenario 护栏
3. `44f2a35` 对话表达：断头台改 Jaccard 真重复判定+长对话收尾意图（台词不再丢）、低精力压进对话（"回话必须短可以失礼"）、rival 敌意许可、traitReminder 节流、反思必答"最不顺的事"、narrator 去糖
4. `58adcbd` 世界机制：openHours 生效（打烊真打烊）、**力竭昏睡**（energy≤3 当场睡着+被目击）、删占位 beats、导演恢复 do_nothing（涌现放大器定位）
5. `9b53b07` **四台涌现引擎**：①印象"态度"±3→关系（对话内容第一次有机制分量）②对话结束承诺抽取自动落 appointment ③积怨状态机（argue 结疙瘩/见面空气僵/道歉限肇事方/3 天淡化/随档）④prepare 产出进货架+库存卖完+skill_up（晋升复活）
6. `8b4e6db` 存档按剧本归属（save-<scenario>.db 防覆盖）+ 道歉解疙瘩只认肇事方
7. `d50771f` 审查修复：力竭乒乓、valence 水位线（同批台词不重复计分）、反应轮 grudge 冻结、steal 守恒、承诺时间基准、库存超卖复检、LTM 注入去重、补货规则（杂货店毒化修复）、argue 边际递减、库存随档

**↑ 这批的「下次入口」已由上一节的 7 天基线兑现**：valence 通胀=确认为真、约定误报率=结算判到场非兑现。
deep work 剩余项（群聊/tick 解耦/命运事件层/多日 Project/aspiration 落地）见 AUDIT §5，仍未开工。

### 活人感全面体检（2026-07-04，诊断完成 → 已按上节修复）

用户反馈「太假了，像过家家」→ 23-agent 多路审计 + 独立取证，93 条发现经对抗验证存活，
完整报告见 **[AUDIT-aliveness-20260704.md](./AUDIT-aliveness-20260704.md)**（含全部 file:line 证据与修复排序）。

**六个实锤 bug（修复入口，均小时级~天级）**：
1. `agent-loop.ts:549` 效果 switch 缺 `relationship_change` case → argue -15/偷窃被抓 -20/送礼 +5 全是哑弹，关系数学上只能上涨（"全员好人"的机制根源）
2. `tool-builder.ts:574` argue/comfort 不发 inbox → 被吵的一方无感知、不能还嘴、不留记忆、无 angry moodlet
3. `scenario-loader.ts:171` seeds 的 `visible_to` 丢失 + `simulation.ts:961` 兜底 `"*"` → 剧本秘密全员泄漏（save.db 已验证）
4. `database.ts saveAll` memories/LTM 裸 INSERT 无覆盖 → 存档记忆重复堆积（实测短期 74%/长期 86% 重复）；且存档无 scenario 标识 → default 续了 last-ferry 的污染档
5. `short-term.ts:171` 过滤 thought 类型 → importance-9 反思对检索重排不可见；LTM 检索 API 全仓库零调用 → 48 小时记忆气泡
6. 语义重复拦截器 = 对话断头台（不看内容、每人 3 句必杀、丢台词代写 thought）

**下一步**：按 AUDIT §4 quick wins 顺序修（1-2 天），然后 §5 deep work 依次立项
（冲突负反馈 → 语言→状态编译 → 长期记忆演化 → 职业经济闭环 → 跨日 Project → 对话场景化）。
修复前先跑一次当前阵容的 seven-day 建长线回归基线。

### 记忆检索接入 · 重要性×时间衰减 + MMR 多样性重排（2026-07-04，活人感优化）

注入 prompt 的记忆此前是**纯 recency**（`short-term.ts formatForPrompt` 取最近 N 条），importance 只参与
淘汰不参与检索、没有多样性去重 → 重要反思容易被琐事挤出、同类记忆反复刷屏。把两个早先删掉的纯函数模块
（`memory/mmr.ts` Jaccard+MMR、`memory/temporal-decay.ts` 半衰期衰减）**恢复并接线**到检索路径：

- **只在已选出的最近窗口内重排**（候选池 `count×3`，天然被 `_maxEntries=30` 封顶，不碰长期记忆/DB）：
  打分 = `importance × 时间衰减(halfLife=2 游戏天)` → MMR（λ=0.7）去冗余 → 选出 count 条 → **按 tick 正序还原**
  （下游时间戳/跨天前缀/连续压缩照常）。核心逻辑抽成纯函数 `rerankRecentForPrompt`
- **向后兼容 & 干净 A/B**：候选 ≤ count 或关闭时退化为 `slice(-count)`，与旧输出**逐字一致**；
  `ANIMA_MEM_RERANK=0` 关掉重排 → baseline = 改动前行为（同一份构建，可控 A/B）。所有旧单测零改动通过
- **验证（`pnpm test:live` sim-halfday，deepseek-chat，各 ~230s）**：
  - **确定性记忆选择对比**（临时探针：同一批候选同时算 rerank 与纯 recency，194 次激活、均候选池 22.1）——
    注入平均**重要性 +18.4%**（6.17 vs 5.21）、去重后**独特内容 +1.02 条**（11.7 vs 10.7 / 12）、
    每次平均**换入 4.86 条** recency 会漏掉的记忆；**100% 的调用**在重要性与多样性两轴都 ≥ recency。
    即"既更相关又更不冗余"在真实记忆上被逐调用坐实（无 LLM 噪声）。探针用完已删
  - **行为 A/B**（rerank ON vs `ANIMA_MEM_RERANK=0`，各一轮 36 tick）：约束失败 **0/0 无回归**；
    重复对话拦截 10→**7**、只想不做救回 8→**5**（都更少，去卡壳倾向）；行为种类 20→**24**、
    baseline 的 `shelve_books(14)/prepare(21)` 刷屏尖峰被摊平 → 行为更丰富。净收益确认，已默认开启
  - 半天窗口内无"昨天/夜间反思"，"记得昨天反思"这条留 `pnpm test:sim` seven-day 观察
- 单测：新增 5 条重排选择/多样性/正序 + 1 条 formatForPrompt 接入 + 恢复 mmr/temporal-decay 各自测试，
  全套 **507 通过**、build 0 error。调参入口：`short-term.ts` 的 `DEFAULT_RETRIEVAL_RERANK`（halfLife/λ）
  与 `RETRIEVAL_POOL_MULTIPLIER`

### 可维护性 · runOneTick 拆分（2026-07-04，P1 上帝函数）

`simulation.ts` 的 `runOneTick` 曾是 **519 行**单函数（tick 的全部 phase 挤在一起，任何改动都要在
500 行里穿针）。做了一次**行为保持的结构化提取**（只改组织、不改执行顺序/逻辑），拆成 10 个按 phase
命名的 private 方法：`_applyDailyEnvironment`（0/0b 天气节日开销）、`_applyClimateAndMoodlets`（1.0f）、
`_rollRandomEvents`（1.5）、`_gatherAgentDecisions`（2 并行决策）、`_applyTalkEffects`（3）、
`_runReactionRounds`（3.5 反应轮，最大一块 ~145 行）、`_scheduleImpressionUpdates`（3.6）、
`_scheduleObservations`（3.7）、`_processGossip`（4）、`_runNightlyReflection`（4b 反思+晋升）。
`runOneTick` 现在是 **75 行的编排器**，读起来就是一条 tick 的 phase 流水线。

- **验证**：build 0 error + **485 单测全绿** + stress-sim（SmartMockLLM 多 tick）通过 → 行为未变
- 下一个可维护性目标（未做）：`tool-builder.ts`（1069）、`agent-loop.ts`（1015）同类拆分，但没 simulation 急

### 存档补齐 · 生活主线状态入档（2026-07-04，P0 正确性缺口）

整体审阅发现的唯一功能正确性缺口：读档会丢掉整条「生活主线」。反思→晨间打算→约定→赴约是头号
feature，但 save-load 从不保存这些状态 → reload 即蒸发。已补齐：

- **新增持久化字段**：`characters` 表加 `today_plan_json` / `current_intent_json` / `inbox_json` 三列
  + 新建 `appointments` 表（`database.ts`）；老库通过 `_migrate()` 用 `PRAGMA table_info` 探测后
  `ALTER TABLE ADD COLUMN` 幂等补列，向后兼容（已用模拟老库验证：补列 + 建表 + 旧数据正常读出）
- **World 新增 `restoreAppointments()`**：读档直接替换列表，跳过 `addAppointment` 的配额/替换校验
- **save-load.ts**：saveGame 收集 todayPlan/currentIntent/inbox + `getAllAppointments()`；
  loadGame 逐字段还原 + `restoreAppointments()`；saveAll 事务里全量覆盖 appointments（避免旧档残留）
- **新增 `save-load.test.ts`**（2 测试）：真实 saveGame→loadGame 往返，断言四类状态完整还原 +
  读档后约定仍可被 `getUpcomingAppointments` 检索到（结算链路依赖）。全套 **501 通过**、build 0 error
- 未纳入（有意）：`wantToDiscuss`（director 工作态，narrative snapshot 另存）、`observableState`（瞬态痕迹）

### 世界系统深化 · 第 1 弹「气候系统」（2026-07-03，天气×四季做成真游戏系统）

把原本纸面化的天气/四季（只有文字、无机制、无画面）升级成三位一体系统。审计结论：
天气 2/10、四季 2/10、经济 3/10、社交 6/10 —— 按"可感知 + 有生存压力 + 前端看得见"逐个补齐。
**顺序：气候 ✅ → 经济 ✅ → 社交（进行中：关系网可视化 ✅；声誉/恋爱线阶段/冲突升级待做）**。

### 世界系统深化 · 第 3 弹「社交系统」（进行中）——从"扎实"到"有戏剧张力"

社交本就是四系统里最扎实的（关系轴+bond身份+八卦+同场修正+印象+约定），先补最缺的「看得见」：

- **关系网可视化**（`godot/ui/RelationWeb.gd`，R 键 / HUD「关系」按钮）：全镇角色沿圆环排布，
  两两关系画成连线——颜色=类型（挚友绿/点头之交灰/宿敌红/暧昧恋人粉）、粗细=亲密/敌对强度，
  bond 身份（恋人/前任/宿敌…）在连线中点标注。纯前端消费 tick 已下发的 `relationships[]`；
  离线 demo 注入了假关系网，`--relweb` flag 可截图。**⚠️ 该文件踩过 GDScript 严格警告坑**：
  `var x := dict.get(...)` 会因"从 Variant 推断类型"被当错误，改 `var x: T = ...` 或无冒号 `var x =`
- **气候+经济真机验证（2026-07-04）**：跑了半天真实模拟（rainy spring 36 tick）——房租准点扣、
  金币 100→76~92（有压力没破产、零焦虑刷屏）；7 角色晨间打算全被雨影响、避雨窝室内行为涌现。
  两系统平衡良好无需调整（探针用完已删）
- **待做（社交 drama 三件套）**：声誉/名声（公共善行↑恶行↓ + 进 prompt + 前端显示）、
  恋爱线阶段（好感→暧昧→表白→在一起/被拒 状态机）、冲突升级（积怨到临界爆发）


- **后端 `src/world/climate.ts`（新，17 测试）**：体感温度 = 季节基温 + 天气修正 + 时辰摆动（±5°C，
  正午最暖凌晨最冷）；`comfortBand` 六档；`isSheltered(loc)`（residential/commercial/library/home_* 算室内）
- **有生存压力**：`simulation` 每 tick 对**露天**角色施加 `climateNeedEffects`——冷/热耗 energy、
  雨雪掉 hygiene+fun、暴风雨最狠；`applyClimateMoodlet` 露天淋雨→狼狈 moodlet、宜人晴天→舒展 moodlet。
  躲屋里就免疫 → 催生"避雨躲寒"的涌现行为
- **可感知**：`prompt-builder` 环境行加温度体感（"下着小雨，12°C（微凉）"）+ 气候提示（带伞/添衣）+
  季节氛围一句话（樱花/蝉鸣/落叶/呵气成霜）
- **看得见（Godot）**：WS 广播 `temperature`；`Main.gd` 四季换装 = 地图季节染色（春嫩绿/夏标准/
  秋金黄/冬冷白，与时段染色**相乘**，只染地面不染角色脸）+ 季节氛围粒子（樱花瓣/落叶/雪絮，preprocess
  预热整屏）+ 时钟显示温度。离线渲染 4 季 × 昼夜验证零 SCRIPT ERROR（截图见 godot/docs/shot_climate_*.png）
- 验证 flag：`godot --path godot -- --shot [--spring|--summer|--autumn|--winter] [--day] [--wide]`

### 世界系统深化 · 第 2 弹「经济系统」（2026-07-04，让钱有牙齿）

原本 gold 只涨不跌（工作+，可选消费−），没有生计压力 → 钱没有分量。深化后三位一体：

- **后端 `src/world/economy.ts` 扩写（新增 +14 测试）**：
  - **生计压力（keystone）**：`dailyUpkeep(income)` 按收入累进的每日开销（房租+杂用），
    `simulation` 每天 07:00 `applyDailyUpkeep` 扣一次；付不起 → 尽量付 + "开销没付清"焦虑
    moodlet + 生计记忆（不引 debt 字段，用压力表达）。角色起始 100 金 ≈ 5 天开销的缓冲
  - **财务体感**：`financeBand/financeLabel/financeFeeling`——按"手头的钱撑得了几天"分档
    （宽裕/宽松/够用/手头紧/拮据/揭不开锅），比裸金额更贴生活；破产 `financeMoodlet` 焦虑
  - **季节市场价格**：`effectivePrice` 应季便宜反季贵（秋收食物 0.82、寒冬 1.22…），
    `tool-builder` 的 buy 工具 filter/展示/扣款三处用同一到手价，展示带"应季实惠/反季偏贵"标注
- **可感知**：`prompt-builder` 身体感受段接入 `financeFeeling`（宽裕不啰嗦，紧才提醒"多接点活"）
- **看得见（Godot）**：WS 下发 `finance` 标签；名册每行显示金币数（按财务档上色，红=拮据）、
  详情面板「钱包 8 金币 · 揭不开锅」行、**挣钱/花钱/房租头顶飘金币**（`float_text`，绿+红−，
  diff 上一 tick gold）。离线渲染名册/详情零 SCRIPT ERROR
- 验证 flag 复用 `--roster` / `--detail <id>`；截图 godot/docs/shot_economy_*.png

### 后端 / 模拟核心

**叙事系统 N0-N6 + Director Agent 化 D1/D2/D4 全部完成并合并 main。**

- 规则导演 (BeatEngine) + LLM 导演 (Director) 双层架构
- Director Agent 化：4 个 read 工具 + tool loop（先看后写） + pulse 反馈闭环 + agenda 跨 invoke 工作记忆 + seed_topic 话题注入
- seed_topic + auto_seeds：beat 触发时自动把核心剧情话题注入角色 prompt，high urgency 自动注入 intent 让角色主动找人对话
- scenario pack 5 剧本可切换（default / mygo-seaside / koukou-judgment / last-ferry / seaside-trio）
- last-ferry 狗血版（3 角色 + 3 重 climax + 全 beat auto_seeds 配置）
- 玩家可通过 web 叙事面板塞纸条、注入事件、触发 director
- 细节见代码（`src/narrative/`、`src/agent/`）

### Godot 游戏前端（godot/）——「世界 2.0」

P0~P4 主干完成（详见 [PLAN-game-frontend.md](./PLAN-game-frontend.md) 状态区 + [godot/README.md](./godot/README.md)）：

- **美术**：Ninja Adventure（CC0）日式 RPG 像素风 + 缝合像素字体（OFL）
- **世界**：72x40 大地图（树墙边界/沙滩/海/池塘/围栏农田/栈桥吊机渔船/鸟居樱花广场）
- **室内**：13 个房间（6 商铺公共 + 7 住宅），点建筑进入、ESC 返回、占位小人徽章
- **系统**：AStarGrid2D 寻路、相机拖拽缩放跟随（自动跟进室内）、昼夜染色 + 夜景灯光、
  BGM 昼夜双曲、天气特效（雨/雪/阴）、JRPG 底部对话框、调速面板（P4）、详情面板离线可用
- **验证**：`godot --path godot -- --shot [--day] [--wide] [--rain] [--room <id>] [--roster] [--detail <id>]` 离线渲染（零 LLM 成本）

**生存可视化层（2026-07-03 新增）——「让 AI 的生存被看见」**：把 needs 从详情面板的裸数字
变成一眼可读的游戏化表达，兑现"像真正的游戏、AI 在其中生存"：
- **镇民状态名册**（`ui/StatusRoster.gd`，Tab 键 / HUD「名册」按钮）：JRPG 半透明菜单，
  每行 = 像素头像 + 名字 + 当前动作 + 饿/困 迷你血条（绿/橙/红三档）+ 最紧迫需求高亮标签
- **头顶生存告警徽章**（`CharacterView.set_need_alert`）：需求跌破阈值时角色头顶挂
  「饿/困/寂/脏/闷/急」小牌，urgent（<15-20）红底脉动、moderate（<30-32）橙底，
  数据每 tick 从 needs 推导（`Main._apply_need_alerts` / `_worst_need`，阈值对齐后端 need-definitions）
- **详情面板需求条**（`ui/DetailPanel.gd`）：裸文本 "hunger 45" → 六条彩色血条 + 数值 + 中文标签
- 全部 **纯前端、零后端改动、零 LLM 成本**：消费 tick/snapshot 已下发的 `needs`（server.ts:308），
  离线 demo 数据已补 needs+动作，4 张离线渲染验证零 SCRIPT ERROR（roster/detail/on-map 徽章都对）

### 未完成 / 下次入口

1. ~~live 回归~~ ✅ **2026-07-03 已跑**（12 真实 tick / 约 3 分钟 / ~130 次 LLM 调用）：
   - 零 SCRIPT ERROR；气泡每 tick 想法 3-7 条、对话 0-4 条正常渲染
   - JRPG 底部对话框吃真实长台词并换行正常（真嗣/L/战场原实测）；调速面板连上后自动启用
   - 清晨时段全员在室内 → 镇面空、徽章正确显示屋内人数（符合设计，观看时点建筑进室内看）
   - 据此迭代：徽章移出地名标签区、时钟改「春 第X天 · 清晨 06:15」格式
   - 探针工具：`godot --path godot -- --probe`（连真后端 3 分钟，每 30s 存 shot_live_N.png 自动退出）
2. ~~叙事控制进 Godot~~ ✅ **2026-07-03 完成**：`ui/NarrativePanel.gd`（N 键/按钮开关），
   塞纸条/散布流言/注入事件/推进导演四模式，HTTP 直连 3001；三个注入接口已 curl 冒烟通过，
   nudge（会调 LLM）未实测但接口简单。离线可预览、发送禁用
3. **其他剧本前端适配**：mygo-seaside ✅ **2026-07-03 完成** —— 5 角色皮肤
   （tomori=EggGirl / anon=Cavegirl2 / sakiko=Princess / mutsumi=Cavegirl / soyo=Woman）+
   **通用住宅槽位分配**（任何剧本的未知 home_* 自动按序复用默认七栋房子的空位，含室内房间与
   徽章，标签用后端下发的地点名）；真后端 snapshot 验证通过（0 tick 零成本流程：起服→连上抓
   snapshot→15 秒内杀）。koukou-judgment（14 角色 + 25 监狱地点）需要独立的监狱地图，另行立项
3.5 ✅ **行为可视化（2026-07-03）**：tick.events 的工具调用映射到画面——
   PAIR_ACTIONS（talk/gossip/comfort/argue/share_secret/invite_out/give_gift）触发凑近+对视；
   give_gift 飞包裹+爱心+底部对话框播报；argue 怒/心碎；comfort 爱心；sleep/nap 困；
   skipped 冒"…"。离线 demo 已含 talk 凑近 + 室内送礼 + 发呆三个演示 case
4. ~~后端：PLAN-tool-feedback.md 的 Tool Feedback Loop 改造~~ ✅ 核查确认已全部实现
   （Layer B/C/D/E 都在代码里，MAX_TOOL_RETRY=2；PLAN 文档状态已更正）
5. **前缀缓存优化（待决策，2026-07-03）**：provider 已接入 DeepSeek 缓存命中指标
   （`LLMResponse.usage.cacheHitTokens/cacheMissTokens` + 每 25 次调用输出累计命中率日志）。
   先跑一次 halfday sim 看真实命中率，再决定是否做"工具描述静态化"改造
   （把在场人名/商品清单/位置锚点等易变内容从 tool description 挪到 user prompt，
   工具集仍按情境浮现但字节稳定）。注意：这与"工具=环境可供性"设计有张力，动之前先量化收益。
6. **活人感优化第一批（2026-07-03 已落地，待 live 验证）**：
   - 短期记忆改重要性感知淘汰（`short-term.ts _evictOne`）：反思(9)/冲突(8)/对话(7) 比琐事(3-4)
     活得久，2 游戏天硬过期兜底。此前是纯 FIFO，importance 字段形同虚设
   - 记忆/念头时间戳跨天标注（"昨天23:00"），模型能分清昨晚和刚才
   - 生活节律：饭点提示（早/午/晚，肚子不满才触发，`need-definitions.ts`）+
     上班节律一句话进 system prompt（静态、缓存友好，`prompt-builder.ts formatLifeContext`）
   - ~~已知未接线：`memory/temporal-decay.ts` 和 `memory/mmr.ts` 死代码（曾删，代码在 git 历史）~~
     ✅ **2026-07-04 已恢复并接入 `formatForPrompt` 检索路径**（重要性×时间衰减加权 + MMR 多样性重排），
     live 半天模拟确认净收益（详见上方「记忆检索接入」section）
   - 验证入口：`pnpm test:live`（sim-halfday），观察点 = 角色是否按饭点吃饭/是否记得昨天的反思/
     `[LLM cache]` 命中率日志
7. **活人感第二批：半天模拟实测驱动（2026-07-03）**。第一轮 live 实测数据（275 次调用）：
   - ✅ 饭点节律生效：6 次 eat，2 次落在早饭窗口（09:00-09:15）、4 次落在午饭窗口（11:15-12:00）
   - ✅ 前缀缓存命中率收敛在 **57.8%**（首批 17.8% 是冷启动）——system 前缀正常命中，
     "工具静态化"改造的边际收益 = 剩余 42% 里 tools 段占的部分，优先级降低
   - ❌ **21 次（约 8%）"只想不做"**：模型（多为对话模式顺着 prefill）只写内心戏/台词不调工具，
     tick 作废且台词被丢弃 → 已修：agent-loop 同 turn 追加提示救回（`💬 只想不做救回`日志）
   - ❌ 在家 go_to "家/home" 报"镇上并没有这个地方"，误导重试连撞 2 次 → 第一版修复（改清晰报错）
     被第二轮实测证伪：报错再清晰模型也学不会，重试仍选 go_to 家。**最终方案：go_to 到当前位置
     （含"家"）优雅降级为"原地歇会儿"成功**（Claude Code stay-where-you-are 容错），
     不烧重试、记忆留自然叙事，重复倾向交给 recentActions streak 提示纠正
   - 第二轮验证（300 次调用）：只想不做 21→4（救回 14 次，其中 11 次转成 talk 把台词说出口）；
     缓存命中率 57.8%→68.5%（跨 run 磁盘缓存复用）；talk"对方不在"类失败是并行决策的
     时序竞态（A 决定说话时 B 同 tick 离开），叙事自洽 + 重试可纠，视为可接受不修
8. **选错工具四大根因修复（2026-07-03 第三批，v3 半天模拟零失败验证）**：
   - ① **见=可执行一致性**（`agent-loop.ts`）：会话模式此前给模型看静态 ALL_BASIC_ACTIONS、
     执行却按情境表验证 → 模型选"看得到但执行不了"的工具报不存在，真正可用的情境工具看不见。
     修复：conversationRequest 的 tools 强制替换为 dynamicActions
   - ② **对话对象必须同地点**（`simulation.ts` 两处）：isActiveConversation 只看 3-tick 时间窗
     不看位置，B 走后 A 仍被喂"请回应对方"→ 幻觉 talk。修复：进会话模式前检查同地点
   - ③ **居家可供性**（`residential.yml`）：家里工具全部条件门控，状态好的角色在家只有
     go_to+do_nothing → "go_to 家"病急乱投医的供给根源。修复：加无条件 rest / tidy_up
   - ④ **eat 参数宽容**（`tool-builder.ts`）：缺 item 时默认背包第一个食物 > 店里最便宜的
   - **三轮对比（每轮 ~250-300 次真实调用）**：最终失败 ✗ 8→13→**0**；重试 25→41→**1**；
     未调用工具 21→4→2；不存在的工具 →**0**；tidy_up 被自发使用 5 次、rest 1 次；
     行为分布 talk 29%/go_to 20%/eat+buy 13%/工作 9%/家务休闲其余——不再全员聊天
   - 唯一一次重试：L 想吃"方糖"（人设嗜糖，物品表没有）——建议给物品表加甜食让人设落地
   - **工具充分性审计结论**：45 个工具覆盖生存/工作/社交/休闲/居家/极端六域，日常粒度足够。
     真正缺口是系统级不是工具级：跨 tick 约定兑现（"明天中午一起吃饭"）、给不在场者留言、
     共同活动（一起吃饭是两人分别 eat）——属于新系统设计，待立项
9. **约定系统 v1（2026-07-03 实现，设计见 PLAN-appointments.md）**：
   - 数据：`Appointment` 存 World（`addAppointment`/`getUpcomingAppointments`/`getDueAppointments`，
     同对角色新约替换旧约、每人最多 3 个 pending）；~~瞬态不持久化~~ ✅ **2026-07-04 已入档**
     （见下方「存档补齐」）
   - 创建：`arrange_meet` 工具（tool-builder，附近有人时浮现），确定性时间解析
     （`world/appointments.ts parseAppointmentTime`：今天18:00/明天中午/18点半，过时自动滚明天），
     `_appointment` 后门落库 + inbox 通知对方
   - 提醒：prompt「你心里挂着的事」按临近分级（远期平静/临近催出发/到点紧急）
   - 结算：simulation 每 tick，宽限窗 2 tick；kept→双方记忆+happy+关系+3；
     missed→等的人（记忆8/sad/关系−5/记挂 intent）+ 爽约者（愧疚记忆8+道歉钩子 intent）；
     双缺席扯平。已知简化：结算时刻才看在场，"等了一会儿先走"判为没来
   - 24 个新单元测试，全套 461 通过
   - **v4 半天模拟验证（2026-07-03）**：质量指标保持零失败（✗=0/重试2/救回10），
     arrange_meet 正确浮现但 9 游戏小时内未被自然使用 → 判定为可发现性问题（会话 prompt
     只列了 talk/go_to/eat 选项），已在 conversation-mode 行动指令加一行"聊得投缘可约下次"
     的非强迫提示。**下次观察点：7 日模拟（`pnpm test:sim` seven-day）看约定的自然发生率
     和赴约/爽约叙事**——半天窗口太短，约定本来就是低频行为，不值得再烧半天模拟去等它
10. **晨间打算 Morning Intentions（2026-07-03 实现）**：把"反应式生存"推向"有主线的生活"——
    这是对照 Generative Agents daily planning 找出的当前最大活人感差距：
    - `agent/morning-plan.ts`：每天 06:00 各角色基于昨日反思(wish/concern/insights) +
      今日约定 + 天气生成 1-3 条"今天想做的事"（150 maxTokens 小调用，失败降级不阻塞）
    - 存 `CharacterState.todayPlan {day, items}`（跨天自动失效）；prompt 注入
      「你今天的打算」段（措辞刻意松弛"顺其自然"，防 todo 执行机器化）
    - 晚间反思回顾打算完成情况 → 闭环：反思→打算→行动→回顾→次日反思
    - 成本：7 角色 × 每天 1 次小调用，可忽略
    - 8 个新测试，全套 469 通过
    - **v5 半天模拟验证（2026-07-03）：7/7 生成成功且深度贴合人设**（真嗣"烤出完美面包让
      父亲愿意尝一口"、L"糖纸叠遮阳片+观察实习生"、夜神月"检查借书卡标记"、战场原
      "修椅子免得老太太摔了还得打急救电话"）。**打算→行为因果链直接可见**：真嗣打算
      "中午去海边听海浪"→ 12:00 go_to 海边 + walk（6 小时后兑现）；rei 打算弄花
      → arrange_flowers 成为其最高频行为(×10)；light 打算图书馆整理观察 → shelve_books。
      回归指标连续第三轮零失败（✗=0/重试1/救回6）。arrange_meet 仍 0 次，留 7 日模拟观察
   **首批真实数据（2026-07-03 live 回归顺带采到，7 角色 12 tick）**：累计命中率随调用数衰减
   25次 86.3% → 50次 76.6% → 75次 71.4% → 100次 69.1% → 125次 70.2%（323840/461490 tokens）。
   即现状已有 ~70% 命中，"静态化"的可提升空间 = 未命中的 30% 里属于易变前缀的部分，收益上限有限，
   建议 halfday sim 复测后再决策。

## 关键教训（跨会话必读）

- **图集裁片必须先验证**：Ninja Adventure 图集里建筑/道具紧挨着排，新 region 必须先 PIL
  裁片放大确认边界；"半截贴图"两种成因 = 区域裁到邻居 / 贴图本身是组合件碎块
- **停后端按端口杀**：`lsof -ti:3001 | xargs kill -9`（pkill 匹配不到 pnpm 真实进程名会残留偷跑烧钱）
- **Godot CLI 用绝对路径**：`godot --path <绝对路径>`（shell cwd 会被重置，`--path .` 指错会开
  项目管理器空转卡死）
