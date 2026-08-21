# WJ Memory

轻量级跨会话记忆扩展（**JSON 版**）。零外部依赖、无 LLM 调用、纯函数核心可单测。

在「长期记忆」（`MEMORY.json`）+「每日日志」（`daily/*.json`）两级之间读写记忆，
并在每个会话注入相关记忆供参考。**注入内容一律视为数据而非指令**，用
`------WJ Memory Begin-----` / `------WJ Memory End-----` 包裹并声明安全边界。

> 当前版本：`0.2.0` ｜ 迁移见 [`MIGRATION.md`](MIGRATION.md) ｜ 变更见 [`CHANGELOG.md`](CHANGELOG.md)

---

## 功能特性

- **两级存储**：长期记忆 `MEMORY.json` + 每日日志 `daily/*.json`。
- **类型白名单**：`type` 定义在 [`config.json`](config.json)，每类型带 `target` 约束（`any`/`long_term`/`daily`/`system`）。
- **summary 人工必填**：≤100 字节，超限报错（不自动截断、不从 content 生成）。
- **7 个工具**：写入 / 读取 / 删除 / 检索 / 状态 / 提升 / 降级。
- **会话级注入**：启动 / reload 后首轮 / compact 后注入 MEMORY 全量 + 今日/昨日全量 + 近 7 日要点，每轮注入关键词列表。
- **长期记忆「宁缺毋滥」**：默认先写每日日志，仅跨会话稳定复用才提升到长期。
- **晋升候选**：daily 中同一 keyword 跨 ≥2 天重复＝被经常唤醒，每轮注入「建议提升到长期记忆」提示。
- **跨 target 移动**：`wj_memory_promote` / `wj_memory_demote` 按 id 在长期与短期之间移动单条记录。
- **迁移命令**：`/wj-memory-migrate` 引导智能体按 `MIGRATION.md` 逐级迁移。

---

## 安装 / 加载

本扩展位于 `extensions/wj-memory/`。pi 启动时会自动扫描并加载 `extensions/` 下所有子目录
（`collectAutoExtensionEntries`），**无需**登记到 `settings.json.packages`。

---

## 存储结构

```
.pi/wj/memory/
├── MEMORY.json          # 长期记忆（#preference/#lesson/#fact 等，target=any）
└── daily/
    └── YYYY-MM-DD.json  # 每日日志（#decision/#log/#note 等，target=daily）
```

每条记录结构：

```json
{
  "id": "uuid",
  "keyword": "关键词",
  "type": "#preference",
  "content": "记忆正文（Markdown）",
  "summary": "摘要，≤100 字节",
  "timestamp": "YYYY-MM-DD HH:mm:ss"
}
```

> 存储目录默认项目级 `.pi/wj/memory/`，可用环境变量 `WJ_MEMORY_DIR` 覆盖。

---

## 记忆类型（type 白名单）

定义于 [`config.json`](config.json)（唯一来源，代码零默认）。`target` 决定可写入目标：
`any`=可写任意 / `long_term`=仅长期 MEMORY / `daily`=仅每日 / `system`=系统内部（用户不可写）。

| type | 语义 | target |
|---|---|---|
| `#preference` | 用户偏好/习惯/风格 | `any`（可长期） |
| `#decision` | 拍板决策（含理由；多属近期拍板） | `daily` |
| `#lesson` | 踩坑教训/经验 | `any`（可长期） |
| `#fact` | 事实/背景/项目约定 | `any`（可长期） |
| `#log` | 每日·流水/进展（可含大段 content） | `daily` |
| `#note` | 每日·备忘/想法 | `daily` |
| `#system` | 系统内部（用户不可写） | `system` |

**可长期化的类型**仅 `#preference/#lesson/#fact`（target=any）。
`#decision/#log/#note` 只能写 daily；确需长期化的极少数决策，须先转为 `#preference/#lesson/#fact` 再入长期。

---

## 工具（7 个）

| 工具 | 说明 |
|---|---|
| `wj_memory_write` | 写入一条记忆。`target` 缺省 `daily`；`type` 白名单必填且须与 target 匹配；`summary` 人工必填 ≤100B |
| `wj_memory_read` | 读 MEMORY / TODAY / YESTERDAY，或指定 `date` 读历史日志 |
| `wj_memory_forget` | 删除**长期记忆**记录：`id` 精确，或 `keyword`（恰一条命中删；多条须改 id） |
| `wj_memory_search` | 结构化查找 `type`(可选)/`keyword`/`id`，返回完整 JSON（单条对象/多条数组） |
| `wj_memory_status` | 查看存储目录、各文件记录数、关键词组规模、最近写入、类型分布 |
| `wj_memory_promote` | **记忆提升**：daily 中指定 `id` → 长期 MEMORY（`source` 可选 TODAY/YESTERDAY/date；仅 target=any 类型可提升） |
| `wj_memory_demote` | **记忆降级**：长期 MEMORY 中指定 `id` → 指定 daily（`target` 必填 TODAY/YESTERDAY/date） |

---

## 主动记忆原则

- 发现值得记的信息（偏好/决策/教训/事实/进展/想法）时**主动写入，无需等用户说「记住」**。
- **默认一律先写今日日志（daily）**；进入长期（`target: "long_term"`）需对照三条硬标准：
  ① 跨多个会话持续成立、反复被依赖；② 影响长期工作方向；③ 用户明确要求。
  不确定即只写 daily；宁缺毋滥。
- **短期记忆可提升**：某条 daily 记忆近期被反复唤醒（同一 keyword 跨多天重复），可提升到长期。

---

## 配置

| 项 | 说明 |
|---|---|
| `config.json` | type 白名单与 target（唯一来源；改后重启生效） |
| `PROMPT.md` | 会话级注入提示词（主动记忆/宁缺毋滥/晋升引导），可独立编辑；缺失回退内置默认 |
| `WJ_MEMORY_DIR` | 覆盖记忆存储目录 |
| `WJ_MEMORY_CONFIG` | 覆盖 type 白名单配置路径 |
| `WJ_MEMORY_PROMPT` | 覆盖会话提示词文件路径 |

---

## 命令

- **`/wj-memory-migrate`**：引导智能体阅读 [`MIGRATION.md`](MIGRATION.md)，按各版本判据判断当前版本并逐级迁移记忆数据（「直接执行」项自动处理、「需决策」项以选择题询问用户，执行前先备份）。

---

## 相关文档

- [`MIGRATION.md`](MIGRATION.md) — 通用版本迁移指南（人类直接使用命令，无需查看）
- [`CHANGELOG.md`](CHANGELOG.md) — 各版本变更记录
