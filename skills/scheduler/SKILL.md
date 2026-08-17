---
name: scheduler
description: >
  封装 6 个内置调度工具（scheduler_create/scheduler_list/scheduler_get/
  scheduler_update/scheduler_delete/scheduler_run_now），
  提供自然语言接口来管理定时任务。

  支持 cron（周期性）、interval（固定间隔）、once（一次性）三种调度类型。
  创建任务后不要等待执行，系统会自动在正确时间唤醒执行。
triggers:
  - create: 创建/新建/添加定时任务/定时/安排/计划
  - list: 查看任务/任务列表/我的任务/所有任务/有哪些任务/list
  - detail: 查看任务详情/任务状态/任务执行结果/任务历史
  - update: 修改/更新/更改/编辑定时任务
  - delete: 删除/取消/移除/停止/暂停定时任务
  - run: 立即执行/马上执行/手动执行/强制执行/触发/run now
  - schedule: 每天/每周/每月/每日/每小时/每5分钟/周期性/循环/cron
metadata:
  source: pi-framework
  tools:
    - scheduler_create
    - scheduler_list
    - scheduler_get
    - scheduler_update
    - scheduler_delete
    - scheduler_run_now
---

# Scheduler — 定时任务管理器

封装 pi 框架内置的 6 个调度工具，通过自然语言管理定时任务。

---

## When to Use

- 用户需要创建定时/周期性/延迟执行的任务
- 用户想查看、修改或删除已有的定时任务
- 用户想立即手动触发一个已有的定时任务
- 用户询问"能定时执行吗"、"能设置每天跑吗"等调度相关问题时

## When NOT to Use

- 一次性即时执行的任务（直接执行即可，不需要调度）
- pi-subagents 的子代理调度（`subagent({ action: "schedule" })` 走 subagent 流程）
- 需要持续 sleep/轮询等待的任务（应使用定时任务替代 sleep）

## ⚠️ 核心行为规则（必须遵守）

1. **创建定时任务后不要 sleep 或等待执行。** 任务会在正确时间自动唤醒，你只需提交创建即可。
2. 创建/更新/删除任务后，**直接终止当前流程或继续后续任务**。
3. 用户询问"任务是否执行了/执行结果如何"时，使用 `scheduler_get` 查询，**不要原地等待**。
4. **不要替用户决定调度时间**，除非用户明确要求你推荐。

---

## 路由表

| 用户意图 | 对应工具 | 说明 |
|---------|---------|------|
| 创建一个定时任务 | `scheduler_create` | 支持 cron/once/interval 三种类型 |
| 列出所有定时任务 | `scheduler_list` | 查看任务 ID、名称、状态、下次执行时间 |
| 查看某个任务详情 | `scheduler_get` | 查看完整配置和运行历史 |
| 修改一个定时任务 | `scheduler_update` | 可改调度、prompt、名称、启用/禁用 |
| 删除一个定时任务 | `scheduler_delete` | 按 taskId 删除 |
| 立即执行一个任务 | `scheduler_run_now` | 忽略原调度计划，强制立即执行 |

---

## 详细使用指南

### 1. 创建定时任务（scheduler_create）

**自然语言示例：**
- "帮我定个每天早上9点发日报的任务" → 创建 cron 任务
- "5分钟后提醒我开会" → 创建 once 任务（`+5m`）
- "每30分钟检查一次服务器状态" → 创建 interval 任务（`30s`/`5m`/`1h`）

**参数说明：**
| 参数 | 必填 | 说明 |
|------|------|------|
| `type` | ✅ | `cron` / `once` / `interval` |
| `schedule` | ✅ | cron 表达式 / 时间偏移 / 间隔字符串 |
| `prompt` | ✅ | 到达时间后要执行的指令 |
| `name` | ❌ | 任务名称（建议填写以便管理） |
| `description` | ❌ | 任务描述 |
| `enabled` | ❌ | 是否启用，默认 `true` |
| `timeoutMs` | ❌ | 执行超时时间（毫秒），默认 30 分钟 |

**调用方式：**
```typescript
scheduler_create({
  type: "cron",
  schedule: "0 9 * * *",
  prompt: "请生成昨天的项目日报并发送",
  name: "每日日报",
  description: "每个工作日早上9点生成日报"
})
```

**行为注意：** 创建成功后返回任务摘要（含 id、下次执行时间等），**不要 sleep 等待执行**。

---

### 2. 列出所有任务（scheduler_list）

**自然语言示例：**
- "查看我有哪些定时任务" / "列出所有任务" / "我的任务列表"

**调用方式：**
```typescript
scheduler_list({})
```

**返回示例：**
```json
[
  {
    "id": "abc123",
    "name": "每日日报",
    "type": "cron",
    "schedule": "0 9 * * *",
    "enabled": true,
    "lastStatus": "completed",
    "nextRunAt": "2025-01-02T09:00:00Z",
    "runCount": 5
  }
]
```

---

### 3. 查看任务详情（scheduler_get）

**自然语言示例：**
- "查看任务 abc123 的详情" / "看看日报任务执行的怎么样了"

**调用方式：**
```typescript
scheduler_get({ taskId: "abc123" })
```

返回完整的任务配置和运行历史记录。

---

### 4. 修改任务（scheduler_update）

**自然语言示例：**
- "把日报任务改成下午6点执行"
- "暂停日报任务" / "启用日报任务"
- "把日报任务的 prompt 改一下"

**调用方式：**
```typescript
scheduler_update({
  taskId: "abc123",
  schedule: "0 18 * * *",     // 只改调度
  enabled: false               // 或禁用
})
```

---

### 5. 删除任务（scheduler_delete）

**自然语言示例：**
- "把任务 abc123 删掉" / "取消日报任务" / "停止那个定时任务"

**调用方式：**
```typescript
scheduler_delete({ taskId: "abc123" })
```

---

### 6. 立即执行任务（scheduler_run_now）

**自然语言示例：**
- "日报任务现在就跑一次" / "立即触发 abc123"
- "不等了，马上执行"

**调用方式：**
```typescript
scheduler_run_now({ taskId: "abc123" })
```

**注意：** 这不会修改原有的定时计划，只是额外立即执行一次。

---

## 调度表达式速查表

### cron 表达式（周期性）

| 含义 | 表达式 | 说明 |
|------|--------|------|
| 每分钟 | `* * * * *` | 分 时 日 月 周 |
| 每5分钟 | `*/5 * * * *` | 常用监控频率 |
| 每30分钟 | `*/30 * * * *` | |
| 每小时（整点） | `0 * * * *` | |
| 每天早上9点 | `0 9 * * *` | 常用日报时间 |
| 每天早上9点和下午6点 | `0 9,18 * * *` | 一天两次 |
| 每天上午9:30 | `30 9 * * *` | |
| 每周一早上9点 | `0 9 * * 1` | 周报时间（1=周一） |
| 工作日每天早上9点 | `0 9 * * 1-5` | 仅周一至周五 |
| 每月1号凌晨0点 | `0 0 1 * *` | 月报时间 |
| 每季度第一天 | `0 0 1 1,4,7,10 *` | 按季度执行 |

### interval（固定间隔）

| 含义 | 表达式 |
|------|--------|
| 每30秒 | `30s` |
| 每5分钟 | `5m` |
| 每30分钟 | `30m` |
| 每小时 | `1h` |
| 每6小时 | `6h` |
| 每12小时 | `12h` |

### once（一次性）

| 含义 | 表达式 | 说明 |
|------|--------|------|
| 10分钟后 | `+10m` | 相对时间 |
| 2小时后 | `+2h` | 相对时间 |
| 1天后 | `+1d` | 相对时间 |
| 指定时间 | `2030-01-01T09:00:00Z` | 绝对时间（UTC） |

---

## 常见使用场景示例

### 场景 1：每日定时生成日报
```text
用户：每天早上9点帮我生成一份项目日报
→ scheduler_create({ type:"cron", schedule:"0 9 * * *", name:"每日日报",
    prompt:"查看今天的 git 提交和 issue 状态，生成日报" })
→ "已创建，下次执行：明天 09:00"  // 不等待，直接回复
```

### 场景 2：定时监控
```text
用户：每5分钟检查一次服务器是否在线
→ scheduler_create({ type:"interval", schedule:"5m", name:"服务器监控",
    prompt:"检查服务器状态，如果离线就告警" })
→ "已创建，每5分钟执行一次"  // 不等待
```

### 场景 3：一次性延迟提醒
```text
用户：2小时后提醒我发周报
→ scheduler_create({ type:"once", schedule:"+2h", name:"发周报提醒",
    prompt:"提醒用户该发周报了" })
→ "已创建，2小时后提醒"  // 不等待
```

### 场景 4：查看和管理任务
```text
用户：看看我的定时任务
→ scheduler_list({})
→ 展示任务列表

用户：把日报任务改成下午6点
→ scheduler_update({ taskId:"xxx", schedule:"0 18 * * *" })
→ "已更新，下次执行：今天 18:00"
```

---

## FAQ

### Q: 创建任务后需要等它执行吗？
**A: 不需要！** 系统会在指定时间自动唤醒执行。创建后直接回复用户或继续其他工作即可。

### Q: 用户问"任务执行了吗"怎么办？
**A: 使用 `scheduler_get` 查询任务状态，查看 `lastStatus` 和 `lastRunAt` 字段。**

### Q: 任务为什么没执行？
**A: 检查以下几点：**
1. 任务是否 `enabled: true`（被禁用的任务不会执行）
2. 调度表达式是否正确
3. 用 `scheduler_get` 查看 `lastStatus` 是否有错误信息

### Q: 可以修改已有任务的调度时间吗？
**A: 可以。使用 `scheduler_update` 传入新的 `schedule` 即可，其他配置保持不变。**

### Q: 立即执行和原来的定时冲突吗？
**A: 不冲突。`scheduler_run_now` 只是额外执行一次，不影响原有的定时计划。**

### Q: 支持哪些时区？
**A: 调度系统使用 UTC 时间。cron 表达式也是基于 UTC。如果用户指定的是北京时间（UTC+8），需要转换。**
