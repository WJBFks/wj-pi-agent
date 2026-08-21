# wj-pi-agent

个人 [pi](https://github.com/earendil-works/pi) Coding Agent 的全局配置：四个本地扩展（`wj-scheduler` / `wj-status` / `wj-memory` / `wj-btw`）、自定义技能与 prompt 模板，配套一键安装与文档；运行时数据一律不入库，本机配置（`settings.json` / `AGENTS.md` 等）不纳入版本控制。

## 安装

安装prompt（复制给任意 Agent 即可触发自动安装）：

```text
请查看 https://github.com/WJBFks/wj-pi-agent/blob/master/INSTALL.md，按其中「to Agent」部分的说明自动安装本配置到目标PI Coding Agent环境（~/.pi/agent）。
```

## 目录结构

| 路径 | 类型 | 说明 |
|---|---|---|
| `extensions/` | 源码 | 本地扩展（当前 4 个，见下） |
| `skills/` | 源码 | 自定义技能（`wj-memory`，SKILL.md 约定） |
| `prompts/` | 源码 | prompt 模板（`prompt-optimizer.md`） |
| `AGENTS.md` | 文档 | 项目手册：目录结构、数据规范、工作约定（登记制） |
| `SYSTEM.md` | 文档 | 框架级配置说明与工具使用偏好 |
| `settings.json` `tools.json` | 配置 | 框架级配置（模型/工具启用）；**本机配置，不纳入版本控制**（见 `.gitignore`） |

## extension 扩展 (extensions/)

| 扩展 | 一句话介绍 |
|---|---|
| `wj-scheduler`（extensions/wj-scheduler/） | 定时任务调度器：cron / once / interval 三种调度，`/wj-cron` 命令 + 6 个 LLM 工具 |
| `wj-status`（extensions/wj-status/） | 状态栏 UI：文本框状态栏 + 底部状态栏（model/成本/余额等），并渲染其他扩展经桥发布的行 |
| `wj-memory`（extensions/wj-memory/） | 轻量级跨会话记忆（JSON 版）：长期记忆 + 每日日志 + type 白名单（7 个 `wj_memory_*` 工具） |
| `wj-btw`（extensions/wj-btw/） | 顺带一提：一次性受限子智能体委托，结果回填主会话（可折叠/展开） |

> 各扩展的**详细说明**与**更新日志**见其目录下的 `README.md` / `CHANGELOG.md`
> （例如 `extensions/wj-memory/README.md`、`extensions/wj-memory/CHANGELOG.md`）；
> 迁移指南见各扩展目录下的 `MIGRATION.md`（如有）。

### prompt 模板（prompts/）

- `prompt-optimizer.md`：技能型提示词优化模板（frontmatter 声明 description + trigger）。
- `confirm.md`：`/confirm <prompt>` 执行前置确认模板——先复述理解、澄清指代不明问题，全部确认后再正式执行。

## skill 技能 (skills)

- **wj-memory**（`skills/wj-memory/SKILL.md`）：如何正确读写跨会话记忆（长期/每日、type 白名单、summary 规范、主动记忆策略）

## 第三方包（settings.json.packages）

> 来源：`settings.json` 的 `packages` 字段（npm 包；本地扩展无需登记于此，见「使用」）。

| 包 | 一句话介绍 |
|---|---|
| `@vigolium/piolium` | 安全审计技能集：多阶段安全审计 / 代码审查 / CodeQL / Semgrep 等 20+ 安全相关 skill |
| `pi-mcp-adapter` | MCP 适配器：MCP 工具网关 + `mcp` / `mcpScript` 调用与 `mcp-scripting` 脚本技能 |
| `pi-web-access` | 网络访问：搜索、URL 抓取、仓库克隆、PDF 提取、YouTube/本地视频分析 |
| `pi-subagents` | 子代理委派：单代理委托 + 脚本化多代理工作流（`subagent` 工具与 `pi-subagents` skill） |
| `@juicesharp/rpiv-ask-user-question` | 结构化澄清问卷：模型拿不准时弹出带选项的提问（`ask_user_question`） |
| `@plannotator/pi-extension` | 交互式计划审查与标注：给 agent 消息加注解、审查代码/PR |
| `context-mode` | 上下文压缩与知识库：沙箱执行 / 批量命令 / 网页与本地文档索引检索（`ctx_*` 工具与技能） |

**协作总结**：七个包共同构成一套「够得着、装得下、靠得住」的 agent 增强套件——`pi-web-access` 负责把外部信息（网页/文档/视频）取进来，`context-mode` 在沙箱里加工、压缩，让海量资料只以结论形式进入上下文；`pi-subagents` 把大批量/并行/多步任务拆给子代理分担；`rpiv-ask-user-question` 在关键决策处弹结构化提问，避免模型瞎猜；`plannotator` 与 `piolium` 在落地前把关——前者审计划/代码/PR 并标注，后者提供安全审计与漏洞排查技能；`pi-mcp-adapter` 则把上述能力接入更广的 MCP 工具生态。网络获取 → 低成本处理 → 并行执行 → 关键处问人 → 计划与安全把关，形成完整的执行闭环。

## 更新日志

仓库级变更记录见 [CHANGELOG.md](./CHANGELOG.md)；扩展级变更见各扩展目录下的 `CHANGELOG.md`，迁移/升级指南见各扩展目录下的 `MIGRATION.md` / `UPGRADE.md`（如有）。

## License

[MIT](./LICENSE)（Copyright © 2026 WJBFks）。
