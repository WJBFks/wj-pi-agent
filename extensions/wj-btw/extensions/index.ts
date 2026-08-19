/**
 * WJ BTW — 一次性受限子智能体委托（pi 扩展）
 *
 * 架构（受限子进程后端 + 结果回填主会话）：
 *  - 后端 = 独立受限 pi 子进程：`pi --mode rpc --no-session -t <工具白名单>`
 *    自带完整 pi、独立对话上下文、按白名单受限工具；`--no-session` 保证不落盘
 *  - 用法：`/btw [prompt]` → 把 [prompt] 交给子智能体执行，
 *    **跑完后直接把回答输出回主进程会话**（无弹窗、无交互层）
 *  - 会话贯穿：本次委托完成后子进程保留（内存态），再次 `/btw [prompt2]`
 *    会沿用同一上下文继续追问；子进程随主进程退出而销毁
 *
 * 配置：项目级 `.pi/wj/btw/settings.json`（WJ_BTW_SETTINGS 环境变量可覆盖）。
 * 字段 `tools`/`skills` 白名单；空白名单 = 纯 LLM 聊天。
 * 白名单校验：忽略 + 警告（未命中名字不阻断启动，仅提示）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, Box } from "@earendil-works/pi-tui";
import { loadSettings, checkWhitelist } from "./settings.ts";

// ──────────────────────────────────────
// RPC 客户端：与受限 pi 子进程的 stdin/stdout JSONL 通信
// ──────────────────────────────────────
class RpcClient {
  private proc: ChildProcess;
  private buf = "";
  private pending = new Map<string, (data: any) => void>();
  private seq = 0;

  constructor(proc: ChildProcess) {
    this.proc = proc;
  }

  alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed && !this.proc.signalCode;
  }

  start(): void {
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.handleLine(JSON.parse(line));
        } catch {
          /* 忽略非 JSON 噪音行 */
        }
      }
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8").trim();
      if (s) console.warn(`[wj-btw:rpc] ${s}`);
    });
  }

  private handleLine(msg: any): void {
    if (msg && msg.type === "response" && msg.id) {
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  send(cmd: Record<string, unknown>): Promise<any> {
    const id = `btw-${++this.seq}`;
    const payload = { id, ...cmd };
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 超时: ${cmd.type}`));
      }, 30_000);
      this.pending.set(id, (data: any) => {
        clearTimeout(to);
        resolve(data);
      });
      this.proc.stdin?.write(JSON.stringify(payload) + "\n");
    });
  }

  /** 发送 prompt，返回 RPC response（accepted？） */
  prompt(message: string): Promise<any> {
    return this.send({ type: "prompt", message });
  }

  /** 取当前 session 状态（isStreaming / messageCount 等） */
  async getState(): Promise<any> {
    const resp = await this.send({ type: "get_state" });
    return resp?.success ? resp.data : null;
  }

  /** 取最近一条 assistant 文本 */
  async lastAssistantText(): Promise<string | null> {
    const resp = await this.send({ type: "get_last_assistant_text" });
    if (!resp?.success) return null;
    const t = resp.data?.text;
    return typeof t === "string" ? t : null;
  }

  /** 等子进程就绪 */
  async ready(): Promise<void> {
    try {
      await this.send({ type: "get_state" });
    } catch {
      /* 子进程就绪前可能报错，忽略 */
    }
  }

  /**
   * 等待本轮完成并返回该轮回答。
   * 判定 = 实时状态轮询：`messageCount` 超过 prompt 前的基线 且 当前未在流式（isStreaming=false）。
   * 用计数/状态而非文本内容判定，避免连续轮错配到上一轮旧文本（自愈、可靠）。
   * @param base 发起本 prompt 之前的 messageCount 基线
   */
  async waitTurn(base: number, timeoutMs = 300_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let st: any = null;
      try {
        st = await this.getState();
      } catch {
        /* 忽略瞬态错误，继续轮询 */
      }
      if (st) {
        const mc = st.messageCount ?? 0;
        if (mc > base && st.isStreaming === false) {
          return await this.lastAssistantText().catch(() => null);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return await this.lastAssistantText().catch(() => null);
  }

  kill(): void {
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

// ──────────────────────────────────────
// 会话状态（进程内存态，多次 /btw 贯穿同一上下文）
// ──────────────────────────────────────
let child: { proc: ChildProcess; rpc: RpcClient } | null = null;

// 动态更新同卡：TUI 引用（经 setWidget 工厂捕获）+ 当前「处理中」卡的更新器
let tuiRef: any = null;
let liveUpdater: ((reply: string) => void) | null = null;

// ──────────────────────────────────────
// 后端启动 / 转发 / 输出
// ──────────────────────────────────────
function spawnRpcProcess(cwd: string, model?: any): ChildProcess {
  const settings = loadSettings(cwd);
  const args = ["--mode", "rpc", "--no-session", "-n", "wj-btw"];
  const toolsCsv = settings.tools.join(",");
  if (toolsCsv) args.push("-t", toolsCsv);
  // 复用主进程当前 provider / 模型到子进程
  if (model) {
    const prov = model.provider?.name ?? model.provider?.id ?? model.provider;
    const id = model.id;
    if (prov) args.push("--provider", String(prov));
    if (prov && id) args.push("--model", `${prov}/${id}`);
  }
  return spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

function ensureChild(ctx: any): boolean {
  if (child && child.rpc.alive()) return true;
  // 白名单校验（忽略 + 警告）
  const settings = loadSettings(ctx.cwd);
  const activeTools = (ctx.getActiveTools?.() ?? []) as string[];
  const { ignored } = checkWhitelist("tools", settings.tools, activeTools);
  if (ignored.length > 0) {
    ctx.ui.notify(`[wj-btw] 已忽略未注册项：${ignored.join("、")}`, "warning");
  }
  const model = (ctx as any).model ?? (ctx as any).modelRegistry?.getActive?.() ?? undefined;
  const proc = spawnRpcProcess(ctx.cwd, model);
  const rpc = new RpcClient(proc);
  rpc.start();
  child = { proc, rpc };
  return true;
}

function destroyChild(): void {
  if (child) {
    try {
      child.rpc.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
}

/**
 * 执行一次委托：把 prompt 交给子智能体，跑完后把回答输出回主会话。
 * 子进程保留，便于 /btw 连续追问。
 */
async function runOneTask(ctx: any, prompt: string): Promise<void> {
  if (!ensureChild(ctx) || !child) return;
  piWidgets.running(prompt);
  try {
    // 在发 prompt 前记录 messageCount 基线（用于本轮完成判定，避免误判到上一轮）
    const pre = await child.rpc.getState().catch(() => null);
    const base = (pre?.messageCount ?? 0) as number;
    await child.rpc.prompt(prompt);
    const reply = ((await child.rpc.waitTurn(base)) ?? "(无回复)") as string;
    piWidgets.done(prompt, reply);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`[wj-btw] 执行出错：${msg}`, "error");
    destroyChild();
  }
}

// ──────────────────────────────────────
// 渲染（写入主会话展示，不进 LLM 上下文）
// ──────────────────────────────────────
let piWidgets: {
  running: (prompt: string) => void;
  done: (prompt: string, reply: string) => void;
} = {
  running: () => {},
  done: () => {},
};

// ──────────────────────────────────────
// 扩展入口
// ──────────────────────────────────────
export default function wjBtw(pi: ExtensionAPI): void {
  // 渲染器：btw 委派结果卡片（带背景，像工具块；只展示，不进 LLM 上下文）
  pi.registerEntryRenderer("btw-result", (entry: any, _opts, theme) => {
    const d = (entry.data ?? {}) as { status?: string; prompt?: string; reply?: string };
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    // Text 显式 padding=0，避免分隔线上下出现空行；Box paddingY=1 即上下各一行背景
    if (d.status === "running") {
      const promptLabel = d.prompt ?? "";
      const content = new Text(
        `${theme.fg("accent", "[btw]")} ${theme.fg("dim", "处理中…")} ${promptLabel}`,
        0,
        0,
      );
      box.addChild(content);
      // 保存更新器：跑完后原地把这张「处理中」卡变成「结果」卡（背景不变）
      liveUpdater = (reply) => {
        // 同步更新 entry 数据，避免后续 rebuild（如展开卡重渲）回退成「处理中」
        if (entry && entry.data) entry.data = { status: "done", prompt: promptLabel, reply };
        content.setText(
          `${theme.fg("accent", "[btw]")} ${promptLabel}\n` +
            `${theme.fg("dim", "────")}\n${reply}`,
        );
        tuiRef?.requestRender?.();
      };
    } else {
      box.addChild(new Text(`${theme.fg("accent", "[btw]")} ${d.prompt ?? ""}`, 0, 0));
      box.addChild(new Text(theme.fg("dim", "────"), 0, 0));
      box.addChild(new Text(`${d.reply || "(无回复)"}`, 0, 0));
    }
    return box;
  });

  piWidgets = {
    running: (prompt) => pi.appendEntry("btw-result", { status: "running", prompt } as any),
    done: (prompt, reply) => {
      // 优先原地更新同一张「处理中」卡；更新器未就绪时退化为追加一张结果卡
      if (liveUpdater) {
        liveUpdater(reply);
      } else {
        pi.appendEntry("btw-result", { status: "done", prompt, reply } as any);
      }
    },
  };

  // /btw 命令：一站式委派受限子智能体，结果回填主会话
  pi.registerCommand("btw", {
    description:
      "委托受限子智能体执行并回填结果：/btw <prompt>（独立子进程、不落盘，多次调用沿用同一上下文）",
    handler: async (args: string, ctx: any) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("[wj-btw] 仅支持 TUI 模式", "warning");
        return;
      }
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("用法：/btw <prompt> — 委托子智能体执行，结果将输出到主会话", "warning");
        return;
      }
      await runOneTask(ctx, prompt);
    },
  });

  // 捕获 TUI 引用：用一个空 widget（不占行）借工厂拿到 tui，供 requestRender 原地刷新卡片
  pi.on("session_start", (_ev: any, ctx: any) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("wj-btw-tui-ref", (tui: any) => {
      tuiRef = tui;
      return new Text("", 0, 0);
    });
  });

  // 清理：主进程退出/迁移时 kill 存活的 btw 子进程，避免僵尸进程
  pi.on("session_shutdown", () => {
    destroyChild();
  });
}
