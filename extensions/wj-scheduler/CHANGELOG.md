# Changelog

本文件记录 wj-scheduler 各版本的变更。

## [Unreleased]

### 锁状态主会话卡片样式定稿
- 卡片机制与 wj-btw 对齐：`registerEntryRenderer` + **同步** `appendEntry`（不再延迟/弹窗）；
  data 结构化 `{ active, pid }`；`pid` 为锁持有者（成功=自身，失败=占用者），新增 `PerProcessLock.holderPid()`。
- 布局：第一行加粗（`[wj-scheduler]` + 启用成功/失败），标题与正文之间**空一行**（`BlankLine` 组件，
  因 pi-tui Text 对空白行返回 `[]` 会被跳过）；正文灰色（`muted`）；失败末行 `/reload` 用行内代码主题色（`mdCode`）。
- 状态用文字色表达（去 ✅/⚠️ 符号、去绿/橙背景方案）：成功标签**自绘真彩色纯绿**
  `\x1b[38;2;80;220;80m`（主题 `success` token 的 green=#b5bd68 是黄绿非纯绿）；失败标签 `warning`（纯黄）；背景统一 `customMessageBg`。
- 排查记录：早期卡片不显示的根因是 renderer 链式 `return new Box(...).addChild(...)`；
  pi-tui `addChild()` 不返回 this（返回 undefined）→ renderer 返回 undefined → `hasContent()` false → **静默不显示**；
  须先 `addChild` 再单独 `return box`。经验已沉淀为项目级技能 `.pi/skills/pi-entry-card/`。

## [0.2.0] - 2026-08-21

### 数据存储改为项目级
- 数据从全局 `~/.pi/agent/data/wj-scheduler/<sessionId>/` 改为**项目级** `.pi/wj/scheduler/<sessionId>/`
  （与 wj-memory 同级模式，跟随项目、跨项目隔离）；任务数据（`tasks.json`，懒创建）与锁同目录。
- 新增 `resolveSchedulerRoot(sessionId)`：默认 `process.cwd()/.pi/wj/scheduler/<sessionId>`；
  `WJ_SCHEDULER_DIR` 环境变量可覆盖根目录（仍追加 `<sessionId>`），方便迁移/测试。
- 旧全局 `data/wj-scheduler/` 下历史 session 目录均为空任务残留，无有效任务需迁移。

### 进程锁逻辑重做（`PerProcessLock`）
- 锁文件改为**隐藏文件 `.lock`**（原 `scheduler.lock`），内容 = 持有进程 PID。
- 获取规则：① `.lock` 不存在/空/损坏（PID 非法）→ `flag:"wx"` 原子创建获取；
  ② 持有者 PID 已死（`kill(pid,0)` 抛 `ESRCH`）→ 删除后重写抢占；
  ③ 锁内 PID 为本进程 → 重入视为已获取；④ 持有者存活 → 获取失败。
- 修复边界漏洞：空锁文件（`Number("")=0` 会命中进程组探测导致死锁）视为可抢占；
  `#isAlive` 仅 `ESRCH` 判死，`EPERM` 等探测受限**保守视为存活**（防误抢活跃进程的锁）。
- **主会话汇报**：插件加载完成后，锁获取成功/失败结果以卡片（✅/⚠️ 文案）显示到主会话。

## [0.1.0] - 2026-08-19

首个版本。
- 定时任务调度，支持三种类型：`cron`（周期、错过不补）、`once`（一次性、重启后可补跑）、`interval`（固定间隔，下次=完成+间隔）。
- `/wj-cron` 命令：`status` / `list` / `get` / `run` / `enable` / `disable` / `delete` 子命令。
- 6 个 LLM 工具：`wj_scheduler_create` / `list` / `get` / `update` / `delete` / `run_now`。
- 任务持久化（会话级 `tasks.json`）、运行历史与 `lastError`。
- **跨进程锁竞争修复**：`PerProcessLock`——每个进程独立数据目录 `data/wj-scheduler/<pid>/`，
  替代原 `@amaster.ai/pi-task-scheduler` 共用一个锁文件的实现，消除多进程抢锁竞争；非激活时拒绝写入。
- 底部状态栏桥：`status.ts` 轮询 `scheduler.list()` 发布激活任务行，由 wj-status 宿主渲染。
