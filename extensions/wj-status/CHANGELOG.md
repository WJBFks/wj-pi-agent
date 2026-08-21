# Changelog

本文件记录 wj-status 各版本的变更。

## [0.1.0] - 2026-08-19

首个版本。
- **文本框状态栏**：`● status · model · provider · statuses · think 级别`，按宽度三档自适应精简（窄到极限只留 think 级别）。
- **底部状态栏**（`setFooter`）：展示 model / tokens / cache / cost / context / CWD / balance，并在自身行下方追加其他扩展经桥发布的行。
- **余额获取**（`balance.ts`）：按 provider 分发、会话内去重并发拉取，缓存到全局 `balance-cache.json`。
- **成本追踪**：today cost = 当前 cost - 基线；基线在 `session_start` 首次落盘持久化（会话级 `cost-tracking.json`）。

- **宽度规范**：统一用 pi-tui 的 `visibleWidth()` / `truncateToWidth()` 测量/截断，不自行实现宽度表。
- **扩展间通信桥**：渲染时读取 `globalThis.__wj_scheduler_footer_lines` 并追加到自身行下方（纯文本、宿主统一样式）。
- **i18n**：中英双语，`locale`/`currency` 配置（`config.json`）。

## [0.2.0] - 2026-08-21

### 数据存储改为项目级
- 成本基线 + 余额缓存全部移到 `.pi/wj/status/<sessionId>/`（`cost-tracking.json`、`balance-cache.json`，跟随项目、跨项目隔离，与 wj-memory/wj-scheduler 同级模式）。
- 新增 `resolveStatusRoot()`：默认 `process.cwd()/.pi/wj/status`；`WJ_STATUS_DIR` 环境变量可覆盖根目录。
- 旧全局 `data/wj-status/` 为历史残留，无有效数据需迁移。

### 思考级别显示优化
- 思考等级值的颜色 = **输入框边框颜色**：与 interactive-mode 切换思考时 `theme.getThinkingBorderColor(level)` 同一映射（`thinkingOff/Minimal/Low/Medium/High/Xhigh/Max` token，随主题变化）；替换原先硬编码的亮蓝 ANSI。
- 右侧新增快捷键提示 `(shift+tab)`（灰色 muted），显示为 `think high (shift+tab)`；快捷键**动态读取** `keyText("app.thinking.cycle")`——跟随用户 keybindings.json 自定义，不硬编码。
- 自适应：**`(shift+tab)` 在所有单元中最先被隐藏**（隐藏优先级最高），窄屏先去掉提示，极限只剩 think 级别值。
- 交互细节：**等级值永远加粗**（含极窄兜底分支），前缀「think」与 `(shift+tab)` 保持不加粗；off 时显示 `off`（原为 `-`）。
