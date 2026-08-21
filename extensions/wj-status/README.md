# WJ Status

pi 的**状态栏 UI**：文本框状态栏 + 底部状态栏。实时展示 model、provider、思考级别、
扩展状态、上下文用量与**余额**，并渲染其他扩展（如 wj-scheduler）经桥发布的行。

> 当前版本：`0.2.0` ｜ 变更见 [`CHANGELOG.md`](CHANGELOG.md)

---

## 功能特性

**文本框状态栏**（文本框内部、输入行下方、下边框之上），按宽度三档自适应隐藏：
`● status · model · provider · statuses · think 级别`，窄到极限只保留 think 级别。
- 思考等级值的颜色与**输入框边框颜色一致**（同一 `thinking*` 主题 token，随思考等级/主题切换）且**永远加粗**；
  等级值右侧带灰色快捷键提示 `(shift+tab)`——动态读取 `app.thinking.cycle`，跟随用户改键；
  宽度不足时 `(shift+tab)` 最先被隐藏，off 时显示 `off`。

**底部状态栏**（`setFooter`）：在自身行下方**追加其他扩展桥发布的行**，统一渲染。
- 支持显示：model、tokens、cache、cost、context 用量、CWD、余额（balance）。
- **宽度规范**：所有行（含桥行）用 pi-tui 的 `visibleWidth()` / `truncateToWidth()` 测量/截断，
  不自行实现宽度表（避免对 `⏰`/`🔔` 等 Ambiguous/emoji 字符宽度误判导致补白/截断误差）。

**余额获取**（`balance.ts`）：按 provider 分发到对应实现，用 `modelRegistry`
取 API key，会话内去重并发拉取、缓存到全局 `data/wj-status/balance-cache.json`
（与 provider/key 绑定，不随会话变化）。

**成本追踪**：today cost = 当前 cost - 基线，基线在 `session_start` 首次落盘持久化
（会话级 `data/wj-status/<session>/cost-tracking.json`）。

**i18n**：中英双语（`i18n/zh.json` / `i18n/en.json`），`locale` 配置切换。

---

## 安装 / 加载

位于 `extensions/wj-status/`。pi 启动时自动扫描加载 `extensions/` 下所有子目录，无需登记。

---

## 配置

`extensions/wj-status/config.json`：

```jsonc
{
  "locale": "en",    // 界面语言：zh / en
  "currency": "CNY"  // 余额展示货币
}
```

## 扩展间通信（共享桥）

wj-status 的底部状态栏渲染时读取 `globalThis.__wj_scheduler_footer_lines`
（`string[] | null | undefined`）并追加到自身行**下方**。桥内容为**纯文本**（无 ANSI），
样式（深灰蓝背景 + `┌─┐│└─┘` 边框）由 wj-status 宿主统一渲染；wj-scheduler 定时发布、
空任务时发布 `null` 隐藏。**新扩展要往最底部加内容时沿用此桥模式**，并同步更新 AGENTS.md 清单。

---

## 数据与存储

- **成本基线 + 余额缓存**（项目级，跟随项目）：`.pi/wj/status/<sessionId>/cost-tracking.json`、`balance-cache.json`
- 默认基于**当前工作目录**（与 wj-memory/wj-scheduler 同级模式）；`WJ_STATUS_DIR` 环境变量可覆盖根目录

> 项目级 `.pi/wj/` 存储意图：成本与余额随项目归档、跨项目隔离，不入全局 `data/`。

## 文件

- `extensions/index.ts` — 入口：文本框状态栏 + 底部状态栏渲染、余额/成本拉取与缓存、桥渲染
- `extensions/balance.ts` — 余额获取模块（按 provider 分发）
- `i18n/zh.json` / `i18n/en.json` — 中英文案
- `config.json` — locale / currency
- `cost.json` — 成本配置（baseline 等）
