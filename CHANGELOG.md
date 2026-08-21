# Changelog

本文件记录本仓库（wj-pi-agent）整体的版本变更。
**各扩展的详细变更记录在其各自目录的 `CHANGELOG.md`**（如 `extensions/wj-memory/CHANGELOG.md`）。

## [0.2.0] - 2026-08-21

- `wj-memory` 0.1.0 → 0.2.0：长期记忆「宁缺毋滥」+ 晋升候选、提示词抽到 `PROMPT.md` 动态加载、
  `#system` 收尾移除、`#decision` 收紧为 daily、新增迁移体系（`MIGRATION.md` + `/wj-memory-migrate`）、
  记忆提升/降级工具（`wj_memory_promote`/`wj_memory_demote`，工具 5 → 7）。
- `wj-btw` 0.1.0 → 0.2.0：命名为「顺带一提」；btw 卡片布局调整（底部固定窗口 + 单一结果）、
  新增折叠/展开（Ctrl+O）、Markdown 渲染。
- `wj-scheduler` 0.1.0 → 0.2.0：数据改为项目级 `.pi/wj/scheduler/<sessionId>/`（`WJ_SCHEDULER_DIR` 可覆盖）、
  进程锁重做（`.lock` 隐藏文件 + 空/损坏/已死可抢占）、锁获取结果在主会话汇报。
- `wj-status` 0.1.0 → 0.2.0：成本基线 + 余额缓存改为项目级 `.pi/wj/status/<sessionId>/`（`WJ_STATUS_DIR` 可覆盖）。
- **本次升级将全部插件的数据都改为「项目级 `.pi/wj/`」存储**：wj-memory（`.pi/wj/memory/`）、
  wj-scheduler（`.pi/wj/scheduler/<sid>/`）、wj-status（`.pi/wj/status/<sid>/`）——跟随项目、跨项目隔离，
  不再写入全局 `~/.pi/agent/data/`。
- 文档：为全部扩展补齐 `README.md` / `CHANGELOG.md`；`wj-status` description 完善；
  新增 `/confirm` 提示词模板（执行前先复述理解 + 澄清，确认后再执行）。

## [0.1.0] - 2026-08-19

- 初始版本：四个本地扩展（`wj-scheduler` / `wj-status` / `wj-memory` / `wj-btw`）、
  `wj-memory` 技能 + 会话记忆（JSON 版）、`prompt-optimizer` 模板、项目手册与数据规范。