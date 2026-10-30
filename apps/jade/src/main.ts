#!/usr/bin/env -S bun --no-env-file
// jade：基于 uncarved 内核的编程 Agent 命令行宿主。
//
// 宿主负责内核不管的事：配置目录、会话索引、项目层插件的确认、审批界面、渲染、中断。
// 不读当前目录的 .env（见 config.ts）：模型配置放在 $JADE_HOME/.env。
// 交互运行时用终端界面（ui/tui.tsx），-p 和非交互运行时逐行输出（ui/screen.ts）。

import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlLogStore, JsonlTrustStore } from "@uncarved/store-jsonl";
import {
  loadProjectPlugin,
  readAll,
  Runtime,
  UntrustedPlugin,
  type Block,
  type LogEvent,
  type EventDataMap,
  type PendingCall,
  type Plugin,
  type TurnEndReason,
  type Usage,
  type UserInput,
} from "uncarved";
import { hasProvider, loadEnvFile, updateEnvFile } from "./config.ts";
import { createJade } from "./distro.ts";
import { MODES, POLICY_KEY, type Mode, type PolicySettings } from "./plugins/policy.ts";
import { listModels, providerFromEnv, providerInfo, switchable, withRetry, type ProviderKind } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { UNDO_KEY, type UndoState } from "./tools/checkpoint.ts";
import { display } from "./tools/fs.ts";
import type { ShellProgress } from "./tools/shell.ts";
import type { TaskProgress } from "./tools/task.ts";
import { renderTodos, type Todo } from "./tools/todo.ts";
import { bold, cyan, dim, green, plainScreen, red, yellow, type CommandInfo, type Screen } from "./ui/screen.ts";
import { tuiScreen } from "./ui/tui.tsx";

const HELP = `Usage: jade [options] [prompt]

  -p, --print <prompt>   run one prompt and exit
  -c, --continue         continue the most recent session in this directory
  -r, --resume <id>      resume a session by id
  -m, --mode <mode>      permission mode: ${MODES.join(" | ")} (default ask)
      --cwd <dir>        working directory (default: current directory)
  -h, --help

Type / in the session for commands; /model configures the model.
Model settings are read from $JADE_HOME/.env, and data lives in $JADE_HOME (default ~/.jade).
Instructions are read from AGENTS.md (or CLAUDE.md) in $JADE_HOME and from the repository root down to the working directory.`;

/** 会话里的命令：/help、输入 / 时的菜单都从这里取 */
const COMMANDS: CommandInfo[] = [
  { name: "help", about: "list the commands and keys" },
  { name: "model", args: "[name]", about: "switch the model, or configure the provider, API key and output limit" },
  { name: "mode", args: `[${MODES.join("|")}]`, about: "show or change the permission mode" },
  { name: "clear", about: "start a new session (the current one stays resumable)" },
  { name: "compact", about: "compact the history before the next request" },
  { name: "undo", about: "restore the file changed by the agent's most recent write_file/edit_file" },
  { name: "retry", about: "request the model again after a failed request, without sending another message" },
  { name: "usage", about: "token usage of this session, including sub-agents and compaction" },
  { name: "sessions", about: "recent sessions in this directory" },
  { name: "rules", about: `"always allow" rules of this session` },
  { name: "hooks", about: "execution order of every extension point" },
  { name: "exit", about: "quit (the session stays resumable)" },
];
/** 运行中也立即执行的命令（不碰运行时，或者只读） */
const INSTANT = new Set(["help", "model", "usage", "sessions", "rules", "hooks", "exit", "quit"]);

const KEYS = `Keys: enter send · \\ or alt+enter new line · ↑↓ history · esc interrupt · ctrl+c twice to exit
      mouse wheel or PgUp/PgDn scroll the conversation · ctrl+home/ctrl+end jump to the top/bottom · shift+drag selects text
While jade is working you can keep typing: messages are queued and sent when the current turn ends.`;

const VERSION: string = (await Bun.file(new URL("../package.json", import.meta.url)).json()).version;

/** 回复被输出上限截断后，自动让模型接着做的次数（每条用户消息） */
const MAX_CONTINUES = 3;
const CONTINUE_NOTE =
  "Your previous reply was cut off because it reached the output token limit. Continue from where you stopped. " +
  "If you were writing a large file or edit, split it into several smaller write_file/edit_file calls.";

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const opts: { print?: string; cont?: boolean; resume?: string; mode?: Mode; cwd?: string; prompt: string[] } = { prompt: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const value = () => {
    const v = argv[++i];
    if (v === undefined) fail(`${a} needs a value`);
    return v;
  };
  if (a === "-h" || a === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (a === "-p" || a === "--print") opts.print = value();
  else if (a === "-c" || a === "--continue") opts.cont = true;
  else if (a === "-r" || a === "--resume") opts.resume = value();
  else if (a === "-m" || a === "--mode") {
    const m = value();
    if (!(MODES as readonly string[]).includes(m)) fail(`unknown mode ${m}`);
    opts.mode = m as Mode;
  } else if (a === "--cwd") opts.cwd = value();
  else if (a.startsWith("-")) fail(`unknown option ${a}`);
  else opts.prompt.push(a);
}

function fail(msg: string): never {
  console.error(`jade: ${msg}\n\n${HELP}`);
  process.exit(2);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 家目录下的路径显示成 ~/… */
function shortPath(p: string): string {
  const rel = path.relative(os.homedir(), p);
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : rel === "" ? "~" : p;
  return shown.split(path.sep).join("/");
}

async function gitBranch(dir: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------- 配置与界面 ----------

const cwd = path.resolve(opts.cwd ?? process.cwd());
if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) fail(`${cwd} is not a directory`);
const home = process.env.JADE_HOME ?? path.join(os.homedir(), ".jade");
const envFile = path.join(home, ".env");
await loadEnvFile(envFile);

const tui = Boolean(process.stdin.isTTY && process.stdout.isTTY) && opts.print === undefined;
if (!hasProvider() && !tui) {
  console.error(
    `jade: no model is configured.\n\n` +
      `Run jade in a terminal and use /model, or put one of these in ${envFile} (or set them in the shell):\n` +
      `  OPENAI_COMPAT_BASE_URL=…  OPENAI_COMPAT_API_KEY=…  OPENAI_COMPAT_MODEL=…   (any /chat/completions service)\n` +
      `  OPENAI_API_KEY=…  [OPENAI_BASE_URL=…  OPENAI_MODEL=…]                     (OpenAI Responses API)\n` +
      `  ANTHROPIC_API_KEY=…  [ANTHROPIC_MODEL=…]                                  (Claude)`,
  );
  process.exit(2);
}

const compactTokens = process.env.JADE_COMPACT_TOKENS ? Number(process.env.JADE_COMPACT_TOKENS) : undefined;
// NaN 会让"是否超过阈值"永远为假，每次请求都压缩
if (compactTokens !== undefined && !(Number.isInteger(compactTokens) && compactTokens > 0)) {
  fail(`JADE_COMPACT_TOKENS must be a positive integer, got ${JSON.stringify(process.env.JADE_COMPACT_TOKENS)}`);
}
const contextLimit = compactTokens ?? 120_000;

const modelLabel = () => (hasProvider() ? providerInfo().model || "(no model)" : "(no model)");

// 界面在启动过程中就已经可以输入；启动完成前提交的内容先存着，完成后再处理
let ready = false;
const early: string[] = [];

const screen: Screen = tui
  ? tuiScreen({
      status: { cwd: shortPath(cwd), branch: await gitBranch(cwd), model: modelLabel(), mode: opts.mode ?? "ask" },
      version: VERSION,
      commands: COMMANDS,
      handlers: {
        submit: (text) => (ready ? onSubmit(text) : void early.push(text)),
        interrupt: () => ready && interrupt(),
        exit: () => (ready ? void quit() : process.exit(130)),
      },
    })
  : plainScreen({ interactive: Boolean(process.stdin.isTTY) });

/** 压缩、子 Agent 和主循环共用；/model 改配置后换掉里面的实现 */
const provider = switchable({
  id: "unconfigured",
  complete: () => Promise.reject(new Error("no model is configured; use /model")),
});

if (!hasProvider()) {
  screen.log(bold("Welcome to jade.") + " No model is configured yet; let's set one up.");
  if (!(await configureProvider())) {
    await screen.close();
    process.exit(2);
  }
} else {
  try {
    provider.set(retrying(providerFromEnv()));
  } catch (err) {
    await screen.close();
    fail(errorText(err));
  }
}

function retrying(inner: ReturnType<typeof providerFromEnv>) {
  return withRetry(inner, {
    onRetry: ({ attempt, delayMs, error }) => screen.log(yellow(`[retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}]`)),
  });
}

const store = new JsonlLogStore(path.join(home, "sessions"));
const trust = new JsonlTrustStore(path.join(home, "trust.jsonl"));
const index = new SessionIndex(path.join(home, "index.jsonl"));

const extraPlugins = await projectPlugins();
/** 每个会话用一套新的插件实例：插件里有按会话记的状态（例如压缩、重复调用的计数） */
const makeJade = (mode?: Mode) => createJade({ cwd, home, store, provider, mode, projectPlugins: extraPlugins, compactTokens });

let jade = await makeJade(opts.mode);
for (const w of jade.warnings) screen.log(yellow(`[warning] ${w}`));

/** .jade/plugins/<name>/index.ts：项目层插件，首次加载（及内容变化后）要用户确认（7.1） */
async function projectPlugins(): Promise<Plugin[]> {
  const root = path.join(cwd, ".jade", "plugins");
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
  const out: Plugin[] = [];
  for (const dir of dirs) {
    try {
      out.push(
        await loadProjectPlugin(dir, {
          trust,
          confirm: async ({ path: p, hash, files }) =>
            (await screen.select(
              `Project plugin ${display(cwd, p)} is new or changed. Load and run it?`,
              [
                { label: "No", value: false },
                { label: "Yes, load it", value: true },
              ],
              { body: dim(`sha256 ${hash.slice(0, 12)}, ${files.length} files:\n${files.map((f) => `  ${f}`).join("\n")}`) },
            )) ?? false,
        }),
      );
    } catch (err) {
      if (!(err instanceof UntrustedPlugin)) throw err;
      screen.log(yellow(`[skipped] ${err.message}`));
    }
  }
  return out;
}

let resumeId = opts.resume;
if (opts.cont) {
  resumeId = (await index.list(cwd))[0]?.id;
  if (!resumeId) {
    await screen.close();
    fail(`no session to continue in ${cwd}`);
  }
}

// /clear 换成新的运行时和会话
let rt = resumeId
  ? await Runtime.resume({ store, provider, plugins: jade.plugins, sessionId: resumeId })
  : await Runtime.create({ store, provider, plugins: jade.plugins });
let sessionId = rt.state.sessionId;

// 权限设置记在日志里（derived），关卡从那里读，恢复会话后仍然有效
const settings = () => jade.policy.settings(rt.state.derived);
const saveSettings = async (next: PolicySettings) => {
  await rt.record(POLICY_KEY, next);
  screen.status({ mode: next.mode });
};

// ---------- 渲染 ----------

const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const addUsage = (u?: Usage) => {
  for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u?.[k] ?? 0;
};
/** 一个事件带来的用量：模型回复、压缩时的总结调用；子 Agent 的用量在它自己的日志里 */
async function countUsage(e: LogEvent) {
  if (e.type === "model.responded") addUsage((e as LogEvent<"model.responded">).data.usage);
  else if (e.type === "jade/compact/compacted") addUsage((e.data as { usage?: Usage }).usage);
  else if (e.type === "tool.completed") {
    const child = (e as LogEvent<"tool.completed">).data.child;
    if (child) for (const c of await readAll(store, child.sessionId)) await countUsage(c);
  }
}

/** 上下文用量：最近一次回复的输入加输出，就是下一次请求的大致起点 */
function showContext(u: Usage | undefined) {
  if (u?.inputTokens === undefined) return;
  screen.status({ context: { used: u.inputTokens + (u.outputTokens ?? 0), limit: contextLimit } });
}

const toolNames = new Map<string, string>();
/** 正在重新显示恢复的会话里已有的内容：只输出，不显示进行中的状态 */
let replaying = false;
const activity = (label: string) => {
  if (!replaying) screen.busy(label);
};
/** 结果不用再显示的工具调用 */
const quiet = new Set<string>();
let streamed = false;
/** 本轮已经以 turn.ended（error/aborted）结束并显示过原因，随后抛出的同一个错误不再重复显示 */
let turnFailed = false;
/** 最近一轮的结束原因 */
let lastEnd: TurnEndReason | undefined;
/** 每个工具已经显示了多少行进度输出 */
const progressLines = new Map<string, number>();
const MAX_PROGRESS_LINES = 20;

function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "bash") return clip(String(i.command ?? "").split("\n")[0]!, 120);
  if (name === "task") return String(i.description ?? "");
  if (name === "bash_output" || name === "kill_shell") return String(i.id ?? "");
  if (name === "todo_write") return `${Array.isArray(i.todos) ? i.todos.length : 0} items`;
  const where = typeof i.path === "string" ? display(cwd, i.path) : "";
  if (name === "grep" || name === "glob") return `${i.pattern}${where && where !== "." ? ` in ${where}` : ""}`;
  return where || clip(JSON.stringify(input), 120);
}

rt.subscribe(onNotice);

function onNotice(n: Parameters<Parameters<Runtime["subscribe"]>[0]>[0]) {
  switch (n.type) {
    case "delta":
      if (n.delta.kind === "reset") {
        // 已经输出的内容收不回来，标记一下
        if (streamed) {
          screen.endStream();
          screen.log(yellow("[output above discarded; retrying]"));
        }
        streamed = false;
        return;
      }
      streamed = true;
      if (n.delta.kind === "thinking") {
        screen.busy("Thinking");
        screen.stream("thinking", n.delta.text);
      } else {
        screen.busy("Writing");
        screen.stream("text", n.delta.text);
      }
      return;
    case "hook-error":
      screen.log(yellow(`[hook error] ${n.info.plugin} at ${n.info.point}: ${errorText(n.info.error)}`));
      return;
    case "warning":
      screen.log(yellow(`[warning] ${n.code}`));
      return;
    case "awaiting":
      return;
    case "tool-progress":
      return renderProgress(n.toolUseId, n.update as ShellProgress | TaskProgress);
    case "event":
      return renderEvent(n.event);
  }
}

function renderProgress(toolUseId: string, p: ShellProgress | TaskProgress) {
  if (p.kind === "task-start") return screen.log(dim(`  ↳ sub-agent: ${p.description}`));
  if (p.kind === "task-tool") return screen.log(dim(`    ${p.decision === "deny" ? "✗" : "·"} ${p.name}(${summarize(p.name, p.input)})`));
  const shown = progressLines.get(toolUseId) ?? 0;
  if (shown > MAX_PROGRESS_LINES) return;
  const lines = p.text.replace(/\n$/, "").split("\n");
  const room = MAX_PROGRESS_LINES - shown;
  progressLines.set(toolUseId, shown + Math.min(lines.length, room + 1));
  for (const l of lines.slice(0, room)) screen.log(dim(`  │ ${clip(l, 200)}`));
  if (lines.length > room) screen.log(dim("  │ …"));
}

function renderEvent(e: LogEvent) {
  switch (e.type) {
    case "model.requested":
      activity("Waiting for the model");
      return;
    case "model.responded": {
      const d = e.data as EventDataMap["model.responded"];
      void countUsage(e);
      showContext(d.usage);
      for (const b of d.content) if (b.kind === "tool_use") toolNames.set(b.id, b.name);
      // 不支持流式的 provider：直接打印最终文本
      if (!streamed) {
        const text = textOf(d.content).trim();
        if (text) screen.log(text);
      }
      streamed = false;
      screen.endStream();
      return;
    }
    case "tool.decided": {
      const d = e.data as EventDataMap["tool.decided"];
      const name = toolNames.get(d.toolUseId) ?? "?";
      if (d.decision === "ask") return;
      const head = `${bold(name)}(${summarize(name, d.input)})`;
      if (d.decision === "deny") screen.log(red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""));
      else {
        activity(`Running ${name}`);
        if (name === "todo_write") {
          // 清单本身就是参数：直接显示，结果不再显示
          quiet.add(d.toolUseId);
          screen.log(cyan("● ") + bold("Todos"));
          screen.log(renderTodos((d.input as { todos?: Todo[] }).todos ?? []).replace(/^/gm, "  "));
        } else if (d.decidedBy !== "user" || replaying) {
          // 用户批准的调用在审批时已经显示过；重新显示历史时没有审批这一步
          screen.log(cyan("● ") + head);
        }
      }
      return;
    }
    case "tool.completed": {
      const d = e.data as EventDataMap["tool.completed"];
      void countUsage(e);
      activity("Working");
      if (quiet.delete(d.toolUseId) && !d.isError) return;
      const text = textOf(d.content).trim();
      const lines = text.split("\n");
      if (d.isError) screen.log(red(`  ⎿ ${lines.slice(0, 4).map((l) => clip(l, 200)).join("\n    ")}`));
      else screen.log(dim(`  ⎿ ${clip(lines[0] ?? "", 160)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`));
      return;
    }
    case "tool.interrupted":
      screen.log(yellow(`  ⎿ interrupted before finishing; not retried`));
      return;
    case "turn.ended": {
      const d = e.data as EventDataMap["turn.ended"];
      lastEnd = d.reason;
      turnFailed = d.reason === "error" || d.reason === "aborted";
      if (d.reason === "stopped") screen.log(yellow("[stopped: step budget for this turn used up; send a message to continue]"));
      else if (d.reason === "aborted") screen.log(yellow("[interrupted]"));
      else if (d.reason === "max_tokens") {
        const limit = process.env.JADE_MAX_TOKENS ? `${process.env.JADE_MAX_TOKENS} tokens` : "the provider's default";
        screen.log(yellow(`[reply cut off at the output limit (${limit}); raise it with /model if this keeps happening]`));
      } else if (d.reason !== "end") screen.log(yellow(`[turn ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}]`));
      if (turnFailed && !replaying && canRetry()) screen.log(dim("[send /retry to request again without adding a message]"));
      return;
    }
    case "jade/compact/compacted": {
      const d = e.data as { from: number; upTo: number; before: number };
      void countUsage(e);
      screen.log(dim(`[compacted ${d.upTo - d.from} messages, ~${d.before} tokens before]`));
      return;
    }
    case "jade/compact/trimmed": {
      const d = e.data as { saved: number };
      screen.log(dim(`[cleared old tool output, ~${d.saved} tokens]`));
      return;
    }
  }
}

// ---------- 审批 ----------

function preview(c: PendingCall): string {
  const i = (c.input ?? {}) as Record<string, string>;
  const lines = (s: string, mark: string, color: (s: string) => string, max = 30) => {
    const all = s.split("\n");
    const shown = all.slice(0, max).map((l) => color(`${mark} ${l}`));
    if (all.length > max) shown.push(dim(`  … ${all.length - max} more lines`));
    return shown.join("\n");
  };
  if (c.name === "edit_file") return `${lines(i.old_string ?? "", "-", red)}\n${lines(i.new_string ?? "", "+", green)}`;
  if (c.name === "write_file") return lines(i.content ?? "", "+", green, 20);
  if (c.name === "bash") return lines(i.command ?? "", "$", (s) => s);
  return dim(clip(JSON.stringify(c.input, null, 2), 2000));
}

async function approvePending() {
  while (rt.state.phase === "awaiting") {
    for (const c of rt.state.batch.filter((x) => x.decision === "ask")) {
      const head = `${c.name}(${summarize(c.name, c.input)})`;
      if (!screen.interactive) {
        screen.log(red(`✗ ${head} denied: not running interactively`));
        await rt.send({ kind: "approval", toolUseId: c.toolUseId, approved: false, reason: "The user is not available to approve this action." });
        continue;
      }
      const rule = jade.policy.ruleFor(c);
      const always = rule.prefix ? `always allow "${rule.prefix}…"` : `always allow ${rule.tool}`;
      const answer = await screen.select(
        `Allow ${head}?`,
        [
          { label: "Yes", value: "yes" as const },
          { label: `Yes, and ${always} in this session`, value: "always" as const },
          { label: "No, and tell jade what to do instead", value: "no" as const },
        ],
        { body: preview(c) },
      );
      if (answer === "always") {
        const s = settings();
        await saveSettings({ ...s, rules: [...s.rules, rule] });
      }
      const approved = answer === "yes" || answer === "always";
      const reason = approved
        ? undefined
        : (answer === "no" ? await screen.input("What should jade do instead? (optional)") : undefined) || "The user rejected this action.";
      screen.log(approved ? green(`✓ ${head}`) : red(`✗ ${head}`) + dim(reason ? ` — ${clip(reason, 200)}` : ""));
      await rt.send({ kind: "approval", toolUseId: c.toolUseId, approved, reason });
    }
  }
}

// ---------- 运行 ----------

/** 正在执行一轮对话（或一个需要独占运行时的命令） */
let running = false;

function interrupt() {
  if (!running) return;
  rt.abort("interrupted by user");
  screen.busy("Interrupting");
}

/** 离开会话但保留它：写入 session.detached，插件的收尾写入完成后再退出（4.2） */
async function leave() {
  jade.shutdown();
  try {
    await rt.detach();
  } catch (err) {
    screen.log(red(`[error] ${errorText(err)}`));
  }
}

/** 关掉界面后再提示怎么恢复：终端界面退出备用屏幕后，里面的内容就看不到了 */
async function closeScreen() {
  await screen.close();
  if (rt.state.messages.length > 0) console.log(dim(`Resume with: jade --resume ${sessionId}`));
}

let quitting = false;
async function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  if (running) rt.abort("exiting");
  // 中断后等这一轮收尾，再写 session.detached
  while (running) await new Promise((r) => setTimeout(r, 20));
  await leave();
  await closeScreen();
  process.exit(code);
}

/** /clear：离开当前会话（保持可恢复），换一套新的插件和运行时开始新会话，权限模式沿用 */
async function newSession() {
  const mode = settings().mode;
  await leave();
  jade = await makeJade(mode);
  rt = await Runtime.create({ store, provider, plugins: jade.plugins });
  rt.subscribe(onNotice);
  const old = sessionId;
  sessionId = rt.state.sessionId;
  for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] = 0;
  toolNames.clear();
  quiet.clear();
  progressLines.clear();
  notes.length = 0;
  lastEnd = undefined;
  screen.clear();
  screen.status({ session: sessionId, mode, context: undefined });
  screen.log(dim(`Started a new session. The previous one can be resumed with: jade --resume ${old}`));
}
process.on("SIGINT", () => (running ? interrupt() : void quit(130)));

async function guarded(fn: () => Promise<void>) {
  turnFailed = false;
  try {
    await fn();
    await approvePending();
  } catch (err) {
    if (!turnFailed) screen.log(red(`[error] ${errorText(err)}`));
  } finally {
    screen.endStream();
  }
}

/** 宿主替用户告诉模型的事（例如 /undo），随下一条消息发出 */
const notes: string[] = [];
const hostNote = (text: string): Block => ({ kind: "text", text: `[Note from jade] ${text}`, origin: { by: "host" }, trust: "trusted" });

async function say(text: string) {
  await index.add({ id: sessionId, cwd, title: clip(text.replace(/\s+/g, " "), 80), at: new Date().toISOString() });
  const content: Block[] = notes.splice(0).map(hostNote);
  content.push({ kind: "text", text, origin: { by: "user" }, trust: "trusted" });
  await drive({ kind: "message", content });
}

/** 上一轮在模型回复之前就失败了：最后一条消息还没有回复 */
const canRetry = () => rt.state.phase === "idle" && rt.state.messages.at(-1)?.role === "user";

async function retry() {
  if (!canRetry()) return screen.log(dim("Nothing to retry: the last message already has a reply."));
  await drive({ kind: "retry" });
}

async function drive(input: UserInput) {
  // 计时从这次输入开始，不接着上一条排队消息的
  screen.busy(undefined);
  screen.busy("Working");
  lastEnd = undefined;
  await guarded(() => rt.send(input));
  // 回复被输出上限截断：让模型接着做，而不是把半截任务丢给用户
  for (let i = 0; i < MAX_CONTINUES && lastEnd === "max_tokens"; i++) {
    screen.log(dim(`[asking the model to continue (${i + 1}/${MAX_CONTINUES})]`));
    lastEnd = undefined;
    await guarded(() => rt.send({ kind: "message", content: [hostNote(CONTINUE_NOTE)] }));
  }
}

/** 撤销本会话里还没撤销的最近一次文件写入 */
async function undo() {
  const undone = new Set((rt.state.derived[UNDO_KEY] as UndoState | undefined)?.undone ?? []);
  const cp = (await jade.checkpoints.list(sessionId)).find((c) => !undone.has(c.toolUseId));
  if (!cp) return screen.log(dim("Nothing to undo."));
  const shown = display(cwd, cp.path);
  if (!(await jade.checkpoints.unchangedSince(cp))) {
    const ok = await screen.select(`${shown} has changed since the agent wrote it. Undo anyway and discard those changes too?`, [
      { label: "No", value: false },
      { label: "Yes, undo anyway", value: true },
    ]);
    if (!ok) return;
  }
  await jade.checkpoints.restore(cp);
  await rt.record(UNDO_KEY, { undone: [...undone, cp.toolUseId] } satisfies UndoState);
  const what = cp.before === null ? `deleted ${shown} (the agent had created it)` : `restored ${shown} to its content before the agent's ${cp.tool}`;
  notes.push(`The user undid one of your changes: ${what}. Read the file again before changing it.`);
  screen.log(green(`Undid ${cp.tool}: ${what}.`));
}

/** 恢复的会话里已有的内容：终端界面里重新显示对话，逐行输出时只统计用量 */
async function replayHistory() {
  const events = await readAll(store, sessionId);
  if (!tui) {
    for (const e of events) {
      await countUsage(e);
      if (e.type === "model.responded") showContext((e as LogEvent<"model.responded">).data.usage);
    }
    return;
  }
  replaying = true;
  /** 等待用户审批的调用的参数，用户的决定记在之后的 input.received 里 */
  const asked = new Map<string, unknown>();
  try {
    for (const e of events) {
      if (e.type === "tool.decided") {
        const d = e.data as EventDataMap["tool.decided"];
        if (d.decision === "ask") asked.set(d.toolUseId, d.input);
      }
      if (e.type !== "input.received") {
        renderEvent(e);
        continue;
      }
      const d = e.data as EventDataMap["input.received"];
      if (d.kind === "approval") {
        const name = toolNames.get(d.toolUseId) ?? "?";
        const head = `${bold(name)}(${summarize(name, asked.get(d.toolUseId))})`;
        screen.log(d.approved ? green(`✓ ${head}`) : red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""));
        continue;
      }
      if (d.kind === "retry") {
        screen.log(dim("[retried]"));
        continue;
      }
      if (d.kind !== "message") continue;
      // 宿主附带的说明（例如自动续写）不是用户说的话
      const text = d.content.flatMap((b) => (b.kind === "text" && b.origin.by === "user" ? [b.text] : [])).join("\n");
      if (text) echo(text);
    }
  } finally {
    replaying = false;
  }
  screen.log(dim("─".repeat(20) + " resumed " + "─".repeat(20)));
}

/** 恢复会话：先显示之前的对话，处理插件变化（4.6），再继续日志里没做完的工作 */
async function resumeSession() {
  await replayHistory();
  const held = rt.state.held;
  if (held) {
    screen.log(yellow(`Plugins changed since this session was last used: ${held.plugins.map((p) => `${p.id}@${p.version}`).join(", ")}`));
    if (held.resolution === "abort") {
      screen.log(red("A plugin requires this session to stop. Restore the previous plugins to continue."));
      await screen.close();
      process.exit(1);
    }
    const ok =
      (await screen.select("Continue with the new plugins? Pending tool calls will be re-checked.", [
        { label: "Yes, continue", value: true },
        { label: "No, quit", value: false },
      ])) ?? false;
    await guarded(() => rt.send({ kind: "plugins", approved: ok }));
    if (!ok) {
      await screen.close();
      process.exit(1);
    }
  }
  running = true;
  try {
    await guarded(() => rt.recover());
  } finally {
    running = false;
    screen.busy(undefined);
  }
  // 命令行明确给了 --mode 时覆盖日志里的设置
  if (opts.mode && opts.mode !== settings().mode) await saveSettings({ ...settings(), mode: opts.mode });
  screen.log(dim(`Resumed ${sessionId} (${rt.state.messages.length} messages, mode ${settings().mode})`));
}

// ---------- 模型配置 ----------

const PROVIDERS: Array<{ kind: ProviderKind; label: string; hint: string }> = [
  { kind: "openai-compat", label: "OpenAI-compatible service", hint: "any /chat/completions endpoint" },
  { kind: "openai", label: "OpenAI", hint: "Responses API" },
  { kind: "anthropic", label: "Anthropic", hint: "Claude" },
];

const MODEL_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_MODEL", openai: "OPENAI_MODEL", anthropic: "ANTHROPIC_MODEL" };
const KEY_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const URL_KEY: Record<ProviderKind, string> = { "openai-compat": "OPENAI_COMPAT_BASE_URL", openai: "OPENAI_BASE_URL", anthropic: "ANTHROPIC_BASE_URL" };

/** 保存配置并换上新的 provider；失败时报告原因，旧的 provider 继续用 */
async function applyConfig(updates: Record<string, string | undefined>): Promise<boolean> {
  await updateEnvFile(envFile, updates);
  try {
    provider.set(retrying(providerFromEnv()));
  } catch (err) {
    screen.log(red(`Saved to ${shortPath(envFile)}, but the configuration is incomplete: ${errorText(err)}`));
    return false;
  }
  const info = providerInfo();
  screen.status({ model: modelLabel() });
  screen.log(green(`Model: ${info.model} (${info.kind}${info.baseURL ? `, ${info.baseURL}` : ""}). Saved to ${shortPath(envFile)}.`));
  return true;
}

/** 选模型：服务能列出模型时从列表里选，否则手动输入 */
async function chooseModel(env: Record<string, string | undefined>, current: string | undefined): Promise<string | undefined> {
  const models = await listModels(env);
  if (models.length > 0) {
    const OTHER = "\0other";
    const picked = await screen.select(
      "Choose a model",
      [
        ...models.map((m) => ({ label: m, value: m, hint: m === current ? "current" : undefined })),
        { label: "Enter a name…", value: OTHER },
      ],
    );
    if (picked !== OTHER) return picked;
  }
  return (await screen.input("Model name", { initial: current })) || undefined;
}

/** 选服务、填地址和密钥、选模型；返回是否配置成功 */
async function configureProvider(): Promise<boolean> {
  const current = hasProvider() ? providerInfo() : undefined;
  const kind = await screen.select(
    "Which service should jade use?",
    PROVIDERS.map((p) => ({ label: p.label, value: p.kind, hint: p.kind === current?.kind ? `${p.hint} · current` : p.hint })),
  );
  if (!kind) return false;
  const same = kind === current?.kind;

  let baseURL: string | undefined = process.env[URL_KEY[kind]];
  if (kind !== "anthropic") {
    const fallback = kind === "openai" ? "https://api.openai.com/v1" : "";
    const answer = await screen.input("Base URL", { initial: baseURL ?? fallback, placeholder: "https://example.com/v1" });
    if (answer === undefined) return false;
    if (kind === "openai-compat" && !answer) {
      screen.log(red("A base URL is required."));
      return false;
    }
    baseURL = answer || undefined;
  }

  const hasKey = Boolean(process.env[KEY_KEY[kind]]);
  const key = await screen.input("API key", { mask: true, placeholder: hasKey ? "leave empty to keep the current key" : "" });
  if (key === undefined) return false;

  const env = { ...process.env, JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL, ...(key ? { [KEY_KEY[kind]]: key } : {}) };
  const model = await chooseModel(env, same ? current?.model : undefined);
  if (!model) return false;

  const updates: Record<string, string | undefined> = { JADE_PROVIDER: kind, [URL_KEY[kind]]: baseURL, [MODEL_KEY[kind]]: model };
  if (key) updates[KEY_KEY[kind]] = key;
  // 其他服务常常默认只给 4096 个输出 token，带思考的模型很容易用完
  if (kind !== "anthropic" && !process.env.JADE_MAX_TOKENS) {
    const max = await screen.input("Output limit per reply in tokens (empty for the service default)", { initial: "32000" });
    if (max) updates.JADE_MAX_TOKENS = max;
  }
  return applyConfig(updates);
}

async function configureModel(arg: string | undefined) {
  const info = providerInfo();
  if (arg) return void (await applyConfig({ [MODEL_KEY[info.kind]]: arg }));
  const action = await screen.select(`Model: ${info.model} (${info.kind})`, [
    { label: "Switch model", value: "model" as const, hint: `current: ${info.model}` },
    { label: "Change service, base URL or API key", value: "provider" as const, hint: info.baseURL },
    { label: "Output limit per reply", value: "max" as const, hint: process.env.JADE_MAX_TOKENS ? `${process.env.JADE_MAX_TOKENS} tokens` : "service default" },
  ]);
  if (action === "model") {
    const model = await chooseModel(process.env, info.model);
    if (model) await applyConfig({ [MODEL_KEY[info.kind]]: model });
  } else if (action === "provider") await configureProvider();
  else if (action === "max") {
    const max = await screen.input("Output limit per reply in tokens (empty for the service default)", { initial: process.env.JADE_MAX_TOKENS ?? "32000" });
    if (max !== undefined) await applyConfig({ JADE_MAX_TOKENS: max || undefined });
  }
}

// ---------- 命令 ----------

const COMMAND_WIDTH = Math.max(...COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length)) + 2;

/** 执行命令；返回 false 表示退出 */
async function command(input: string): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case "help":
      screen.log(COMMANDS.map((c) => `${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(COMMAND_WIDTH)}${dim(c.about)}`).join("\n"));
      screen.log(dim(KEYS));
      break;
    case "model":
      await configureModel(rest[0]);
      break;
    case "mode": {
      let m = rest[0];
      if (!m) {
        m = await screen.select(
          "Permission mode",
          MODES.map((x) => ({ label: x, value: x, hint: x === settings().mode ? "current" : MODE_HINTS[x] })),
        );
        if (!m) break;
      }
      if (!(MODES as readonly string[]).includes(m)) screen.log(red(`unknown mode ${m}`));
      else await saveSettings({ ...settings(), mode: m as Mode });
      screen.log(`mode: ${settings().mode}`);
      break;
    }
    case "undo":
      await undo();
      break;
    case "retry":
      await retry();
      break;
    case "clear":
      await newSession();
      break;
    case "compact":
      jade.compact.request();
      screen.log(dim("History will be compacted before the next request."));
      break;
    case "sessions":
      for (const s of (await index.list(cwd)).slice(0, 15)) {
        screen.log(`${s.id === sessionId ? "*" : " "} ${s.id}  ${dim(s.at.slice(0, 16))}  ${s.title}`);
      }
      screen.log(dim("Resume one with: jade --resume <id>"));
      break;
    case "hooks":
      for (const p of ["context.project", "context.build", "model.before", "model.after", "tool.before", "tool.gate", "tool.after", "turn.continue", "event", "session.start", "session.end"]) {
        screen.log(`${p.padEnd(16)} ${rt.hookOrder(p).join(" → ") || dim("(none)")}`);
      }
      break;
    case "rules":
      screen.log(settings().rules.length ? settings().rules.map((r) => `${r.tool}${r.prefix ? ` "${r.prefix}…"` : ""}`).join("\n") : dim("(none)"));
      break;
    case "usage":
      screen.log(`input ${usage.inputTokens}  output ${usage.outputTokens}  cache read ${usage.cacheReadTokens}  cache write ${usage.cacheWriteTokens}`);
      break;
    case "exit":
    case "quit":
      return false;
    default:
      screen.log(red(`unknown command /${cmd}; type / to see the commands`));
  }
  return true;
}

const MODE_HINTS: Record<string, string> = {
  ask: "ask before edits and commands",
  "auto-edit": "edit files without asking; ask before commands",
  yolo: "never ask",
  readonly: "read only, no edits or commands",
};

// ---------- 输入 ----------

/** 等待执行的输入：运行中提交的消息和需要独占运行时的命令排在这里，按顺序执行 */
const queue: string[] = [];

/** 把用户的输入回显到输出里 */
const echo = (text: string) => screen.log(text.startsWith("/") ? cyan(`› ${text}`) : `\n${bold(`› ${text.replace(/\n/g, "\n  ")}`)}`);

function onSubmit(text: string) {
  const name = text.startsWith("/") ? text.slice(1).split(/\s+/)[0]! : undefined;
  if (name !== undefined && INSTANT.has(name)) {
    // 只读命令和 /model 不碰运行时状态，运行中也直接执行
    echo(text);
    if (name === "exit" || name === "quit") return void quit();
    return void command(text).catch((err) => screen.log(red(`[error] ${errorText(err)}`)));
  }
  queue.push(text);
  if (running) screen.queued(queue);
  void pump();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const text = queue.shift()!;
      screen.queued(queue);
      echo(text);
      if (text.startsWith("/")) {
        try {
          if (!(await command(text))) {
            running = false;
            return void quit();
          }
        } catch (err) {
          screen.log(red(`[error] ${errorText(err)}`));
        }
      } else await say(text);
    }
  } finally {
    running = false;
    screen.busy(undefined);
  }
}

// ---------- 开始 ----------

if (resumeId) await resumeSession();
else if (tui) screen.log(dim("Type / for commands, /model to configure the model, esc to interrupt."));
else screen.log(dim(`jade · ${shortPath(cwd)} · ${modelLabel()} · mode ${settings().mode} · session ${sessionId}`));
screen.status({ mode: settings().mode, session: sessionId });

const first = opts.print ?? (opts.prompt.length > 0 ? opts.prompt.join(" ") : undefined);
if (tui) {
  // 之后由输入框驱动：onSubmit → pump
  ready = true;
  for (const text of [...(first ? [first] : []), ...early.splice(0)]) onSubmit(text);
} else {
  if (first) {
    running = true;
    await say(first);
    running = false;
  }
  await leave();
  await closeScreen();
}
