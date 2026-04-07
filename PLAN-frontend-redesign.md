# Anima — 管理前端重构计划（web/）

> 对象：`web/` 观察/管理面板（不是 `web-game/` 像素 RPG，那条线另行推进）。
> 目标：从「单 HTML 只读观察器」升级为「可配置 + 可编辑」的运营面板，参考 SillyTavern / RisuAI 的信息架构。

## 1. 目标与非目标

### 目标
1. **API 设置面板**：在前端配置 LLM provider（base URL / api key / model / 温度等），无需改 `.env` 重启
2. **角色 CRUD**：列表、查看、新建、编辑、删除角色卡（对应 `data/characters/*.yml`）
3. **地点 CRUD**：列表、查看、新建、编辑、删除地点（对应 `data/locations/*.yml`）
4. **整体 UI 重构**：采用左侧导航 + 主面板的经典布局，参考 SillyTavern 的 tab 切换 + 抽屉式编辑器
5. **保留观察能力**：现有 tick 推进、对话流、印象、关系图等只读视图全部迁移到新框架

### 非目标
- 不动 `web-game/`（Phaser 像素端）
- 不做多用户/权限/账号
- 不做云端同步，所有数据仍本地 SQLite + YAML
- 不引入复杂状态管理框架（Redux 等），保持轻量

## 2. 现状速记

- `web/index.html`：611 行单文件，纯 vanilla JS + WS 客户端，只读
- 后端 `src/api/server.ts`：**只有 GET 路由**（state / characters / events / impressions / cards / conversations），无写接口、无 provider 配置接口
- 数据源：
  - 角色卡：`data/characters/*.yml`（6 个）
  - 地点：`data/locations/*.yml`（12 个）
  - LLM provider：`.env`（DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL）+ `src/providers/`
- 写入意味着要让仿真在运行时热重载角色/地点/provider 配置——这是关键技术风险点

## 3. 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| 框架 | **Vite + 原生 TS + Web Components** 或 **Vite + Preact** | 与后端 TS 一致；包小；不绑大框架 |
| UI 组件 | 自写 + 少量 CSS 变量主题 | 参考 SillyTavern 的暗色配色 |
| 状态 | 模块级 store（订阅 + Pub/Sub）+ WS 单连 | 不引入 Redux/Zustand |
| 构建 | Vite，输出到 `web/dist/`，server 静态托管 | 与现 staticDir 兼容 |
| 表单 | 简单受控表单 + JSON Schema 校验（角色/地点 schema 抽出来共享） | 复用后端 types |

> 决策点（待用户确认）：**Preact vs 原生 Web Components**。Preact 上手快、生态足够；原生方案更贴近现状。默认用 **Preact**，除非有偏好。

## 4. 后端改动（先于前端）

### 4.1 新增写接口
```
POST   /api/characters             # 新建（body 是角色卡 JSON）
PUT    /api/characters/:id         # 全量更新
DELETE /api/characters/:id         # 删除
POST   /api/locations              # 新建
GET    /api/locations              # 列表（当前缺）
GET    /api/locations/:id
PUT    /api/locations/:id
DELETE /api/locations/:id
```
- 写接口落盘到 `data/characters/*.yml` / `data/locations/*.yml`
- 触发热重载：通知 simulation 重新装载对应角色/地点；正在执行的角色 tick 不打断，下一 tick 生效
- 删除角色：需要决定是「软停用」还是「真删」。**默认软停用**（在 YAML 加 `disabled: true`），避免历史记忆悬空

### 4.2 Provider 配置接口
```
GET  /api/settings/llm     # 当前配置（key 脱敏只返回末 4 位）
PUT  /api/settings/llm     # 更新配置（base URL / api key / model / temperature / provider 类型）
POST /api/settings/llm/test  # 用当前 body 试调一次，返回 latency + sample 输出
```
- 落盘到 `data/settings.json`（gitignore），优先级高于 `.env`
- 支持多 provider profile（OpenAI / DeepSeek / 自定义 OpenAI 兼容端点），下拉切换
- 修改后通知 `src/providers/` 重新构造客户端实例

### 4.3 Schema 共享
- 把 `CharacterCard` / `LocationDef` 的 TS 类型抽到 `src/shared/schemas/`
- 用 `zod` 或纯 TS guard 做后端校验
- 前端复用同一份类型（vite alias 引用 `src/shared`）

## 5. 前端 UI 结构

```
┌─────────────────────────────────────────────────────────────┐
│ Topbar:  [Anima] [Tick: 124 06:15] [▶ ⏸ ⏩]   [⚙ Settings] │
├──────────┬──────────────────────────────────────────────────┤
│ Sidebar  │ Main panel (路由切换)                           │
│          │                                                  │
│ Live     │ ┌── Live ─────────────────────────────────────┐ │
│ Chars    │ │ 当前 tick 快照 / 对话流 / 角色场上位置        │ │
│ Places   │ └─────────────────────────────────────────────┘ │
│ Memory   │ ┌── Characters ───────────────────────────────┐ │
│ Logs     │ │ 卡片网格 → 点击进抽屉编辑器                   │ │
│ Settings │ │ [+ New Character]                            │ │
│          │ └─────────────────────────────────────────────┘ │
└──────────┴──────────────────────────────────────────────────┘
```

### 路由（哈希路由即可）
- `#/live` — 默认；现有观察面板内容
- `#/characters` — 角色列表 + 抽屉编辑器
- `#/characters/:id` — 角色详情（性格/记忆/印象/最近行为）
- `#/locations` — 地点列表 + 抽屉编辑器
- `#/memory` — 印象与关系图（现有内容迁移）
- `#/logs` — 事件流 + 对话历史
- `#/settings` — API 设置 / 仿真设置 / 数据导出

### 角色编辑器（抽屉式，参考 SillyTavern）
分 tab：
1. **基本**：id / name / 职业 / 头像（暂用 emoji 或本地路径）
2. **性格**：核心性格描述、说话风格、口头禅
3. **背景**：背景故事、价值观
4. **行为**：可用工具白名单、初始位置、初始 needs
5. **高级**：模型覆盖（可选 per-character provider）、disabled 开关
6. **预览**：渲染最终 prompt 片段，方便调试

### 设置页结构
1. **LLM Provider**
   - Provider 类型（OpenAI / DeepSeek / 自定义）
   - Base URL / API Key（密文输入 + 显示末 4 位） / Model / Temperature / max tokens
   - [Test connection] 按钮 → 显示 latency + sample
   - 多 profile + 默认 profile 选择
2. **仿真**：tick 速度、自动暂停条件、日志详细度
3. **数据**：导出/导入 YAML、清空记忆、重置世界

## 实施进度

- ✅ Phase A — 后端 schema + CRUD + 设置接口 + 热重载（266 tests pass）
- ✅ Phase B — 前端脚手架（Preact + htm via esm.sh，**零构建步骤**）
- ✅ Phase C — Settings 页（LLM provider 表单 + test 按钮）
- ✅ Phase D — 角色 CRUD（列表 + 5 tab 抽屉编辑器 + 软停用/永久删除）
- ✅ Phase E — 地点 CRUD（列表 + 编辑器 + atmosphere 编辑）
- ✅ Phase F — 旧 `index.html` 改名 `legacy.html`，作为 `#/live` iframe 内嵌

> 实际选型变更：放弃 Vite + Preact 构建链，改用 Preact + htm 通过 esm.sh CDN 直接 ESM 加载。
> 理由：零依赖、零构建、不动 package.json，刷新即生效。后续如需打包再切回 Vite。

## 6. 实施分期

### Phase A — 后端写接口与 schema（前置）
- [ ] 抽 schema 到 `src/shared/schemas/`，加 zod 校验
- [ ] 角色 CRUD 路由 + YAML 读写 + 热重载
- [ ] 地点 CRUD 路由 + 热重载
- [ ] Provider 配置接口 + `data/settings.json` 持久化 + 客户端热重建
- [ ] 单元测试：CRUD + 热重载 + provider 切换
- 验收：用 curl 跑通全部新接口

### Phase B — 前端脚手架
- [ ] `web/` 改为 Vite + Preact 项目，保留旧 index.html 作为 fallback
- [ ] 实现 topbar + sidebar + 哈希路由 + 主题
- [ ] WS client 抽成 store，跨页共享
- [ ] 把现有「观察面板」原样搬到 `#/live` 页

### Phase C — Settings 页
- [ ] LLM provider 表单 + test 按钮
- [ ] 表单与后端联调

### Phase D — 角色 CRUD
- [ ] 角色列表 + 卡片视图
- [ ] 抽屉式编辑器（6 个 tab）
- [ ] 新建 / 删除 / 软停用
- [ ] 详情页：实时 needs / currentIntent / observableState / 最近对话

### Phase E — 地点 CRUD
- [ ] 列表 + 编辑器
- [ ] 删除前提示「正在使用此地点的角色」
- [ ] atmosphere 字段的多行编辑器

### Phase F — 收尾
- [ ] 旧 `web/index.html` 删除或归档
- [ ] CLAUDE.md / STATUS.md / DESIGN.md 更新
- [ ] 截图放进 README

## 7. 风险与未决问题

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 运行中改角色卡可能导致正在进行的对话/意图崩溃 | 热重载只在 tick 间隙生效；当前角色 tick 完成后再切换 |
| R2 | API key 写入磁盘的安全性 | `data/settings.json` 加进 gitignore；权限 600；前端只回末 4 位 |
| R3 | 删除角色对历史记忆/印象的引用悬空 | 默认软停用 + 显式「永久删除」二次确认 |
| R4 | 前端框架引入增加构建链复杂度 | 用 Vite，构建产物落到 `web/dist/`，server 继续静态托管 |
| R5 | YAML 与 JSON 编辑的来回转换 | 后端统一 JSON in/out，YAML 只是磁盘格式 |
| R6 | 现有 web/ 单文件的 ad-hoc 状态会丢失 | 先做 Phase B 框架 + Live 页迁移再删旧文件 |

## 8. 已定决策（自行判断）

1. **框架：Preact + Vite + TS**。理由：体积小（~3KB）、和 React 生态兼容方便抄 SillyTavern 思路、与后端 TS 工具链一致、不必引入庞大 React 全家桶。
2. **删除策略：默认软停用**（YAML 加 `disabled: true`，仿真跳过），UI 上有「永久删除」按钮但需二次确认弹窗。理由：避免历史记忆/印象/对话引用悬空。
3. **不做 per-character provider 覆盖**（至少 v1 不做）。理由：当前所有角色共享一个 LLM 是设计前提，多 provider 会显著增加 prompt 调试复杂度。后续真有需要再加。
4. **旧 `web/index.html` 暂保留为 `web/legacy.html`**，新前端 Phase B 上线后默认路由进新版，旧版作为 Phase F 之前的 fallback，Phase F 删除。
5. **Phase 顺序不变**：A 后端 → B 脚手架 → C Settings → D 角色 → E 地点 → F 收尾。理由：Settings 先做是因为没有 provider 配置，角色 CRUD 也无从验证 LLM 行为。

> webgame 线已暂停，本计划是 anima 唯一前端线。

---

**下一步**：直接开 Phase A 分支 `feature/frontend-redesign-phase-a`，先动后端 schema + CRUD + provider 配置接口。
