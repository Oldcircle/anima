<div align="center">

# 🌙 Anima

### *动漫角色们生活、工作、密谋、相撞的地方*

**LLM 驱动的自主生活模拟器。七位家喻户晓的动漫角色共享一个海边小镇——每一个都是完全自主的 Agent，每个 game tick 自己决定下一步做什么。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-43853d?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![DeepSeek](https://img.shields.io/badge/LLM-DeepSeek%20%2F%20OpenAI%20%E5%85%BC%E5%AE%B9-7c3aed?style=for-the-badge)](#-llm-providers)
[![Tests](https://img.shields.io/badge/tests-266%20passing-3fb950?style=for-the-badge)](src)

[English](README.md) · **简体中文**

---

</div>

## ✨ Anima 是什么？

Anima **不是**聊天机器人。也不是带剧本 NPC 的游戏。它是一个 **24/7 自动运行的社交模拟**——每个角色都是独立的 LLM agent，根据以下信息决定下一步做什么：

- **他们需要什么**（饥饿、精力、社交、卫生……）
- **他们记得谁**（印象、关系、流言）
- **周围发生什么**（其他角色可观察到的行为、天气、时间）
- **他们是谁**（参考 SillyTavern 角色卡格式的深度人格描写）

然后从几十个**工具**里挑一个（talk、eat、work、go_to、give、steal……）执行。戏剧自然涌现。友谊建立。有人开始疏远。某人慢慢意识到事情不太对。

## 🎭 现役阵容

当前世界里住着动漫史上最具标志性的七个角色——而且他们彼此处不来。

| 角色 | 出处 | 工作 | 隐藏张力 |
|---|---|---|---|
| **L** | 死亡笔记 | 图书馆研究员 | 已经 12% 确信月就是 Kira |
| **夜神月** | 死亡笔记 | 图书馆助理 | 完美的优等生。别问他笔记本里写了什么。 |
| **碇真嗣** | 新世纪福音战士 | 面包店学徒 | 连呼吸都要道歉 |
| **明日香·兰格雷** | 新世纪福音战士 | 咖啡馆店员 | 每天找借口出现在真嗣附近，绝不承认 |
| **绫波丽** | 新世纪福音战士 | 花店店员 | 不理解"你最喜欢哪种花"是什么意思 |
| **鲁鲁修·兰佩路基** | Code Geass | 咖啡馆店员 | 月的镜像——他自己很清楚 |
| **战场原黑仪** | 化物语 | 杂货店店员 | 口袋里揣着钉书机。当武器用。 |

**冲突矩阵**：L ↔ 月（鼠猫核心）/ 月 ↔ 鲁鲁修（两个"我即正义"互相警觉）/ 真嗣 ↔ 明日香（毒性依赖）/ 战场原 ↔ 任何小看她的人。

让仿真跑一个小时，你会看到自己根本没写过的剧情。

## 🧠 核心机制

- **基于工具的 Agent**——每个行为都是函数调用。没有写死的行为。角色卡定义性格，工具列表定义可能性。
- **五层活人感**——环境氛围、印象系统、内心独白分级、对话模式、观察推理。
- **持久化的内心独白**——LLM 每次决策的思考都存进记忆。念头能跨 tick 延续。
- **生活惯性**——`currentIntent` 让未完成的事保持挂着（你想回她消息但还没回）。`observableState` 让别人看到"她端着半凉的拿铁发着呆"。
- **热重载**——在 UI 里编辑角色或地点，变更会在下个 tick 间隙生效，不会打断进行中的决策。
- **存储**——SQLite 存世界状态，YAML 存角色卡和地点，JSON 存 LLM 设置。

## 🖥️ 管理面板

`web/` 目录里是一个零构建的 Preact + htm 网页 UI。打开后可以：

- **实时**——看仿真一个 tick 一个 tick 推进，谁在哪、说了什么
- **角色**——完整的角色卡 CRUD，5 标签编辑器（基本/性格/背景/生活/JSON 预览）
- **地点**——编辑地点、按时段编辑氛围描述、营业时间
- **设置**——12 个 OpenAI 兼容 LLM provider 任选（DeepSeek / OpenAI / OpenRouter / Groq / Mistral / Together / Fireworks / Moonshot / 硅基流动 / Ollama / ……），自动填 endpoint + 一键切换模型，保存前可以测连接

角色和地点都支持**软停用**（保留 YAML 文件），适合频繁试验新阵容。

## 🚀 快速开始

```bash
# 1. 克隆 + 安装
git clone https://github.com/Oldcircle/anima.git
cd anima
pnpm install

# 2.（可选）配置 LLM——也可以装完后直接在 UI 里设置
cp .env.example .env  # 填 DEEPSEEK_API_KEY 或你用的 provider

# 3. 启动
pnpm dev
# → http://localhost:3001
```

就这样。打开页面，如果跳过了第 2 步就去 **Settings** 配 key，然后看七个角色苏醒、开始他们的一天。

## 🔑 LLM Provider

Anima 说的是 **OpenAI Chat Completions** 方言。任何兼容它的服务都能用：

| Provider | 备注 |
|---|---|
| DeepSeek | 默认。便宜，中文强 |
| OpenAI | gpt-4.1, gpt-4o, gpt-4o-mini |
| OpenRouter | 聚合器——Claude / Gemini / Llama 都能选 |
| Groq | 极速 Llama / Gemma 推理 |
| Mistral, xAI, Together, Fireworks, Moonshot, 硅基流动 | Settings 下拉里都有 |
| Ollama | **本地模型，不需要 key** |
| Custom | 任何 OpenAI 兼容端点 |

在 **Settings** 页配置——也可以在 `.env` 里设 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`。`data/settings.json` 优先级高于 `.env`，下个 tick 自动生效。

## 🛠️ 技术栈

| | |
|---|---|
| **运行时** | Node.js 24 + TypeScript 5.9 |
| **LLM** | OpenAI 兼容（默认 DeepSeek） |
| **存储** | SQLite (better-sqlite3) + YAML + JSON |
| **Web** | Express 5 + WebSocket + Preact (CDN) + htm |
| **测试** | Vitest 4 — 266 个测试通过 |

## 🧪 命令

```bash
pnpm dev              # 启动仿真 + 管理面板  → :3001
pnpm build            # tsc 编译
pnpm test             # 266 个单元测试，不需要 API key
pnpm test:watch       # 监听模式
pnpm test:live        # Live LLM 测试（需要 key）
pnpm test:sim         # 多天模拟测试（需要 key）
```

## 📁 目录结构

```
anima/
├── src/
│   ├── core/           # tick 引擎、事件总线
│   ├── world/          # 世界状态、地点、天气、关系
│   ├── character/      # 角色卡类型 & YAML 加载器
│   ├── agent/          # agent 循环、prompt 构建、对话模式
│   ├── memory/         # 短期记忆、印象、时间衰减
│   ├── actions/        # 行为工具（talk/eat/work/go_to/...）
│   ├── providers/      # LLM provider 抽象
│   ├── persistence/    # SQLite 存档读档
│   ├── api/            # Express + WebSocket + admin CRUD 路由
│   └── shared/         # 校验 & schema
├── web/                # 管理面板（零构建 Preact + htm）
│   ├── index.html
│   ├── legacy.html     # 原始观察面板
│   └── app/            # main.js、providers.js、styles.css
├── data/
│   ├── characters/     # 角色卡（YAML）
│   └── locations/      # 地点（YAML）
└── test/
```

## 🤝 贡献

Anima 是一个私人实验——「如果把著名虚构角色当成自主 agent 会发生什么」。Issue、PR、还有**奇怪的新角色卡**都欢迎。

加新角色：往 `data/characters/` 丢一个 YAML 文件，重启，搞定。或者用管理面板的「+ 新建角色」按钮。

## 📄 License

[MIT](LICENSE) © Anima contributors

---

<div align="center">

*跑仿真。不要写剧本。让他们给你惊喜。*

</div>
