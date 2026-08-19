# wj-btw — 一次性受限子智能体委托

在 pi 里执行 `/btw [prompt]`，把任务交给一个**独立受限的 pi 子智能体**去跑，
跑完后**直接把回答输出回主进程会话**——无弹窗、无交互层。

## 架构

**受限子进程后端 + 结果回填主会话**

- 后端：`spawn("pi", ["--mode","rpc","--no-session","-t",<工具白名单>])`
  拉起一个 headless 受限子进程——完整 pi、独立对话上下文、按白名单受限工具；
  `--no-session` 保证会话不写盘。
- 结果：子智能体跑完后，用 `get_last_assistant_text` 取到最终回答，经
  `pi.appendEntry("btw-result", …)` 渲染成**带背景的卡片**（像工具块）输出到主会话展示
  （不进主 LLM 上下文）。

- **同一张卡原地更新**：`/btw` 先 append 一张「处理中…」背景卡（renderer 保存
  `liveUpdater` + 捕获的 `tui` 引用），跑完后 `setText` + `tui.requestRender()`
  **原地**把这张卡变成「结果」卡（背景不变），不追加第二张卡。
- **机制**：`CustomEntryComponent` 持久持有 renderer 返回的组件树，`Text.setText()`
  清缓存、`Box.render` 重渲子组件比对缓存 → 内容失效即原地重绘；`requestRender`
  经 `session_start` 里 `setWidget` 工厂捕获的 `tui` 引用触发。
- 兜底：更新器未就绪（任务极快）时退化为 append 一张结果卡；`entry.data` 同步
  更新避免展开卡重渲回退成「处理中」。

## 用法

- `/btw <prompt>` — 委托子智能体执行，结果直接输出到主会话
- 多次 `/btw` —— **沿用同一子进程上下文**，可连续追问（不落盘、秒级延续）
- 子进程随主 pi 退出而销毁

> 与旧版区别：不再有浮层、`/btw-back`、`/btw-save`、ESC 交互——退化为「发任务 → 回填结果」。

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

- `extensions/index.ts` — 入口：RPC 客户端、`/btw` 一次性委派、结果渲染、退出清理
- `extensions/settings.ts` — 纯逻辑：配置读取（双层可覆盖）+ 白名单校验，可独立单测
- `settings.json` — 扩展内置默认（空白名单）
