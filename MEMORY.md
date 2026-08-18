# MEMORY.md

> 2026-08-18 15:17:03 CST — 会话上下文存档（压缩前快照）

本文档记录本会话（2026-08-17 ~ 2026-08-18）在 `/home/jiaxingwang/.pi/agent` 项目中完成的全部工作、技术发现、关键决策与当前文件状态。压缩上下文后，新会话以此文档为恢复依据。

---

## 一、项目背景与目录结构

`~/.pi/agent` 是个人 pi agent 的全局配置目录，核心资产：
- **extensions/** — 本地扩展（当前：`wj-scheduler`、`wj-status`）
- **prompts/** — prompt 模板（`prompt-optimizer.md`，触发词 `prompt-optimizer`）
- **skills/** — 自定义技能（当前为空目录）
- **data/** — 运行时数据（git 忽略），规范路径 `data/<name>/<session>/`

其他目录：`npm/`（框架依赖）、`sessions/`、`workflow-runs/`（禁止改动）、`bin/`（fd/rg 二进制，本机环境）、`auth.json`/`models-store.json`/`trust.json`（敏感，不提交）。

**pi 安装位置**：`/home/jiaxingwang/.local/share/pnpm/global/v11/37fe50-19fa18afb79-e3bcf7666e32d2f9/node_modules/@earendil-works/pi-coding-agent/`
**pi-tui**：`/home/jiaxingwang/.local/share/pnpm/store/v11/links/@earendil-works/pi-tui/0.82.1/...`

---

## 二、已完成的文件 & 配置

### 1. `.gitignore`（已生成并验证）
忽略：`auth.json`、`models-store.json`、`trust.json`、`bin/`、`sessions/`、`workflow-runs/`、`data/`、`npm/`、`tasks/`、`test/`、`deprecated/`、Python 缓存、系统文件。
**保留跟踪**：`SYSTEM.md`、`settings.json`、`tools.json`、`AGENTS.md`、`extensions/`、`skills/`、`prompts/`。
当前目录**尚未 `git init`**（用户知悉）。

### 2. `AGENTS.md`（新编写，项目手册，含 5 节）
- §1 项目定位 / §2 目录结构表 / §3 数据存放规范 / §4 工作约定 / §5 已知待确认
- **数据规范**：自动生成的运行时数据/临时文件 → `data/<name>/<session>/`（如 `data/wj-scheduler/<sessionId>/tasks.json`）
- **插件配置数据例外**：`balance-cache.json`、`cost-tracking.json`、`config.json`、`i18n/` 留在扩展目录（不是 data 下）
- **登记制**：扩展/技能/prompt 变更后必须同步更新 AGENTS.md
- **禁止改动**：`npm/`、`sessions/`、`workflow-runs/`、`auth.json`、`models-store.json`、`trust.json`、`bin/`
- §4 扩展加载机制：pi 自动扫描 `extensions/` 子目录（`collectAutoExtensionEntries`），**无需登记 settings.json packages**；仅 npm 包需登记

### 3. `settings.json` 修改
从 `packages` 移除 `"./extensions/wj-status"`（冗余——扩展自动发现，无需登记）。当前 packages：piolium、pi-mcp-adapter、pi-web-access、pi-subagents、rpiv-ask-user-question、pi-extension。

### 4. 数据清理（已做，需确认已删）
删除：`data/wj-scheduler/tasks.json`（顶层，空 []）、`data/wj-scheduler/locks/`（旧版锁）、`data/tasks.json`（旧版 2 个已完成测试任务）——均为旧版遗留，当前代码零引用。

---

## 三、pi 框架关键技术知识（调查结论）

1. **扩展自动发现**：`dist/core/package-manager.js` 的 `collectAutoExtensionEntries()` 扫描 `~/.pi/agent/extensions/` 下每个子目录（非隐藏、非 node_modules）自动加载，读 `package.json` 的 `pi.extensions` 入口。
2. **扩展加载器**：`dist/core/extensions/loader.js` 用 **jiti** 加载 TS 扩展（`createJiti from "jiti/static"`），**支持相对 import 的 .ts 子模块**（已验证：wj-status 成功 import ./balance）。
3. **UI API（`ctx.ui`）**：
   - `setFooter(factory)`：底部状态栏，factory 拿到 `(tui, theme, footerData)`；`footerData.getExtensionStatuses()` 是读取其他扩展 `setStatus()` 状态的**唯一途径**
   - `setHeader(factory)`：头部；`setTitle`；`setWidget(key, content, {placement:"aboveEditor"|"belowEditor"})`：输入框上下方容器（默认 aboveEditor）
   - `setEditorComponent(factory)`：**替换输入框编辑器**（`EditorFactory = (tui, theme, keybindings) => EditorComponent`），官方注释明确支持"extending CustomEditor"（duck typing：`"actionHandlers" in customEditor`）；`getEditorComponent()` 获取当前 factory
   - `setStatus(key, text)`：扩展状态文本（进 footer 数据，非 statusContainer）
   - `custom(factory, options)`：overlay 弹层
4. **TUI 布局顺序**（interactive-mode.js 484-493 addChild 顺序）：headerContainer → loadedResourcesContainer → chatContainer → pendingMessagesContainer → statusContainer → widgetContainerAbove → editorContainer(输入框) → widgetContainerBelow → footer。
5. **widgetContainerAbove 固定空行**：框架初始化时 `renderWidgets(); // Initialize with default spacer`，无 widget 时 `spacerWhenEmpty=true` 也渲染 `Spacer(1)`——**输入框上方始终有一行空位，扩展 API 无法移除**（用户接受保留）。
6. **Editor 渲染结构**（pi-tui `components/editor.js`）：`render(width)` 返回 `string[]` = `[上边框, ...输入行(可多行/滚动), 下边框]`。可通过继承 CustomEditor 重写 render，在**下边框前插入自定义行**（= 文本框内部）。
7. **widget 工厂拿不到 footerData**（仅 setFooter 有）→ wj-status 用 footer 组件作"状态缓存桥"：每次 render 时 `syncExtensionStatuses()` 读 `getExtensionStatuses()` 存入模块变量，widget/editor 渲染时读取。
8. **EditorTheme 无 fg()**：editor 内部 theme 是 pi-tui 的 EditorTheme，可能没有 `fg()` 方法——wj-status 有 `color()` 防护（`typeof theme?.fg === "function" ? theme.fg(name,x) : x`）和 `atelierThemeRef`（由 footer/widget 工厂的完整 Theme 统一注入）。

---

## 四、wj-status 扩展（extensions/wj-status/）当前状态

### 结构
- `extensions/index.ts` — 主逻辑（约 850 行：i18n、cost 跟踪、balance 调度、UI 渲染、命令、编辑器注入）
- `extensions/balance.ts` — **独立余额模块**（新抽取）：`getBalance(provider, apiKey)` 总函数 switch 分发 + 各供应商函数
- `config.json`（locale=en, currency=CNY）、`cost.json`（USD rate1 / CNY rate7, decimals4——注意 todayCost 显示已改用固定 toFixed(2)，不再用 decimals）、`i18n/`、`balance-cache.json`、`cost-tracking.json`（修复后自动生成）

### 数据文件分类
- 配置数据（留扩展目录）：`balance-cache.json`、`cost-tracking.json`、`config.json`、`i18n/`
- 无运行时数据在 data/ 下（wj-status 无 session 数据）

### 功能清单
1. **状态栏两行布局**：
   - **文本框状态栏**（编辑器内部、输入行下方、下边框上方，`StatusAwareEditor.render` 注入）：`● READY · model · provider · statuses … think high`（右端）
   - **底部状态栏**（footer，`renderLine2`）：`session · cwd · duration`（左）`ctx · cache · cost · bal`（右）
2. **文本框状态栏自适应**（隐藏顺序固定，宽度不足逐项隐藏）：provider → think 前缀 → ●READY → statuses → model → think 级别（最后只剩 high）。**显示顺序与隐藏顺序独立**：显示为 ●READY → model → provider → statuses（`displayOrder` 排序）。
3. **底部状态栏三级自适应**：1 行（左右同行右对齐，gap≥4）→ 2 行（左部/右部各自≤width）→ 4 行（2 行时任一行超宽则细拆：① session·dur ② cwd ③ ctx·cache ④ cost·bal，逐行截断）。
4. **行列颜色体系**：●READY 状态=syntaxKeyword；model=text；provider=灰色；think 标签=灰色、级别值=蓝 `\x1b[38;2;114;211;252m`；ctx 值=青 `38;2;114;211;252m`；cache 值=紫 `38;2;177;140;255m`；cost=橙 `38;2;255;159;67m`；bal 值=绿 `38;2;187;255;153m`。
5. **数字格式**：cache 百分比 `toFixed(1)`（99.9%）；todayCost 固定 `toFixed(2)`（¥0.00）；session cost `toFixed(2)`。in/out 已删除；ctx（`ctx 26.1% 1.0M (auto)`）并入底部状态栏左侧（cache 之前）。
6. **成本统计**：session cost 从 entries 的 `usage.cost.total` 累加；todayCost = 当前累计 - `cost-tracking.json` 的 `lastMidnightCost` 基线（跨午夜重置）。**修复历史**：原 bug 是 baseline 永不落盘→todayCost 恒 0；修复让 `loadCostTracking` 首次创建即 save，且加了格式校验与 `Math.max(0,...)` 负值保护。
7. **余额**：`fetchBalance(ctx)` 取 key 后调 `getBalance(provider, key)`。支持：deepseek（¥, 官方 /user/balance）、openai/openai-compatible（$）、opencode-go（`15%/22%/11%` 滚动/周/月已用百分比）。缓存 60s、轮询 30s（`startBalanceTimer`），`balance-cache.json` 持久化。**`bal` 为 null/UNKNOWN 时整段隐藏**。
8. `/wj-status` 命令：notify 详情面板。

### 已知注意事项
- `cost-tracking.json` 修复后已在扩展目录生成（balance-cache.json 中 opencode-go 已是最新格式 `15%/22%/11%`；deepseek 为 null）
- 曾发生的报错已修复：`renderStatusLine is not defined`（因替换 renderLine2 时误删函数体，已恢复）——**改 renderLine2 时注意不要动 renderStatusLine**
- 其他会话/进程也重构过此文件（color 防护 `color()`、atelierThemeRef 等改进保留）

---

## 五、opencode-go 供应商（当前默认 provider）

- `settings.json`: defaultProvider=opencode-go, defaultModel=deepseek-v4-flash
- **baseUrl**: `https://opencode.ai/zen/go/v1`（OpenAI 兼容；auth 为 api_key）
- **余额接口**（实测有效，HTTP 200）：`GET https://opencode.ai/zen/go/v1/usage`，Bearer key（auth.json 的 opencode-go.key）
  - 响应：`{"usage":{"rolling":{"status":"ok","percent":13,"resetsAt":...},"weekly":{...},"monthly":{...}}}`
  - 只有**百分比**，无金额；格式 `14%/22%/11%`（滚动/周/月已用；剩余 = 100-该值）
  - `GET /zen/v1/balance` 与 `/zen/go/v1/balance` 均为 404（不存在）
- models-store.json 中 opencode-go 有 19 个模型（deepseek/glm/gpt/grok/kimi/mimo/minimax/qwen 系列），单模型实例字段含 api/cost/compat 等

---

## 六、wj-scheduler 扩展

- `extensions/wj-scheduler/extensions/index.ts`（**TS 实现**，2026-08-18 由 JS 重构；自包含 cron 解析；入口 `package.json pi.extensions → ./extensions/index.ts`）
- 数据路径：session_start 时 `data/wj-scheduler/<sessionId>/tasks.json` + `scheduler.lock`（**符合 data/[name]/[session] 规范**）
- **不**在 settings.json packages 中，靠扩展自动发现加载（已验证）
- 提供 `/wj-cron` 命令（status/list/get/run/enable/disable/delete）与 LLM 工具（wj_scheduler_create/list/get/update/delete/run_now）
- **已移除 setStatus 状态推送**（`wj-scheduler: active/idle` 不再显示在状态栏）
- **新增 `status.ts` 状态展示模块**：轮询 `scheduler.list()` → 过滤 enabled 任务 → 按**有效下次时间**升序 → 行格式 `序号. 标题 · 定时类型 · 间隔(仅循环) · 下次YYYY/MM/DD-HH:mm:ss · 上次YYYY/MM/DD-HH:mm:ss`（序号 1 起，原 ⏰ 已改）；定时类型=单次/循环/周期；**无 lastRunAt 不显示上次段**；**新任务实时估算下次时间**（interval=now+间隔；once=schedule(未来)；cron=computeNextCronRun）→ 发布到共享桥 `globalThis.__wj_scheduler_footer_lines`（空任务发 null）；`index.ts` 在 session_start 安装（立即发布+5s 轮询，unref），shutdown 时 dispose 清桥
- **cron 解析器抽为共享模块 `cron.ts`**（export computeNextCronRun）：index.ts（调度）与 status.ts（下次时间估算）共用，避免循环依赖；架构上 index.ts → status.ts → cron.ts, index.ts → cron.ts 单向无环
- **共享桥协议**：wj-status footer `renderLine2` 渲染时读 `__wj_scheduler_footer_lines` 追加到自身行下方；**桥内容纯文本，宿主统一样式化**：深灰蓝背景 `48;2;34;40;50` + 前景灰蓝 `38;2;148;163;184` + 边框 `┌─┐/│ │/└─┘`（行宽按 visibleLen 补足到 width，ANSI 由 truncateToVisible 保持）;两扩展通过 globalThis 桥解耦，无相互 import
- **重构要点**：新增 Task/TaskInput/HistoryEntry/SchedulerStatus 类型 + 类字段类型 + 方法签名；`import type { ExtensionAPI }`；删除零引用的死代码（defineTool/TString/TBoolean/TObject）；工具注册用本地 `register` 包装（any 上下文，规避 TypeBox 类型噪音）；`import type` 在运行时被剥离，无新增依赖
- 锁实现：PerProcessLock（每个 session 独立锁文件，PID 存活检查）
- session 目录为空的属正常（session_start 时 mkdirSync 创建）

---

## 七、待办 / 潜在事项

1. 当前目录**未 git init**——用户若要纳入版本管理需自行 init（.gitignore 已就绪）
2. AGENTS.md §5 已移除（两项待确认均已解决），但可考虑记录历史（当前无待确认项）
3. wj-status 的 editor 替换（setEditorComponent）：若其他扩展也调用此 API 会相互覆盖（当前项目无冲突扩展）
4. `in/out` 已删除、`ctx` 已并入底部栏——若未来要恢复 in/out 需重新加渲染
5. config.json 的 costCfg.rate CNY=7 为估算汇率（¥ 显示）；todayCost 已固定 toFixed(2)

---

## 八、工作方式备注（与用户协作的经验）

1. 用户使用 `prompt-optimizer <内容>` 触发优化引导流程（会粘贴一整套角色说明），内容优化后以"✅ 优化后的 Prompt 如下："展示并让用户选 A 立即执行 / B/C 建议 / D 继续修改，**不选 A 则不执行**
2. 用户对 TUI 布局细节要求精准（曾多次用 ASCII 图纠正位置），修改 UI 前确认布局意图
3. 用户偏好"内容自适应"胜于固定阈值（footer/文本框状态栏均为自适应）；名称约定：**文本框状态栏**（编辑器内行）、**底部状态栏**（footer行）
4. 涉及删除/敏感操作（删文件、改 auth 相关）必须先征得确认
5. 该项目改代码时注意：源文件含真实 ESC 控制字节（`\x1b[...m`）的旧代码段，edit 工具字面匹配会失败，**用 Python 按行定位替换更稳**；新写代码可用字面 `\x1b` 转义（等价）
6. 验证扩展代码：复制到 /tmp 桩化外部 import（`declare const`+mock CEMock 覆盖 CustomEditor）+ `node --experimental-strip-types` 加载 + mock pi/ctx 冒烟测试；真实网络验证用 auth.json 的 key（勿打印 key）