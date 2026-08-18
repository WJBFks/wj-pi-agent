/**
 * WJ Scheduler — 状态展示模块（status.ts）
 *
 * 在 pi TUI 的 wj-status 底部状态栏 *下方* 追加当前激活（enabled）任务的列表。
 * 实现方式：定时轮询 scheduler.list()，把渲染好的行文本发布到 globalThis 共享桥，
 * wj-status 的 footer（renderLine2）渲染时读取该桥并追加到自带行之后。
 *
 * 对外契约（与 wj-status 约定的桥键）：
 *   globalThis.__wj_scheduler_footer_lines : string[] | null | undefined
 *   - string[] 非空 → wj-status 追加这些行
 *   - null/undefined/空数组 → wj-status 不追加任何行
 */

/** 共享桥键 —— wj-status 的 renderLine2 按此键读取 */
export const FOOTER_BRIDGE_KEY = "__wj_scheduler_footer_lines";

/** 轮询间隔（毫秒） */
const POLL_MS = 5000;

/** status.ts 依赖的最小任务结构（结构类型，避免与 index.ts 循环 import） */
interface TaskLike {
  id: string;
  type: string;
  name?: string;
  enabled?: boolean;
  intervalSeconds?: number;
  schedule?: string;
  nextRunAt?: string;
  lastRunAt?: string;
}

/** status.ts 依赖的最小调度器结构（WJScheduler 天然满足） */
interface SchedulerLike {
  list(): Promise<TaskLike[]>;
}

/** 间隔类型的人类可读标签 */
function formatInterval(secs?: number): string {
  if (!secs || secs < 60) return secs ? `每${secs}s` : "间隔";
  if (secs < 3600) return `每${Math.round(secs / 60)}分`;
  return `每${Math.round(secs / 3600)}时`;
}

/** 任务类型的短标签 */
function typeLabel(t: TaskLike): string {
  if (t.type === "once") return "一次性";
  if (t.type === "interval") return "循环";
  return "周期";
}

/** 循环任务的间隔描述（cron 从分钟字段推导常见粒度，复杂表达式不推导） */
function loopInterval(t: TaskLike): string {
  if (t.type === "interval") return formatInterval(t.intervalSeconds);
  if (t.type === "cron") {
    const f = t.schedule?.trim().split(/\s+/) ?? [];
    if (f.length !== 5) return "";
    const min = f[0];
    const step = min.match(/^\*\/(\d+)$/);
    if (step) return `每${step[1]}分`;
    if (min === "*") return "每分钟";
    if (min === "0" && f[1] === "*") return "每小时";
    return "";
  }
  return "";
}

/** ISO 时间 → YYYY/MM/DD-HH:mm:ss（本地时区）；无则返回「待首跑」 */
function timeLabel(iso?: string): string {
  if (!iso) return "待首跑";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}-${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 构建要展示的任务行（纯文本，无 ANSI）：
 * 仅保留 enabled 任务，按下次执行时间升序（无 nextRunAt 的排最后）。
 * 行格式：⏰ 标题 · 定时类型 · 间隔(仅循环任务) · 下次YYYY/MM/DD-HH:mm:ss · 上次.../待首跑
 */
export function buildTaskLines(list: TaskLike[]): string[] {
  return list
    .filter((t) => t.enabled !== false)
    .sort((a, b) => {
      const ta = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    })
    .map((t) => {
      const parts = [`⏰ ${t.name ?? "(未命名)"}`, typeLabel(t)];
      const interval = loopInterval(t);
      if (interval) parts.push(interval);
      parts.push(`下次${timeLabel(t.nextRunAt)}`, `上次${timeLabel(t.lastRunAt)}`);
      return parts.join(" · ");
    });
}

/**
 * 发布任务行到共享桥。
 * @param lines 空数组 → 发布 null（通知 wj-status 隐藏该区块）
 */
export function publishLines(lines: string[]): void {
  (globalThis as Record<string, unknown>)[FOOTER_BRIDGE_KEY] = lines.length > 0 ? lines : null;
}

/**
 * 安装状态展示：立即发布一次并启动定时轮询。
 * 返回 dispose()：停止轮询并清空桥（session_shutdown 时调用）。
 */
export function installSchedulerStatus(scheduler: SchedulerLike, options?: { pollMs?: number }): { dispose(): void } {
  const pollMs = options?.pollMs ?? POLL_MS;
  const poll = async () => {
    try {
      const tasks = await scheduler.list();
      publishLines(buildTaskLines(tasks));
    } catch {
      // scheduler 不可用时保持当前状态，忽略轮询错误
    }
  };
  const timer = setInterval(poll, pollMs);
  timer.unref?.();
  void poll();
  return {
    dispose() {
      clearInterval(timer);
      publishLines([]);
    },
  };
}