# AGENTS.md — pi Agent 配置项目

`~/.pi/agent` 是个人 pi agent 的全局配置目录。本文件是面向 pi agent 的项目手册，
描述目录结构、数据规范与工作约定。

## 一、项目定位

本项目的核心资产是三类可移植内容：

1. **extensions/** — 本地扩展（当前：`wj-scheduler`、`wj-status`）
2. **prompts/** — 技能型提示词模板（当前：`prompt-optimizer.md`）
3. **skills/** — 自定义技能目录（当前为空，未来新增技能放此）

其余目录为框架运行时、依赖或本机环境，不应作为开发/修改对象。

## 二、目录结构与职责

| 路径 | 类型 | 说明 |
|---|---|---|
| `extensions/` | 源码 | 本地扩展；扩展的**配置数据**留在各自目录（见 §3） |
| `prompts/` | 源码 | prompt 模板，frontmatter 声明 description + trigger |
| `skills/` | 源码 | 自定义技能（SKILL.md 约定），当前为空 |
| `data/` | 运行时 | 自动生成的运行时数据 / 临时文件（git 忽略） |
| `npm/` | 依赖 | 框架依赖包，可再安装，禁止改动 |
| `sessions/` `workflow-runs/` | 运行时 | 会话/工作流记录，禁止改动 |
| `bin/` | 本机 | 本机二进制工具（fd/rg），非可移植内容 |
| `SYSTEM.md` `settings.json` `tools.json` | 配置 | 框架级配置 |
| `auth.json` `models-store.json` `trust.json` | 敏感 | 凭据与本机状态，禁止改动/提交 |

## 三、数据存放规范（重要）

**自动生成的运行时数据与临时文件**必须放在 `data/<name>/<session>/` 下：

- `<name>`：产生数据的插件/功能名（如 `wj-scheduler`、`wj-status`）
- `<session>`：关联的会话 ID（UUID）
- 示例：`data/wj-scheduler/01a00da6-fd9b-74fa-ad77-3ebfcf4f9cb1/tasks.json`

**插件配置数据**（插件维护或手工维护的配置，如 `balance-cache.json`、
`cost-tracking.json`、`config.json`、`i18n/`）则**保留在插件自己的目录**下，
不属于本条规范约束对象。

禁止事项：

- ❌ 把自动生成的数据写到扩展目录、项目根目录或其他目录
- ❌ 把运行时数据提交进 git（`data/` 已在 `.gitignore` 中）

## 四、工作约定

1. **登记制**：新增/修改扩展、技能、prompt 模板后，必须同步更新本文件
   （目录表、说明或规范），保持文档与现状一致。
2. **禁止改动**：`npm/`、`sessions/`、`workflow-runs/`、`auth.json`、
   `models-store.json`、`trust.json`、`bin/` 为框架/本机/敏感内容，除非明确授权。
3. **数据路径合规**：新增或重构扩展时，运行时数据的写入路径必须遵循 §3 规范。
4. **扩展开发流程**：
   - 新扩展创建于 `extensions/<name>/`：`package.json`（声明 `pi.extensions` 入口）+ `extensions/index.js|ts`
   - 加载机制：pi 自动扫描并加载 `extensions/` 下所有子目录（`collectAutoExtensionEntries`），**无需**登记到 `settings.json.packages`；仅 npm 包才需在 `packages` 登记
   - 数据分流：运行时数据 → `data/<name>/<session>/`；配置数据 → 留在扩展目录
   - 完成后按第 1 条更新本文件目录表
5. **语言与风格**：本项目文档使用中文；改动后说明原因，多文件改动给出总结。