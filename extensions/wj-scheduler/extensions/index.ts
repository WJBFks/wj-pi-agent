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
 *    锁文件落在 session 隔离目录内，不同 session 不冲突；
 *    数据目录为项目级 .pi/wj/scheduler/<sessionId>/（WJ_SCHEDULER_DIR 可覆盖）。
 */

// ──────────────────────────────────────
// Node.js 内置模块（无需外部依赖）
// ──────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeNextCronRun } from "./cron.ts";
import { installSchedulerStatus } from "./status.ts";

// ──────────────────────────────────────
// 常量
// ──────────────────────────────────────
const SETTINGS_KEY = "wj-scheduler";

// ──────────────────────────────────────
// 类型定义
// ──────────────────────────────────────
type TaskType = "cron" | "once" | "interval";

interface HistoryEntry {
  id: string;
  status: string;
  createdAt: string;
  message?: string;
  [key: string]: unknown;
}

interface Task {
  id: string;
  type: TaskType;
  schedule: string;
  intervalSeconds: number;
  prompt: string;
  name?: string;
  description?: string;
  model?: string;
  sessionId?: string;
  toolPolicyProfile?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  runHistory: HistoryEntry[];
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "pending" | "running" | "success" | "error";
  lastError?: string;
  timeoutMs?: number;
}

interface TaskInput {
  type?: TaskType;
  schedule?: string;
  prompt?: string;
  name?: string;
  description?: string;
  model?: string;
  sessionId?: string;
  toolPolicyProfile?: string;
  enabled?: boolean;
}

interface SchedulerStatus {
  active: boolean;
  pid: number;
  taskCount: number;
  timerCount: number;
  runningCount: number;
}

/**
 * 调度器数据根目录：项目级 .pi/wj/scheduler/<sessionId>（与 wj-memory 同级模式）
 * - 默认基于当前工作目录（跟随项目）
 * - WJ_SCHEDULER_DIR 环境变量可覆盖根目录（迁移/测试用），仍追加 <sessionId>
 */
function resolveSchedulerRoot(sessionId: string): string {
  const override = process.env.WJ_SCHEDULER_DIR?.trim();
  if (override) return path.join(override, sessionId);
  return path.join(process.cwd(), ".pi", "wj", "scheduler", sessionId);
}

// ──────────────────────────────────────
// PerProcessLock — 每个进程独立的锁
// ──────────────────────────────────────

class PerProcessLock {
  private path: string;
  private acquired: boolean;

  constructor(lockDir: string) {
    // 锁文件放在 session 隔离目录内，不同 session 不冲突；保存持有者 PID
    this.path = path.join(lockDir, ".lock");
    this.acquired = false;
  }

  acquire(): boolean {
    mkdirSync(path.dirname(this.path), { recursive: true });
    // 1) 锁不存在（或目录为空）→ 原子创建获取
    if (this.#writeWx()) {
      this.acquired = true;
      return true;
    }
    // 锁已存在：读持有者 PID 判定是否可抢占
    const holder = this.#readHolderPid();
    if (holder === process.pid) {
      // 本进程已持有（可重入）
      this.acquired = true;
      return true;
    }
    if (holder !== 0 && this.#isAlive(holder)) {
      // 持有者进程存活（含 EPERM 探测受限，保守视为存活）→ 获取失败
      this.acquired = false;
      return false;
    }
    // 2) 持有者已死，或 3a) 锁文件空/损坏（holder===0）→ 清理并重新获取
    try {
      unlinkSync(this.path);
      if (this.#writeWx()) {
        this.acquired = true;
        return true;
      }
    } catch {}
    this.acquired = false;
    return false;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      const pid = Number(readFileSync(this.path, "utf8").trim());
      if (pid === process.pid) unlinkSync(this.path);
    } catch {}
    this.acquired = false;
  }

  isAcquired(): boolean { return this.acquired; }

  /**
   * 当前锁文件的持有者 PID（用于失败文案展示占用者）；
   * 无锁/空/损坏时返回 0（此时按可抢占处理）。
   */
  holderPid(): number {
    return this.#readHolderPid();
  }

  #readHolderPid(): number {
    // 返回 0 表示锁文件不存在/空/损坏（视为可抢占）
    try {
      const raw = readFileSync(this.path, "utf8").trim();
      const pid = Number(raw);
      return Number.isInteger(pid) && pid > 0 ? pid : 0;
    } catch {
      return 0;
    }
  }

  #writeWx(): boolean {
    // 原子创建（flag wx）：仅当锁不存在时成功，绝不覆盖他人锁
    try {
      writeFileSync(this.path, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  #isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // 仅 ESRCH（进程不存在）视为已死；EPERM 等探测受限保守视为存活
      return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
    }
  }
}

// ──────────────────────────────────────
// PerProcessTaskStore — 每个进程独立的任务存储
// ──────────────────────────────────────

class PerProcessTaskStore {
  private filePath: string;
  private cache: Map<string, Task> | null;
  private writeQueue: Promise<unknown>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.cache = null;
    this.writeQueue = Promise.resolve();
  }

  async list(): Promise<Task[]> {
    await this.#load();
    return Array.from(this.cache.values());
  }

  async get(taskId: string): Promise<Task | undefined> {
    await this.#load();
    return this.cache.get(taskId);
  }

  async create(task: Task): Promise<Task> {
    const normalized = this.#normalize(task);
    await this.#mutate(() => this.cache.set(normalized.id, normalized));
    return normalized;
  }

  async update(taskId: string, task: Task): Promise<Task | undefined> {
    const normalized = this.#normalize(task);
    const ok = await this.#mutate(() => {
      if (!this.cache.has(taskId)) return false;
      this.cache.set(taskId, normalized);
      return true;
    });
    return ok ? normalized : undefined;
  }

  async delete(taskId: string): Promise<boolean> {
    return this.#mutate(() => this.cache.delete(taskId));
  }

  async #load(): Promise<void> {
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

  async #save(): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Array.from(this.cache.values()), null, 2), "utf-8");
  }

  async #mutate<T>(fn: () => T): Promise<T> {
    const pending = this.writeQueue.then(async () => {
      await this.#load();
      const result = fn();
      await this.#save();
      return result;
    });
    this.writeQueue = pending.catch(() => undefined);
    return await pending;
  }

  #normalize(raw: any): Task {
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
  private store: PerProcessTaskStore;
  private lock: PerProcessLock;
  private runner: (task: Task, entryId: string) => Promise<void>;
  private timers: Map<string, ReturnType<typeof setTimeout>>;
  private active: boolean;
  private runningIds: Set<string>;
  private pendingSettlements: { taskId: string; entryId: string }[];
  private heartbeatTimer: ReturnType<typeof setInterval> | null;

  constructor(opts: { store: PerProcessTaskStore; lock: PerProcessLock; runner: (task: Task, entryId: string) => Promise<void> }) {
    this.store = opts.store;
    this.lock = opts.lock;
    this.runner = opts.runner;
    this.timers = new Map();
    this.active = false;
    this.runningIds = new Set();
    this.pendingSettlements = [];
    this.heartbeatTimer = null;
  }

  async list(): Promise<Task[]> { return this.store.list(); }
  async get(id: string): Promise<Task | undefined> { return this.store.get(id); }

  async status(): Promise<SchedulerStatus> {
    const tasks = await this.store.list();
    return {
      active: this.active,
      pid: process.pid,
      taskCount: tasks.length,
      timerCount: this.timers.size,
      runningCount: this.runningIds.size,
    };
  }

  isActive(): boolean { return this.active; }

  async create(input: TaskInput): Promise<Task> {
    // 写保护：仅持锁（active）进程可写，防止多进程同目录互覆盖
    if (!this.active) throw new Error("调度器未激活（锁被其他进程持有），拒绝写入");
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
    const created = await this.store.create(this.#withNextRun(task));
    if (this.active) this.#schedule(created);
    return created;
  }

  async update(taskId: string, input: TaskInput): Promise<Task | undefined> {
    if (!this.active) throw new Error("调度器未激活（锁被其他进程持有），拒绝写入");
    const existing = await this.store.get(taskId);
    if (!existing) return undefined;

    const next = { ...existing, ...input, updatedAt: new Date().toISOString() } as Task;

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

  async delete(taskId: string): Promise<boolean> {
    if (!this.active) throw new Error("调度器未激活（锁被其他进程持有），拒绝写入");
    this.#unschedule(taskId);
    return this.store.delete(taskId);
  }

  async runNow(taskId: string): Promise<Task | undefined> {
    if (!this.active) return undefined;
    const task = await this.store.get(taskId);
    if (!task) return undefined;
    this.#execute(taskId).catch(() => {});
    return task;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!this.lock.acquire()) {
      // 锁获取失败：不再打印终端日志（不可见），仅通过主会话提示（见 session_start 锁状态汇报）
      return;
    }
    this.active = true;
    this.#startHeartbeat();

    const tasks = await this.store.list();
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (task.lastStatus === "running" || task.lastStatus === "pending") {
        // 上次异常中断（含已投递但未等到 AI 响应的 pending 任务）
        const fixed = this.#withNextRun({
          ...task,
          lastStatus: "error",
          lastError: "进程异常中断，正在运行的任务未完成",
          runHistory: [...task.runHistory, this.#histEntry("error", "进程中断")].slice(-25),
          updatedAt: new Date().toISOString(),
        });
        await this.store.update(task.id, fixed).catch(() => {});
        this.#schedule(fixed);
        continue;
      }
      // 错过补执行（需求 2）：interval 超间隔、once 已到时刻 → 立即补一次；
      // 结算后由 #settleRun 自动续调度，这里不重复调度。
      if (task.type === "interval" && this.#isIntervalOverdue(task)) {
        await this.#execute(task.id);
        continue;
      }
      if (task.type === "once" && this.#isOnceOverdue(task)) {
        await this.#execute(task.id);
        continue;
      }
      // cron（需求 3：错过不补，直接等下一周期）及未过期的 interval/once：
      // 保持任务原有 nextRunAt 正常调度，不重置（interval 的下次 = 上次完成 + 间隔）。
      this.#schedule(task);
    }
  }

  async stop(): Promise<void> {
    for (const [id] of this.timers) this.#unschedule(id);
    this.active = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.lock.release();
  }

  // ── 内部方法 ──

  #resolveSchedule(input: TaskInput): { type: TaskType; schedule: string; intervalSeconds: number } {
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

  #parseInterval(v: string): number | undefined {
    const m = v.trim().match(/^(\d+)(s|m|h|d)$/);
    if (!m) return undefined;
    const mults = { s: 1, m: 60, h: 3600, d: 86400 };
    return Number(m[1]) * (mults[m[2]] ?? 1);
  }

  #resolveOnce(v: string): string {
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

  #withNextRun(task: Task): Task {
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

  #schedule(task: Task): void {
    this.#unschedule(task.id);
    if (!this.active || !task.enabled) return;

    if (task.type === "once") {
      const ts = new Date(task.schedule).getTime();
      if (Number.isNaN(ts) || ts <= Date.now()) {
        // 已过期且未通过 catch-up 补跑成功 → 报错禁用，避免反复重试
        if (task.lastStatus !== "success") {
          this.#markError(task.id, `调度时间 ${task.schedule} 已过期`);
        }
        return;
      }
      this.#armTimer(task.id, ts - Date.now());
      return;
    }

    if (task.type === "interval") {
      const next = task.nextRunAt ? new Date(task.nextRunAt).getTime() : NaN;
      const delay = Number.isNaN(next) ? task.intervalSeconds * 1000 : next - Date.now();
      if (delay <= 0) {
        // 过期：立即执行一次（catch-up 兜底）
        this.#execute(task.id).catch(() => {});
        return;
      }
      this.#armTimer(task.id, delay);
      return;
    }

    // cron：错过不补，仅调度下一个未来周期（需求 3）
    const next = computeNextCronRun(task.schedule);
    if (!next) return;
    const delay = new Date(next).getTime() - Date.now();
    if (delay <= 0) return;
    this.#armTimer(task.id, delay);
  }

  /** 设置一次性定时器；到点触发 execute，之后由结算（#settleRun）重新调度下一次。 */
  #armTimer(taskId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.#execute(taskId).catch(() => {});
    }, Math.max(1, delayMs));
    timer.unref();
    this.timers.set(taskId, timer);
  }

  async #execute(taskId: string): Promise<void> {
    if (!this.active || this.runningIds.has(taskId)) return;
    const task = await this.store.get(taskId);
    if (!task?.enabled) return;

    this.runningIds.add(taskId);
    const startedAt = new Date().toISOString();
    const entry = this.#histEntry("pending", "Task triggered, awaiting agent response");

    // 触发阶段：仅标记 pending（消息已投递、等待 AI 实际处理）。
    // 不推进 nextRunAt —— nextRunAt 在结算（#settleRun）时按"执行完成时刻"重算，
    // 以满足"循环任务下次执行 = 上次执行完毕 + 间隔"（需求 5）。
    await this.store.update(taskId, {
      ...task,
      lastStatus: "pending",
      runHistory: [...task.runHistory, entry].slice(-25),
      updatedAt: startedAt,
    });

    try {
      // 投递触发消息（携带 任务ID+记录ID marker）；AI 处理完成后由事件回调结算
      await this.runner(task, entry.id);
    } catch (error) {
      // 消息投递失败：结算为 error（并据此续调度下一次）
      const msg = error instanceof Error ? error.message : String(error);
      await this.#settleRun(taskId, entry.id, "error", msg);
    } finally {
      this.runningIds.delete(taskId);
    }
  }

  /**
   * before_agent_start 命中任务 marker 时调用：
   * 将该任务的本次触发（entryId）压入待结算队列（消息被 AI 处理的顺序 = 队列顺序）。
   */
  markAgentRunStarted(taskId: string, entryId: string): void {
    this.pendingSettlements.push({ taskId, entryId });
  }

  /**
   * agent_settled 事件回调：AI 已完整处理完一条触发消息。
   * 从队列取出队首触发并按 entryId 精确结算为 success（记录 lastRunAt / runCount+1），
   * 同任务连续多次触发也不会串位。once 任务结算成功后自动禁用。
   */
  async markAgentRunSettled(): Promise<void> {
    const item = this.pendingSettlements.shift();
    if (!item) return;
    await this.#settleRun(item.taskId, item.entryId, "success");
  }

  /**
   * 统一结算一次执行（成功或失败）：
   * - 更新对应 pending 历史条目为 success/error；
   * - success 时 runCount+1；
   * - 无论成败均记录 lastRunAt（执行结束时间，非 pending 即视为"执行完成"，见需求 5）；
   * - once 任务结算后禁用（一次性语义，失败也不再重试）；
   * - 用结算时刻重算 nextRunAt（interval: 完成+间隔；cron: 下一周期），并续调度。
   */
  async #settleRun(taskId: string, entryId: string, status: "success" | "error", errorMessage?: string): Promise<void> {
    const task = await this.store.get(taskId);
    if (!task || task.lastStatus !== "pending") return;

    const completedAt = new Date().toISOString();
    const runHistory = this.#updateHistory(task.runHistory, entryId, {
      status,
      message: status === "success" ? "Run completed" : (errorMessage ?? "Run failed"),
    });

    const updated = {
      ...task,
      enabled: task.type === "once" ? false : task.enabled,
      lastRunAt: completedAt,
      lastStatus: status,
      runHistory,
      runCount: status === "success" ? task.runCount + 1 : task.runCount,
      updatedAt: completedAt,
    };
    if (status === "error") {
      updated.lastError = errorMessage ?? "Run failed";
    } else {
      delete updated.lastError;
    }

    const settled = this.#withNextRun(updated);
    await this.store.update(taskId, settled);

    if (settled.type === "once" || !settled.enabled) {
      this.#unschedule(taskId);
    } else {
      this.#schedule(settled);
    }
  }

  #unschedule(taskId: string): void {
    const t = this.timers.get(taskId);
    if (t) { clearTimeout(t); this.timers.delete(taskId); }
  }

  async #markError(taskId: string, error: string): Promise<void> {
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

  /** interval 是否已过期（距上次完成或创建超过一个间隔）——用于重启后补跑判断 */
  #isIntervalOverdue(task: Task): boolean {
    if (task.type !== "interval") return false;
    const intervalMs = (task.intervalSeconds ?? 60) * 1000;
    const base = task.lastRunAt
      ? new Date(task.lastRunAt).getTime()
      : new Date(task.createdAt).getTime();
    return !Number.isNaN(base) && Date.now() >= base + intervalMs;
  }

  /** once 是否已到调度时刻且未执行——用于重启后补跑判断 */
  #isOnceOverdue(task: Task): boolean {
    if (task.type !== "once") return false;
    const ts = task.schedule ? new Date(task.schedule).getTime() : NaN;
    return !Number.isNaN(ts) && ts <= Date.now();
  }

  #startHeartbeat(): void {
    const t = setInterval(() => {
      if (!this.lock.isAcquired()) {
        this.stop().catch(() => {});
      }
    }, 30000);
    t.unref();
    this.heartbeatTimer = t;
  }

  #histEntry(status: string, message: string, extra?: Record<string, unknown>): HistoryEntry {
    return { id: randomUUID(), status, createdAt: new Date().toISOString(), message, ...extra };
  }

  #updateHistory(history: HistoryEntry[], entryId: string, patch: Partial<HistoryEntry>): HistoryEntry[] {
    return history.map((e) => (e.id === entryId ? { ...e, ...patch } : e)).slice(-25);
  }
}

// ──────────────────────────────────────
// 扩展入口
// ──────────────────────────────────────

export default function wjSchedulerExtension(pi: ExtensionAPI) {
  let scheduler: WJScheduler | undefined;
  let ownsScheduler = false;
  let statusDispose: { dispose(): void } | undefined;

/** 空行组件：pi-tui Text 对空白行 render 返回 [] 会被跳过，须用此组件插入空行（render 返回 [""]） */
class BlankLine implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [""];
  }
}

// 锁获取结果的主会话展示卡
  // ⚠️ 注意：pi-tui 的 addChild() 不返回 this（返回 undefined），必须分两步：先 addChild 再 return box，
  //    否则 renderer 整体返回 undefined，CustomEntryComponent.hasContent()=false → 卡片静默不显示。
  // 布局：第一行加粗（[wj-scheduler] 成功=自绘真彩色纯绿 38;2;80;220;80 / 失败=warning 黄 token + 标题 text 色），
  //   标题与正文之间空一行（Text 对空白行返回 [] 会被跳过，须用 BlankLine 组件），
  //   正文行灰色（muted）；`/reload` 用行内代码主题色（mdCode）；背景 customMessageBg。
  pi.registerEntryRenderer("wj-scheduler-status", (entry: any, _opts: any, theme: any) => {
    const d = (entry.data ?? {}) as { active?: boolean; pid?: number };
    if (typeof d.active !== "boolean") return undefined;
    const pid = d.pid ?? process.pid;
    const fg = (c: string, t: string) => theme.fg(c, t);
    // 主题内 success="green"=#b5bd68（黄绿色，非纯绿）——成功标签用自绘真彩色绿
    const green = (t: string) => `\x1b[38;2;80;220;80m${t}\x1b[39m`;
    const body = d.active
      ? [fg("muted", `进程锁获取成功(PID ${pid}), 定时调度器运行中`)]
      : [
          fg("muted", `进程锁已被占用(PID ${pid}), 定时调度器正在其他进程中运行`),
          fg("muted", `如需在当前进程中运行，请先停止进程(PID ${pid})后重新启动(`) + fg("mdCode", "/reload") + fg("muted", ")"),
        ];
    const title = d.active
      ? theme.bold(green("[wj-scheduler]")) + theme.bold(fg("text", " 定时调度器启用成功"))
      : theme.bold(fg("warning", "[wj-scheduler]")) + theme.bold(fg("text", " 定时调度器启用失败"));
    const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(title, 0, 0));
    box.addChild(new BlankLine()); // 标题与正文之间空行（Text 空白行会被跳过）
    box.addChild(new Text(body.join("\n"), 0, 0));
    return box;
  });

  // AI 处理触发消息的生命周期（模块级注册一次，闭包引用 scheduler）：
  // - before_agent_start：prompt 含任务 marker → 入队（该 agent 循环在处理此任务）
  // - agent_settled：agent 循环完全结束 → 出队结算为 success（记录 lastRunAt/runCount）
  // 这样 lastStatus 在消息投递后保持 pending，直到 AI 真正响应完才变为 success。
  pi.on("before_agent_start", (event) => {
    const m = event.prompt?.match(/<!-- wj-scheduler-run:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) -->/);
    if (m?.[1] && m[2]) scheduler?.markAgentRunStarted(m[1], m[2]);
  });
  pi.on("agent_settled", () => {
    scheduler?.markAgentRunSettled().catch(() => {});
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      // ════════════════════════════════════════════
      // 以 session ID 为隔离粒度，同一 session 内任务持久化
      // 不同 session（/exit + pi 新开）各自独立
      // ════════════════════════════════════════════
      const sessionId = ctx.sessionManager.getSessionId();
      // 项目级 .pi/wj/scheduler/<sessionId>：任务数据 + 锁（session 隔离，跟随项目，不入全局 data/）
      const sessionDir = resolveSchedulerRoot(sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const store = new PerProcessTaskStore(path.join(sessionDir, "tasks.json"));
      const lock = new PerProcessLock(sessionDir);
      const runner = async (task, entryId) => {
        const msg = buildTriggerMessage(task, entryId);
        // 使用 followUp 让消息排队，等 AI 空闲后再处理
        pi.sendUserMessage(msg, { deliverAs: "followUp" });
      };

      const instance = new WJScheduler({ store, lock, runner });
      await instance.start();
      scheduler = instance;
      ownsScheduler = true;

      // 锁获取结果（成功/失败）在主会话持久卡片提示（registerEntryRenderer + appendEntry，
      // 与 wj-btw 同构）——直接同步 append，不延迟（renderer 修复后同步即可显示；
      // 即使启动期实时渲染错过，entry 也已入库，reload/重建时会显示）。无弹窗、无终端输出。
      // pid = 锁持有者（成功=自身进程；失败=占用者），供 renderer 排版文案。
      try {
        pi.appendEntry("wj-scheduler-status", {
          active: instance.isActive(),
          pid: lock.holderPid() || process.pid,
        });
      } catch (err) {
        console.error("[wj-scheduler] 锁状态主会话提示失败:", err);
      }

      // 底部状态栏展示（写入共享桥，wj-status footer 追加显示）
      statusDispose = installSchedulerStatus(scheduler);

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
    statusDispose?.dispose();
    statusDispose = undefined;
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
function buildTriggerMessage(task: Task, entryId: string): string {
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
  ].filter(Boolean).join("\n")
    // 消息末尾注入任务标记（taskId + 本次触发的记录 ID）：
    // before_agent_start 事件据此识别"AI 正在处理哪次触发"，agent_settled 时精确结算为
    // success（对 AI 无实质影响，仅内部配对用）
    + `\n\n<!-- wj-scheduler-run:${task.id}:${entryId} -->`;
}

function registerTools(pi: ExtensionAPI, scheduler: WJScheduler) {
  // 本地注册封装：any 上下文让工具 schema 字面量零类型噪音，运行时由 pi 解析 JSON Schema
  const register = (tool: any): void => { pi.registerTool(tool); };
  // 使用 TypeBox 兼容的 schema 格式
  const typeSchema = () => ({ type: "string", enum: ["cron", "once", "interval"] });
  const stringSchema = (desc) => ({ type: "string", description: desc });
  const booleanSchema = (desc) => ({ type: "boolean", description: desc });

  register({
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
    execute: async (_toolCallId: string, params: any) => {
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

  register({
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

  register({
    name: "wj_scheduler_get",
    label: "WJ Scheduler",
    description: "查看定时任务的详细信息，包括调度配置和执行历史。",
    promptSnippet: "Get scheduled prompt details.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务 ID" } },
      required: ["taskId"],
    },
    execute: async (_toolCallId: string, params: any) => {
      const task = await scheduler.get(params.taskId);
      if (!task) return { content: [{ type: "text", text: `任务未找到: ${params.taskId}` }], details: undefined };
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: undefined };
    },
  });

  register({
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
    execute: async (_toolCallId: string, params: any) => {
      const { taskId, ...updates } = params;
      const task = await scheduler.update(taskId, updates);
      if (!task) return { content: [{ type: "text", text: `任务未找到: ${taskId}` }], details: undefined };
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: undefined };
    },
  });

  register({
    name: "wj_scheduler_delete",
    label: "WJ Scheduler",
    description: "删除一个定时任务。",
    promptSnippet: "Delete a scheduled prompt.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务 ID" } },
      required: ["taskId"],
    },
    execute: async (_toolCallId: string, params: any) => {
      const ok = await scheduler.delete(params.taskId);
      return {
        content: [{ type: "text", text: ok ? `已删除任务: ${params.taskId}` : `任务未找到: ${params.taskId}` }],
        details: undefined,
      };
    },
  });

  register({
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
