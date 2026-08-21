> **对于人类**：使用命令 `/wj-memory-migrate` 进行迁移。**无需查看该文件**。如有必要可以查看 `README.md` 和 `CHANGELOG.md`。

> **对于智能体**：查看当前文件并执行。

---

# WJ-Memory 迁移指南

本文件是 wj-memory 的**通用升级指南**，说明升级时已有记忆数据（`MEMORY.json` + `daily/*.json`）
需要做哪些调整。**每个版本迁移各占一个小节**（形如 `# Vx.y -> Vx.y`），今后发布新版本时，
把对应迁移步骤追加为新的一节即可。

> ⚠️ **通用红线**：以下任何一步都会改动你的**真实记忆数据**。
> **执行前必须先询问用户确认**，并先做好备份；本指南只描述「需要改什么 / 怎么改」，不自动替你执行。

## 升级前准备（必做）

1. **备份整个记忆目录**：
   ```bash
   cp -r .pi/wj/memory .pi/wj/memory.backup-$(date +%Y%m%d)
   ```
   或备份 `WJ_MEMORY_DIR` 指定的位置。
2. 确认你已把 wj-memory 升级到目标版本（改完 config/代码后需重启 pi / reload 生效）。

---

# V0.1.0 -> V0.2.0

从 **V0.1.0** 升级到 **V0.2.0** 时，记忆数据需要做的调整。

## 版本判据

当出现以下**内容之一**时，表示当前存在 V0.1.0 的记录：

1. `config.json` 中 `#decision` 的 `target=any` 而非 `daily`。
2. `daily/` 存在 `#system` 类型的记录，且内容为 `会话结束（自动收尾）`。
3. `MEMORY.json` 中存在 `#decision` 记录。

## 逐项调整

对照「版本判据」处理。**判据 1、2 无需用户决策，直接执行**；仅**判据 3** 需用户选择方案。

### 判据 1：`#decision` 的 `target=any` —— 直接执行
把 `config.json` 中 `#decision.target` 改为 `daily`（V0.2.0 已内置）。仅涉及配置，不涉及记录迁移。

### 判据 2：daily 存在 `#system`「会话结束（自动收尾）」 —— 直接执行
删除这些 `#system` 条目（保留其余真实日志）。核对条件：`type === "#system"` 且 `content === "会话结束（自动收尾）"`。

### 判据 3：`MEMORY.json` 存在 `#decision` —— 需用户决策（选择题）

**选择方案：**

1. **移出长期（推荐）**：把该记录追加到对应 timestamp 日期的 `daily/YYYY-MM-DD.json`，然后从 MEMORY 删除。（可调用工具 `wj_memory_demote`（按 id，长期→指定 daily）自动完成。）
2. **转换类型**：若确属跨会话仍有效，转成 `#preference / #lesson / #fact` 之一，更新 type 后留在 MEMORY。

## 长期记忆收窄（在 3 个判据迁移完成后进行）

> 若上述 3 个判据**均未命中**（用户并非从 V0.1.0 迁移而来），可跳过本项。

V0.2.0 对**进入长期记忆（MEMORY.json）的记录要求更严格**（宁缺毋滥：只有跨会话持续成立、影响长期方向、或用户明确要求的内容才值得保留长期；不确定的一律放短期 daily）。

因此，在完成上述 3 个判据的迁移后，还须**重新审视当前已在长期记忆中的记录是否真的值得留在长期**：

- 逐条检查 MEMORY.json 现有记录，判断其是否仍满足「长期保留」标准。
- **提示用户**：对不再值得长期保留的记录，是否移动到短期记忆（`daily/`；type 相应调整为 `#log`/`#note` 等 daily-only 类型）。
- 这是一项高度依赖用户判断的操作：执行前先询问用户、先备份，逐条确认后再移动。
- **工具辅助**：移动单个记录可用 `wj_memory_demote`（长期→指定 daily，按 id）与 `wj_memory_promote`（daily→长期，按 id）完成；先由 `wj_memory_read({file:"MEMORY"})` 列出长期记录与 id 供逐条确认。

## 升级后校验

- `wj_memory_status`：MEMORY/今日/昨日记录数、关键词组、类型分布是否合理。
- `wj_memory_read({ file: "MEMORY" })`：长期记忆应**仅剩** `#preference/#lesson/#fact`（零 `#decision`、零噪音）。
- 日常注入：不再出现 `#system session-end:xxx`。
- 可用 `wj_memory_search` 抽查迁移后的记录 keyword/content 完整。

---

# （新增版本迁移对照示例，未来追加）

今后的版本迁移在此追加新小节，例如 `# V0.2.0 -> V0.3.0`，沿用上述「版本判据 → 备份 → 逐项调整（先问用户）→ 校验」的结构。
