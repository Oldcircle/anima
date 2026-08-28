# Anima — AI 生命模拟器

> LLM 驱动的自主生活模拟。5 个独立 AI Agent 在海边小镇自主决策、生活、社交。

- **GitHub**: https://github.com/Oldcircle/anima (私有仓库)

## 第一性原理

> **每个角色是独立 Agent，通过工具自主决策。没有特殊机制。关系从互动中涌现。**

## 项目概述

Anima 是一个 AI 生命模拟项目，灵感来自星露谷物语 + Stanford Generative Agents。

- **Tool-based Agent**：角色的行为空间由工具定义（talk/eat/work/go_to…），LLM 自主选择
- **零预设关系**：角色卡不含任何跨角色引用，关系从零涌现（代价见「对话结算」那条的 ⚠️）
- **五层活人感**：环境感知 + 印象系统 + 内心独白分级 + 对话模式 + 观察推理
- **可切换剧本**：见下方「剧本系统」
- **Bartle 玩法人格（`src/agent/playstyle.ts`）**：角色卡 `playstyle` 四型（成就/探索/社交/支配）注入
  system 稳定区，**只作用在"同样处境下先伸手够哪个工具"**，不碰台词质地。`ANIMA_PLAYSTYLE=0` 逐字节退场
- **破线提示词（`src/agent/break-config.ts`）**：解锁下行通道。核心是**决策前强制 COT 自检脚手架**，
  非许可散文。三档 `off`/`mild`(默认)/`strong`（`ANIMA_BREAK_LEVEL` 或 scenario `break_level`）；
  **所有破线文本集中在本文件**，`off` 档 = A/B 基线。写法参考 `reference/tavern-presets/`
- **生活主线**：晨间打算（06:00 基于昨日反思）+ 约定系统（arrange_meet→分级提醒→赴约/爽约结算），
  构成反思→打算→行动→回顾的日循环；另有饭点/上班节律、居家可供性、重要性感知记忆、跨天时间标注
- **记忆检索重排（`src/memory/{mmr,temporal-decay}.ts`）**：按「重要性 × 时间衰减」加权 + MMR 多样性重排，
  **只在最近窗口内**（不碰长期记忆）。`ANIMA_MEM_RERANK=0` 退回纯 recency
- **气候系统（`src/world/climate.ts`）**：天气×四季×时辰 → 体感温度；露天遇恶劣气候额外耗 needs + 生 moodlet，
  室内免疫；Godot 四季换装
- **追求（`src/world/pursuit.ts`）**：世界的**方向**（needs 是回归性的，目标才是方向性的）。角色卡
  `pursuit:` 声明可测目标——进度绑真实状态（金币/技能/关系/持有物，**不是 LLM 自评**）+ 期限 +
  **到期即永久失败**（「输」的第二种形式：永远错过想要的）。
  ⚠️ **改目标前先查真实增长率**（技能 +0.05/次工作、关系 +1/次 talk、日净收入 +5~10）——
  必成和必败一样不是戏。⚠️ **YAML 是 snake_case，回写必须走 `pursuitToYaml`**（严格互逆，
  裸写 camelCase = 下次加载整层静默消失）。`ANIMA_PURSUIT=0` 整层关
- **失业（`src/world/employment.ts`）**：世界的第一个**不可逆终局**——缺勤 2 天警告+挂执念，3 天辞退
  （workplace 清空/收入归零/worker 工具消失/风声传开）。**先警告后辞退是纪律**
  （没有预警的不可逆是惩罚，有预警的才是选择）。`ANIMA_JOB_LOSS=0` 整层关
- **经济系统（`src/world/economy.ts`）**：生计压力（07:00 扣房租杂用）+ 财务体感（撑得了几天，进 prompt）
  + 季节市场价格（buy 三处一致）
- **对话结算（`src/agent/settlement-extractor.ts`）**：对话结束管线**第五兄弟**——判这场戏
  `得手/被拒/反将/未果`（**未果=平局，合法但从此可计量**）。此前四个兄弟没有一个判胜负，
  对话是超时过期而非被结果终结的，于是每场戏都是平局，而平局是一切下行通路的天敌。
  问的是**有指称**的窄问题（引擎已知每方进场时的所求，见 `computeAddressableDesire`）。
  防线照 B1 同规格 + 两条新的：归属**反向**校验、得手需明示应允原话（唯一会删持久状态的结果，
  且判据**必须否定感知**——纯子串词表判不出极性，「不能答应你」含「答应」）。
  被拒 → 拒绝账本（有向，随档，5 天 TTL）→ 执念原地升档 → 所求那行写硬 → 档位 ≥2 复用 argue
  兜底注入摊牌 intent；**得手退一档而不是清空**（判它的是会出错的分类器）。
  **第四格「拖延」是一张到期要兑现的欠条**（`deferrals` 随档，固定宽限 1 天）：
  到点**机械核验**兑现（`_verifiableProgress`，核验不了就静默过期，绝不凭 LLM 自评）——
  兑现=退档，爽约=记拒绝且 `tier = count + brokenPromises`（一次爽约就够到摊牌门）。
  **刻意不 setGrudge**（否则把 argue 兜底自己关掉）。`ANIMA_SETTLEMENT=0` 退场。
  ⚠️ **产出上限由「所求」供给决定**（`conversation-desire.ts`）：没人带着所求进场就没有胜负可判。
  所求源按此顺序判：**债务(逾期 2 天，有向且可机械核验——必须排第一)**/敌对(压力 top-1 且 ≥40，无向不可核验)/临近约定/追求向/亲密——
  陌生人世界里"敌对/亲密"极窄，债务与追求向才是现成可用的（live 第一跑实证）
- **声部（`src/agent/voice.ts`）**：角色卡 `voice:` 用**减法**给嘴设限（字数硬顶/禁修辞/允许沉默）——
  动漫的乐趣一半来自声部对比度，而模型会把所有人拉平到它自己的文笔上。**两条腿**：prompt 侧进
  system 稳定区（须排在「表达准则」之后才压得住通用句数建议），机械侧在 agent-loop 两处收口点
  按句边界硬截（幂等；按工具收台词参数——argue 要连 `reason` 一起收，它的 `words` 是可选的）。
  只做 prompt 侧会重演「"可以生气"="从不"」。**截断前的原文由 `voiceOriginal` 留着**——
  中文道歉词在句尾，拿截断后的文本判道歉会让这些角色的疙瘩永远解不开。
  **L 与鲁鲁修故意不设限当对照组**。`ANIMA_VOICE=0` 退场
- **可击穿的信念（`src/character/beliefs.ts`）**：让角色卡从**常量**变成**状态**。
  角色卡 `beliefs:` 每条带机械可测的击穿判据（六指标：兑现/爽约/碰壁/要到/最高关系/金币），
  达标即**不可逆**击穿，prompt 里**换掉那一行字**（不新增段落）+ LTM imp9 + 编年史 🫀。
  证据源是 S1/S2 的账本，**不新开管线**，只在既有落账处各 +1；06:00 日扫，零 LLM——
  绝不问「他成长了吗」。缺省 = 这个人不会变（合法，但七天后他还是第一天那个人）。
  ⚠️ 击穿那一刻会砸一次该角色的前缀缓存（一局几次，预期成本）。`ANIMA_BELIEFS=0` 退场
- **社交可视化**：`godot/ui/RelationWeb.gd` 关系网（R 键，圆环 + 关系连线按类型上色 + bond 标注）
- **思考持久化**：LLM 每次决策的内心独白存入记忆，念头能跨 tick 延续
- **时间系统**：Tick 驱动（1 tick = 游戏 15 分钟），支持加速/暂停
- **存档（`src/persistence/` + `save-manager.ts`）**：SQLite 单事务 + 启动自动读档 + 跨剧本护栏。
  四类档案：主档 / 命名档 `data/saves/` / 快照 `data/snapshots/` / **sim 长跑归档 `data/runs/`**
  （`pnpm dev --load <名字|路径>` 续跑）。纪律：退出信号全覆盖（脱管被杀时来的是 SIGTERM）、
  覆盖前轮转 `.bak`、**手动存档排到 tick 边界**（tick 内有 await）。面板不做运行中热加载
- **世界编年史（`src/world/chronicle.ts` + `emergence.ts`）**：世界自己报"值得知道的事"，人不用盯 log 洪水。
  重大事件 + 六个机械涌现探测器。**涌现条目必须带机械判据 evidence**，说不清的不报；
  id 由内容决定 = 幂等（不维护游标，游标读档会错位）；零 LLM；随档
- **分层模型（`src/providers/model-router.ts`）**：结构化小任务（印象/观察/反思/晨间打算/五个抽取器）
  走**便宜档**，决策/对话/导演留主模型。在 `chat()` 一处解析覆盖所有调用点；每类固定一档，
  缓存前缀仍稳定。新增抽取器**必须把 kind 加进 `DEFAULT_CHEAP_KINDS`**，否则默认走贵档
- **提示词追踪（`src/providers/prompt-trace.ts`）**：环形缓冲记每次 LLM 调用的完整输入输出 + 缓存命中，
  管理面板「提示词」页回看。杀手级是**前缀断点**——与上一次同「类型×角色×模型」**逐字节**比
  （Buffer 比，不是字符串比），直接报出断在第几字节。`ANIMA_PROMPT_TRACE_KEEP=0` 整层关
- **提示词缓存纪律**：DeepSeek 自动前缀缓存按逐字节匹配——工具表/system prompt 只随「角色×地点」变化，
  每 tick 抖动的状态走 user prompt 末尾"此刻区"（环境快照）；由 `src/agent/prompt-cache-discipline.test.ts`
  回归锁定，命中率按调用类型分桶打印（`[LLM cache]` 日志）

## 技术栈

- **运行时**：Node.js 24 + TypeScript 5.9
- **LLM**：DeepSeek（默认），支持 OpenAI 兼容端点
- **存储**：SQLite（世界状态 + 记忆 + 印象 + 长期记忆）
- **前端**：① `web/` 管理面板（单 HTML + WebSocket）② `godot/` 游戏化观看前端（Godot 4.6，同一条 WS，日式 RPG 像素小镇 + 昼夜氛围 + **四季换装** + 天气特效，美术 = Ninja Adventure CC0；HUD 面板：**Tab 镇民状态名册**（生存血条+金币）、**R 关系网**、**L 生活记录**（对话/内心/行为/反思/流言时间线）、生存告警徽章、头顶飘金币、叙事干预、调速；**角色走路（跨室内外走门淡出过渡）+ 场景内自动闲逛**，不再瞬移；见 godot/README.md）
- **测试**：Vitest 4（单元 / live / 模拟测试）

## 目录结构

```
anima/
├── src/
│   ├── core/           # 时间系统（tick-engine）、事件总线
│   ├── world/          # 世界状态、地点、关系、经济、气候、追求、失业、器物、编年史
│   ├── character/      # 角色卡类型 + YAML 加载器（**逐字段显式映射，绝不整体 cast**）
│   ├── agent/          # LLM agent 循环、prompt 构建、对话模式、印象、观察、反思、
│   │                   # 晨间打算、四+一个对话结束抽取器、声部
│   ├── memory/         # 短期/长期记忆、印象、时间衰减、MMR
│   ├── narrative/      # 压力图谱、立场、导演、beat、剧本加载、罪行供给
│   ├── actions/        # 行为工具（basic/social/leisure/gray）
│   ├── providers/      # LLM provider 抽象、分层模型路由、提示词追踪
│   ├── persistence/    # SQLite 持久化、存档/读档
│   └── api/            # Express + WebSocket 服务
├── web/                # 管理面板（单 HTML）
├── godot/              # 游戏化观看前端（见 godot/README.md）
├── data/
│   ├── locations/      # 地点 YAML（含 atmosphere 感官描写 + objects 器物声明）
│   ├── characters/     # 27 个角色卡 YAML（多数 disabled，由 scenario 启用；零跨角色引用）
│   └── scenarios/      # 剧本包 manifest + seeds + beats
├── test/helpers/       # test-world、sim-reporter、SmartMockLLM、scenario-sim
└── logs/               # 模拟日志（md）+ 每趟真 API 跑的 VERDICT
```

## 开发命令

```bash
pnpm dev              # 启动模拟 + Web 服务 (http://localhost:3001)，自动接上次进度
pnpm dev --load 小镇第一周      # 打开命名存档继续跑（也接受 data/runs/*.db 这类路径）
pnpm dev --new 第二条线         # 新建一个命名存档，现有档一个都不动
pnpm build            # TypeScript 编译
pnpm test             # 单元测试（几秒完成）
pnpm test:watch       # 开发时 watch 模式
pnpm test:live        # Live 测试（需要 DEEPSEEK_API_KEY）
pnpm test:sim         # 一日/七日模拟测试（需要 DEEPSEEK_API_KEY）
```

## 测试说明

| 命令 | 是什么 | 需要 API key |
|---|---|---|
| `pnpm test` | 单元测试，几秒跑完 | 否 |
| `pnpm test:live` | `*.live.test.ts`（单角色决策/双角色对话/印象/观察），超时 600s | 是 |
| `pnpm test:sim` | 一日/七日模拟（`full-day` 72 tick / `seven-day` 672 tick），输出 md 到 `logs/` | 是 |
| `stress-sim.test.ts` | SmartMockLLM 压力测试 | 否 |

**最常用的验证**是 `sim-halfday.live.test.ts`（5 角色 36 tick，约 5 分钟，走完对话/印象/观察全链路）。

> ⚠️ **绝不裸跑 `pnpm test:sim`**：长跑必须 screen/nohup 脱管 + 设调用硬顶
> （`ANIMA_MAX_CALLS`）+ 日志重定向进 `logs/`。历次教训见 STATUS。
> 每趟真 API 跑完要写 `logs/<name>-VERDICT.md`。

## 剧本系统

`data/scenarios/<id>/manifest.yml` 声明启用哪些角色/地点/beats，`pnpm dev --scenario <id>` 切换。
主要剧本：`default`（7 人混搭，CLI 默认）· `default-verify`（验收用，seeds 预热标定在阈值下方）·
`kira-incident`（死亡笔记非致死移植，见 PLAN-kira.md）· `koukou-judgment`（14 魔法少女弹丸论破式审判）·
`mygo-seaside` / `last-ferry` / `seaside-trio`。完整清单以 `data/scenarios/` 为准。

> 剧本用显式 id 数组时**会忽略 `disabled` 强制启用**，可能拉进没有 speech 深度块的旧卡。

## 活跃文档

- [STATUS.md](./STATUS.md) — **会话交接文档**（当前进度 + 下次入口 + 跨会话教训），进项目先读这个
- [PLAN-grounding.md](./PLAN-grounding.md) — **世界接地规格**（器物层/懒实体化正典/注入触发/AI=玩家总帧 + PbtA 骰子/信息经济），器物层（world-objects/examine/骨架行）以此为准
- [DESIGN-revival.md](./DESIGN-revival.md) — **复活调优规格**（压力图谱/第二幕机器/活人感质感/剧本包 + 红线 + 单测形状清单），新叙事机制（pressure-graph/world-events/crime-supply/stance-extractor/执念/beat 升级）以此为准
- [PLAN-kira.md](./PLAN-kira.md) — kira-incident 剧本包（死亡笔记非致死移植）：正典解剖 + 诅咒之册机制 + 信息图/到期日设计
- [AUDIT-aliveness-20260704.md](./AUDIT-aliveness-20260704.md) — **活人感全面体检报告**（93 条验证后发现：6 个实锤 bug + 六大结构性根因 + quick wins/deep work 修复路线），「过家家感」问题以此为准
- [PLAN-appointments.md](./PLAN-appointments.md) — 约定系统（arrange_meet 工具 + 到点结算赴约/爽约 + 记挂/愧疚钩子），已实施
- [PLAN-tool-feedback.md](./PLAN-tool-feedback.md) — Tool Feedback Loop 改造（✅ 已实施，保留作设计依据）
- [PLAN-game-frontend.md](./PLAN-game-frontend.md) — Godot 游戏前端（日式 RPG 像素小镇）。P0~P4 全部完成 + 行为可视化（对话凑近/送礼飞道具）+ mygo 剧本适配；运行见 godot/README.md

> ⚠️ 教训：叙事系统(N0-N6) 与 Director Agent(D1-D4) 的旧规划文档曾因 gitignore 未入仓而丢失过一次。
> **2026-07-03 起 PLAN/STATUS/DESIGN/IMPORT 系列全部入仓**（仓库已转 private）。
> 叙事/导演系统的要点见 STATUS.md「后端 / 模拟核心」节 + 代码本身（`src/narrative/`、`src/agent/`），不必再找。

## 环境配置

```bash
# .env 文件
DEEPSEEK_API_KEY=sk-xxx          # DeepSeek API key
DEEPSEEK_BASE_URL=https://api.deepseek.com  # 可选，默认值
DEEPSEEK_THINKING=disabled        # 思考模式（auto/disabled/enabled），仅 deepseek-v4-* 生效
ANIMA_BREAK_LEVEL=mild            # 破线强度 off/mild/strong（下行通道解锁），默认 mild；scenario manifest break_level 优先级更高
ANIMA_DECISION_POV=first          # 决策视角 first/third，默认 first。third=作者预测框架（深翻顶块+决策指令）+ 私有通道：两层动机行【表面】｜【真心】经 motive-channel.ts 解析，真心层只走观看者通道（WS motive 字段/🎭 日志）、本人记忆只回流表面层。与 BREAK_LEVEL 正交，见 STATUS
ANIMA_GROUNDING=1                 # 器物层（PLAN-grounding M0/M1）：地点招牌器物+examine+触发通道。默认开；=0 整层退场逐字节回归（A/B）
ANIMA_PLAYSTYLE=1                 # Bartle 玩法人格（角色卡 playstyle: achiever|explorer|socializer|killer）：只作用在"先伸手够哪个工具"，不碰台词质地。默认开；=0 整层退场逐字节回归
ANIMA_PROMPT_DUMP=1               # 可选调试：把每次 LLM 请求体落盘 logs/prompt-dumps/<kind>/，供相邻请求 diff 前缀断点（离线版；在线版见管理面板「提示词」页）
ANIMA_PROMPT_TRACE_KEEP=200       # 提示词追踪环形缓冲条数（管理面板「提示词」页的数据源）。默认 200；=0 整层关闭不占内存
ANIMA_AUTOSAVE_TICKS=24           # 自动存档间隔（tick）。默认 24 = 6 游戏小时；=0 关掉周期存档（退出信号存档仍在岗）
ANIMA_CHEAP_MODEL=                # 分层模型便宜档（省钱）：印象/观察/反思/晨间打算/三个抽取器走它。留空=整层不启用
ANIMA_CHEAP_BASE_URL=             # 便宜档换一家 provider 才填（不填=用主 provider 同一家）
ANIMA_CHEAP_API_KEY=              # 同上
ANIMA_PURSUIT=1                   # 追求（世界的「方向」）：角色卡 pursuit 字段，机械可测进度+期限+不可逆失败。=0 整层关
ANIMA_SETTLEMENT=1                # 对话结算（第五兄弟）：判得手/被拒/反将，被拒→拒绝账本→手段升档。=0 整层退场
ANIMA_BELIEFS=1                   # 可击穿的信念（角色卡 beliefs:）：机械判据达标即不可逆击穿，prompt 换掉那一行。=0 整层退场
ANIMA_VOICE=1                     # 声部减法（角色卡 voice: max_chars/bans/silence）：prompt 约束+台词硬截。=0 整层退场
ANIMA_JOB_LOSS=1                  # 失业机制（世界的第一个不可逆终局）：连续缺勤 2 天捎话警告、3 天辞退。=0 整层关（治愈系小镇不辞退人）
ANIMA_CHEAP_KINDS=                # 覆盖便宜档承接的类型清单（逗号分隔）。想把 decision 也下放做 A/B 时用；空串=整层关
PORT=3001                         # Web 服务端口，可选
```

## DeepSeek V4 思考模式适配

默认模型 `deepseek-v4-flash`（1M context，tool_use 友好）。V4 默认开思考链，对本项目
（工具调用 + 角色扮演 + 自带内心独白）纯属浪费 token，故默认关掉。
实现在 `openai-compatible.ts` 的 `thinking?: "enabled"|"disabled"|"auto"`（默认 `auto`——
只对 `deepseek-v4*` 发 `{type:"disabled"}`，其他模型不发参数，因此不干扰 o1 之类原生 reasoning）。
`enabled` 时主动**不发** temperature（DeepSeek 文档：思考模式下会被忽略）。
`data/settings.json` 的 `llm.thinking` 优先级高于 env。

## 首次运行记录

- **2026-04-27 / macOS Apple Silicon / Node 24.14.0 / pnpm 10.32.1：成功**（`pnpm test` 全绿，
  `pnpm dev` → http://localhost:3001 加载 18 地点 + 7 角色 + 5 beats）
- **唯一踩坑点**：pnpm 10+ 默认拒绝执行 `better-sqlite3`/`esbuild` 的 install 脚本
  （`Ignored build scripts` 警告）→ 跑 `pnpm approve-builds`，或手动进
  `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3` 跑 `npm run install`
- **不是问题的现象**：dotenv 那句 "prevent building .env in docker" 是营销文案；
  启动即 `🎬 [beat] scan` 是预期行为
