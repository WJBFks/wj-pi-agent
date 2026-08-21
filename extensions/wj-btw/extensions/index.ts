/**
 * WJ BTW — 顺带一提（by the way）——一次性受限子智能体委托（pi 扩展）
 *
 * 架构（受限子进程后端 + 结果回填主会话）：
 *  - 后端 = 独立受限 pi 子进程：`pi --mode rpc --no-session -t <工具白名单>`
 *    自带完整 pi、独立对话上下文、按白名单受限工具；`--no-session` 保证不落盘
 *  - 用法：`/btw [prompt]` → 把 [prompt] 交给子智能体执行，
 *    **跑完后直接把回答回填到主进程**。
 *
 * 展示（底部固定 → 关闭时迁入主对话，2026-08-20 重构）：
 *  - `/btw` 后，结果以 `ctx.ui.setWidget("wj-btw-dock", …, {placement:"aboveEditor"})`
 *    渲染在**输入框上方的 dock 区** —— 属于底部 dock、不随对话滚动，始终固定在视口最下方；
 *    「处理中…」→「结果」为同一 widget 的两次更新（setWidget 覆盖渲染），完整显示不截断。
 *  - **同一结果不同时两处出现**：结果先只在底部固定窗口；直到你开始新的正常交互——
 *    输入框提交普通 prompt（`on("input")`，source="interactive"）或执行 `!bash / !!bash`
 *    （`on("user_bash")`）时，先把该结果 `pi.appendEntry("btw-result", …)` 迁入主对话
 *    随对话滚动（可展开/回溯），再移除底部窗口。连续 `/btw` 追问会先把上一个未迁移结果
 *    迁入主对话，避免被新任务覆盖丢失；结果在途时关闭窗口则不复活、直接落主对话。
 *  - `/btw` 命令本身走扩展命令分支、不触发 input 事件，不会误关。
 *  - 会话贯穿：多次 `/btw` 沿用同一子进程上下文可连续追问；子进程随主进程退出而销毁。
 *
 * 配置：项目级 `.pi/wj/btw/settings.json`（WJ_BTW_SETTINGS 环境变量可覆盖）。
 * 字段 `tools`/`skills` 白名单；空白名单 = 纯 LLM 聊天。
 * 白名单校验：忽略 + 警告（未命中名字不阻断启动，仅提示）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  Box,
  type MarkdownTheme,
  type Component,
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { loadSettings, checkWhitelist } from "./settings.ts";

/** 底部固定窗口的 widget 键（输入框上方 dock 区，不随对话滚动） */
const WIDGET_KEY = "wj-btw-dock";

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
// 扩展 API 引用（供模块级函数回填会话流卡片）
let piRef: ExtensionAPI | null = null;
// 底部窗口是否已被用户关闭（提交普通 prompt / !bash）——结果晚到时不复活窗口
let dismissed = false;
// 当前“只为底部窗口”的最新结果（尚未迁移进主对话）；关闭固定窗口时迁入主对话随滚动
let pendingResult: { prompt: string; reply: string } | null = null;
// 底部固定窗口（dock widget）状态
let widgetActive = false; // 当前是否有底部窗口
let widgetSaved: { prompt: string; reply: string } | null = null; // 当前结果（折叠/展开纯跟随全局 toolOutputExpanded）

// ──────────────────────────────────────
// 后端启动 / 转发
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

/** 把当前底部结果迁移进主对话（会话流结果卡，随对话滚动）；无待迁移结果则无操作 */
function flushToConversation(): void {
  if (!pendingResult) return;
  piRef?.appendEntry("btw-result", {
    status: "done",
    prompt: pendingResult.prompt,
    reply: pendingResult.reply,
  } as any);
  pendingResult = null;
}

// ──────────────────────────────────────
// 底部固定窗口（widget）：输入框上方 dock 区，不随对话滚动
// ──────────────────────────────────────

/** 安全清除底部窗口（非 TUI 上下文静默忽略） */
function closeWidget(ctx: any): void {
  dismissed = true;
  widgetActive = false;
  widgetSaved = null;
  try {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  } catch {
    /* 非 TUI 模式或无 widget 能力时静默 */
  }
}

/** 以带背景的 Box 构建 widget 组件（复用结果卡片同款视觉；纯文本行，处理中/错误用） */
function buildWidgetBox(
  theme: any,
  lines: string[],
): Box {
  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

/** tool output 切换快捷键的动态文本（跟随用户实际 keybinding；读不到时兜底 ctrl+o，不硬编码） */
function toolToggleKey(): string {
  try {
    const t = keyText("app.tools.expand");
    return t || "ctrl+o";
  } catch {
    return "ctrl+o";
  }
}

/** 白色加粗的快捷键提示文本（跟随实际绑定） */
function keyHintBold(theme: any, key: string): string {
  return theme.bold(theme.fg("text", key));
}

/** 展开态末行提示：(<快捷键> to collapsed)，快捷键白色加粗 */
function toggleToCollapsedHint(theme: any): string {
  return (
    theme.fg("muted", "(") +
    keyHintBold(theme, toolToggleKey()) +
    theme.fg("muted", " to collapsed)")
  );
}

/** 基于传入 theme（运行时已初始化）构建 Markdown 主题，样式与普通对话一致 */
function makeMarkdownTheme(theme: any): MarkdownTheme {
  const fg = (c: string) => (t: string) => theme.fg(c as any, t);
  return {
    heading: fg("mdHeading"),
    link: fg("mdLink"),
    linkUrl: fg("mdLinkUrl"),
    code: fg("mdCode"),
    codeBlock: fg("mdCodeBlock"),
    codeBlockBorder: fg("mdCodeBlockBorder"),
    quote: fg("mdQuote"),
    quoteBorder: fg("mdQuoteBorder"),
    hr: fg("mdHr"),
    listBullet: fg("mdListBullet"),
    bold: (t: string) => theme.bold(t),
    italic: (t: string) => theme.italic(t),
    strikethrough: (t: string) => theme.strikethrough(t),
    underline: (t: string) => theme.underline(t),
  };
}

/** 以带背景 Box + Markdown 渲染结果（与普通对话一致：标题/代码块/加粗/列表等）
 *  需求：分隔线——→空行；[btw] 与 prompt 加粗；末行加 (快捷键 to collapsed) 提示（动态快捷键、白粗） */
function buildDoneBox(theme: any, prompt: string, reply: string): Box {
  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      theme.bold(theme.fg("accent", "[btw]")) +
        " " +
        theme.bold(theme.fg("text", prompt)),
      0,
      0,
    ),
  );
  box.addChild(new BlankLine()); // 问题与回复之间空行（Text 对空白返回 [] 会被 Box 跳过，须用自定义空行组件）
  box.addChild(
    new Markdown(reply || "(无回复)", 0, 0, makeMarkdownTheme(theme), {
      color: (text: string) => theme.fg("customMessageText", text),
    }),
  );
  box.addChild(new Text(toggleToCollapsedHint(theme), 0, 0)); // 展开末行提示
  return box;
}

/** 以带背景 Box + CollapsedBtw 渲染折叠态（问题最多 3 行 + 回复最后 5 行） */
function buildCollapsedBottom(theme: any, prompt: string, reply: string): Box {
  const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
  box.addChild(new CollapsedBtw(prompt, reply, theme));
  return box;
}

/** 统一渲染底部窗口：折叠/展开**纯跟随全局 toolOutputExpanded**（不监听 Ctrl+O、不改全局），
 *  用 FollowBtwWidget 每次 render(width) 读 getToolsExpanded() 决定折叠或展开。 */
function setBottomWidget(ctx: any, prompt: string, reply: string): void {
  widgetActive = true;
  widgetSaved = { prompt, reply };
  const readExpanded =
    typeof ctx.ui.getToolsExpanded === "function"
      ? () => !!ctx.ui.getToolsExpanded()
      : () => false; // 无可读全局时默认折叠
  try {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui: any, theme: any) => new FollowBtwWidget(theme, prompt, reply, readExpanded),
      { placement: "aboveEditor" },
    );
  } catch {
    /* 非 TUI 模式静默 */
  }
}

/** 「处理中…」状态 */
function showRunningWidget(ctx: any, prompt: string): void {
  dismissed = false;
  widgetActive = true;
  widgetSaved = null; // 结果未就绪，不可折叠
  try {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui: any, theme: any) =>
        buildWidgetBox(theme, [
          `${theme.fg("accent", "[btw]")} ${theme.fg("customMessageText", prompt)}`,
          theme.fg("dim", "（处理中...）"),
        ]),
      { placement: "aboveEditor" },
    );
  } catch {
    /* 非 TUI 模式静默 */
  }
}

/** 结果状态：按当前折叠态用 buildDoneBox(展开) 或 buildCollapsedBottom(折叠)，支持 Ctrl+O 切换 */
function showDoneWidget(ctx: any, prompt: string, reply: string): void {
  setBottomWidget(ctx, prompt, reply);
}

/** 错误状态 */
function showErrorWidget(ctx: any, message: string): void {
  try {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui: any, theme: any) =>
        buildWidgetBox(theme, [
          `${theme.fg("accent", "[btw]")} ${theme.fg("red", "执行出错")}`,
          theme.fg("dim", "────"),
          message,
        ]),
      { placement: "aboveEditor" },
    );
  } catch {
    /* 非 TUI 模式静默 */
  }
}

/**
 * 执行一次委托：把 prompt 交给子智能体，跑完后回填到主进程。
 * 子进程保留，便于 /btw 连续追问。
 */
async function runOneTask(ctx: any, prompt: string): Promise<void> {
  if (!ensureChild(ctx) || !child) return;
  // 迁移上一个尚未进入主对话的结果，避免被新一轮任务覆盖丢失
  flushToConversation();
  showRunningWidget(ctx, prompt);
  try {
    // 在发 prompt 前记录 messageCount 基线（用于本轮完成判定，避免误判到上一轮）
    const pre = await child.rpc.getState().catch(() => null);
    const base = (pre?.messageCount ?? 0) as number;
    await child.rpc.prompt(prompt);
    const reply = ((await child.rpc.waitTurn(base)) ?? "(无回复)") as string;
    // 结果先进入底部固定窗口；用户关闭窗口（下一次正常输入）时才迁移进主对话随滚动
    pendingResult = { prompt, reply };
    if (dismissed) {
      // 用户已开始正常交互（窗口已关闭）→ 结果直接迁入主对话，不再复活底部窗口
      flushToConversation();
    } else {
      showDoneWidget(ctx, prompt, reply);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`[wj-btw] 执行出错：${msg}`, "error");
    if (!dismissed) showErrorWidget(ctx, msg);
    destroyChild();
  }
}

// ──────────────────────────────────────
// 扩展入口
// ──────────────────────────────────────
export default function wjBtw(pi: ExtensionAPI): void {
  piRef = pi;

  // 渲染器：btw 结果卡（会话流持久记录，带背景像工具块；只展示，不进 LLM 上下文）。
  // 支持与工具块一致的 Ctrl+O 展开/折叠：CustomEntryComponent.setExpanded → rebuild →
  // 传 opts.expanded；折叠态=问题最多 3 行 + 回复最后 5 行（省略行数提示）；展开态=完整 Markdown。
  pi.registerEntryRenderer("btw-result", (entry: any, opts: any, theme: any) => {
    const d = (entry.data ?? {}) as { status?: string; prompt?: string; reply?: string };
    const prompt = d.prompt ?? "";
    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    if (d.status === "running") {
      // 历史「处理中」卡：两行（[btw] prompt + 单独一行（处理中...））
      box.addChild(
        new Text(
          `${theme.fg("accent", "[btw]")} ${theme.fg("customMessageText", prompt)}\n${theme.fg("dim", "（处理中...）")}`,
          0,
          0,
        ),
      );
    } else if (!opts?.expanded) {
      // 折叠态：问题最多 3 行 + 回复最后 5 行（按终端宽度精确截断）
      box.addChild(new CollapsedBtw(prompt, d.reply ?? "", theme));
    } else {
      // 展开态：复用 buildDoneBox（标题加粗 + 空行 + 完整 Markdown + 末行折叠提示）
      return buildDoneBox(theme, prompt, d.reply ?? "");
    }
    return box;
  });

  // /btw 命令：委托受限子智能体执行，结果回填主进程（底部固定窗口 + 会话流结果卡）
  pi.registerCommand("btw", {
    description:
      "委托受限子智能体执行并回填结果：/btw <prompt>（结果固定在底部窗口，直到你输入普通 prompt 或 !bash；多次调用沿用同一上下文）",
    handler: async (args: string, ctx: any) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("[wj-btw] 仅支持 TUI 模式", "warning");
        return;
      }
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("用法：/btw <prompt> — 委托子智能体执行，结果将固定显示在底部窗口", "warning");
        return;
      }
      await runOneTask(ctx, prompt);
    },
  });

  // 关闭底部固定窗口：用户在输入框提交普通 prompt 时，把底部结果迁入主对话（随对话滚动）再移除窗口。
  // /btw 命令走扩展命令分支、不触发 input 事件，因此不会误关。
  pi.on("input", (event: any, ctx: any) => {
    if (event.source === "interactive") {
      flushToConversation(); // 底部结果 → 主对话（同一结果，不重复）
      closeWidget(ctx);
    }
  });

  // 关闭底部固定窗口：用户执行 !bash / !!bash（开始正常交互），同样先迁入主对话再移除窗口。
  pi.on("user_bash", (_event: any, ctx: any) => {
    flushToConversation();
    closeWidget(ctx);
  });

  // 清理：主进程退出/迁移时 kill 存活的 btw 子进程，避免僵尸进程
  pi.on("session_shutdown", () => {
    widgetActive = false;
    // 底部固定窗口此刻将被销毁；把仍驻留底部、尚未迁移的结果迁入主会话（custom entry 随会话持久化），
    // 避免 reload / graceful shutdown(pi -c / SIGHUP / interrupt) 时 btw 结果直接丢失。
    flushToConversation();
    destroyChild();
  });
}

/**
 * 跟随全局 toolOutputExpanded 的底部 widget：
 * 每次 render(width) 读 getToolsExpanded() 决定折叠/展开——
 * **不监听 Ctrl+O、不改全局，纯跟随 "Tool output: collapsed/expanded" 状态**。
 * （Ctrl+O 由 editor 的 setToolsExpanded 处理 → showStatus/广播 → requestRender
 *   → TUI 全量重绘时本组件 render(width) 重跑，读到最新全局值。）
 */
class FollowBtwWidget implements Component {
  constructor(
    private theme: any,
    private prompt: string,
    private reply: string,
    private readExpanded: () => boolean,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return (this.readExpanded?.() ?? false)
      ? buildDoneBox(this.theme, this.prompt, this.reply).render(width)
      : buildCollapsedBottom(this.theme, this.prompt, this.reply).render(width);
  }
}

/**
 * 空行组件：render 返回 [""]（Text 对空白行返回 [] 会被 Box 跳过，故需要此类真正生成一行）。
 */
class BlankLine implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [""];
  }
}

/**
 * 折叠态组件：把 btw 结果（prompt + reply）按终端可见宽度精确截断成固定行数。
 *  - prompt（问题）：最多 3 行，超出则最后一行以省略号收尾
 *  - reply（回复）：最多显示最后 5 行；若被省略了若干行，先输出一行
 *    `... (N earlier lines, ctrl+o to expand)` 提示
 * 在 render(width) 阶段按实际宽度换行/截断，保证严格的行数与不超宽。
 */
class CollapsedBtw implements Component {
  constructor(
    private prompt: string,
    private reply: string,
    private theme: any,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const w = Math.max(width, 1);
    const T = this.theme; // 仅别名引用，不剥离方法 this：下面一律 T.fg(...) 方法调用
    const out: string[] = [];

    // ── 问题：最多 3 行，超出则省略号；[btw] 与 prompt 加粗 ──
    const LABEL = "[btw] ";
    const pw = Math.max(w - visibleWidth(LABEL), 1);
    const pLines = wrapTextWithAnsi(this.prompt, pw);
    const pShown = pLines.slice(0, 3);
    pShown.forEach((line, i) => {
      let body = line;
      if (i === pShown.length - 1 && pLines.length > pShown.length) {
        // 后面仍有被省略的行：强制在末尾追加省略号（truncateToWidth 保证不超宽并保留 …）
        body = truncateToWidth(body + "…", pw, "…");
      }
      out.push(
        i === 0
          ? T.bold(T.fg("accent", LABEL)) + T.bold(T.fg("text", body))
          : T.fg("customMessageText", body),
      );
    });

    // 分隔线替换为空行
    out.push("");

    // ── 回复：最多显示最后 5 行，省略行数用提示行标注（快捷键动态+白粗） ──
    const rMax = 5;
    const rw = Math.max(w, 1); // 问题/回复都顶格（Box 外框内边距已由 Box 处理）
    const rLines = wrapTextWithAnsi(this.reply, rw);
    const rShown = rLines.slice(-rMax);
    const earlier = rLines.length - rShown.length;
    if (earlier > 0) {
      out.push(
        T.fg("muted", `... (${earlier} earlier lines, `) +
          keyHintBold(T, toolToggleKey()) +
          T.fg("muted", ` to expand)`),
      );
    }
    for (const line of rShown) {
      out.push(T.fg("customMessageText", line)); // 无缩进，与问题/提示对齐
    }
    return out;
  }
}