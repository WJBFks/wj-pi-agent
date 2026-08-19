/**
 * wj-btw 的配置读取与白名单校验。
 *
 * 纯逻辑、零外部依赖、不依赖 pi API，可独立单测。
 * - 配置双层可覆盖：默认内置（空白名单）→ 项目级 `.pi/wj/btw/settings.json`
 *   （环境变量 `WJ_BTW_SETTINGS` 可覆盖路径）。
 * - 白名单校验语义：「忽略 + 警告」——不在 active 集合里的名字归入 ignored，
 *   不抛错、不阻断启动。
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface BtwSettings {
  tools: string[];
  skills: string[];
}

/** 默认设置：空白名单 = 纯 LLM 聊天（不调工具/技能） */
export const DEFAULT_SETTINGS: BtwSettings = { tools: [], skills: [] };

/** 解析配置文件路径：WJ_BTW_SETTINGS 覆盖 → 项目级 .pi/wj/btw/settings.json */
export function resolveSettingsPath(cwd: string): string {
  const override = process.env.WJ_BTW_SETTINGS;
  if (override && override.trim()) return override.trim();
  return path.join(cwd, ".pi", "wj", "btw", "settings.json");
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** 读取配置；文件缺失或解析失败时回退默认（新对象） */
export function loadSettings(cwd: string): BtwSettings {
  const file = resolveSettingsPath(cwd);
  if (!existsSync(file)) {
    return { tools: [...DEFAULT_SETTINGS.tools], skills: [...DEFAULT_SETTINGS.skills] };
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      tools: asStringArray(raw.tools),
      skills: asStringArray(raw.skills),
    };
  } catch (err) {
    console.warn(`[wj-btw] 配置解析失败，回退默认：${String(err)}`);
    return { tools: [...DEFAULT_SETTINGS.tools], skills: [...DEFAULT_SETTINGS.skills] };
  }
}

/**
 * 白名单「忽略 + 警告」校验：
 * whitelist 中命中的 active 集合的名字 → valid；未命中 → ignored。
 * 顺序保持 whitelist 原始顺序，返回新数组。
 */
export function checkWhitelist(
  _kind: "tools" | "skills",
  whitelist: string[],
  active: string[],
): { valid: string[]; ignored: string[] } {
  const set = new Set(active);
  const valid: string[] = [];
  const ignored: string[] = [];
  for (const name of whitelist) {
    if (set.has(name)) valid.push(name);
    else ignored.push(name);
  }
  return { valid, ignored };
}
