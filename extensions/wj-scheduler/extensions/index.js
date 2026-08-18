/**
 * WJ Scheduler — 零依赖、自包含的定时任务管理器
 *
 * 修复了原 @amaster.ai/pi-task-scheduler 的跨进程锁竞争 bug。
 *
 * 🐛 Bug 根源：
 *    原 FileSchedulerLock 所有 PI 进程共用同一个锁文件，
 *    仅第一个启动的进程能获取锁，其他进程静默失败。
 *
 * 🔧 修复方案：
 *    每个进程使用独立的数据目录 ~/.pi/agent/data/wj-scheduler/<pid>/
 */

// ──────────────────────────────────────
// Node.js 内置模块（无需外部依赖）
// ──────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// ──────────────────────────────────────
// 常量
// ──────────────────────────────────────
const SETTINGS_KEY = "wj-scheduler";

/**
 * 解析用户主目录
 */
function resolveHome() {
  return process.env.HOME || process.env.USERPROFILE || "/home/jiaxingwang";
}

/**
 * 获取 PI agent 数据目录
 */
function getAgentDataDir() {
  return path.join(resolveHome(), ".pi", "agent", "data");
}

// ──────────────────────────────────────
// 硬编码的 cron 解析器（轻量版）
// 避免依赖 croner 包
// ──────────────────────────────────────

/**
 * 简易 cron 解析 — 计算下一次执行时间
 * 支持标准 5 字段 cron 表达式
 */
function computeNextCronRun(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;

  const now = new Date();
  // 从下一分钟开始搜索
  let search = new Date(now);
  search.setSeconds(0, 0);

  const [minField, hourField, domField, monField, dowField] = fields;

  for (let i = 0; i < 525600; i++) {
    // 最多搜索 1 年
    const candidate = new Date(search.getTime() + i * 60 * 1000);

    if (!matchField(candidate.getMonth() + 1, monField, 1, 12)) continue;
    if (!matchField(candidate.getDate(), domField, 1, 31)) continue;
    if (!matchField(candidate.getDay(), dowField, 0, 6)) continue;
    if (!matchField(candidate.getHours(), hourField, 0, 23)) continue;
    if (!matchField(candidate.getMinutes(), minField, 0, 59)) continue;

    return candidate.toISOString();
  }
  return undefined;
}

function matchField(value, field, min, max) {
  if (field === "*") return true;

  // 逗号分隔列表
  for (const part of field.split(",")) {
    // 步进: */5, 1-10/2
    let [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;

    if (range === "*") {
      if ((value - min) % step === 0) return true;
      continue;
    }

    // 范围: 1-5
    const [rStart, rEnd] = range.split("-").map((s) => parseInt(s, 10));
    if (rEnd !== undefined) {
      if (value >= rStart && value <= rEnd && (value - rStart) % step === 0) return true;
    } else {
      // 单个值
      if (value === rStart) return true;
    }
  }
  return false;
}

// ──────────────────────────────────────
// PerProcessLock — 每个进程独立的锁
// ──────────────────────────────────────

class PerProcessLock {
  constructor(lockDir) {
    // 锁文件放在 session 隔离目录内，不同 session 不冲突
    this.path = path.join(lockDir, "scheduler.lock");
    this.acquired = false;
  }

  acquire() {
    mkdirSync(path.dirname(this.path), { recursive: true });
    try {
      writeFileSync(this.path, String(process.pid), { flag: "wx" });
      this.acquired = true;
      return true;
    } catch {
      // 锁文件已存在，检查 PID
      try {
        const pid = Number(readFileSync(this.path, "utf8").trim());
        if (pid === process.pid) {
          this.acquired = true;
          return true;
        }
        // 旧进程死亡则清理
        if (!this.#isAlive(pid)) {
          unlinkSync(this.path);
          writeFileSync(this.path, String(process.pid), { flag: "wx" });
          this.acquired = true;
          return true;
        }
      } catch {}
      this.acquired = false;
      return false;
    }
  }

  release() {
    if (!this.acquired) return;
    try {
      const pid = Number(readFileSync(this.path, "utf8").trim());
      if (pid === process.pid) unlinkSync(this.path);
    } catch {}
    this.acquired = false;
  }

  isAcquired() { return this.acquired; }

  #isAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
}

// ──────────────────────────────────────
// PerProcessTaskStore — 每个进程独立的任务存储
// ──────────────────────────────────────

class PerProcessTaskStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = null;
    this.writeQueue = Promise.resolve();
  }

  async list() {
    await this.#load();
    return Array.from(this.cache.values());
  }

  async get(taskId) {
    await this.#load();
    return this.cache.get(taskId);
  }

  async create(task) {
    const normalized = this.#normalize(task);
    await this.#mutate(() => this.cache.set(normalized.id, normalized));
    return normalized;
  }

  async update(taskId, task) {
    const normalized = this.#normalize(task);
    const ok = await this.#mutate(() => {
      if (!this.cache.has(taskId)) return false;
      this.cache.set(taskId, normalized);
      return true;
    });
    return ok ? normalized : undefined;
  }

  async delete(taskId) {
    return this.#mutate(() => this.cache.delete(taskId));
  }

  async #load() {
    if (this.cache) return;
    this.cache = new Map();
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (item?.id) this.cache.set(item.id, this.#normalize(item));
          }
        }
      }
    } catch {}
  }

  async #save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Array.from(this.cache.values()), null, 2), "utf-8");
  }

  async #mutate(fn) {
    const pending = this.writeQueue.then(async () => {
      await this.#load();
      const result = fn();
      await this.#save();
      return result;
    });
    this.writeQueue = pending.catch(() => undefined);
    return await pending;
  }

  #normalize(raw) {
    return {
      id: raw.id,
      type: raw.type ?? "interval",
      schedule: raw.schedule ?? "",
      intervalSeconds: typeof raw.intervalSeconds === "number" && Number.isFinite(raw.intervalSeconds)
        ? Math.max(5, Math.floor(raw.intervalSeconds)) : 60,
      prompt: raw.prompt ?? "",
      name: raw.name,
      description: raw.description,
      model: raw.model,
      sessionId: raw.sessionId,
      toolPolicyProfile: raw.toolPolicyProfile,
      enabled: raw.enabled !== false,
      createdAt: raw.createdAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      runCount: typeof raw.runCount === "number" ? Math.max(0, Math.floor(raw.runCount)) : 0,
      runHistory: Array.isArray(raw.runHistory) ? raw.runHistory.slice(-25) : [],
      nextRunAt: raw.nextRunAt,
      lastRunAt: raw.lastRunAt,
      lastStatus: raw.lastStatus,
      lastError: raw.lastError,
      timeoutMs: raw.timeoutMs,
    };
  }
}

// ──────────────────────────────────────
// WJ-Scheduler 核心
// ──────────────────────────────────────

class WJScheduler {
  constructor(opts) {
    this.store = opts.store;
    this.lock = opts.lock;
    this.runner = opts.runner;
    this.timers = new Map();
    this.intervals = new Map();
    this.active = false;
    this.runningIds = new Set();
    this.heartbeatTimer = null;
  }

  async list() { return this.store.list(); }
  async get(id) { return this.store.get(id); }

  async status() {
    const tasks = await this.store.list();
    return {
      active: this.active,
      pid: process.pid,
      taskCount: tasks.length,
      timerCount: this.timers.size,
      intervalCount: this.intervals.size,
      runningCount: this.runningIds.size,
    };
  }

  isActive() { return this.active; }

  async create(input) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const def = this.#resolveSchedule(input);
    const task = {
      id,
      ...def,
      prompt: input.prompt,
      name: input.name,
      description: input.description,
      model: input.model,
      sessionId: input.sessionId,
      toolPolicyProfile: input.toolPolicyProfile,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      runHistory: input.enabled === false
        ? [this.#histEntry("paused", "Created paused")]
        : [],
    };
    const created = await this.store.create(task);
    if (this.active) this.#schedule(created);
    return created;
  }

  async update(taskId, input) {
    const existing = await this.store.get(taskId);
    if (!existing) return undefined;

    const next = { ...existing, ...input, updatedAt: new Date().toISOString() };

    // 处理 enabled 状态变更历史
    if (input.enabled !== undefined && input.enabled !== existing.enabled) {
      next.runHistory = [
        ...next.runHistory,
        this.#histEntry(
          input.enabled ? "resumed" : "paused",
          input.enabled ? "Task resumed" : "Task paused",
        ),
      ].slice(-25);
    }

    // 如果重新启用且之前有 error，清除错误
    if (input.enabled !== false && existing.lastStatus === "error" && existing.lastError) {
      delete next.lastError;
    }

    // 重新调度类型
    if (input.type || input.schedule) {
      const def = this.#resolveSchedule({
        type: input.type ?? existing.type,
        schedule: input.schedule ?? existing.schedule,
      });
      next.type = def.type;
      next.schedule = def.schedule;
      next.intervalSeconds = def.intervalSeconds;
    }

    const task = this.#withNextRun(next);
    const updated = await this.store.update(taskId, task);
    if (this.active) this.#schedule(task);
    return updated;
  }

  async delete(taskId) {
    this.#unschedule(taskId);
    return this.store.delete(taskId);
  }

  async runNow(taskId) {
    const task = await this.store.get(taskId);
    if (!task) return undefined;
    this.#execute(taskId).catch(() => {});
    return task;
  }

  async start() {
    if (this.active) return;
    if (!this.lock.acquire()) {
      console.warn("[wj-scheduler] 锁获取失败");
      return;
    }
    this.active = true;
    this.#startHeartbeat();

    const tasks = await this.store.list();
    for (const task of tasks) {
      if (task.lastStatus === "running") {
        // 上次异常中断
        const fixed = this.#withNextRun({
          ...task,
          lastStatus: "error",
          lastError: "进程异常中断，正在运行的任务未完成",
          runHistory: [...task.runHistory, this.#histEntry("error", "进程中断")].slice(-25),
          updatedAt: new Date().toISOString(),
        });
        await this.store.update(task.id, fixed).catch(() => {});
        this.#schedule(fixed);
      } else {
        this.#schedule(this.#withNextRun(task));
      }
    }
  }

  async stop() {
    for (const [id] of this.timers) this.#unschedule(id);
    this.active = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.lock.release();
  }

  // ── 内部方法 ──

  #resolveSchedule(input) {
    if (input.type === "interval") {
      const sec = this.#parseInterval(input.schedule);
      if (!sec) throw new Error(`无效的间隔表达式: ${input.schedule}`);
      return { type: "interval", schedule: input.schedule, intervalSeconds: Math.max(5, sec) };
    }
    if (input.type === "once") {
      const resolved = this.#resolveOnce(input.schedule);
      const delay = Math.max(1, Math.ceil((new Date(resolved).getTime() - Date.now()) / 1000));
      return { type: "once", schedule: resolved, intervalSeconds: delay };
    }
    // cron
    return { type: "cron", schedule: input.schedule, intervalSeconds: 0 };
  }

  #parseInterval(v) {
    const m = v.trim().match(/^(\d+)(s|m|h|d)$/);
    if (!m) return undefined;
    const mults = { s: 1, m: 60, h: 3600, d: 86400 };
    return Number(m[1]) * (mults[m[2]] ?? 1);
  }

  #resolveOnce(v) {
    const rel = v.trim().match(/^\+(\d+)(s|m|h|d)$/);
    if (rel) {
      const mults = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      return new Date(Date.now() + Number(rel[1]) * (mults[rel[2]] ?? 0)).toISOString();
    }
    const d = new Date(v);
    if (isNaN(d.getTime())) throw new Error(`无效时间格式: ${v}`);
    if (d.getTime() <= Date.now()) throw new Error(`时间已过期: ${d.toISOString()}`);
    return d.toISOString();
  }

  #withNextRun(task) {
    const r = { ...task };
    if (!r.enabled) { delete r.nextRunAt; return r; }

    if (r.type === "interval") {
      r.nextRunAt = new Date(Date.now() + r.intervalSeconds * 1000).toISOString();
    } else if (r.type === "once") {
      const t = new Date(r.schedule).getTime();
      if (t > Date.now()) r.nextRunAt = r.schedule;
      else delete r.nextRunAt;
    } else if (r.type === "cron") {
      const next = computeNextCronRun(r.schedule);
      if (next) r.nextRunAt = next;
      else delete r.nextRunAt;
    }
    return r;
  }

  #schedule(task) {
    this.#unschedule(task.id);
    if (!this.active || !task.enabled) return;

    if (task.type === "once") {
      const delay = new Date(task.schedule).getTime() - Date.now();
      if (delay <= 0) {
        this.#markError(task.id, `调度时间 ${task.schedule} 已过期`);
        return;
      }
      const timer = setTimeout(() => this.#execute(task.id).catch(() => {}), delay);
      timer.unref();
      this.timers.set(task.id, timer);
      return;
    }

    if (task.type === "interval") {
      const timer = setInterval(() => this.#execute(task.id).catch(() => {}), task.intervalSeconds * 1000);
      timer.unref();
      this.intervals.set(task.id, timer);
      return;
    }

    // cron — 每次执行后重新调度
    this.#scheduleNextCron(task);
  }

  #scheduleNextCron(task) {
    const next = computeNextCronRun(task.schedule);
    if (!next) return;
    const delay = new Date(next).getTime() - Date.now();
    if (delay <= 0) return;

    const timer = setTimeout(() => {
      this.#execute(task.id).catch(() => {}).then(() => {
        // 执行完后重新调度下一次
        const refreshed = this.#withNextRun(task);
        this.store.update(task.id, refreshed).catch(() => {});
        this.#scheduleNextCron(task);
      });
    }, delay);
    timer.unref();
    this.timers.set(task.id, timer);
  }

  async #execute(taskId) {
    if (!this.active || this.runningIds.has(taskId)) return;
    const task = await this.store.get(taskId);
    if (!task?.enabled) return;

    this.runningIds.add(taskId);
    const startedAt = new Date().toISOString();
    const entry = this.#histEntry("running", "Run started");

    await this.store.update(taskId, {
      ...task,
      lastStatus: "running",
      runHistory: [...task.runHistory, entry].slice(-25),
      updatedAt: startedAt,
    });

    try {
      await this.runner(task);
      const completedAt = new Date().toISOString();
      const latest = (await this.store.get(taskId)) ?? task;
      const updated = this.#withNextRun({
        ...latest,
        enabled: latest.type === "once" ? false : latest.enabled,
        lastRunAt: completedAt,
        lastStatus: "success",
        runHistory: this.#updateHistory(latest.runHistory, entry.id, {
          status: "success", message: "Run completed",
        }),
        runCount: latest.runCount + 1,
        updatedAt: completedAt,
      });
      delete updated.lastError;
      await this.store.update(taskId, updated);
      if (updated.type === "once") this.#unschedule(taskId);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const latest = (await this.store.get(taskId)) ?? task;
      const msg = error instanceof Error ? error.message : String(error);
      const updated = this.#withNextRun({
        ...latest,
        lastStatus: "error",
        lastError: msg,
        runHistory: this.#updateHistory(latest.runHistory, entry.id, {
          status: "error", message: msg,
        }),
        updatedAt: failedAt,
      });
      await this.store.update(taskId, updated);
    } finally {
      this.runningIds.delete(taskId);
    }
  }

  #unschedule(taskId) {
    const t = this.timers.get(taskId);
    if (t) { clearTimeout(t); this.timers.delete(taskId); }
    const i = this.intervals.get(taskId);
    if (i) { clearInterval(i); this.intervals.delete(taskId); }
  }

  async #markError(taskId, error) {
    const task = await this.store.get(taskId);
    if (!task) return;
    const updated = {
      ...task,
      enabled: false,
      lastStatus: "error",
      lastError: error,
      runHistory: [...task.runHistory, this.#histEntry("error", error)].slice(-25),
      updatedAt: new Date().toISOString(),
    };
    delete updated.nextRunAt;
    await this.store.update(taskId, updated);
  }

  #startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.lock.isAcquired()) {
        this.stop().catch(() => {});
      }
    }, 30000);
    this.heartbeatTimer.unref();
  }

  #histEntry(status, message, extra) {
    return { id: randomUUID(), status, createdAt: new Date().toISOString(), message, ...extra };
  }

  #updateHistory(history, entryId, patch) {
    return history.map((e) => (e.id === entryId ? { ...e, ...patch } : e)).slice(-25);
  }
}

// ──────────────────────────────────────
// 工具注册辅助
// ──────────────────────────────────────

function defineTool(name, label, description, params, executeFn) {
  return {
    name,
    label,
    description,
    promptSnippet: description,
    parameters: params,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await executeFn(params, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: undefined };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `错误: ${msg}` }], details: undefined };
      }
    },
  };
}

function TString(desc, opts = {}) {
  return { type: "string", description: desc, ...opts };
}

function TBoolean(desc) {
  return { type: "boolean", description: desc };
}

function TObject(props, required = []) {
  return { type: "object", properties: props, required };
}

// ──────────────────────────────────────
// 扩展入口
// ──────────────────────────────────────

export default function wjSchedulerExtension(pi) {
  let scheduler;
  let ownsScheduler = false;

  pi.on("session_start", async (_event, ctx) => {
    try {
      // ════════════════════════════════════════════
      // 以 session ID 为隔离粒度，同一 session 内任务持久化
      // 不同 session（/exit + pi 新开）各自独立
      // ════════════════════════════════════════════
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionDir = path.join(getAgentDataDir(), "wj-scheduler", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const store = new PerProcessTaskStore(path.join(sessionDir, "tasks.json"));
      const lock = new PerProcessLock(sessionDir);
      const runner = async (task) => {
        const msg = buildTriggerMessage(task);
        // 使用 followUp 让消息排队，等 AI 空闲后再处理
        pi.sendUserMessage(msg, { deliverAs: "followUp" });
      };

      const instance = new WJScheduler({ store, lock, runner });
      await instance.start();
      scheduler = instance;
      ownsScheduler = true;

      // 注册 LLM 工具
      registerTools(pi, scheduler);
    } catch (e) {
      console.error("[wj-scheduler] 启动失败:", e);
    }
  });

  pi.on("session_shutdown", async () => {
    if (ownsScheduler && scheduler) {
      await scheduler.stop();
    }
    scheduler = undefined;
    ownsScheduler = false;
  });

  // 注册 /wj-cron 命令
  pi.registerCommand("wj-cron", {
    description: "管理定时任务 (wj-scheduler)。子命令: status, list, get, run, enable, disable, delete",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "list", "get", "run", "enable", "disable", "delete"];
      return subs.filter((s) => s.startsWith(prefix.trim().toLowerCase())).map((s) => ({ label: s, value: s }));
    },
    handler: async (args, ctx) => {
      if (!scheduler) {
        ctx.ui.notify("wj-scheduler 未运行。", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase() ?? "status";
      const rest = parts.slice(1).join(" ").trim();

      switch (sub) {
        case "status": {
          const st = await scheduler.status();
          ctx.ui.notify(
            [
              `Active: ${st.active}`,
              `PID: ${st.pid}`,
              `Tasks: ${st.taskCount}`,
              `Timers: ${st.timerCount}`,
              `Intervals: ${st.intervalCount}`,
              `Running: ${st.runningCount}`,
            ].join("\n"),
            "info",
          );
          break;
        }
        case "list": {
          const tasks = await scheduler.list();
          if (tasks.length === 0) {
            ctx.ui.notify("暂无定时任务。", "info");
            break;
          }
          const lines = tasks.map((t) => {
            const name = t.name ?? t.id.slice(0, 8);
            const st = t.enabled ? t.lastStatus ?? "pending" : "disabled";
            const next = t.nextRunAt ? ` next: ${t.nextRunAt}` : "";
            return `${t.id.slice(0, 8)} ${name} [${t.type}] ${st}${next}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
        case "get": {
          if (!rest) { ctx.ui.notify("用法: /wj-cron get <task-id>", "warning"); break; }
          const task = await scheduler.get(rest);
          if (!task) { ctx.ui.notify(`任务未找到: ${rest}`, "error"); break; }
          ctx.ui.notify(
            [
              `ID: ${task.id}`,
              `Name: ${task.name ?? "(unnamed)"}`,
              `Type: ${task.type}`,
              `Schedule: ${task.schedule}`,
              `Enabled: ${task.enabled}`,
              `Status: ${task.lastStatus ?? "pending"}`,
              `Runs: ${task.runCount}`,
              task.nextRunAt ? `Next: ${task.nextRunAt}` : "",
              task.description ? `Desc: ${task.description}` : "",
              `Prompt: ${task.prompt}`,
            ].filter(Boolean).join("\n"),
            "info",
          );
          break;
        }
        case "run": {
          if (!rest) { ctx.ui.notify("用法: /wj-cron run <task-id>", "warning"); break; }
          const task = await scheduler.runNow(rest);
          if (!task) { ctx.ui.notify(`任务未找到: ${rest}`, "error"); break; }
          ctx.ui.notify(`已触发: ${task.name ?? task.id}`, "info");
          break;
        }
        case "enable": {
          if (!rest) { ctx.ui.notify("用法: /wj-cron enable <task-id>", "warning"); break; }
          const task = await scheduler.update(rest, { enabled: true });
          if (!task) { ctx.ui.notify(`任务未找到: ${rest}`, "error"); break; }
          ctx.ui.notify(`已启用: ${task.name ?? task.id}`, "info");
          break;
        }
        case "disable": {
          if (!rest) { ctx.ui.notify("用法: /wj-cron disable <task-id>", "warning"); break; }
          const task = await scheduler.update(rest, { enabled: false });
          if (!task) { ctx.ui.notify(`任务未找到: ${rest}`, "error"); break; }
          ctx.ui.notify(`已禁用: ${task.name ?? task.id}`, "info");
          break;
        }
        case "delete": {
          if (!rest) { ctx.ui.notify("用法: /wj-cron delete <task-id>", "warning"); break; }
          const ok = await scheduler.delete(rest);
          ctx.ui.notify(ok ? `已删除: ${rest}` : `任务未找到: ${rest}`, ok ? "info" : "error");
          break;
        }
        default:
          ctx.ui.notify("未知子命令。可用: status, list, get, run, enable, disable, delete", "warning");
      }
    },
  });
}

/**
 * 构建结构化的定时任务触发消息
 */
function buildTriggerMessage(task) {
  const now = new Date();
  const triggerTime = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const typeLabel = { once: "一次性", interval: "固定间隔", cron: "周期性" }[task.type] ?? task.type;
  const runOrder = (task.runCount ?? 0) + 1;

  // 查找上次执行结果
  const history = task.runHistory ?? [];
  let lastRunInfo = "无";
  let lastErrorInfo = "";
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.status === "success") {
      const t = new Date(entry.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      lastRunInfo = `✅ 成功 (${t})`;
      break;
    }
    if (entry.status === "error") {
      const t = new Date(entry.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      lastRunInfo = `❌ 失败 (${t})`;
      lastErrorInfo = `     原因: ${entry.message ?? task.lastError ?? "未知错误"}`;
      break;
    }
  }

  // 下次执行时间
  let nextRunStr = "";
  if (task.nextRunAt) {
    const t = new Date(task.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    nextRunStr = `  下次执行: ${t}`;
  }

  // 描述
  const desc = task.description ? `\n  📋 描述: ${task.description}` : "";

  // 错误警告
  const errBlock = task.lastError && task.lastStatus === "error"
    ? `\n  ⚠️ 上次异常: ${task.lastError}`
    : "";

  const separator = "═".repeat(46);
  const subSeparator = "─".repeat(46);

  return [
    separator,
    "  ⏰  定时任务触发",
    separator,
    "",
    `  任务名称: ${task.name ?? "(未命名)"}`,
    `  任务类型: ${typeLabel}`,
    `  触发时间: ${triggerTime}`,
    `  执行次数: 第 ${runOrder} 次`,
    `  上次执行: ${lastRunInfo}`,
    lastErrorInfo,
    desc,
    errBlock,
    "",
    nextRunStr,
    "",
    subSeparator,
    "  执行内容",
    subSeparator,
    "",
    task.prompt,
  ].filter(Boolean).join("\n");
}

function registerTools(pi, scheduler) {
  // 使用 TypeBox 兼容的 schema 格式
  const typeSchema = () => ({ type: "string", enum: ["cron", "once", "interval"] });
  const stringSchema = (desc) => ({ type: "string", description: desc });
  const booleanSchema = (desc) => ({ type: "boolean", description: desc });

  pi.registerTool({
    name: "wj_scheduler_create",
    label: "WJ Scheduler",
    description: "创建一个定时任务。支持 cron(周期性)、once(一次性)、interval(固定间隔)三种类型。",
    promptSnippet: "Schedule prompts to run automatically via cron, one-time delay, or fixed interval.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["cron", "once", "interval"], description: "调度类型" },
        schedule: { type: "string", description: '调度表达式。Cron: "0 9 * * 1-5"; Once: ISO时间或"+10m"; Interval: "30s", "5m", "1h"' },
        prompt: { type: "string", description: "到达时间后要执行的指令" },
        name: { type: "string", description: "任务名称（可选）" },
        description: { type: "string", description: "任务描述（可选）" },
        enabled: { type: "boolean", description: "是否启用，默认 true" },
      },
      required: ["type", "schedule", "prompt"],
    },
    execute: async (_toolCallId, params) => {
      const task = await scheduler.create({
        type: params.type,
        schedule: params.schedule,
        prompt: params.prompt,
        name: params.name,
        description: params.description,
        enabled: params.enabled !== false,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({
          id: task.id,
          name: task.name ?? "(unnamed)",
          type: task.type,
          schedule: task.schedule,
          enabled: task.enabled,
          nextRunAt: task.nextRunAt,
          runCount: task.runCount,
        }, null, 2) }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "wj_scheduler_list",
    label: "WJ Scheduler",
    description: "列出所有定时任务及其状态和下次执行时间。",
    promptSnippet: "List all scheduled prompts.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const tasks = await scheduler.list();
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "暂无定时任务。" }], details: undefined };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(tasks.map((t) => ({
          id: t.id, name: t.name ?? "(unnamed)", type: t.type,
          schedule: t.schedule, enabled: t.enabled,
          lastStatus: t.lastStatus ?? "pending", nextRunAt: t.nextRunAt,
          runCount: t.runCount,
        })), null, 2) }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "wj_scheduler_get",
    label: "WJ Scheduler",
    description: "查看定时任务的详细信息，包括调度配置和执行历史。",
    promptSnippet: "Get scheduled prompt details.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务 ID" } },
      required: ["taskId"],
    },
    execute: async (_toolCallId, params) => {
      const task = await scheduler.get(params.taskId);
      if (!task) return { content: [{ type: "text", text: `任务未找到: ${params.taskId}` }], details: undefined };
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: undefined };
    },
  });

  pi.registerTool({
    name: "wj_scheduler_update",
    label: "WJ Scheduler",
    description: "修改定时任务。可改调度、prompt、名称、启用/禁用。",
    promptSnippet: "Update scheduled prompt settings.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务 ID" },
        schedule: { type: "string", description: "新的调度表达式" },
        prompt: { type: "string", description: "新的执行指令" },
        name: { type: "string", description: "新名称" },
        description: { type: "string", description: "新描述" },
        enabled: { type: "boolean", description: "启用或禁用" },
      },
      required: ["taskId"],
    },
    execute: async (_toolCallId, params) => {
      const { taskId, ...updates } = params;
      const task = await scheduler.update(taskId, updates);
      if (!task) return { content: [{ type: "text", text: `任务未找到: ${taskId}` }], details: undefined };
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: undefined };
    },
  });

  pi.registerTool({
    name: "wj_scheduler_delete",
    label: "WJ Scheduler",
    description: "删除一个定时任务。",
    promptSnippet: "Delete a scheduled prompt.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务 ID" } },
      required: ["taskId"],
    },
    execute: async (_toolCallId, params) => {
      const ok = await scheduler.delete(params.taskId);
      return {
        content: [{ type: "text", text: ok ? `已删除任务: ${params.taskId}` : `任务未找到: ${params.taskId}` }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "wj_scheduler_run_now",
    label: "WJ Scheduler",
    description: "忽略原有调度计划，立即执行一个定时任务。",
    promptSnippet: "Trigger immediate execution of a scheduled prompt.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务 ID" } },
      required: ["taskId"],
    },
    execute: async (_toolCallId, params) => {
      const task = await scheduler.runNow(params.taskId);
      if (!task) return { content: [{ type: "text", text: `任务未找到: ${params.taskId}` }], details: undefined };
      return { content: [{ type: "text", text: `已触发: ${task.name ?? task.id}` }], details: undefined };
    },
  });
}
