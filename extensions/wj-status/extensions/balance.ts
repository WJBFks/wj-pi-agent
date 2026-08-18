/**
 * 余额/额度获取模块 — wj-status
 *
 * 结构：各供应商一个私有函数 + 一个统一调度的总函数 getBalance()。
 * 返回值约定：展示用字符串（已含符号/单位）或 null（不可用）。
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** DeepSeek：官方余额接口，返回 CNY，显示为 ¥xx.xx */
async function balanceDeepseek(apiKey: string): Promise<string | null> {
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  const bal = data?.balance_infos?.[0]?.total_balance ?? data?.balance;
  return bal != null ? `\u00a5${Number(bal).toFixed(2)}` : null;
}

/** OpenAI：计费订阅接口，返回 USD，显示为 $xx.xx */
async function balanceOpenAI(apiKey: string): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/dashboard/billing/subscription", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  const bal = data?.account_balance ?? data?.balance ?? data?.hard_limit_usd;
  return bal != null ? `\u0024${Number(bal).toFixed(2)}` : null;
}

/**
 * OpenCode Go：官方 usage 接口，返回三窗口已用百分比。
 * 显示格式：14%/21%/10%（滚动/周/月）
 */
async function balanceOpenCodeGo(apiKey: string): Promise<string | null> {
  const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  const usage = data?.usage;
  const m = usage?.monthly?.percent;
  if (typeof m !== "number") return null;
  const pct = (v: number) => `${Math.round(v)}%`;
  const parts: string[] = [];
  for (const v of [usage?.rolling?.percent, usage?.weekly?.percent, m]) {
    if (typeof v === "number") parts.push(pct(v));
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * 总入口：按 provider 分发到各供应商实现。
 * 拿不到 key 或不支持的 provider 返回 null（UI 层据此隐藏余额项）。
 */
export async function getBalance(provider: string, apiKey: string): Promise<string | null> {
  switch (provider) {
    case "deepseek":
      return await balanceDeepseek(apiKey);
    case "openai":
    case "openai-compatible":
      return await balanceOpenAI(apiKey);
    case "opencode-go":
      return await balanceOpenCodeGo(apiKey);
    default:
      return null;
  }
}

// 保留类型导出引用，避免未使用告警（无副作用）
export type { ExtensionContext };