import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * WJ Status — lightweight status bar for Pi.
 *
 * Commands:
 *   /wj-status  — show detailed status info
 */

const _dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(_dirname, "..");

// Cost tracking (todayCost resets at midnight)
const COST_TRACKING_FILE = join(EXT_DIR, "cost-tracking.json");

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
      return JSON.parse(readFileSync(COST_TRACKING_FILE, "utf-8"));
    }
  } catch {}
  // New file: treat existing cost as pre-tracking baseline
  return { lastMidnightCost: initialCost, lastCheckDate: getTodayStr() };
}

function saveCostTracking(tracking: CostTracking): void {
  try {
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

    try {
      if (provider === "deepseek") {
        // DeepSeek returns CNY - always display as CNY with ¥
        const res = await fetch("https://api.deepseek.com/user/balance", {
          headers: { "Authorization": `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json() as any;
        const bal = data?.balance_infos?.[0]?.total_balance ?? data?.balance;
        return bal != null ? `\u00a5${Number(bal).toFixed(2)}` : null;
      }
      if (provider === "openai" || provider === "openai-compatible") {
        // OpenAI returns USD - always display as USD with $
        const res = await fetch("https://api.openai.com/v1/dashboard/billing/subscription", {
          headers: { "Authorization": `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json() as any;
        const bal = data?.account_balance ?? data?.balance ?? data?.hard_limit_usd;
        return bal != null ? `\u0024${Number(bal).toFixed(2)}` : null;
      }
      return null;
    } catch {}
    return null;
  }

  const CACHE_FILE = join(EXT_DIR, "balance-cache.json");

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
      writeFileSync(CACHE_FILE, JSON.stringify(all, null, 2), "utf-8");
    } catch {}
  }

  let footerTuiRef: any = null;
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
    const todayCost = cost - tracking.lastMidnightCost;

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

  function installFooter(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    refreshUsage(ctx);

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTuiRef = tui;
      const textColor = (t: string) => theme.fg("text", t);
      const muted = (t: string) => theme.fg("muted", t);
      const accent = (t: string) => theme.fg("accent", t);
      const green = (t: string) => theme.fg("toolDiffAdded", t);
      const dim = (t: string) => theme.fg("dim", t);
      const bold = (t: string) => theme.bold(t);

      return {
        render(width: number): string[] {
          const s = footerState?.activity ?? "ready";
          const model = footerState?.modelId ?? "-";
          const think = footerState?.thinkingLevel ?? "-";
          const inp = fmt(footerState?.input ?? 0);
          const out = fmt(footerState?.output ?? 0);
          const ctxWin = footerState?.contextWindow ? fmt(footerState.contextWindow) : "";
          const ctxPct = footerState?.contextPercent !== null && footerState?.contextPercent !== undefined
            ? `${footerState.contextPercent.toFixed(1)}%` : "-%";
          const dir = footerState?.cwd?.split("/").pop() ?? "-";
          const dur = footerState?.lastRunDurationMs !== undefined ? fmtDuration(footerState.lastRunDurationMs) : "";

          // Auto-compaction
          const ac = footerState?.autoCompact === true ? muted(t.compaction.auto)
            : footerState?.autoCompact === false ? muted(t.compaction.off)
            : muted(t.compaction.unknown);

          // Extension statuses
          const statuses: string[] = [];
          try {
            const statusMap = footerData.getExtensionStatuses();
            if (statusMap && typeof statusMap.forEach === "function") {
              statusMap.forEach((text: string) => { if (text) statuses.push(text); });
            }
          } catch {}
          const statusStr = statuses.length > 0 ? muted(statuses.join("  ")) : "";

          // ── Line 1 ──
          const statusLabel = s === "ready" ? t.status.ready : s === "working" ? t.status.working : t.status.error;
          // Left:  status(blue+bold) · model(white) · thinking · extension statuses
          const L1left = [
            theme.bold(theme.fg("syntaxKeyword", `\u25cf ${statusLabel}`)),
            textColor(model),
            theme.italic(muted(think)),
          ];
          if (statusStr) L1left.push(statusStr);

          // Right: labels in dim, values colored
          const L1right = [
            `${dim(t.line1.in)} ${theme.fg("syntaxKeyword", inp)}`,
            `${dim(t.line1.out)} [38;2;177;140;255m${out}[39m`,
            ctxWin ? `${dim(t.line1.ctx)} [38;2;114;211;252m${ctxPct}[39m ${dim(ctxWin)} ${ac}` : `${dim(t.line1.ctx)} [38;2;114;211;252m${ctxPct}[39m ${ac}`,
          ];

          const l1LeftText = L1left.join(` ${muted("\u00b7")} `);
          const l1RightText = L1right.join(` ${muted("\u00b7")} `);
          const l1Gap = width - visibleLen(l1LeftText) - visibleLen(l1RightText);
          const line1 = l1Gap >= 4
            ? `${l1LeftText}${muted(" ".repeat(l1Gap))}${l1RightText}`
            : `${l1LeftText}  ${l1RightText}`;

          // ── Line 2: left = full path + duration, right = read · write · cache% · $cost
          const L2left = [dim(footerState?.sessionName ?? t.generic.untitled), dim(footerState?.cwd ?? "-")];
          if (dur) L2left.push(dim(dur));

          const ch = footerState?.cacheHitPercent !== undefined ? `${Math.round(footerState.cacheHitPercent)}%` : "-%";
          // Balance display
          const bal = footerState?.balance;

          const L2right = [
            `${dim(t.line2.cache)} [38;2;243;169;165m${ch}[39m`,
            `[38;2;255;159;67m${costCfg.symbol}${((footerState?.todayCost ?? 0) * costCfg.rate).toFixed(costCfg.decimals)}/${costCfg.symbol}${((footerState?.cost ?? 0) * costCfg.rate).toFixed(2)}[39m`,
            bal && bal !== "UNKNOWN" ? `${dim(t.line2.bal)} [38;2;187;255;153m${bal}[39m` : `${dim(t.line2.bal)} UNKNOWN`,
          ];

          const l2LeftText = L2left.join(` ${muted("\u00b7")} `);
          const l2RightText = L2right.join(` ${muted("\u00b7")} `);
          const l2Gap = width - visibleLen(l2LeftText) - visibleLen(l2RightText);
          const line2 = l2Gap >= 4
            ? `${l2LeftText}${muted(" ".repeat(l2Gap))}${l2RightText}`
            : `${l2LeftText}  ${l2RightText}`;

          return [truncateToVisible(line1, width), truncateToVisible(line2, width)];
        },
        invalidate(): void {},
      };
    });
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
      if (ctx.mode === "tui") installFooter(ctx);
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
