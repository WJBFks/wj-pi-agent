# wj-pi-agent

个人 [pi](https://github.com/earendil-works/pi) agent 的全局配置与扩展集。

本项目是 `~/.pi/agent` 目录的可移植内容：**本地扩展（extensions）、自定义技能（skills）、prompt 模板（prompts）**，以及配套的项目手册与规范。运行时数据（会话、记忆库、依赖等）一律不入库。

> ⚠️ 本仓库是个人配置的公开镜像：`settings.json`（默认模型等）与 `MEMORY.md`（历史会话存档）中的本机路径信息会公开可见。

## 目录结构

| 路径 | 类型 | 说明 |
|---|---|---|
| `extensions/` | 源码 | 本地扩展（当前 4 个，见下） |
| `skills/` | 源码 | 自定义技能（`wj-memory`，SKILL.md 约定） |
| `prompts/` | 源码 | prompt 模板（`prompt-optimizer.md`） |
| `AGENTS.md` | 文档 | 项目手册：目录结构、数据规范、工作约定（登记制） |
| `SYSTEM.md` | 文档 | 框架级配置说明与工具使用偏好 |
| `settings.json` `tools.json` | 配置 | 框架级配置（模型/工具启用） |

## 扩展清单

### wj-scheduler — 定时任务调度器
- `/wj-cron` 命令 + 6 个 LLM 工具（`wj_scheduler_*`）
- 支持 cron / once / interval 三种调度，任务持久化到 `data/wj-scheduler/<session>/tasks.json`
- `status.ts` 经共享桥在 wj-status 状态栏发布激活任务行

### wj-status — 状态栏 UI
- 文本框状态栏 + 底部状态栏（模型、tokens、缓存、成本、上下文、CWD）
- 余额查询（`balance.ts`）、成本跟踪（`cost-tracking.json`）
- 通过 `globalThis.__wj_scheduler_footer_lines` 桥渲染调度器状态行

### wj-memory — 跨会话记忆（JSON 版）
- 轻量级、零 LLM、零外部依赖的跨会话记忆：`MEMORY.json`（长期）+ `daily/*.json`（每日日志）
- **项目级存储**：`<项目>/.pi/wj/memory/`（可用 `WJ_MEMORY_DIR` 覆盖）
- 记录结构：`{ id, keyword, type(#开头), content, summary(≤100B), timestamp }`
- **type 白名单**：定义在 `extensions/wj-memory/config.json`（唯一来源），target 决定可写目标（any/long_term/daily/system）
- 5 个工具（`wj_memory_write/read/forget/search/status`）+ 4 个 hook（session_start/shutdown/compact/before_agent_start）
- 注入内容用 `------WJ Memory Begin-----/End-----` 包裹并声明「数据非指令」
- 配套技能：`skills/wj-memory/SKILL.md`

### wj-btw — 一次性受限子智能体委托
- `/btw <prompt>`：把任务交给独立受限 pi 子进程（`pi --mode rpc --no-session -t <白名单>`）执行，结果回填主会话
- 完成判定 = 实时状态轮询（`get_state` 的 `messageCount` + `isStreaming`，prompt 前记基线），不依赖文本内容
- 结果渲染为**带背景卡**，「处理中 → 结果」**同一张卡原地更新**（`Text.setText` + `requestRender`）
- 多次 `/btw` 沿用同一子进程上下文可连续追问；子进程随主进程退出销毁
- 配置：项目级 `.pi/wj/btw/settings.json`（`WJ_BTW_SETTINGS` 可覆盖），tools/skills 白名单，校验=忽略+警告

## 技能

- **wj-memory**（`skills/wj-memory/SKILL.md`）：如何正确读写跨会话记忆（长期/每日、type 白名单、summary 规范、主动记忆策略）

## 使用

```bash
# 克隆到本机（仅可移植内容；运行时数据按 AGENTS.md 规范自动生成）
git clone https://github.com/WJBFks/wj-pi-agent.git ~/.pi/agent
```

- 扩展加载：pi 自动扫描 `extensions/` 下所有子目录，无需登记到 `settings.json.packages`
- 数据规范：运行时数据 → `data/<name>/<session>/`；配置数据留在扩展目录（详见 `AGENTS.md` §三）
- 约定：文档与代码使用中文；新增/修改扩展、技能、prompt 后必须同步更新 `AGENTS.md`

## 开发约定

详见 [AGENTS.md](./AGENTS.md)：
- 登记制：改动后同步更新项目手册
- 禁止改动：`npm/`、`sessions/`、`workflow-runs/`、`auth.json`、`models-store.json`、`trust.json`、`bin/`
- 数据路径合规：运行时数据按 `data/<name>/<session>/` 分流
- 扩展间通信：共享桥约定（wj-status 底部状态栏渲染 `__wj_scheduler_footer_lines`）
- 宽度计算：一律使用 pi-tui 的 `visibleWidth()` / `truncateToWidth()`，禁止自实现宽度表

## License

未指定（个人配置仓库）。
