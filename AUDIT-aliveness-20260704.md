# AUDIT — 活人感全面体检（2026-07-04）

> 起因：用户反馈「太假了，像过家家」。方法：11 路取证/审计（3 路日志取证 + 8 路子系统审计）
> → 逐路对抗验证 → 综合。23 个 agent，93 条发现经验证存活。
> 另有独立取证的 4 个持久化/剧本层 bug（见 §2 末尾）。修复排序见 §4/§5。

## 1. 第一性根因

你的模拟像过家家，不是因为台词不够好，而是因为整个系统在每一层都删除了"后果"，而真实人生的重量恰恰等于后果的不可逆积累。语言层：说话不改变世界——告别不离场、承诺不落状态、"杀死L"级的 aspiration 没有任何工具可推进，语言与行动彻底脱钩；关系层：唯一真正生效的结算规则是"开口就+1 好感"，所有负向效果（argue -15、偷窃被抓 -20）在 agent-loop 效果应用层被静默丢弃，"讨厌一个人"在机制上不可表达，全镇数学上必然滑向人人挚友；身体与经济层：饿到 0、精力 0、破产都只产生一行文案和心情贴纸，不产生任何事件；记忆层：人生在 48 小时后蒸发（LTM 检索 API 全仓库零调用），人格参数终身冻结，每天从同一状态空间重新采样；时间层：15 分钟 tick 把对话切成木偶回合、把效果一次性预付，角色不是雕像就是每 15 分钟换 pose 的多动症；最上层雪上加霜——prompt 明确告诉模型"你是沉浸式小说的创作引擎，在呈现一个角色"，导演层用日历触发的占位 beats 向角色脑内直写"必须聊"的念头。于是角色只能演戏，而且被系统要求演戏。修复的第一杠杆不是加更多剧情，而是先让最普通的一次吵架、一次爽约、一次破产真正咬人、被对方感知、被记住超过两天——三个 S 级修复（relationship_change 丢弃、argue 无感知回路、反思被记忆过滤器排除）落地后，世界才第一次可能出现"有分量的事"。

## 2. 六大主题与头部发现

### 零后果世界：负反馈在每一层都缺席或被 bug 丢弃

关系只涨不跌、冲突是独角戏、needs 归零无事发生、经济不咬人、行为永不失败——nothing at stake 是过家家感的机制核心。其中两条是证据最硬的代码级 bug（效果被静默丢弃、被吵者收不到消息），修复成本小时级，是全部 93 条发现里性价比最高的支点。

**[5/5 · S] relationship_change 效果被效果应用层静默丢弃：argue/偷窃被抓/送礼对关系全部无效，关系数值只能上涨**
- 证据：agent-loop.ts:549-581 效果 switch 只有 need_change/location_change/inbox_message/skill_up 四个 case，无 relationship_change；而 tool-builder.ts:581(argue -15)、gray-actions.ts:69(偷窃被抓在场者 -20)、social-actions.ts:70(give_gift +5) 均声明该效果。全库真正调 relationships.modify 的只有 talk 无条件 +1(simulation.ts:508/657)、赴约 +3、爽约 -5。rival(<-20) 数学上不可达，7 天日志 10 对关系全部单调升至 friend/best_friend。
- 修法：switch 补 case relationship_change 调 relationships.modify（relationships 已在作用域，line 686 在用）；同时统一 tool-builder 与 actions/ 两套效果 shape 并加单测锁住。

**[5/5 · S] 冲突无感知回路：被 argue/comfort 的一方收不到 inbox、不进反应轮、不留记忆——吵架是演给旁观者看的独角戏**
- 证据：tool-builder.ts:574-585 argue 效果无 inbox_message（对比 talk 在 :443 有）；反应轮入口 simulation.ts:553 只认 inbox；:259 目击记忆明确跳过 targetId——旁观者拿到吵架原因全文，当事对方一无所知，同 tick 无法还嘴，也没有 angry moodlet（全库 addMoodlet 无一处 angry）。
- 修法：argue/comfort 加 inbox_message 送达对方（复用 talk 反应轮，吵架自然变多轮对骂）；给对方写 importance 7-8 记忆；双方加 angry/sad moodlet。

**[5/5 · M] talk 内容对机制完全透明：任何对话（包括辱骂）都=+1 好感+双方 happy moodlet；且无积怨/冷战/和好状态机，冲突后果最长寿命 8 tick**
- 证据：simulation.ts:502-527 _applyTalkEffects 对任何 success talk 无条件 modify(+1) 且双方 addMoodlet(happy)，message/manner/intent 完全不参与；rel.history 保留 20 条但全库无读取注入 prompt 的路径（仅 database.ts 存档）；爽约 intent expiresAt tick+8（simulation.ts:1148-1155）是全系统最长的冲突记账。asuka 卡'每句话都像在挑战别人'的毒舌被系统性记账为友谊进度。
- 修法：关系增量按语义分档（最便宜：利用已有 intent 标签 confront/warn 时 delta=0+对方 angry；中期：挂到已在读全部对话内容的 impression-updater 输出 -2..+2 倾向数）；加 per-pair unresolved_conflict 状态机（同场注入'你们上次不欢而散'、道歉/送礼/时间衰减解除）；rel.history 最近 3 条注入 prompt。

**[5/5 · M] 需求归零零后果+恢复瞬时全额：饿到 0/精力 0 与满值的行为空间几乎一样，睡=瞬间满电，稀缺不存在**
- 证据：world.ts:186 衰减 clamp 到 0 后无任何代码响应（全库无生病/晕倒处理）；221103 日志 4/7 角色精力=0 仍在 14:30-14:45 完整敬语寒暄，talk 工具无精力门槛；residential.yml sleep effects {energy:100} 在 t0 一次性生效，睡 1 tick 被叫醒白得 100 精力（agent-loop.ts:549/716）。
- 修法：分级后果链：energy≤5 强制昏睡（被目击+importance 9 记忆）、hunger=0 持续 8 tick 病倒（禁 work+花钱买药+进八卦）；恢复按 duration 摊销（sleep 每 tick +12，熬夜=第二天带低 energy 出门）；低 needs 在 conversation prompt 注入'回话必须短、可以失礼'（复制 financeFeeling 的成功路子）。

**[4/5 · M] 经济是开环铸币机+世界永远没有意外：偷窃无受害者、破产无深渊、随机事件全表 8 条天花板 fun+12**
- 证据：agent-loop.ts:612-624 work 凭空铸币、steal 受害者一分钱不掉、buy 的钱直接蒸发；economy.ts:96 金币封底 0 无债务；全镇最贵可买物 25 金币鱼竿，guitar 80/camera 50 注册了却无处出售；events.ts:34-115 全部事件=野花/香味/流浪猫级微扰，importance 一律写死 5，无任何改变一天走向的事件；7 天里唯一 emergent 危机（Bob 破产挨饿 5 天）被全世界包括他本人无视，反思照样'乐呵'。
- 修法：steal 从真实对象转移金币+失窃记忆+报案八卦；买卖闭环（顾客付款进营业额、员工收入挂钩）；允许负债+讨债事件；命运事件层每 3-7 天一件（失窃/扭伤/店铺事故，importance 8-9+intent 强制处理+进 gossip）；补 borrow_money/treat_someone 让求助/援助有工具供给。

### 语言与世界脱钩：说的话不改变任何状态，野心没有落点

角色嘴上是神与侦探与革命者，手上永远在擦桌子；说了一天'我得去工作了'一步不走；147 次对话产出 0 个约定。语言是纯表演，世界只认工具调用，两条通路之间没有编译器——这是'小孩演戏说大话'观感最直接的来源。

**[5/5 · M] 告别死循环+言行脱钩：说十几次'我得去揉面团了'从未揉过，一场互道告别持续 7-8 游戏小时；病根（告别≠离场、靠系统护栏硬打断）仍在**
- 证据：221103.md:48 真嗣 talk(35)/knead_dough=0，:75-:183 约 15 次'我得去揉面团了'；:72-:195 明日香↔鲁鲁修 07:30→14:45 互道告别 7 小时不离场；代码无告别=离场出口，仅 conversation-mode.ts:249 一句 prompt 提示。0704 已靠语义拦截缓解（talk 降到 25.4%）但拦截是系统强制换行为而非角色意志（dev-server.log:129/140/148 半天 3 次触发）。
- 修法：talk 加 farewell 参数或告别语义检测→自动结算离场+写'XX走了'进对方观察+同 tick 解锁 go_to；店员提供'边干活边应付'复合行为。校验指标：同对角色连续对话轮数 P95 <6。

**[5/5 · L] 角色核心动机（aspiration/秘密身份）在世界机制里零落点：'杀死 L'每 tick 注入 prompt 却无任何工具可推进，晨间打算只能幻觉出不存在的实体（C.C./流浪猫/新闻/地下室）**
- 证据：light.yml:77 aspiration'成为新世界的神，并杀死 L'经 prompt-builder.ts:94 每 tick 注入，但 grep 全 src 确认 aspiration 无任何机制消费，工具空间无 investigate/跟踪类；【0704 当天】dev-server.log:69 light 打算'搞到体型相近的身份'（无证件系统）、:70 lelouch'C.C.又来蹭披萨'（无此角色）、:65 L'去地下室翻档案'（无地下室）；morning-plan.ts 无任何可供性校验。
- 修法：双向收口：①给带秘密的角色挂多步隐秘 project（调查进度/证据物品/暴露风险值+investigate/搜查/藏匿工具，进度触发 Director 摊牌 beat）；②做不起就反向裁剪角色卡，把野心改写成小镇尺度可被 45 个工具推进的欲望；③晨间打算加可供性校验（提到的实体不在世界里则要求改写）。

**[4/5 · M] 对话零产出：147 次对话 0 个约定/请求/秘密，承诺跨天静默蒸发，约定系统上线后所有真实运行产物仍 0 次使用**
- 证据：221103.md 对话 147 次无任何承诺；dev-server.log:12 第 3 天存档'0 约定'；share_secret/invite_out/arrange_meet 反复列入可用工具但全部日志 0 次被选；7day log:186 Bob'明天一早去码头钓鱼'+老陈'给我留条大的'→day7 全部蒸发零提及。根因：说话和调工具是两条通路，对话无'我想从对方得到什么'的诉求注入。
- 修法：对话结束/夜间反思时用小模型抽取承诺自动落成 appointment（复用现有分级提醒+赴约/爽约结算管线，不依赖模型显式调工具）；conversation prompt 注入'你当前想从对方得到的东西'（从 needs/todayPlan/印象疑惑派生——印象系统已在产大量疑惑，是现成对话目标没接线）。

**[5/5 · M] work 是空转哑剧：劳动不产出、顾客不存在、库存无限、技能永不成长导致整个晋升系统死路；'师傅会生气'说了 10+ 次而师傅不存在**
- 证据：bakery.yml:14-28 bake 不产出面包不耗原料；serve_customer 无需顾客在场；buildToolList 从不注入带 skill_up 的 work 工具（grep data/locations 无 name:work）→ shinji baking 3 永远到不了晋升需要的 5（checkPromotion 永不通过）；buy 不减库存。221103 真嗣全天 0 次揉面边聊边说'师傅会检查'10+ 次，零后果。
- 修法：最小闭环：prepare/bake 产出真实物品进店铺库存（卖一件少一件，早晨烤的面包别人真能买到）；worker_tools handler 附带 skill_up 让 40-80 次劳动后晋升真发生；serve_customer 仅在有非员工在场时可用/有收入；旷工被同事写进记忆并扣薪。

**[4/5 · M] 灰色行为+秘密通道被工具 schema 切断：说谎/坦白/对峙的语义入口不存在，default 七卡 0 条 secrets，narrative 秘密机制整套空转**
- 证据：实际使用的 buildTalkTool（tool-builder.ts:404-427）参数只有 thought/target/message/manner——intent:lie/reveals 只存在于未被注入的死代码 basic-actions.ts:140-152；beg/steal 浮现门槛 gold===0 在现行经济下半天窗口不可达；steal 无 target、金币凭空、被抓 effects:[] 零后果；七张 default 卡 grep secrets 零命中，setSecretsPool 零调用者。
- 修法：把 intent/reveals/topic_tags 加回 buildTalkTool schema；灰色行为浮现改挂 financeBand（broke 即浮现）；steal 改真实转移+被抓进 gossip 白名单+受害者 grudge intent；给七卡从 psychology/backstory 现成素材里补 2-3 条 secrets 灌入秘密池并追踪知情人集合。

### 每天重置：记忆 48 小时蒸发、人格终身冻结、无跨日积累

长期记忆检索 API 写好了但全仓库零调用，importance-9 的反思被记忆过滤器排除在重排之外，对话时不按对象检索共同历史——于是角色只能用编造的'上周/平时'冒充连续性。第 1 天=第 7 天不是观感而是机制必然。用户'每天重置=过家家'的定义在此字面成立。

**[5/5 · M] 长期记忆是死路：LTM 只在存/读档瞬间被碰，loadMemoriesAbout/searchLongTermMemories 全仓库零调用，角色永远活在 48 小时记忆气泡里**
- 证据：database.ts:302-313 两个检索 API 定义后 grep 零调用点；LTM 仅是 saveGame 时的快照（save-load.ts:62-70）；loadGame 回注的 top10 进入受 HARD_EXPIRE_TICKS=192 支配的短期 buffer，数小时后被淘汰；运行期间无任何路径查询 long_term_memories 表。'她上次放过我鸽子'这类带历史重量的引用机制上不可能发生。
- 修法：①反思/冲突/约定结算/importance≥8 事件在发生当刻 saveLongTermMemory；②对话/同场时 loadMemoriesAbout(observer,partner,5) 注入'你们之间发生过的'段；③topic_tags 命中时 searchLongTermMemories 做话题触发回忆。三个查询 API 已写好，只差接线。

**[5/5 · S] 反思晋升链断裂：importance-9 反思存成 type:thought 被 formatForPrompt 明确过滤，唯一出口是纯 recency 的 5 条窗口，几个决策 tick 就被 importance-3 碎碎念冲走**
- 证据：reflection.ts:115-120 反思存 type:'thought' importance 9；short-term.ts:171 `pool.filter((e)=>e.type!=='thought')`——07-04 新上的重要性×衰减+MMR 重排通道对反思不可见；getRecentThoughts 纯 slice(-count) 取 5 条，每个决策 tick 又写入一条 importance-3 thought。第二天上午 5 个决策后昨晚反思从 prompt 完全消失。
- 修法：反思改独立 type（如 reflection）纳入重排候选；或最小改动：short-term.ts:171 对 content.startsWith('[反思]') 豁免。顺手把 ReflectionResult 整体存 CharacterState.lastReflection，晨间打算直接读，不再走 thought 窗口字符串匹配。

**[4/5 · M] 对话时不按对象检索记忆+角色用编造的共同历史冒充连续性：真历史进不了对话，假'上周'反而满天飞**
- 证据：会话模式只注入 formatForPrompt(id,12) 通用窗口+印象（simulation.ts:456-457/589-590），relatedCharacterId 已打在记忆上却从不用于检索；0704 日志（该 run 所有关系=stranger）:88 夜神月对 L'您上周借了那本《连环杀手的思维模式》'——'上周'不存在；:149 鲁鲁修把 prompt 在场名单脑补成'他早就调查过我'；prompt-builder.ts:369 仅一句'不要把猜测当成事实'软约束。
- 修法：会话构建时按 relatedCharacterId===partnerId 捞 3-5 条+LTM loadMemoriesAbout 单独渲染'你们之间发生过的'；prompt 注入关系事实约束'你们之间实际发生过的事只有：<记忆列表>（可能为空=初次见面），不要虚构共同过去/上周/平时'。

**[4/5 · L] 无跨日累积载体：没有多日 Project/Goal、人格参数/自我认知/aspiration 无任何运行时演化路径，第 1 天=第 7 天结构性成立**
- 证据：duration 只是占住 N tick，效果第 1 tick 结清，无'做到一半'状态；todayPlan 按 day 门控跨天失效；反思只回写 currentGoal/currentConcern 两个一句话字段（simulation.ts:821-828），personality.traits/aspiration 全库无写入路径；7day log 第 1 天与第 7 天行为分布同构，唯一累积量=金币与好感度；被爽约十次的人第十一次还是同样信任。
- 修法：①轻量 project 状态入 CharacterState（练曲子/存钱开店/修船：progress 累积、可失败、完成产出可展示物品+高重要性记忆），晨间打算可引用、反思回顾进度；②每 7 游戏天基于 LTM 跑一次 self-notes 自我更新（'你最近不太信任约定'）注入 system prompt 固定段，允许改写 aspiration；③guitar/camera 上架高价商店给攒钱线一个对象。

**[5/5 · M] 当前世界从未跑过多天：唯一 7 天证据是 3 月旧角色旧系统，全部新长线机制（约定/晨间打算/经济/导演）零跨天验证，工程流程把自己锁在'半天内好看'的选择压力里**
- 证据：sim-7day-log.txt:2 日期 2026-03-23、角色是 alice/bob 旧阵容；logs/ 目录当前 cast 最长产物=36-tick halfday；dev-server.log 最新运行从 tick=192 跑到 day3 08:45 即被 kill（exit 137）且该档 0 约定；STATUS.md:226-227 自认'7 日模拟…看约定的自然发生率'仍是待办。
- 修法：立即用当前 cast 跑 pnpm test:sim seven-day；sim-reporter 增加长线专属指标：言行引用前一天事件次数、约定创建/兑现/爽约计数、关系净变化（必须含下降项）、反思情绪分布、第 1 天 vs 第 7 天行为分布散度。此后所有活人感改动必须过 7 天窗口回归。

### 木偶剧时钟：tick 调度把生活切成定格动画

一句话=15 游戏分钟、对话每 tick 蹦 2 句再静音 30 分钟、3 连击拦截器在第 4 句篡改台词把人传送回家、群聊物理不存在、长动作期间角色是雕像。观众看到的'摆拍感'很大一部分来自这个时间形状而非台词内容——真人 5 分钟的对话被摊成 2.5 小时的玩偶对口型。

**[5/5 · L] tick=决策点硬耦合：角色不是雕像就是多动症——空闲时每 15 分钟被迫换 pose，长动作期间完全冻结无想法无观察**
- 证据：agent-loop.ts:68-77 多 tick 行为期间直接 skipped 返回，不写任何记忆/想法；prompt-builder.ts:470-484 streak>=3 强推'该换个事做'；0704 日志 7 角色 9 小时 213 个行为=人均每 16 分钟一个新动作，go_to 50 次占 23.5%；observation-reasoning.ts:60 remainingTicks>1 时连社会观察都被禁；7day 全天口径 ~80% tick 是跳过（雕像）。
- 修法：决策从 tick 解耦成激活队列：唤醒条件=活动自然结束/need 跨 urgent 阈值/目击 importance≥7 事件/inbox/约定临近；空闲改'持续活动'模型（期间低成本走神小念头）；streak 惩罚只打重复台词不打'继续看书'。

**[5/5 · M] 3 连击'语义重复'拦截器是对话断头台：不看内容、精确杀死所有深聊于每人 3 句，第 4 句台词被静默丢弃并强制 go_to 回家+系统代写 thought**
- 证据：agent-loop.ts:308-324 连续 3 次 talk 同一人即判 isRepeat（不判内容）；:327-330 fallback 取 dynamicActions 第一个命中——go_to 永远排第一（tool-builder.ts:55），模型已生成的第 4 句被丢弃，thought 被代写为'聊得差不多了'。0704 日志 7 场两人对话 5 场精确终止在每人 3 句；14:45 战场原的挑衅永远得不到回应。全镇没有任何一场对话能越过寒暄层。
- 修法：拦截条件改'内容真重复'：字面重复保留+语义层用 Jaccard/3-gram>0.6（mmr.ts 已有实现），同目标阈值放宽到 ≥6 且需相似度同时超标；触发时照常说出已生成台词并注入'说完这句自然道别'，fallback 按场景选（工作地回工位而非回家）。

**[5/5 · L] 对话被 15 分钟 tick 量化成对讲机+一句话=15 分钟：吃一块蛋糕 6.5 游戏小时，8 轮对话摊 2 小时，结束无告别无收尾记忆**
- 证据：sim-1day L66-109 一块草莓蛋糕从 17:15 聊到 23:30；0704 日志买可颂闲聊横跨 07:45→09:00；每 tick 每对最多 2 句+2 tick 冷却（simulation.ts:538-547）；对话终结唯一路径是 conversation-mode.ts:82-89 的 8-tick 静默 delete，不产生任何收尾记忆，ConversationTracker.clear() 全库零调用者。
- 修法：对话升格为场景级：激活后在单 tick 内跑 4-8 轮到自然收尾（一次性生成/结算，仿 Generative Agents），或对话期间时钟按 1-2 分钟粒度推进；cleanup 时写'和X聊了一会儿'收尾记忆；行为统计一场对话记 1 个叙事单元。

**[4/5 · L] 群聊不存在：对话上下文严格两两配对，第三者插话被系统性无视——递出的拿铁 7 小时无人接**
- 证据：conversation-mode.ts:46-48 以排序 pairKey 存储、:150 prompt 只有单一对话对象；buildConversationPrompt 无 inbox 参数——第三者本 tick 的消息在会话模式 prompt 完全不可见；实测 08:15 明日香→真嗣'这杯拿铁给你'，真嗣至模拟结束（15:00）零回应。三人同场的吃醋/抢话/拆台物理不可能。
- 修法：会话上下文升级为场景级：注入同地点最近 3 tick 所有 talk 按时间线合并（数据 ConversationTracker 已全有）；buildConversationPrompt 加 pendingInbox 参数显式列出第三者消息；反应轮 partner 遍历全部发件人优先未回应者。

**[3/5 · M] 深夜与作息只有文案没有机制：全镇同步 0 点睡 6 点起（夜行人设 L 也是）、openHours 数据齐全但零消费、凌晨可买咖啡上班**
- 证据：dev-server.log L34-55 00:15→05:00 连续 tick active=0/7 整城冻结、L61-70 七人同刻批量晨间打算；openHours 被 location-loader 读入后全库零 enforcement，cafe.yml 夜间文案'门锁着'与工具列表同时给 buy 自相矛盾；23:00 反思对已入睡者无差别执行。
- 修法：①buildToolList 按 hour 对照 openHours 过滤（S 级，字段现成）；②角色卡加 sleepWindow（L=02:00-10:00），衰减与晨间打算按窗错峰；③低概率夜间事件（失眠→夜走/写日记）给夜晚留 5% 活人痕迹。

### 演员框架：prompt 层让模型演戏而非过日子，声音同质化有放大回路

每 tick 的 prefill '我将忠实呈现这个角色'+'沉浸式小说创作引擎'框架把模型钉在演员位；darkTraits 命中者共享同一段'善意都是表演'模板；反思/晨间打算/印象四条二级 prompt 只给 5 个形容词，产出通用 LLM 腔再以 importance 9 喂回——人设浓度随天数衰减。角色卡还预写死了 54 处对彼此的态度，与'关系从零涌现'的立项宣言正面冲突：角色每天重演名场面，关系被冻结在第 0 天。

**[5/5 · M] 7 张卡 54 处跨角色引用把态度预写死，与'零预设关系、关系涌现'机制正面冲突——动态印象在 static prompt 的既定立场面前永远拗不过**
- 证据：asuka.yml:23'她每天找借口骂他（真嗣）'、senjougahara.yml:29-32 对四人的预设反应、light.yml:66'重点提防 L、鲁鲁修、战场原'；而所有卡 relationships:{}，CLAUDE.md 声称'零预设关系…所有关系从零涌现'。system prompt 每 tick 重申既定态度，互动积累的印象权重极低→无成长、无意外，只有既定桥段循环。
- 修法：把对具体角色的态度从 core_traits 剥离成初始印象 seed：加载剧本时一次性写入 ImpressionStore（之后由互动覆写演化），卡里只留对'某类人'的泛化倾向；顺手删掉 asuka 卡引用的不存在角色'艾米莉'、speech examples 从完整桥段缩为语气片段。

**[4/5 · M] prefill+'沉浸式小说创作引擎'框架把模型钉在演员位，且人称混乱；台词中位 ~45 字书面腔、评论级机锋、格式无输出清洗**
- 证据：agent-loop.ts:215 与 conversation-mode.ts:314 prefill'我已理解X这个角色…我将忠实呈现'；prompt-builder.ts:110'你是沉浸式小说的创作引擎'、:216 第三人称示例与 :111'第一人称完全成为'自相矛盾；0704 日志 54 条消息中位 48.5 汉字、≤10 字仅 1 条，L↔鲁鲁修与 L↔夜神月两场对话结构可互换；message 里混入「」引号与括号动作段无任何后处理。
- 修法：prefill 改角色内视角直接续写（'（我是{name}，现在在{location}——）'）；示例全改第一人称；对话轮次加长度锚'真人不会每句都这么长'；talk handler 后处理剥引号/挪括号动作进 manner；跑 halfday A/B 对比表演腔词频。

**[4/5 · S] buildTraitReminder 给命中暗黑关键词的角色每 tick 注入同一段'你的每句话都有目的/善意都是表演'，把不同角色压成全天候试探机器并结构性禁止真情流露**
- 证据：prompt-builder.ts:597-602 同一模板注入 lelouch/senjougahara 等；调用点在 isSocialScene 之外，独处干活也注入；0704 日志印象 16 条中 7 条是'敏锐/伪装/试探'系标签，全天 54 次对话几乎没有关于面包价格、天气的平庸交谈——全员高智商表演是同质化的高级形态。
- 修法：模板改逐卡自定义 behavior_anchor 字段；只在社交场景注入；措辞留出'此刻也可以只是累了/馋了/什么都不想'的出口；对话模式明确允许'没什么可说就客套收尾或沉默'。

**[4/5 · M] 反思/晨间打算/观察推理/印象四条二级 prompt 丢失人设深度（只给 5 个形容词），产出通用 LLM 腔再以 importance 9 喂回主 prompt——声音同质化的放大回路**
- 证据：reflection.ts:64-65、morning-plan.ts:40-41 system 仅'你是X，职业。性格：5 个形容词'；observation-reasoning.ts:94-96 只有职业+地点；四处全部没有 speech.style/habits/psychology；这些同质文本作为'昨晚你想过'喂回，逐日冲淡 yml 个性。
- 修法：四个 prompt 统一补注 speech.style+habits+psychology 前两行；反思指令加'用你自己的口吻写，允许写你不敢对任何人说的（恶意、嫉妒、对某人的烦）'。成本仅小调用的输入 token 增量。

**[4/5 · S] memory-narrator 给所有角色写同一份硬编码温馨评注+反思是四格正能量问卷：'讨厌、憋屈、不甘'在数据链上游就被删除**
- 证据：memory-narrator.ts:101-156 gossip→'挺开心的'、comfort→'觉得做了对的事'、stargaze→'夜空很美'全员共享；reflection.ts:67-79 固定四问无'谁让你不舒服/你后悔什么'，concern 不入记忆；7day 反思 33/35 是满足/温暖系，Bob 破产挨饿反思'乐呵呵的（就是肚子有点饿）'。
- 修法：记忆模板去情感化只留事实（情绪交给 moodlet/反思层，或把当 tick LLM thought 前 30 字并入 event 记忆——零额外成本带上个人 voice）；反思加必答'今天最不顺的一件事/明天放不下的一件事'并允许答'没有'；用 7 天 sim 验证反思情绪分布不再 >80% 正面。

### 导演在无中生有：编排层替缺失的底层 stakes 造假戏

default 剧本的戏剧输入是自认'不是真正叙事内容'的日历占位 beats；导演被代码剥夺 do_nothing 权利、被告知'前置条件没满足但 deadline 到了必须让它发生'；干预手段被排序为'心灵直写最有效、世界侧事实最弱'。底层缺 drama→用导演硬造→造出来的因无因果而显假→越干预越像过家家。方向应是：导演退回'涌现的放大器'，投入转到底层冲突三件套。

**[5/5 · M] default 剧本 beats 全是占位 demo 但导演每天照常按假节拍开工：剧情时机由日历而非因果决定**
- 证据：beats.yml:3-4 文件头自述'主要为了 N3 阶段证明 BeatEngine 能触发，不是真正叙事内容'；:19-24 day1_complete 前置仅 world.day>=2、:30-35 关系涌现 beat 前置恒真占位、:64 前置干脆写 false 纯靠 day3 deadline；0704 实测第 3 天还在为 sanity beat 烧 director 日预算。
- 修法：删全部占位 beats，改少量真实状态反应型 beats（trust 跌破阈值/连续两次爽约/financeBand 进'揭不开锅'/宿敌同场），前置用 beats.yml 注释里已有的 characters.*.relationships/needs 上下文表达；写不出真条件的 beat 宁可不配。

**[4/5 · S] beat_ready 被代码+prompt 双重强制'必须写入'+fallback 把没发生的事按日历宣布为已发生：导演没有'此刻不该有事'的选项**
- 证据：director.ts:240-243 beat_ready 未写入时物理移除 do_nothing 工具；:272-281/:375-379 两处强制重试'你必须调用至少一个写工具'；:488-490 fallback 文案'前置条件没满足，但 deadline 到了，必须让它发生'——day5 世界里不存在紧密关系，导演也要表演出一个。
- 修法：'必须写'降级为 curated 剧本 climax beat 的专属 must_write 字段；default 下 beat_ready 允许 do_nothing 但要求附 read 到的证据；fallback 语义从'宣布发生'改'播种'（弱提示创造条件），milestone 语义 beat 一律不配 deadline。

**[4/5 · M] 干预无因果伪装：工具排序明确鼓励心灵直写（inject_intent'最有效首选'），seed_topic '必须聊'直改对话内容且无传播路径**
- 证据：director.ts:474 inject_intent'最有效，首选：直接影响下一 tick 行为'、:479 add_unresolved_event'效果最弱'；seed_topic 落地为 conversation-mode.ts:213-218'【必须说】的话题必须在这次对话中提到'的舞台监督指令，不经任何 in-world 渠道（绕过自建的八卦系统）直接植入多人脑内。
- 修法：①inject_intent/observation schema 加必填 cause 字段，落地包装成'你注意到…/你听X提过'带来源的观察；②add_unresolved_event 产出进在场者 observation 管道，prompt 排序反转扶正世界侧路径；③seed_topic 限单角色、措辞改'心里惦记着，聊到相关处自然带出'，多人知情必须走 add_rumor→八卦扩散链。

**[3/5 · M] 导演行为谱系只有轻推/撮合，没有制造冲突的原语也没有硬事件工具，tension 高了反而缩手——最硬的干预是改天气**
- 证据：director.ts:518-519 'tension>40 通常 do_nothing 即可'；director-tools.ts 全部 11 个工具无一能制造不可逆硬事件（grep 无 inject_world_event）；0704 实测 tension_rising（20+）对应的最强动作是 nudge_weather；世界不可能失窃/受伤/来陌生人，戏剧只能靠角色自嗨而角色又零摩擦，闭环卡死。
- 修法：①pacing 加冲突分支：tension 长期<15 且存在负面印象对时注入摩擦性观察（只放大已有负面状态不凭空捏造）；②补 surface_grudge + inject_world_event（失窃/损坏/陌生访客/物价冲击，带周限额与后果落库）；③sanity/一次性 beat 触发后自动 retire 别吃预算。

### 独立取证补充（主报告线外实锤，均有生产数据佐证）

**[5/5 · S] 剧本秘密全员泄漏（visible_to 丢失）**
- 证据：scenario-loader.ts:171 把 seeds.yml 原始对象直接 cast 成 camelCase 类型，`visible_to` 从未被读取；simulation.ts:961 `visibleTo: e.visibleTo ?? "*"` 兜底 → save.db 实测 last-ferry 的 asuka_real_reason_left（seeds 配置 [asuka]）落库为 "*"，narrative-state.ts:168 据此把所有秘密注入所有角色 prompt
- 修法：loadSeeds 显式映射 visible_to→visibleTo（involved 同步检查）；补一条"秘密事件不该出现在无关角色 prompt"的单测

**[4/5 · S] 存档记忆重复堆积**
- 证据：database.ts saveAll 只对 appointments DELETE 全量覆盖，memories/long_term_memories 裸 INSERT → 每次自动存档全量追加。用户 save.db 实测：memories 766 行仅 198 条 distinct（74% 重复）、long_term_memories 318 行仅 46 条（86% 重复）
- 修法：saveAll 事务里对两张记忆表同样 DELETE 后重插（或加唯一索引 upsert）

**[3/5 · S] 跨剧本存档污染**
- 证据：save.db 无 scenario 标识；用户今天跑 default（7 角色）续了 last-ferry 的 narrative_state——"3 天后末班船"征收令/剧情流言挂在日常角色 prompt 与长期记忆里（shinji LTM 有"听说她最近常去诊所"）
- 修法：world_state 存 scenario_id，loadGame 不匹配时拒载并提示另起档

**[3/5 · S] 印象"疑惑"槽自激成谍战腔**
- 证据：impression-updater.ts:60 印象格式强制"疑惑"项 + prompt-builder.ts:396 把疑惑注回作对话驱动力 → 每次互动必须制造悬念、下轮对话变试探。0704 新日志 16 条印象 7 条是"试探/伪装/猎手"框架
- 修法：疑惑改为可选（"没有就写无"已有但注回时不过滤）；注回频率节流，或只注入未解次数 ≥2 的疑惑

## 3. 正面发现（别修错方向）

- 对话文本质量已过关：0704 半天模拟 talk 25.4%（4 月 67.7%），台词有人设区分度，告别死循环被语义拦截压住（但拦截本身是断头台，见 §2）
- 涌现在真实发生但不可见：真嗣听 L 说 92 金币红包装糖 → 下午去杂货店看 → 买不起（47 金）→ 改送自烤可颂。系统没有任何呈现层让观看者看到这条线 → 「涌现叙事的可视化」值得单独立项
- prompt 层的反温柔腔/反比喻/白描指引都在且有效，不需要再堆写作指令

## 4. Quick Wins（1-2 天，按性价比排序）

1. agent-loop.ts:549 效果 switch 补 relationship_change case（≈1 小时）：argue -15、偷窃被抓 -20、送礼 +5 立刻从哑弹变真实，关系第一次可以下跌
2. tool-builder.ts:574-585 argue/comfort 补感知回路：仿 talk 加 inbox_message + 给对方写 importance 7-8 记忆 + angry/sad moodlet——吵架从独角戏变成能还嘴的回合
3. short-term.ts:171 对 [反思] 前缀豁免过滤（或反思改独立 type，reflection.ts:115）：importance-9 的昨晚反思不再在 5 个决策后从 prompt 消失
4. tool-builder.ts:432 talk 在场校验改用执行时的 actx.nearbyCharacters（一行修复）：消灭对已离开者的幽灵对话及其记忆污染
5. agent-loop.ts:308-334 断头台改造：语义重复用 Jaccard（mmr.ts 现成）判真重复才拦、同目标阈值放宽到 6，触发时不丢台词不代写 thought，改注入'这句说完自然道别'
6. buildToolList 接线 openHours（字段已在 location YAML 和类型里，纯消费点缺失）：深夜买拿铁、凌晨上班消失
7. reflection.ts prompt 加必答槽'今天最不顺的一件事/谁让你不舒服'+禁暖色抒情词库：破产不再'乐呵'
8. memory-narrator.ts 模板去情感化只留事实（删'挺开心的/觉得做了对的事'），情绪交给 moodlet/反思层
9. prompt-builder.ts:272 负面关系档位改许可语：rival→'你看这个人不顺眼，说话容易带刺'——系统判出的敌对能落进语气
10. 删 data/scenarios/default/beats.yml 占位 beats + director.ts:240-243 恢复 do_nothing 权利：导演停止按日历硬造剧情
11. conversation-mode.ts 复制 financeFeeling 路子：energy/hunger 低于 urgent 时注入'你困得睁不开眼：回话必须短、可以失礼、想尽快结束'
12. simulation.ts:1207 反思结果整体存 CharacterState.lastReflection 替代 getRecentThoughts(6) 字符串匹配：反思→晨间打算闭环不再靠夜里没人想事的运气
13. prompt-builder.ts:369 附近加关系事实约束'你们之间实际发生过的事只有：<记忆列表>，不要虚构共同过去/上周/平时'：掐断编造共同历史
14. prompt-builder.ts:597-602 buildTraitReminder 按情境节流（只在社交场景注入）+措辞留'此刻也可以只是累了'的出口
15. 用当前 7 人 cast 跑一次 pnpm test:sim seven-day 并在 sim-reporter 加长线指标（关系净变化含下降项/约定创建与兑现数/反思情绪分布/第1天vs第7天行为分布散度）——此后所有活人感改动的回归基线

## 5. Deep Work（按杠杆排序立项）

1. 冲突与负反馈系统（最高杠杆，quickWins 前两条修完后立项）：talk 关系增量按内容 valence 分档（挂到已在读全文的 impression-updater）、per-pair 积怨状态机 unresolved_conflict（起因/严重度/见面尴尬/道歉或送礼或时间解除）、jealous 情绪原语接目击基建（'挚友和别人有说有笑'触发）、负面印象产生行为后果（回避/冷淡/talk 心理成本）、非对称关系（A→B 与 B→A 拆开，单恋/错付成为可能）——验收：7 天窗口至少一对关系真实恶化
2. 语言→状态编译层：告别语义=真离场并写入对方观察；对话结束/夜间反思抽取承诺自动落成 appointment（复用爽约结算管线）；intent:lie/reveals/topic_tags 接回 buildTalkTool schema 让秘密与谎言机制在 default 剧本活过来；给七卡补 secrets 灌入 narrative-state 秘密池并追踪知情人集合，泄密→当事人感知→关系挫伤
3. 长期记忆与人物演化：运行时写 LTM（反思/冲突/约定结算当刻落库）+ 对话时按 relatedCharacterId/loadMemoriesAbout 检索'你们之间发生过的'注入 + rel.history 注入 prompt + 每 7 游戏天基于 LTM 跑 self-notes 自我更新（允许改写 aspiration）——让人被经历改变，传记→人格闭环
4. 职业与经济闭环：劳动产出真实物品进店铺库存被他人购买消费、顾客付款进营业额、员工收入挂钩客流、worker_tools 附带 skill_up 复活晋升系统、上架大件（吉他80/相机50）+储蓄目标+允许负债与讨债——回答'为什么要工作'，让钱造成命运分叉
5. 跨日目标与世界不可逆性：多日 Project/Goal 持久对象（进度/里程碑/可失败，入 SQLite）；命运事件层每 3-7 天一件有状态后果的意外（失窃真扣钱/扭伤限移动/店铺事故停业）；物品腐坏与工具耐久；天气马尔可夫链；director 补 inject_world_event 硬事件工具（带周限额）——打破第 1 天=第 7 天
6. 对话与时间调度重构（观感杠杆最大、工程最重，放最后但必须做）：对话升格场景级在单 tick 内跑 4-8 轮到自然收尾（告别=对话终点而非断头台）；群聊上下文（同地点时间线合并+可回应第三者）；效果按 duration 摊销（睡一半被吵醒只得部分恢复、约定到点可打断长动作产生'真爽约'的选择）；决策从 tick 解耦为激活队列+个体作息窗；go_to 距离成本与途中偶遇
7. 导演层重定位（依赖底层三件套完成后收尾）：default 剧本导演降为观察者（写预算 0-1/天、must_write 按剧本门控、fallback 改播种语义），干预一律带 cause 包装成有来源的感知，tension 指数改由真实涌现状态（积怨/财务/爽约）驱动，之后再写'条件=真实状态'的 beats——导演回归涌现放大器而非剧情制造机

## 6. 证据与复验入口

- 新鲜行为证据：`logs/sim-halfday-20260704-170054.md`（本次体检当天新跑，36 tick / 232s）
- 对照组：`logs/sim-halfday-20260409-221103.md`（告别死循环重灾区）、`sim-7day-log.txt`（3 月旧阵容 7 天）
- 用户实际观看内容：`logs/dev-server.log`（0704，default 剧本续污染档，D3 早晨）
- 回归基线（待建）：用当前 7 人阵容跑 `pnpm test:sim` seven-day，sim-reporter 加长线指标（关系净变化含下降项/约定创建与兑现/反思情绪分布/D1 vs D7 行为分布散度）
