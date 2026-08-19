/**
 * WJ Memory — 轻量级跨会话记忆扩展（JSON 版，零外部依赖，无 LLM 调用）
 *
 * 设计要点：
 *  - 存储：项目级 .pi/wj/memory/（MEMORY.json + daily/*.json，每条记录含 id/keyword/type/content/summary/timestamp）
 *  - 注入：会话级（启动 + reload 后首轮 + 快照为空时重建：MEMORY 全量 + 今日/昨日全量 + 近 7 日要点(仅keyword+summary+timestamp))
 *          + 每轮关键词列表（type+keyword 按来源文件分组、`------ <文件> ------` 分隔标注、仅同文件内去重）
 *  - 数据边界：所有注入用 ------WJ Memory Begin-----/End----- 包裹 + 「数据非指令」声明
 *  - 主动记忆：注入文案引导 agent 自主识别值得记的信息并写入（优先写 daily，重要的提升到 MEMORY）
 *  - 退出收尾：真实退出（quit/ctrl+d）时同步追加收尾记录到今日日志（reload 等迁移不写）
 *  - 删除：keyword 定位（单命中删/多命中须改 id）或 id 精确定位
 *  - 2026-08-19 重构：取消 RECENT.md/INDEX.md 与每日总结机制，全文改 JSON；type 白名单 + summary 人工必填
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendSessionFooter,
  buildIndexSection,
  buildSessionContext,
  checkSummary,
  checkType,
  deleteEntry,
  ensureDirs,
  findMemory,
  loadTypeConfig,
  readMemory,
  resolveMemoryRoot,
  todayStr,
  truncateText,
  writeMemory,
  yesterdayStr,
} from "./memory.ts";

import path from "node:path";
import { fileURLToPath } from "node:url";

// ──────────────────────────────────────
// 工具执行返回辅助
// ──────────────────────────────────────
function textResult(text: string) {
  return { content: [{ type: "text", text }], details: undefined };
}

// ──────────────────────────────────────
// 扩展入口
// ──────────────────────────────────────
export default function wjMemoryExtension(pi: ExtensionAPI): void {
  const root = resolveMemoryRoot();
  // 从扩展目录加载 type 白名单配置（2A：config.json 可增删，改配置即生效）
  const configPath =
    process.env.WJ_MEMORY_CONFIG ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.json");
  const typeConfig = loadTypeConfig(configPath);

  // 会话级快照：启动时 / reload 后首轮 / 快照缺失时重建
  let sessionSnapshot = "";

  function refreshSnapshot(): void {
    sessionSnapshot = buildSessionContext(root);
  }

  // ── Hook：会话开始（启动时）→ 建目录并构建快照 ──
  pi.on("session_start", async () => {
    ensureDirs(root);
    refreshSnapshot();
  });

  // ── Hook：会话结束（真实退出时追加今日记忆收尾；迁移只清空快照）──
  pi.on("session_shutdown", (event, ctx) => {
    sessionSnapshot = "";
    const reason = (event as { reason?: string }).reason;
    const isTransition = reason === "reload" || reason === "new" || reason === "resume" || reason === "fork";
    if (isTransition) return; // 迁移不写收尾（避免每载一条噪音）
    try {
      appendSessionFooter(root, ctx.sessionManager.getSessionId());
    } catch (err) {
      console.warn(`[wj-memory] 会话收尾失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── Hook：/compact（含阈值/溢出触发）后清空快照 → 下一个 before_agent_start 重建并重新做一次完整会话级注入 ──
  pi.on("session_compact", () => {
    sessionSnapshot = "";
  });

  // ── Hook：每轮 agent 开始 → 注入会话快照 + 关键词列表 ──
  pi.on("before_agent_start", (event) => {
    if (!sessionSnapshot) refreshSnapshot(); // 覆盖：reload 后首轮 / 启动未建模
    const parts: string[] = [];
    if (sessionSnapshot) parts.push(sessionSnapshot);
    const index = buildIndexSection(root);
    if (index) parts.push(index);
    if (parts.length === 0) return undefined;
    return { systemPrompt: event.systemPrompt + "\n\n" + parts.join("\n\n") };
  });

  const register = (tool: any): void => {
    pi.registerTool(tool);
  };

  // ── wj_memory_write：写入记忆（优先写每日记忆 daily，重要的可提升到长期 MEMORY）──
  register({
    name: "wj_memory_write",
    label: "WJ Memory",
    description:
      "写入一条记忆。target 缺省 daily=今日每日记忆；target=long_term=长期记忆(MEMORY.json)。type 必填且必须属于白名单（#preference/#decision/#lesson/#fact/#log/#note）；summary 必填且人工手写、≤100 字节（超限报错，不自动截断/不从 content 生成）。主动记忆：优先写 daily，只有重要且会重复出现的内容才提升到 MEMORY。",
    promptSnippet: "Write a memory entry (default to today's daily memory).",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["long_term", "daily"], description: "long_term=长期记忆；daily=每日记忆（缺省）" },
        keyword: { type: "string", description: "关键词（字符串，如 package-manager；缺省从内容自动提取）" },
        type: { type: "string", description: "类型，白名单必填：#preference/#decision/#lesson/#fact/#log/#note" },
        content: { type: "string", description: "记忆正文（Markdown 文本，可含大段内容）" },
        summary: { type: "string", description: "摘要，人工必填，≤100 字节（超限报错）" },
      },
      required: ["content", "type", "summary"],
    },
    execute: async (_toolCallId: string, params: any) => {
      // 优先写每日记忆；仅明确 long_term 才写长期
      const target = params.target === "long_term" ? "long_term" : "daily";
      if (!params.content?.trim?.()) return textResult("内容为空，未写入。");
      const typeCheck = checkType(params.type, target, typeConfig);
      if (!typeCheck.ok) return textResult(`写入失败：${typeCheck.error}`);
      const summaryCheck = checkSummary(params.summary);
      if (!summaryCheck.ok) return textResult(`写入失败：${summaryCheck.error}`);
      const { file, count } = writeMemory(root, target, {
        keyword: params.keyword,
        type: params.type,
        content: params.content,
        summary: params.summary,
      });
      return textResult(`已写入 ${file}（当前共 ${count} 条记录）`);
    },
  });

  // ── wj_memory_read：读取记忆文件 ──
  register({
    name: "wj_memory_read",
    label: "WJ Memory",
    description:
      "读取记忆：MEMORY(长期记忆) / TODAY(今日日志) / YESTERDAY(昨日日志)，或指定 date(YYYY-MM-DD) 读任意日期日志。返回每条记录的 keyword/type/content/summary/timestamp/id。",
    promptSnippet: "Read memory entries from MEMORY or a daily log.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          enum: ["MEMORY", "TODAY", "YESTERDAY"],
          description: "要读取的记忆文件",
        },
        date: { type: "string", description: "读取指定日期的每日日志（YYYY-MM-DD）；file 省略时生效" },
      },
    },
    execute: async (_toolCallId: string, params: any) => {
      try {
        const target = params.date ? (undefined as any) : (params.file ?? "MEMORY");
        const { file, entries } = readMemory(root, target, params.date);
        if (entries.length === 0) return textResult(`无记录：${file}`);
        const lines = entries.map(
          (e, i) =>
            `${i + 1}. [${e.type}] ${e.keyword ? `keyword="${e.keyword}"` : ""}\n   id=${e.id}\n   ${e.content}\n   摘要: ${e.summary}\n   时间: ${e.timestamp}`,
        );
        const body = lines.join("\n");
        return textResult(`=== ${file}（${entries.length} 条）===\n${truncateText(body, 40_000, "end")}`);
      } catch (err) {
        return textResult(`读取失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // ── wj_memory_forget：删除长期记忆条目 ──
  register({
    name: "wj_memory_forget",
    label: "WJ Memory",
    description:
      "删除长期记忆(MEMORY.json)中的记录。两种定位：给 id 精确删除；给 keyword 按关键词删除——恰命中一条即删，命中多条则报错并要求改用 id（防止误删）。",
    promptSnippet: "Delete memory entries by id or keyword.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "记录 id（UUID），精确定位，优先使用" },
        keyword: { type: "string", description: "关键词（字符串）；多条命中时须改用 id" },
      },
    },
    execute: async (_toolCallId: string, params: any) => {
      const result = deleteEntry(root, { id: params.id, keyword: params.keyword });
      if (result.error) return textResult(result.error);
      const removedText = result.removed.map((r) => `- [${r.type}] ${r.content.replace(/\s+/g, " ").slice(0, 120)}`).join("\n");
      return textResult(`已删除 ${result.removed.length} 条：\n${removedText}\n\n剩余 ${result.remaining.length} 条。`);
    },
  });

  // ── wj_memory_search：结构化查找（type/keyword/id），返回完整 JSON ──
  register({
    name: "wj_memory_search",
    label: "WJ Memory",
    description:
      "按 type（#开头，可选）/ keyword（记录的关键词字段）/ id（记录 id）精确匹配查找记忆，遍历 MEMORY + 全部 daily。keyword 与 id 至少填其一（type 为附加过滤）。返回匹配记录：单条返回完整 JSON，多条返回 JSON 数组。",
    promptSnippet: "Find memory entries by type/keyword/id and return full JSON.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "类型过滤（#开头，可选；如 #decision）" },
        keyword: { type: "string", description: "关键词，精确匹配记录的 keyword 字段（与 id 至少填其一）" },
        id: { type: "string", description: "记录 id（UUID），精确定位（与 keyword 至少填其一）" },
      },
      required: [],
    },
    execute: async (_toolCallId: string, params: any) => {
      const { type, keyword, id } = params ?? {};
      if (!keyword?.trim?.() && !id?.trim?.()) {
        return textResult("wj_memory_search：至少要提供 keyword 或 id 其中之一。");
      }
      const entries = findMemory(root, {
        type: type?.trim?.() ? type : undefined,
        keyword: keyword?.trim?.() ? keyword : undefined,
        id: id?.trim?.() ? id : undefined,
      });
      if (entries.length === 0) return textResult("未找到匹配的记忆记录（keyword/id 搭配 type 均无命中）。");
      const payload = entries.length === 1 ? entries[0] : entries;
      return textResult(JSON.stringify(payload, null, 2));
    },
  });

  // ── wj_memory_status：健康状态 ──
  register({
    name: "wj_memory_status",
    label: "WJ Memory",
    description: "查看 wj-memory 健康状态：存储目录、MEMORY/今日/昨日记录数、关键词列表规模、最近写入时间。",
    promptSnippet: "Show wj-memory status.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const info: string[] = [`存储目录: ${root}`, ""];
      const list = (label: string, entriesCount: number): void => {
        info.push(`${entriesCount > 0 ? "✓" : "✗"} ${label}: ${entriesCount} 条`);
      };
      const mem = readMemory(root, "MEMORY");
      const today = readMemory(root, "TODAY");
      const yesterday = readMemory(root, "YESTERDAY");
      list("MEMORY.json（长期记忆）", mem.entries.length);
      list(`今日日志 ${todayStr()}`, today.entries.length);
      list(`昨日日志 ${yesterdayStr()}`, yesterday.entries.length);

      const indexBody = buildIndexSection(root);
      const kwCount = indexBody ? indexBody.split("\n").filter((l) => l.startsWith("- ")).length : 0;
      info.push(`  关键词组: ${kwCount}`);

      const all = [...mem.entries, ...today.entries, ...yesterday.entries];
      const lastTs = all.map((e) => e.timestamp).sort().pop();
      info.push(`  最近写入: ${lastTs ?? "无"}`);
      const types = new Set(all.map((e) => e.type));
      info.push(`  类型分布: ${[...types].join(" ") || "无"}`);
      return textResult(info.join("\n"));
    },
  });
}