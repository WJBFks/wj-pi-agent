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
  nextRunAt?: string;
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
  if (t.type === "cron") return "周期";
  return formatInterval(t.intervalSeconds);
}

/** ISO 时间 → 本地 HH:MM；无则返回「待首跑」（任务首次执行前 nextRunAt 尚未写入） */
function timeLabel(iso?: string): string {
  return iso
    ? new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "待首跑";
}

/**
 * 构建要展示的任务行（纯文本，无 ANSI；排序交给 wj-status 或调用方样式化）：
 * 仅保留 enabled 任务，按下次执行时间升序（无 nextRunAt 的排最后）。
 * 每行格式：⏰ 名称(间隔) · 下次 HH:MM
 */
export function buildTaskLines(list: TaskLike[]): string[] {
  return list
    .filter((t) => t.enabled !== false)
    .sort((a, b) => {
      const ta = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    })
    .map((t) => `⏰ ${t.name ?? "(未命名)"}(${typeLabel(t)}) · 下次 ${timeLabel(t.nextRunAt)}`);
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