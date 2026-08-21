# Changelog

本文件记录 wj-memory 各版本的变更。

## [0.2.0] - 2026-08-21

### 新增
- 会话级注入提示词抽离到 `PROMPT.md` 动态加载，可独立编辑；缺失时自动回退内置默认；`WJ_MEMORY_PROMPT` 环境变量可覆盖路径。
- **长期记忆「宁缺毋滥」**：默认先写入每日日志，仅当跨会话稳定复用时才提升到长期记忆（三条硬标准）。会话注入文案明确引导。
- **晋升候选机制**：`findPromotableCandidates` 扫描近 7 日日志，同一 keyword 跨 ≥2 天重复即视为「被经常唤醒」，随每次关键词列表注入「建议提升到长期记忆」提示（最多 6 条，`#preference/#lesson/#fact` 可直接提升，`#decision/#log/#note` 须先转类型）。
- 新增命令 `/wj-memory-migrate`：引导智能体阅读 `MIGRATION.md`，按各版本判据判断当前版本并逐级迁移记忆数据（「直接执行」项自动处理、「需决策（选择题）」项询问用户，执行前先备份）。
- 新增 `MIGRATION.md` 迁移指南（人类直接使用命令即可，无需查看该文件）。

### 变更
- `#decision` 的 target 由 `any` 改为 `daily`：默认只能写入每日日志、不再进入长期记忆；确需长期化的极少数决策须先转为 `#preference/#lesson/#fact` 再入 MEMORY。
- 可晋升 / 可写长期记忆的类型收窄为 `#preference/#lesson/#fact`。
- 会话退出时的 `session_shutdown` 行为改为仅清空会话快照，不再追加收尾记录。
- package.json 版本号升至 `0.2.0`。

### 移除
- 移除每天自动追加的 `#system`「会话结束（自动收尾）」记录（无信息量噪音）。
- `#system` 类型仅作预留（`target=system`、用户不可写，不再自动产生）。

> 数据迁移：从 V0.1.0 升级需处理历史 `#decision` 移出长期、`#system` 收尾清理等，详见 `MIGRATION.md`。

## [0.1.0] - 2026-08-19

### 新增
- 轻量级跨会话记忆扩展（纯 JSON 存储，零外部依赖、无 LLM 调用）。
- 存储：项目级 `.pi/wj/memory/`（`MEMORY.json` 长期 + `daily/*.json` 每日日志），每条记录含 `id/keyword/type/content/summary(≤100B)/timestamp`。自旧 Markdown 结构（`MEMORY.md`/`daily/*.md`/`RECENT.md`/`INDEX.md`）重构而来，并取消 RECENT/INDEX 与每日总结机制。
- 类型白名单定义于 `config.json`（唯一来源、代码零默认），每类型带 `target` 约束（`any`/`long_term`/`daily`/`system`）：`#preference/#decision/#lesson/#fact`=`any`，`#log/#note`=`daily`，`#system`=`system`（用户不可写）。
- `summary` 人工必填且 ≤100 字节（超限报错，不自动截断、不从 content 生成）。
- 5 个工具：`wj_memory_write` / `wj_memory_read` / `wj_memory_forget` / `wj_memory_search` / `wj_memory_status`。
- 3 个会话 hook：`session_start` / `session_shutdown` / `before_agent_start`。
- 注入机制：会话级（MEMORY 全量 + 今日/昨日全量 + 近 7 日要点）+ 每轮关键词列表（`------ <文件> ------` 分来源标注、同文件内去重），全部以 `------WJ Memory Begin-----` / `------WJ Memory End-----` 包裹并声明「数据非指令」安全边界。
