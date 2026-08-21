# Changelog

本文件记录 wj-btw 各版本的变更。

## [0.2.0] - 2026-08-20

展示层重构：btw 卡片**布局调整**、新增**折叠/展开**与 **Markdown 渲染**。

### 布局调整
- 结果改为「**底部固定窗口 + 结果迁入主对话**」的单一结果展示：`/btw` 结果先经
  `ctx.ui.setWidget("wj-btw-dock", …, {placement:"aboveEditor"})` 渲染为**输入框上方 dock 区 widget**
  （不随对话滚动、始终固定视口最下方、完整显示不截断）；开始正常交互（输入普通 prompt / `!bash` / `!!bash`）
  时再 `pi.appendEntry("btw-result")` 迁入主对话随滚动并移除底部窗口。
- **同一结果不同时两处出现**；连续 `/btw` 追问会把上一未迁移结果先迁入主对话（防覆盖丢失）；
  结果在途关闭窗口则**不复活**、直接落主对话。
- **reload / graceful shutdown（`pi -c`/SIGHUP/interrupt）不丢结果**：`session_shutdown` 把仍驻留底部
  的结果迁入主会话（custom entry 随会话持久化），reload 后主会话仍保留该 btw 块。

### 折叠 / 展开（Ctrl+O）
- 结果卡与底部固定窗口均支持 Ctrl+O 展开/折叠（与工具块一致）。
- 折叠态 = 自定义组件 `CollapsedBtw`：`[btw]` 与 prompt 加粗、问题最多 3 行+超行省略号、分隔线为空行、
  回复最后 5 行 + 省略提示（快捷键白色加粗、随 `keyText("app.tools.expand")` 动态读取实际 keybinding，
  不硬编码 ctrl+o）；在 `render(width)` 阶段按终端宽度精确换行/截断（`wrapTextWithAnsi`/`truncateToWidth`/`visibleWidth`）。
- 底部窗口折叠/展开**纯跟随全局** `ctx.ui.getToolsExpanded()`（不监听 Ctrl+O、不改全局、不维护自有折叠态）。

### Markdown 渲染
- 结果卡与底部窗口正文改用 `Markdown` 组件渲染（自建 `makeMarkdownTheme`：md* 颜色 + bold/italic/
  strikethrough/underline，与普通对话一致）；处理中/错误仍用 `Text`。
- 视觉：`[btw]`/prompt 加粗；分隔线 `────` 改为空行；运行中显示「（处理中...）」；展开态末行加折叠提示。

### 其他
- 架构不变：受限子进程（`spawn("pi", ["--mode","rpc","--no-session","-t",<白名单>])`）+ 结果回填；
  完成判定 = `get_state` 的 `isStreaming` + `messageCount` 基线（计数/状态而非文本，避免串轮）。
- 配置无破坏性改动：`.pi/wj/btw/settings.json`（`WJ_BTW_SETTINGS` 可覆盖）。

## [0.1.0] - 2026-08-19

首个版本：顺带一提（by the way）——一次性受限子智能体委托。
- 架构：受限子进程后端（`spawn("pi", ["--mode","rpc","--no-session","-t",<工具白名单>])`）+ 主进程转发结果回填。
- `/btw <prompt>` 一次性委派，连续 `/btw` 沿用**同一子进程上下文**；子进程随主 pi 退出销毁。
- 主 TUI 内「即焚」轻量浮层：ESC 关闭即毁、会话不落盘（`--no-session`）。
- 工具/技能白名单可配（空 = 纯聊天），白名单校验语义为**忽略 + 警告**（不阻断启动，仅提示）。
