import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, CustomEditor, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getBalance } from "./balance";

/**
 * WJ Status — lightweight status bar for Pi.
 *
 * Commands:
 *   /wj-status  — show detailed status info
 */

const _dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(_dirname, "..");

// Cost tracking (todayCost resets at midnight)
// 会话级数据：data/wj-status/<sessionId>/cost-tracking.json（session_start 时设置）
let COST_TRACKING_FILE = join(EXT_DIR, "cost-tracking.json");

interface CostTracking {
  lastMidnightCost: number;
  lastCheckDate: string; // YYYY-MM-DD
}

function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function loadCostTracking(initialCost: number = 0): CostTracking {
  try {
    if (existsSync(COST_TRACKING_FILE)) {
      const raw = JSON.parse(readFileSync(COST_TRACKING_FILE, "utf-8"));
      // Sanity: reject corrupted/incomplete records instead of silently resetting
      if (raw && typeof raw.lastMidnightCost === "number" && typeof raw.lastCheckDate === "string") {
        return raw;
      }
    }
  } catch {}
  // New file: treat existing cost as pre-tracking baseline and PERSIST it now.
  // Without this, every call would return baseline = current cost, so
  // todayCost (= cost - baseline) would always be 0.
  const tracking: CostTracking = { lastMidnightCost: initialCost, lastCheckDate: getTodayStr() };
  saveCostTracking(tracking);
  return tracking;
}

function saveCostTracking(tracking: CostTracking): void {
  try {
    mkdirSync(dirname(COST_TRACKING_FILE), { recursive: true });
    writeFileSync(COST_TRACKING_FILE, JSON.stringify(tracking, null, 2), "utf-8");
  } catch {}
}

interface I18nDict {
  status: { ready: string; working: string; error: string };
  line1: { in: string; out: string; ctx: string };
  line2: { cache: string; bal: string };
  generic: { untitled: string; unknown: string };
  duration: { day: string; hour: string; minute: string; second: string; ms: string };
  compaction: { auto: string; off: string; unknown: string };
}

function loadI18n(locale: string): I18nDict {
  const filePath = join(EXT_DIR, "i18n", `${locale}.json`);
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch {}
  // Fallback to English
  const enPath = join(EXT_DIR, "i18n", "en.json");
  try { return JSON.parse(readFileSync(enPath, "utf-8")); } catch {}
  // Hardcoded fallback
  return {
    status: { ready: "READY", working: "WORKING", error: "ERROR" },
    line1: { in: "in", out: "out", ctx: "ctx" },
    line2: { cache: "cache", bal: "bal" },
    generic: { untitled: "untitled", unknown: "UNKNOWN" },
    duration: { day: "d", hour: "h", minute: "m", second: "s", ms: "ms" },
    compaction: { auto: "(auto)", off: "(off)", unknown: "(—)" },
  };
}

interface CurrencyDef {
  symbol: string;
  rate: number;
  decimals: number;
}

interface AppConfig {
  locale: string;
  currency: string;
}

function loadConfig(): AppConfig {
  const cfgPath = join(EXT_DIR, "config.json");
  try {
    if (existsSync(cfgPath)) return JSON.parse(readFileSync(cfgPath, "utf-8"));
  } catch {}
  return { locale: "en", currency: "USD" };
}

function loadCostConfig(currencyKey: string): CurrencyDef {
  const costPath = join(EXT_DIR, "cost.json");
  try {
    if (existsSync(costPath)) {
      const all = JSON.parse(readFileSync(costPath, "utf-8"));
      if (all[currencyKey]) return all[currencyKey];
    }
  } catch {}
  return { symbol: "$", rate: 1, decimals: 4 };
}

interface FooterState {
  activity: "ready" | "working" | "error";
  modelId?: string;
  provider?: string;
  thinkingLevel?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent?: number;
  cost: number;
  todayCost: number;
  costAvailable: boolean;
  contextPercent: number | null;
  contextWindow: number;
  cwd: string;
  lastRunDurationMs?: number;
  lastRunStartTime?: string;
  lastRunEndTime?: string;
  autoCompact: boolean | null;
  balance: string | null;
  sessionName: string;
}

export default function wjStatusExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const t = loadI18n(config.locale);
  const costCfg = loadCostConfig(config.currency);
  let footerState: FooterState;
  let currentRunStartTs: number | undefined;

  // ---- helpers ----

  /** Strip ANSI escape codes and return visible width. */
  function visibleLen(s: string): number {
    const plain = s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
    let w = 0;
    for (const ch of plain) {
      const cp = ch.codePointAt(0) ?? 0;
      // CJK / wide chars count as 2, rest as 1
      w += (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
        (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7AF) ||
        (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE6F) ||
        (cp >= 0xFF01 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x1B000 && cp <= 0x1B2FF) || (cp >= 0x20000 && cp <= 0x2FA1F))) ? 2 : 1;
    }
    return w;
  }

  /** Truncate a string to a visible width, preserving ANSI codes. */
  function truncateToVisible(s: string, maxW: number): string {
    if (visibleLen(s) <= maxW) return s;
    // Simple approach: try shorter slices until visible width fits
    let result = "";
    let w = 0;
    const ansiRe = /(\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))|([\s\S])/g;
    let m;
    while ((m = ansiRe.exec(s)) !== null) {
      if (m[1]) {
        result += m[1]; // keep ANSI codes
      } else if (m[2]) {
        const cp = m[2].codePointAt(0) ?? 0;
        const cw = (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
          (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7AF) ||
          (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE6F) ||
          (cp >= 0xFF01 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) ||
          (cp >= 0x1B000 && cp <= 0xB2FF) || (cp >= 0x20000 && cp <= 0x2FA1F))) ? 2 : 1;
        if (w + cw > maxW) break;
        w += cw;
        result += m[2];
      }
    }
    return result;
  }

  function fmt(n: number): string {
    if (!Number.isFinite(n) || n < 0) return "\u2014";
    if (n < 1_000) return String(Math.round(n));
    if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
    if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  // ---- balance fetching ----

  let balanceCache: string | null = null;
  let balancePromise: Promise<void> | null = null;

  async function fetchBalance(ctx: ExtensionContext): Promise<string | null> {
    const model = ctx.model;
    if (!model) return null;
    const provider = model.provider?.toLowerCase() ?? "";
    let apiKey: string | undefined;
    try {
      apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
    } catch {}
    if (!apiKey) return null;
    // 按供应商分发到 ./balance.ts 中的对应实现
    return getBalance(provider, apiKey);
  }

  // 全局数据（余额与 provider/key 绑定，不随会话变化）：data/wj-status/balance-cache.json
  const CACHE_FILE = join(getAgentDir(), "data", "wj-status", "balance-cache.json");

  function readBalanceCache(provider: string): { balance: string | null; timestamp: number } {
    try {
      if (existsSync(CACHE_FILE)) {
        const all = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
        const entry = all[provider];
        if (entry) return entry;
      }
    } catch {}
    return { balance: null, timestamp: 0 };
  }

  function writeBalanceCache(provider: string, balance: string | null): void {
    try {
      let all: Record<string, any> = {};
      if (existsSync(CACHE_FILE)) {
        try { all = JSON.parse(readFileSync(CACHE_FILE, "utf-8")); } catch {}
      }
      all[provider] = { balance, timestamp: Date.now() };
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(all, null, 2), "utf-8");
    } catch {}
  }

  let footerTuiRef: any = null;
  // 编辑器的 theme 是 pi-tui 的 EditorTheme（只有 borderColor/selectList，无 fg）。
  // 颜色需用 footer/widget 工厂拿到的 atelier 主题（有 theme.fg(role, text)）。
  let atelierThemeRef: any = null;
  let balanceTimer: ReturnType<typeof setInterval> | undefined;

  function applyBalance(b: string | null): void {
    const val = b ?? "UNKNOWN";
    balanceCache = val;
    if (footerState) {
      footerState = { ...footerState, balance: val };
    }
    if (footerTuiRef) {
      try { footerTuiRef.requestRender(); } catch {}
    }
  }

  function getProvider(ctx: ExtensionContext): string {
    return ctx.model?.provider?.toLowerCase() ?? "unknown";
  }

  function triggerBalanceFetch(ctx: ExtensionContext): void {
    if (balancePromise) return;
    const provider = getProvider(ctx);
    balancePromise = fetchBalance(ctx).then((b) => {
      balancePromise = null;
      writeBalanceCache(provider, b);
      applyBalance(b);
    }).catch(() => {
      balancePromise = null;
      applyBalance(null);
    });
  }

  function startBalanceTimer(ctx: ExtensionContext): void {
    if (balanceTimer) return;
    const provider = getProvider(ctx);
    // Read cache for this provider
    const cached = readBalanceCache(provider);
    if (cached.balance) {
      applyBalance(cached.balance);
    }
    // Fetch if cache is stale or missing
    const age = Date.now() - cached.timestamp;
    if (!cached.balance || age > 60_000) {
      triggerBalanceFetch(ctx);
    }
    // Check every 30s
    balanceTimer = setInterval(() => {
      const p = getProvider(ctx);
      const cached2 = readBalanceCache(p);
      const age2 = Date.now() - cached2.timestamp;
      if (!cached2.balance || age2 > 60_000) {
        triggerBalanceFetch(ctx);
      }
    }, 30_000);
    balanceTimer.unref?.();
  }

  function fmtDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const totalMs = Math.floor(ms);
    const d = Math.floor(totalMs / 86400000);
    const h = Math.floor((totalMs % 86400000) / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const sec = Math.floor((totalMs % 60000) / 1000);
    const msec = totalMs % 1000;
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}${t.duration.day}`);
    if (h > 0) parts.push(`${h}${t.duration.hour}`);
    if (m > 0 || parts.length > 0) parts.push(`${m}${t.duration.minute}`);
    if (sec > 0 || parts.length > 0) parts.push(`${sec}${t.duration.second}`);
    if (msec > 0 || parts.length === 0) parts.push(`${msec}${t.duration.ms}`);
    return parts.join(" ");
  }

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
  }

  // ---- usage aggregation ----

  function refreshUsage(ctx: ExtensionContext): void {
    const usage = ctx.getContextUsage();
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
    let cost = 0, costAvailable = false;
    let cacheHitPercent: number | undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const u = entry.message.usage;
      if (!u || typeof u.input !== "number" || typeof u.output !== "number") continue;
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
      if (typeof u.cost?.total === "number") {
        cost += u.cost.total;
        costAvailable = true;
      }
      const promptTotal = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      if (promptTotal > 0 && (u.cacheRead ?? 0) > 0) {
        cacheHitPercent = ((u.cacheRead ?? 0) / promptTotal) * 100;
      }
    }

    const model = ctx.model;
    const ctxPct = usage?.percent ?? null;
    const ctxWindow = usage?.contextWindow ?? 0;
    const thinking = pi.getThinkingLevel?.();

    const provider = model?.provider ?? footerState?.provider;

    // Compute todayCost: cross-midnight tracking
    const tracking = loadCostTracking(cost);
    const todayStr = getTodayStr();
    if (tracking.lastCheckDate !== todayStr) {
      // Crossed midnight: snapshot current session cost as baseline
      tracking.lastMidnightCost = cost;
      tracking.lastCheckDate = todayStr;
      saveCostTracking(tracking);
    }
    // Guard against negative values (e.g. switching to a fresh session whose
    // accumulated cost is lower than today's baseline).
    const todayCost = Math.max(0, cost - tracking.lastMidnightCost);

    footerState = {
      ...footerState,
      activity: footerState?.activity ?? "ready",
      modelId: model?.id,
      provider,
      thinkingLevel: thinking && thinking !== "off" ? thinking : undefined,
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheHitPercent,
      cost,
      todayCost,
      costAvailable,
      contextPercent: ctxPct,
      contextWindow: ctxWindow,
      cwd: ctx.cwd,
      sessionName: ctx.sessionManager.getSessionName() || t.generic.untitled,
    };

    // Start balance timer (reads cache, fetches if stale)
    if (model?.provider) {
      startBalanceTimer(ctx);
    }
  }

  // ---- footer ----

  // 其他扩展通过 ctx.ui.setStatus() 写入的状态（如 "wj-scheduler: active"）。
  // 这类数据只能从 setFooter 的 footerData 读取（widget 工厂拿不到），
  // 因此用 footer 组件兼任“状态缓存桥”：每次渲染时同步最新状态供 widget 使用。
  let statusesCache: string[] = [];

  function syncExtensionStatuses(footerData: any): void {
    try {
      const statusMap = footerData?.getExtensionStatuses?.();
      if (statusMap && typeof statusMap.forEach === "function") {
        const arr: string[] = [];
        statusMap.forEach((text: string) => { if (text) arr.push(text); });
        statusesCache = arr;
      }
    } catch {}
  }

  /** 第 1 行（输入框上方 widget）：● status · model · thinking · 扩展状态 | in/out/ctx */
  /** 文本框内部状态行（下边框之上）：● status · model · thinking · 扩展状态 */
  /** 文本框内部状态行（下边框之上）：● status · model · provider · 扩展状态，思考等级右对齐 */
  /** 文本框内部状态行（下边框之上）：● status · model · provider · 扩展状态，think 级别右对齐 */
  /** 文本框内部状态行：● status · model · provider · 扩展状态，think 级别右对齐；窄屏自动精简 */
  /**
   * 文本框内部状态行，按宽度三档渲染：
   *  - 极窄 (<40)：仅 model … high
   *  - 窄屏 (40~119)：● READY · model · statuses … high（无 provider、无 think 前缀）
   *  - 宽屏 (>=120)：● READY · model · provider · statuses … think high（完整）
   */
  /**
   * 文本框状态栏（文本框内部、输入行下方、下边框之上）。
   * 显示顺序（宽度足够时）：● READY · model · provider · statuses … think high
   * 信息不足时按固定顺序逐项隐藏（内容自适应）：
   *   provider → think 前缀 → ● READY → statuses → model → think 级别
   * 宽度足够时展示全部信息，越藏越少，最后只保留 think 级别。
   */
  function renderStatusLine(theme: any, width: number): string {
    const s = footerState?.activity ?? "ready";
    const model = footerState?.modelId ?? "-";
    const provider = footerState?.provider;
    const think = footerState?.thinkingLevel ?? "-";
    // 编辑器 theme 是 pi-tui 的 EditorTheme，没有 fg()；颜色统一用 atelier 主题。
    const color = (name: string, x: string) =>
      typeof theme?.fg === "function" ? theme.fg(name, x) : x;
    const muted = (x: string) => color("muted", x);
    const textColor = (x: string) => color("text", x);
    const bold = (x: string) => (typeof theme?.bold === "function" ? theme.bold(x) : x);

    const statuses: string[] = [];
    for (const text of statusesCache) if (text) statuses.push(text);
    const statusStr = statuses.length > 0 ? muted(statuses.join("  ")) : "";
    const statusLabel = s === "ready" ? t.status.ready : s === "working" ? t.status.working : t.status.error;
    const BLUE = "\x1b[38;2;114;211;252m";
    const RESET = "\x1b[39m";

    // 显示单元（按隐藏顺序排列：越靠前越先被隐藏）
    const units: Array<{ key: string; render: () => string }> = [];
    if (provider) units.push({ key: "provider", render: () => muted(provider ?? "") });
    units.push({ key: "thinkPref", render: () => muted("think") });
    units.push({ key: "status", render: () => bold(color("syntaxKeyword", `\u25cf ${statusLabel}`)) });
    if (statuses.length > 0) units.push({ key: "statuses", render: () => statusStr });
    units.push({ key: "model", render: () => textColor(model) });
    units.push({ key: "think", render: () => BLUE + think + RESET });

    // 显示顺序（视觉布局）：● READY 最先，model 次之，provider 随后，statuses 靠后
    // 与隐藏顺序（units 数组次序）相互独立
    const displayOrder: Record<string, number> = { status: 0, model: 1, provider: 2, statuses: 3 };

    // 从第一个单元开始逐个隐藏（隐藏顺序 = units 数组次序），直到能放下
    for (let drop = 0; drop < units.length; drop++) {
      const kept = units.slice(drop);
      let leftUnits = kept.filter((u) => u.key !== "thinkPref" && u.key !== "think");
      leftUnits = leftUnits.sort((a, b) => (displayOrder[a.key] ?? 9) - (displayOrder[b.key] ?? 9));
      const rightUnits = kept.filter((u) => u.key === "thinkPref" || u.key === "think");
      const left = leftUnits.map((u) => u.render()).join(` ${muted("\u00b7")} `);
      const right = rightUnits.map((u) => u.render()).join(" ");
      const gap = width - visibleLen(left) - visibleLen(right);
      if (gap >= 2) {
        return truncateToVisible(
          gap >= 4 ? left + muted(" ".repeat(gap)) + right : left + "  " + right,
          width,
        );
      }
    }
    // 极端兜底：只剩 think 级别
    return truncateToVisible(BLUE + think + RESET, width);
  }

  /**
   * 底部状态栏（输入框下方），三级内容自适应：
   *  1 行：宽度足够时左右同行（右部右对齐）
   *  2 行：放不下时拆两行，左部一行、右部一行，均靠左
   *  4 行：2 行时若任一行超宽，再细拆为四行：
   *       session · dur / cwd / ctx · cache / cost · bal
   */
  function renderLine2(theme: any, width: number): string[] {
    const dim = (x: string) => theme.fg("dim", x);
    const muted = (x: string) => theme.fg("muted", x);
    const dur = footerState?.lastRunDurationMs !== undefined ? fmtDuration(footerState.lastRunDurationMs) : "";
    const sessionName = footerState?.sessionName ?? t.generic.untitled;
    const cwd = footerState?.cwd ?? "-";

    const ctxWin = footerState?.contextWindow ? fmt(footerState.contextWindow) : "";
    const ctxPct = footerState?.contextPercent !== null && footerState?.contextPercent !== undefined
      ? `${footerState.contextPercent.toFixed(1)}%` : "-%";
    const ac = footerState?.autoCompact === true ? muted(t.compaction.auto)
      : footerState?.autoCompact === false ? muted(t.compaction.off)
      : muted(t.compaction.unknown);

    const ch = footerState?.cacheHitPercent !== undefined ? `${footerState.cacheHitPercent.toFixed(1)}%` : "-%";
    const bal = footerState?.balance;

    const sep = "\u00b7";
    const ctxNode = ctxWin
      ? `${dim(t.line1.ctx)} \x1b[38;2;114;211;252m${ctxPct}\x1b[39m ${dim(ctxWin)} ${ac}`
      : `${dim(t.line1.ctx)} \x1b[38;2;114;211;252m${ctxPct}\x1b[39m ${ac}`;
    const cacheNode = `${dim(t.line2.cache)} \x1b[38;2;177;140;255m${ch}\x1b[39m`;
    const costNode = `\x1b[38;2;255;159;67m${costCfg.symbol}${((footerState?.todayCost ?? 0) * costCfg.rate).toFixed(2)}/${costCfg.symbol}${((footerState?.cost ?? 0) * costCfg.rate).toFixed(2)}\x1b[39m`;
    const balNode = bal && bal !== "UNKNOWN"
      ? `${dim(t.line2.bal)} \x1b[38;2;187;255;153m${bal}\x1b[39m`
      : "";

    const leftFull = [dim(sessionName), dim(cwd), ...(dur ? [dim(dur)] : [])].join(` ${dim(sep)} `);
    const rightItems = [ctxNode, cacheNode, costNode];
    if (balNode) rightItems.push(balNode);
    const rightFull = rightItems.join(` ${dim(sep)} `);
    const v = visibleLen;

    // 扩展行（共享桥）：wj-scheduler 等扩展发布的任务状态行，追加在本栏下方
    const bridgeExtra = (globalThis as Record<string, unknown>)["__wj_scheduler_footer_lines"];
    const extras: string[] =
      Array.isArray(bridgeExtra) && bridgeExtra.length > 0
        ? bridgeExtra.map((s) => dim(String(s)))
        : [];
    const withExtras = (rows: string[]) => [...rows.map((r) => truncateToVisible(r, width)), ...extras];

    // ① 1 行：左右同行（右部右对齐）
    const gap = width - v(leftFull) - v(rightFull);
    if (gap >= 4) {
      return withExtras([truncateToVisible(leftFull + muted(" ".repeat(gap)) + rightFull, width)]);
    }

    // ② 2 行：左部一行、右部一行（均靠左）
    if (v(leftFull) <= width && v(rightFull) <= width) {
      return withExtras([truncateToVisible(leftFull, width), truncateToVisible(rightFull, width)]);
    }

    // ③ 4 行：细拆为 session·dur / cwd / ctx·cache / cost·bal
    const row1 = [dim(sessionName), ...(dur ? [dim(dur)] : [])].join(` ${dim(sep)} `);
    const row2 = dim(cwd);
    const row3 = [ctxNode, cacheNode].join(` ${dim(sep)} `);
    const row4 = [costNode, ...(balNode ? [balNode] : [])].join(` ${dim(sep)} `);
    return withExtras([row1, row2, row3, row4].map((l) => truncateToVisible(l, width)));
  }




  class StatusAwareEditor extends CustomEditor {
    private statusTheme: any;
    constructor(tui: any, theme: any, keybindings: any, options?: any) {
      super(tui, theme, keybindings, options);
      this.statusTheme = theme;
    }
    render(width: number): string[] {
      const lines = super.render(width);
      if (!Array.isArray(lines) || lines.length === 0) return lines;
      // 在最后一行（底部边框）之前注入 ● READY 状态行
      return [...lines.slice(0, -1), "", renderStatusLine(atelierThemeRef ?? this.statusTheme, width), lines[lines.length - 1]];
    }
  }

  function installStatusUI(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    refreshUsage(ctx);

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTuiRef = tui;
      atelierThemeRef ??= theme;
      syncExtensionStatuses(footerData);
      return {
        render(width: number): string[] {
          syncExtensionStatuses(footerData);
          return renderLine2(theme, width);
        },
        invalidate(): void {},
      };
    });

    // 替换编辑器：在文本框内部（输入行下方、下边框上方）注入“文本框状态栏”行
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new StatusAwareEditor(tui, theme, keybindings),
    );
  }

  // ---- commands ----

  pi.registerCommand("wj-status", {
    description: "Show detailed WJ Status info.",
    handler: async (_args, ctx) => {
      refreshUsage(ctx);
      const sLabel = footerState.activity === "ready" ? t.status.ready
        : footerState.activity === "working" ? t.status.working
        : t.status.error;
      const lines = [
        "\u2500\u2500 WJ Status \u2500\u2500",
        `Activity:  ${sLabel}`,
        `Model:     ${footerState.modelId ?? "\u2014"}`,
        `Thinking:  ${footerState.thinkingLevel ?? "off"}`,
        `Input:     ${footerState.input.toLocaleString()} tok`,
        `Output:    ${footerState.output.toLocaleString()} tok`,
        `Cache:     R${footerState.cacheRead.toLocaleString()} W${footerState.cacheWrite.toLocaleString()}` +
          (footerState.cacheHitPercent !== undefined ? ` (${Math.round(footerState.cacheHitPercent)}%)` : ""),
        `Cost:      Today ${costCfg.symbol}${(footerState.todayCost * costCfg.rate).toFixed(costCfg.decimals)} | Session ${costCfg.symbol}${(footerState.cost * costCfg.rate).toFixed(2)}`,
        `Context:   ${footerState.contextPercent?.toFixed(1) ?? "\u2014"}% ${footerState.autoCompact === true ? t.compaction.auto : footerState.autoCompact === false ? t.compaction.off : t.compaction.unknown}`,
        `CWD:       ${footerState.cwd}`,
        footerState.lastRunStartTime ? `Last run:  ${fmtDuration(footerState.lastRunDurationMs!)}  ${footerState.lastRunStartTime} \u2192 ${footerState.lastRunEndTime}` : "",
      ];
      ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
    },
  });

  // ---- lifecycle ----

  pi.on("session_start", (_event, ctx) => {
    try {
      currentRunStartTs = undefined;
      let autoCompact: boolean | null = null;
      try {
        autoCompact = SettingsManager.create(
          ctx.isProjectTrusted() ? ctx.cwd : getAgentDir(),
        ).getCompactionSettings().enabled;
      } catch {}
      // 会话级成本基线：data/wj-status/<sessionId>/cost-tracking.json
      const sid = ctx.sessionManager.getSessionId();
      const costSessionDir = join(getAgentDir(), "data", "wj-status", sid ?? Date.now().toString());
      mkdirSync(costSessionDir, { recursive: true });
      COST_TRACKING_FILE = join(costSessionDir, "cost-tracking.json");
      footerState = {
        activity: "ready",
        modelId: undefined,
        thinkingLevel: undefined,
        input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0,
        cost: 0, todayCost: 0, costAvailable: false,
        contextPercent: null, contextWindow: 0,
        cwd: ctx.cwd,
        autoCompact,
        balance: null,
        sessionName: ctx.sessionManager.getSessionName() || t.generic.untitled,
      };
      refreshUsage(ctx);
      if (ctx.mode === "tui") installStatusUI(ctx);
    } catch (e) {
      console.error("[wj-status] session_start error:", e);
    }
  });

  pi.on("agent_start", () => {
    currentRunStartTs = Date.now();
    footerState = { ...footerState, activity: "working" };
  });

  pi.on("turn_end", (_event, ctx) => refreshUsage(ctx));

  pi.on("agent_settled", () => {
    if (currentRunStartTs) {
      const now = Date.now();
      footerState = {
        ...footerState,
        activity: "ready",
        lastRunDurationMs: now - currentRunStartTs,
        lastRunStartTime: fmtTime(currentRunStartTs),
        lastRunEndTime: fmtTime(now),
      };
      currentRunStartTs = undefined;
    } else {
      footerState = { ...footerState, activity: "ready" };
    }
  });

  pi.on("model_select", (_event, ctx) => refreshUsage(ctx));
  pi.on("thinking_level_select", (_event, ctx) => refreshUsage(ctx));
  pi.on("session_compact", (_event, ctx) => refreshUsage(ctx));
  pi.on("session_info_changed", (_event, ctx) => refreshUsage(ctx));

  pi.on("session_shutdown", () => {
    currentRunStartTs = undefined;
    if (balanceTimer) {
      clearInterval(balanceTimer);
      balanceTimer = undefined;
    }
  });
}
