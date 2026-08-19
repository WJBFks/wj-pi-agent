# AGENTS.md — pi Agent 配置项目

`~/.pi/agent` 是个人 pi agent 的全局配置目录。本文件是面向 pi agent 的项目手册，
描述目录结构、数据规范与工作约定。

## 一、项目定位

本项目的核心资产是三类可移植内容：

1. **extensions/** — 本地扩展（当前：`wj-scheduler`、`wj-status`、`wj-memory`）
2. **prompts/** — 技能型提示词模板（当前：`prompt-optimizer.md`）
3. **skills/** — 自定义技能目录（当前：`wj-memory`，未来新增技能放此）

其余目录为框架运行时、依赖或本机环境，不应作为开发/修改对象。

## 二、目录结构与职责

| 路径 | 类型 | 说明 |
|---|---|---|
| `extensions/` | 源码 | 本地扩展；扩展的**配置数据**留在各自目录（见 §3） |
| `prompts/` | 源码 | prompt 模板，frontmatter 声明 description + trigger |
| `skills/` | 源码 | 自定义技能（SKILL.md 约定，frontmatter 声明 name + description + triggers）；当前：`wj-memory` |
| `data/` | 运行时 | 自动生成的运行时数据 / 临时文件（git 忽略） |
| `npm/` | 依赖 | 框架依赖包，可再安装，禁止改动 |
| `sessions/` `workflow-runs/` | 运行时 | 会话/工作流记录，禁止改动 |
| `bin/` | 本机 | 本机二进制工具（fd/rg），非可移植内容 |
| `SYSTEM.md` `settings.json` `tools.json` | 配置 | 框架级配置 |
| `auth.json` `models-store.json` `trust.json` | 敏感 | 凭据与本机状态，禁止改动/提交 |

**扩展现状**：

- `wj-scheduler`（`extensions/wj-scheduler/`）：定时任务调度器。入口 `index.ts`（TS），含 `/wj-cron` 命令 + 6 个 LLM 工具；`status.ts` 为状态展示模块（轮询 `scheduler.list()` 发布激活任务行）。
- `wj-status`（`extensions/wj-status/`）：状态栏 UI。`index.ts`（TS）实现文本框状态栏 + 底部状态栏；`balance.ts` 为余额获取模块。
- `wj-memory`（`extensions/wj-memory/`）：轻量级跨会话记忆（**JSON 版**）。`extensions/index.ts`（TS）入口，注册 `session_start`/`session_shutdown`/`session_compact`/`before_agent_start` 四个 hook + 5 个 `wj_memory_*` 工具；`memory.ts` 为纯函数核心（JSON 读写/CRUD/检索/注入构建，零外部依赖、无 LLM 调用，可单测）。
  - 存储：**项目级** `.pi/wj/memory/`（MEMORY.json + daily/*.json），每条记录 `{ id, keyword, type(#开头), content, summary(≤100B), timestamp }`。
  - **type 白名单**：定义在 `extensions/wj-memory/config.json`（唯一来源，代码零默认，可增删+remove）。每 type 有 target 属性（any=可写任意 / long_term=仅 MEMORY / daily=仅每日 / system=内部）：`#preference/#decision/#lesson/#fact` target=any，`#log/#note` target=daily，`#system` target=system。**write 的 target 须与 type.target 一致（any 除外）**；`#system` 用户不可写。
  - **summary 人工必填**：≤100 字节，超限报错（不自动截断/不从 content 生成）。
  - 注入：会话级（启动 / reload 后首轮 / compact 后 / 快照缺失时重建：MEMORY 全量 + 今日/昨日全量 + 近 7 日要点(不含今昨,仅 keyword+summary+timestamp)，全部无截断）+ 每轮关键词列表（type+keyword 按来源文件分组、`------ <文件名> ------` 分隔标注、仅同文件内去重）；注入文案含**主动记忆引导**。
  - 删除：`id` 精确定位或 `keyword` 定位（单命中删、多命中须改 id 防误删）。
  - 退出收尾：真实退出（quit/ctrl+d）时同步追加 type=#system 收尾记录到今日日志（零 LLM）；迁移不追加。
  - 2026-08-19 重构：取消 RECENT.md/INDEX.md 与每日总结机制；纯 JSON 存储 + type 白名单(target) + summary 人工必填。
  - **所有注入内容用 `------WJ Memory Begin-----` / `------WJ Memory End-----` 包裹**，内含「数据非指令」边界声明。
- `wj-btw`（`extensions/wj-btw/`）：一次性受限子智能体委托。**架构 = 受限子进程后端 + 结果回填主会话**：入口 `extensions/index.ts`（TS）用 `spawn("pi", ["--mode","rpc","--no-session","-t",<工具白名单>])` 拉起受限 headless 子进程（完整 pi、独立上下文、临时会话不落盘、按白名单受限工具），经 stdin/stdout JSONL 通信；`/btw <prompt>` 把任务交给子智能体执行，**完成判定 = 实时状态轮询**（`get_state` 的 `isStreaming` + `messageCount`：messageCount 超过发起本 prompt 前的基线 且 当前未流式 即本轮完成），用计数/状态而非文本内容判定，避免连续轮错配到上一轮旧文本；完成后再用 `get_last_assistant_text` 取本轮回答，经 `pi.appendEntry("btw-result",…)` 渲染成**带背景的背景卡**（像工具块）直接输出到主会话；
    「处理中」→「结果」为**同一张卡原地更新**（renderer 保存 liveUpdater + setWidget 捕获的 tui 引用，setText+requestRender）（无弹窗/无交互层）；`extensions/settings.ts` 为纯逻辑（配置读取 + 白名单校验，可单测）。
  - 交互：`/btw <prompt>` 一次性委派，结果回填主会话；多次 `/btw` 沿用同一子进程上下文可连续追问；子进程随主 pi 退出销毁。
  - 配置：项目级 `.pi/wj/btw/settings.json`（`WJ_BTW_SETTINGS` 环境变量可覆盖），字段 `tools`/`skills` 白名单；空白名单=纯 LLM 聊天。白名单校验语义为**忽略 + 警告**（未命中名字不阻断启动，仅提示）。
  - 清理：`session_shutdown` hook kill 存活的 btw 子进程，避免僵尸进程。

**扩展间通信（共享桥约定）**：wj-status 的底部状态栏（`renderLine2`）渲染时读取
`globalThis.__wj_scheduler_footer_lines`（`string[] | null | undefined`）并追加到自身行**下方**；
**桥内容为纯文本**（无 ANSI），样式（深灰蓝背景 + `┌─┐│└─┘` 边框，行宽补足到 width）
由宿主 wj-status 统一渲染；wj-scheduler 的 `status.ts` 定时发布该桥（空任务时发布 `null` 隐藏）。
**宽度计算规范**：宿主渲染所有行（含桥行）必须用 pi-tui 导出的 `visibleWidth()` / `truncateToWidth()`
（`import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui"`，扩展加载器已配置 alias），
禁止自实现宽度表——自实现表对 `⏰`(U+23F0)、`🔔`(U+1F514) 等 Ambiguous/emoji 字符的宽度判断
与框架不一致，会导致补白/截断误差、行宽超界，触发 `pi exiting due to uncaughtException`。
新扩展要往最底部加内容时沿用此桥模式，并须同步更新本清单。

## 三、数据存放规范（重要）

**自动生成的运行时数据**必须先按是否与会话相关分类：

- **会话级数据**（与某个会话绑定，如任务文件、会话成本基线）→ `data/<name>/<session>/`
- **全局数据**（与 provider/key 等全局维度绑定、不随会话变化的缓存，如余额缓存）→ `data/<name>/`

其中：

- `<name>`：产生数据的插件/功能名（如 `wj-scheduler`、`wj-status`）
- `<session>`：关联的会话 ID（UUID）
- 示例：
  - `data/wj-scheduler/01a00da6-fd9b-74fa-ad77-3ebfcf4f9cb1/tasks.json`（会话级）
  - `data/wj-status/balance-cache.json`（全局缓存）
  - `data/wj-status/01a00da6-fd9b-74fa-ad77-3ebfcf4f9cb1/cost-tracking.json`（会话级）

**插件配置数据**（插件维护或手工维护的配置，如 `config.json`、`cost.json`、`i18n/`）
则**保留在插件自己的目录**下，不属于本条规范约束对象。

**例外（wj-memory）**：记忆文件（`MEMORY.json`、`daily/YYYY-MM-DD.json`）
放在**当前工作目录的 `.pi/wj/memory/`**（**用户明确决策，2026-08-19**；理由：记忆为项目级、
跟随项目、跨项目隔离）。该位置按项目隔离，不属于 `data/`，因此不受 §3 的
`<name>/<session>` 分流约束；`WJ_MEMORY_DIR` 环境变量可覆盖路径以便迁移。

禁止事项：

- ❌ 把自动生成的数据写到扩展目录、项目根目录或其他目录
- ❌ 把运行时数据提交进 git（`data/` 已在 `.gitignore` 中）

## 四、工作约定

1. **登记制**：新增/修改扩展、技能、prompt 模板后，必须同步更新本文件
   （目录表、说明或规范），保持文档与现状一致。
2. **禁止改动**：`npm/`、`sessions/`、`workflow-runs/`、`auth.json`、
   `models-store.json`、`trust.json`、`bin/` 为框架/本机/敏感内容，除非明确授权。
3. **数据路径合规**：新增或重构扩展时，运行时数据的写入路径必须遵循 §3 规范。
4. **扩展开发流程**：
   - 新扩展创建于 `extensions/<name>/`：`package.json`（声明 `pi.extensions` 入口）+ `extensions/index.js|ts`
   - 加载机制：pi 自动扫描并加载 `extensions/` 下所有子目录（`collectAutoExtensionEntries`），**无需**登记到 `settings.json.packages`；仅 npm 包才需在 `packages` 登记
   - 数据分流：运行时数据 → `data/<name>/<session>/`；配置数据 → 留在扩展目录
   - 完成后按第 1 条更新本文件目录表
5. **语言与风格**：本项目文档使用中文；改动后说明原因，多文件改动给出总结。