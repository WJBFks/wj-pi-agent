# INSTALL — 一键安装

## to 人类

> 本文档供 **Agent 自动安装**使用，人类无需查看。

安装prompt（复制给任意 Agent 即可触发自动安装）：

```text
请查看 https://github.com/WJBFks/wj-pi-agent/blob/master/INSTALL.md，按其中「to Agent」部分的说明自动安装本配置到目标PI Coding Agent环境（~/.pi/agent）。
```

## to Agent

安装详情：

你是安装代理。请在目标环境（`~/.pi/agent`）一键安装 wj-pi-agent 配置（仓库镜像 https://github.com/WJBFks/wj-pi-agent.git）。以下为安装目录：

> 安装目录为：
> `~/.pi/agent/extensions/wj-btw`
> `~/.pi/agent/extensions/wj-memory`
> `~/.pi/agent/extensions/wj-scheduler`
> `~/.pi/agent/extensions/wj-status`
> `~/.pi/agent/skills/wj-memory`
> `~/.pi/agent/prompts/confirm.md`
> `~/.pi/agent/prompts/prompt-optimizer.md`

请按以下步骤执行：

1. 检查 `~/.pi/agent` 是否存在，不存在则创建。
2. 检查安装目录是否已存在（即上述安装目录是否已存在于目标环境）。
3. 如果安装目录已存在，告诉用户，具体有哪些安装目录已经存在了，并且提醒用户，这些目录中的旧/自建内容将被丢弃。并且询问用户，是否要继续安装，或者哪些目录暂不安装（可以使用`ask_user_question`提问，如果有）。
4. 如果用户选择继续安装，则执行以下步骤：

   a. **克隆到临时目录**：`git clone https://github.com/WJBFks/wj-pi-agent.git /tmp/wj-pi-agent-install`（若该目录已存在可作为复用；临时目录路径可自选）。
   b. **按用户选择逐项安装**（用户同意安装的项执行；「暂不安装」的项跳过并保留目标现状）：
      - 扩展（4 项）：删除对应目标目录（如 `~/.pi/agent/extensions/wj-btw/`）→ 从 `/tmp/wj-pi-agent-install/extensions/<同名>` 整体复制
      - 技能（1 项）：删除 `~/.pi/agent/skills/wj-memory/` → 从 `/tmp/wj-pi-agent-install/skills/wj-memory` 整体复制
      - 提示词（2 项）：删除对应目标文件（如 `~/.pi/agent/prompts/confirm.md`）→ 从 `/tmp/wj-pi-agent-install/prompts/<同名>` 复制
      - 第三方包（合并，非替换）：读取 `~/.pi/agent/settings.json` 的 `packages` 数组，与以下 7 个包合并去重后写回（只改 `packages` 字段，不动其他字段；**不要执行 npm install**，依赖由 pi 下次启动自动安装/加载）：
        `npm:@vigolium/piolium`、`npm:pi-mcp-adapter`、`npm:pi-web-access`、`npm:pi-subagents`、`npm:@juicesharp/rpiv-ask-user-question`、`npm:@plannotator/pi-extension`、`npm:context-mode`
   c. **收尾**：删除临时目录 `/tmp/wj-pi-agent-install`，然后告知用户安装完成、需重启 pi 后生效。
   d. **安装总结**：读取 `~/.pi/agent/README.md` 与 `~/.pi/agent/CHANGELOG.md`，总结本配置的**功能介绍**与**最近的重要更新**（README 的扩展/技能/第三方包清单，CHANGELOG 最新版本条目），用简洁列表告知用户。

**不要触碰**：`auth.json`、`models-store.json`、`trust.json`、`.pi/`、`npm/`、`data/`、`sessions/`、`workflow-runs/` 等本机/运行时内容（镜像不含，保持现状）。