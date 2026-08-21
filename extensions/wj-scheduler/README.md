# WJ Scheduler

pi 内的**定时任务调度器**。支持 cron / once / interval 三种类型的任务，
提供 `/wj-cron` 命令与 6 个 LLM 工具，并把「激活中的任务」发布到底部状态栏（经 wj-status 桥渲染）。

> 当前版本：`0.2.0` ｜ 变更见 [`CHANGELOG.md`](CHANGELOG.md)

---

## 功能特性

- **三种任务类型**
  - `cron`：cron 表达式周期调度（如 `0 9 * * 1-5`）；错过不补，仅调度下一个未来周期。
  - `once`：一次性调度（ISO 时间或 `+10m` 相对时间）；重启后若已到时刻未执行可补跑。
  - `interval`：固定间隔（`30s`/`5m`/`1h`）；下次 = 上次完成时间 + 间隔。
- **`/wj-cron` 命令**：子命令 `status`（状态摘要）/ `list` / `get <id>` / `run <id>` / `enable|disable <id>` / `delete <id>`。
- **6 个 LLM 工具**：`wj_scheduler_create` / `list` / `get` / `update` / `delete` / `run_now`。
- **跨进程锁竞争修复**：锁文件放在 **session 隔离目录**内（不同 session 不冲突），
  替代原 `@amaster.ai/pi-task-scheduler` 所有进程共用同一锁文件的实现；非激活（锁被其他进程持有）时**拒绝写入**。
- **持久化**：任务、运行历史、`lastError` 存于会话级 `data/wj-scheduler/<session>/tasks.json`。
- **运行历史**：每次触发记录 entry（status/message/时间），结算时以 `nextRunAt` 续调度下一次。
- **底部状态栏桥**：`status.ts` 轮询 `scheduler.list()`，把激活中的任务行发布到
  `globalThis.__wj_scheduler_footer_lines`，由 wj-status 宿主统一渲染（纯文本、无 ANSI）。
- **错误处理**：任务执行/消息投递失败记入 `lastError` 与历史，并据此续调度下一次。
- **主会话汇报**：插件加载完成后，锁获取结果（成功/失败）以带背景的卡片显示到主会话——
  首行加粗（成功标签纯绿 / 失败标签黄），正文灰色，失败的提示含占用进程 PID 与 `/reload` 指引。

---

## 安装 / 加载

位于 `extensions/wj-scheduler/`。pi 启动时自动扫描并加载 `extensions/` 下所有子目录，无需登记。

---

## 用法

### `/wj-cron` 命令

```
/wj-cron status          # 调度器整体状态（激活？已调度任务数）
/wj-cron list            # 列出任务
/wj-cron get <task-id>   # 查看单个任务详情与运行历史
/wj-cron run <task-id>   # 立即执行
/wj-cron enable <id>     # 启用
/wj-cron disable <id>    # 禁用
/wj-cron delete <id>     # 删除
```

### LLM 工具

| 工具 | 说明 |
|---|---|
| `wj_scheduler_create` | 创建任务（cron/once/interval） |
| `wj_scheduler_list` | 列出所有任务及其状态、下次执行时间 |
| `wj_scheduler_get` | 查看单个任务的调度配置与执行历史 |
| `wj_scheduler_update` | 修改任务（调度表达式 / prompt / 名称 / 描述 / 启用禁用） |
| `wj_scheduler_delete` | 删除任务 |
| `wj_scheduler_run_now` | 忽略原调度计划，立即执行一次 |

---

## 数据与存储

- **任务数据 + 锁**（项目级，跟随项目）：`.pi/wj/scheduler/<sessionId>/tasks.json`、`.lock`（保存持有进程 PID）
- 默认基于**当前工作目录**（与 wj-memory 同级模式）；`WJ_SCHEDULER_DIR` 环境变量可覆盖根目录（仍追加 `<sessionId>`）

> 项目级 `.pi/wj/` 存储意图：调度器任务与某个项目绑定（跨会话隔离、跟随项目），不入全局 `data/`。

---

## 文件

- `extensions/index.ts` — 入口：调度内核（cron/once/interval）、`/wj-cron` 命令、6 个 LLM 工具、进程锁与持久化
- `extensions/cron.ts` — cron 表达式解析与下一次运行时间计算
- `extensions/status.ts` — 底部状态栏桥：发布激活任务行（供 wj-status 渲染）
