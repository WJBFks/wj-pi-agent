# wj-btw — 顺带一提（by the way）

`btw` = **by the way**（顺带一提）——对话中途想到什么，随手委派一个受限子智能体顺带跑一下。

> 当前版本：`0.2.0` ｜ 变更见 [`CHANGELOG.md`](CHANGELOG.md)

在 pi 里执行 `/btw [prompt]`，把任务交给一个**独立受限的 pi 子智能体**去跑，
跑完后**直接把回答回填到主进程**——无弹窗、无交互层。

## 架构

**受限子进程后端 + 结果回填主进程**

- 后端：`spawn("pi", ["--mode","rpc","--no-session","-t",<工具白名单>])`
  拉起一个 headless 受限子进程——完整 pi、独立对话上下文、按白名单受限工具；
  `--no-session` 保证会话不写盘。
- 结果：子智能体跑完后，用 `get_last_assistant_text` 取到最终回答，回填到主进程。

## 展示（先「底部固定」，关闭时「迁入主对话」，2026-08-20 重构）

- **结果先只出现在底部固定窗口**：`/btw` 后结果经 `ctx.ui.setWidget("wj-btw-dock", …,
  {placement:"aboveEditor"})` 渲染为**输入框上方的 dock 区 widget**——属于底部 dock、
  **不随对话滚动**，始终固定在视口最下方，随时可见。「（处理中...）」→「结果」为同一
  widget 的两次更新，完整显示、不截断（Text 自带 word-wrap）。
- **视觉**：`[btw]` 与 prompt 加粗；折叠态分隔线为空行，问题最多 3 行+省略号、回复最后
  5 行 + 省略提示（快捷键白色加粗、随 `keyText("app.tools.expand")` 动态读取实际
  keybinding，不硬编码 ctrl+o）；展开态=完整 Markdown + 末行 `(快捷键 to collapsed)`
  白粗提示；折叠/展开纯跟随全局 Tool output: collapsed/expanded 状态。
- **同一结果不同时两处出现**：结果先只在底部窗口；直到你开始新的正常交互——输入框
  提交普通 prompt（`on("input")`，source=interactive）或执行 `!bash / !!bash`
  （`on("user_bash")`）时，先把该结果 `pi.appendEntry("btw-result", …)` 迁入主对话
  随对话滚动（可展开/回溯），再移除底部窗口。
- 连续 `/btw` 追问：新任务开始时先把上一个未迁移结果迁入主对话，避免被新任务覆盖丢失；
  结果在途时关闭窗口则不复活、直接落主对话。`/btw` 命令走扩展命令分支、不触发 input
  事件，连续追问不会误关窗口。
- **reload / 关闭不丢结果**：若结果仍驻留底部（未开始新交互）时发生 reload 或 graceful
  shutdown（`pi -c` / SIGHUP / interrupt），`session_shutdown` 会把该结果迁入主会话
  （写入 custom entry 随会话持久化），reload 后该 btw 块仍留在主会话区域，不会丢失。

## 用法

- `/btw <prompt>` — 委托子智能体执行，结果先在底部固定窗口显示
- 多次 `/btw` —— **沿用同一子进程上下文**，可连续追问（不落盘、秒级延续）；每次新任务会覆盖并更新底部窗口
- 开始正常交互（输入普通 prompt 或执行 `!bash`）→ 底部结果迁入主对话随滚动，底部窗口消失
- 子进程随主 pi 退出而销毁

> 与旧版区别：不再有浮层、`/btw-back`、`/btw-save`、ESC 交互——退化为
> 「发任务 → 底部窗口回填结果」；结果卡不再是唯一展示（底部窗口承担实时查看）。

## 配置

项目级配置文件：`.pi/wj/btw/settings.json`（环境变量 `WJ_BTW_SETTINGS` 可覆盖路径）。

```jsonc
{
  "tools": ["read", "grep"],   // 工具白名单；空数组 = 纯聊天
  "skills": []                 // 技能白名单（预留）
}
```

白名单校验语义：**忽略 + 警告**——配置里未命中当前进程已注册的名字，不阻断启动，
发送任务时仅提示 `[wj-btw] 已忽略未注册项：…`。

## 文件

- `extensions/index.ts` — 入口：RPC 客户端、`/btw` 一次委派、底部固定窗口渲染、
  input/user_bash 关闭、退出清理
- `extensions/settings.ts` — 纯逻辑：配置读取（双层可覆盖）+ 白名单校验，可独立单测
- `settings.json` — 扩展内置默认（空白名单）