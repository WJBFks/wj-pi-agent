/**
 * WJ Scheduler — 轻量 cron 解析器（共享模块）
 * 由 index.ts（调度）与 status.ts（下次执行时间估算）共同使用。
 */

/**
 * 简易 cron 解析 — 计算下一次执行时间
 * 支持标准 5 字段 cron 表达式
 */
export function computeNextCronRun(expression: string): string | undefined {
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

function matchField(value: number, field: string, min: number, max: number): boolean {
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

