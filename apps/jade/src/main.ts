#!/usr/bin/env -S bun --no-env-file
// jade：基于 uncarved 内核的编程 Agent 命令行宿主。
//
// 宿主负责内核不管的事：配置目录、会话索引、项目层插件的确认、审批界面、渲染、中断。
// 不读当前目录的 .env（见 config.ts）：模型配置放在 $JADE_HOME/.env。

import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
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
  type Usage,
} from "uncarved";
import { hasProvider, loadEnvFile } from "./config.ts";
import { createJade } from "./distro.ts";
import { MODES, POLICY_KEY, type Mode, type PolicySettings } from "./plugins/policy.ts";
import { providerFromEnv, withRetry } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { UNDO_KEY, type UndoState } from "./tools/checkpoint.ts";
import { display } from "./tools/fs.ts";
import type { ShellProgress } from "./tools/shell.ts";
import type { TaskProgress } from "./tools/task.ts";
import { renderTodos, type Todo } from "./tools/todo.ts";

const HELP = `Usage: jade [options] [prompt]

  -p, --print <prompt>   run one prompt and exit
  -c, --continue         continue the most recent session in this directory
  -r, --resume <id>      resume a session by id
  -m, --mode <mode>      permission mode: ${MODES.join(" | ")} (default ask)
      --cwd <dir>        working directory (default: current directory)
  -h, --help

Commands in the session: /help /mode /compact /undo /sessions /hooks /rules /usage /exit
Model settings are read from $JADE_HOME/.env, and data lives in $JADE_HOME (default ~/.jade).
Instructions are read from AGENTS.md (or CLAUDE.md) in $JADE_HOME and from the repository root down to the working directory.`;

/** 会话里的命令：/help 的说明、输入 / 时的提示和 Tab 补全都从这里取 */
const COMMANDS: Array<{ name: string; args?: string; about: string }> = [
  { name: "help", about: "list the commands" },
  { name: "mode", args: `[${MODES.join("|")}]`, about: "show or change the permission mode" },
  { name: "compact", about: "compact the history before the next request" },
  { name: "undo", about: "restore the file changed by the agent's most recent write_file/edit_file" },
  { name: "sessions", about: "recent sessions in this directory" },
  { name: "hooks", about: "execution order of every extension point" },
  { name: "rules", about: `"always allow" rules of this session` },
  { name: "usage", about: "token usage of this session, including sub-agents and compaction" },
  { name: "exit", about: "quit (the session stays resumable)" },
];
const usageOf = (c: (typeof COMMANDS)[number]) => `/${c.name}${c.args ? ` ${c.args}` : ""}`;
const COMMAND_WIDTH = Math.max(...COMMANDS.map((c) => usageOf(c).length)) + 2;

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

// ---------- 输出 ----------

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");
const bold = paint("1");

let atLineStart = true;
function write(s: string) {
  if (!s) return;
  process.stdout.write(s);
  atLineStart = s.endsWith("\n");
}
function line(s = "") {
  if (!atLineStart) write("\n");
  write(s + "\n");
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");

// ---------- 组装 ----------

const cwd = path.resolve(opts.cwd ?? process.cwd());
if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) fail(`${cwd} is not a directory`);
const home = process.env.JADE_HOME ?? path.join(os.homedir(), ".jade");
const envFile = path.join(home, ".env");
await loadEnvFile(envFile);
if (!hasProvider()) {
  console.error(
    `jade: no model is configured.\n\n` +
      `Put one of these in ${envFile} (or set them in the shell):\n` +
      `  OPENAI_COMPAT_BASE_URL=…  OPENAI_COMPAT_API_KEY=…  OPENAI_COMPAT_MODEL=…   (any /chat/completions service)\n` +
      `  OPENAI_API_KEY=…  [OPENAI_BASE_URL=…  OPENAI_MODEL=…]                     (OpenAI Responses API)\n` +
      `  ANTHROPIC_API_KEY=…  [ANTHROPIC_MODEL=…]                                  (Claude)`,
  );
  process.exit(2);
}
const store = new JsonlLogStore(path.join(home, "sessions"));
const trust = new JsonlTrustStore(path.join(home, "trust.jsonl"));
const index = new SessionIndex(path.join(home, "index.jsonl"));
const interactive = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive, completer: complete });
const ask = async (q: string) => (interactive ? (await rl.question(q)).trim() : "");

/** Tab 补全：命令名，以及 /mode 的参数 */
function complete(input: string): [string[], string] {
  if (!atPrompt || !input.startsWith("/")) return [[], input];
  const mode = /^\/mode\s+(\S*)$/.exec(input);
  if (mode) return [MODES.filter((m) => m.startsWith(mode[1]!)).map((m) => `/mode ${m}`), input];
  if (/\s/.test(input)) return [[], input];
  return [COMMANDS.filter((c) => `/${c.name}`.startsWith(input)).map((c) => `/${c.name}`), input];
}

// 输入以 / 开头时，在输入行下方列出匹配的命令。
// readline 先处理按键（重绘时会清掉光标以下的内容），这里随后重画；画完把光标移回输入位置。
/** 正在等待主输入（不是审批之类的提问） */
let atPrompt = false;
/** 输入行下方当前显示了几行提示 */
let hinted = 0;
if (interactive && process.stdout.isTTY) {
  process.stdin.on("keypress", (_ch, key: { name?: string } | undefined) => {
    if (!atPrompt) return;
    // 回车后 readline 已经换行，光标就在原来提示所在的位置
    if (key?.name === "return" || key?.name === "enter") {
      if (hinted) process.stdout.write("\x1b[J");
      hinted = 0;
      return;
    }
    const input = rl.line;
    const matches = input.startsWith("/") && !/\s/.test(input) ? COMMANDS.filter((c) => `/${c.name}`.startsWith(input)) : [];
    if (!matches.length && !hinted) return;
    const col = rl.getCursorPos().cols;
    const rows = matches.map((c) => `\x1b[K${dim(`${usageOf(c).padEnd(COMMAND_WIDTH)}${c.about}`)}`);
    if (rows.length) process.stdout.write(`\r\n${rows.join("\r\n")}\x1b[J\x1b[${rows.length}A\x1b[${col + 1}G`);
    else process.stdout.write(`\x1b[1B\r\x1b[J\x1b[1A\x1b[${col + 1}G`);
    hinted = rows.length;
  });
}

const provider = withRetry(providerFromEnv(), {
  onRetry: ({ attempt, delayMs, error }) => line(yellow(`[retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}]`)),
});

const compactTokens = process.env.JADE_COMPACT_TOKENS ? Number(process.env.JADE_COMPACT_TOKENS) : undefined;
// NaN 会让"是否超过阈值"永远为假，每次请求都压缩
if (compactTokens !== undefined && !(Number.isInteger(compactTokens) && compactTokens > 0)) {
  fail(`JADE_COMPACT_TOKENS must be a positive integer, got ${JSON.stringify(process.env.JADE_COMPACT_TOKENS)}`);
}

const jade = await createJade({
  cwd,
  home,
  store,
  provider,
  mode: opts.mode,
  projectPlugins: await projectPlugins(),
  compactTokens,
});

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
          confirm: async ({ path: p, hash, files }) => {
            line(yellow(`Project plugin ${display(cwd, p)} is new or changed (${files.length} files, sha256 ${hash.slice(0, 12)}).`));
            line(dim(files.map((f) => `  ${f}`).join("\n")));
            return /^y/i.test(await ask("Load and run it? [y/N] "));
          },
        }),
      );
    } catch (err) {
      if (!(err instanceof UntrustedPlugin)) throw err;
      line(yellow(`[skipped] ${err.message}`));
    }
  }
  return out;
}

let resumeId = opts.resume;
if (opts.cont) {
  resumeId = (await index.list(cwd))[0]?.id;
  if (!resumeId) fail(`no session to continue in ${cwd}`);
}

const rt = resumeId
  ? await Runtime.resume({ store, provider, plugins: jade.plugins, sessionId: resumeId })
  : await Runtime.create({ store, provider, plugins: jade.plugins });
const sessionId = rt.state.sessionId;

// 权限设置记在日志里（derived），关卡从那里读，恢复会话后仍然有效
const settings = () => jade.policy.settings(rt.state.derived);
const saveSettings = (next: PolicySettings) => rt.record(POLICY_KEY, next);

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
if (resumeId) for (const e of await readAll(store, sessionId)) await countUsage(e);

const toolNames = new Map<string, string>();
/** 结果不用再显示的工具调用 */
const quiet = new Set<string>();
let streamed = false;
let thinking = false;
/** 思考刚结束，正文还没输出过非换行内容 */
let afterThinking = false;
/** 本轮已经以 turn.ended（error/aborted）结束并显示过原因，随后抛出的同一个错误不再重复显示 */
let turnFailed = false;
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

rt.subscribe((n) => {
  switch (n.type) {
    case "delta":
      if (n.delta.kind === "reset") {
        // 终端里已经打印的内容擦不掉，标记一下
        if (streamed) line(yellow("[output above discarded; retrying]"));
        streamed = false;
        thinking = false;
        afterThinking = false;
        return;
      }
      streamed = true;
      if (n.delta.kind === "thinking") {
        if (!thinking) line(dim("thinking…"));
        thinking = true;
        write(dim(n.delta.text));
      } else {
        // 不少模型在思考之后以空行开头，去掉；整块都是换行时等下一块
        let text = n.delta.text;
        if (thinking || afterThinking) text = text.replace(/^\n+/, "");
        if (thinking) line();
        thinking = false;
        afterThinking = !text;
        write(text);
      }
      return;
    case "hook-error":
      line(yellow(`[hook error] ${n.info.plugin} at ${n.info.point}: ${n.info.error instanceof Error ? n.info.error.message : String(n.info.error)}`));
      return;
    case "warning":
      line(yellow(`[warning] ${n.code}`));
      return;
    case "awaiting":
      return;
    case "tool-progress":
      return renderProgress(n.toolUseId, n.update as ShellProgress | TaskProgress);
    case "event":
      return renderEvent(n.event);
  }
});

function renderProgress(toolUseId: string, p: ShellProgress | TaskProgress) {
  if (p.kind === "task-start") return line(dim(`  ↳ sub-agent: ${p.description}`));
  if (p.kind === "task-tool") return line(dim(`    ${p.decision === "deny" ? "✗" : "·"} ${p.name}(${summarize(p.name, p.input)})`));
  const shown = progressLines.get(toolUseId) ?? 0;
  if (shown > MAX_PROGRESS_LINES) return;
  const lines = p.text.replace(/\n$/, "").split("\n");
  const room = MAX_PROGRESS_LINES - shown;
  progressLines.set(toolUseId, shown + Math.min(lines.length, room + 1));
  for (const l of lines.slice(0, room)) line(dim(`  │ ${clip(l, 200)}`));
  if (lines.length > room) line(dim("  │ …"));
}

function renderEvent(e: LogEvent) {
  switch (e.type) {
    case "model.responded": {
      const d = e.data as EventDataMap["model.responded"];
      void countUsage(e);
      for (const b of d.content) if (b.kind === "tool_use") toolNames.set(b.id, b.name);
      // 不支持流式的 provider：直接打印最终文本
      if (!streamed) write(textOf(d.content));
      streamed = false;
      thinking = false;
      afterThinking = false;
      if (!atLineStart) write("\n");
      return;
    }
    case "tool.decided": {
      const d = e.data as EventDataMap["tool.decided"];
      const name = toolNames.get(d.toolUseId) ?? "?";
      if (d.decision === "ask") return;
      const head = `${bold(name)}(${summarize(name, d.input)})`;
      if (d.decision === "deny") line(red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""));
      else if (name === "todo_write") {
        // 清单本身就是参数：直接显示，结果不再显示
        quiet.add(d.toolUseId);
        line(cyan("● ") + bold("Todos"));
        line(renderTodos((d.input as { todos?: Todo[] }).todos ?? []).replace(/^/gm, "  "));
      } else if (d.decidedBy !== "user") line(cyan("● ") + head);
      return;
    }
    case "tool.completed": {
      const d = e.data as EventDataMap["tool.completed"];
      void countUsage(e);
      if (quiet.delete(d.toolUseId) && !d.isError) return;
      const text = textOf(d.content).trim();
      const lines = text.split("\n");
      if (d.isError) line(red(`  ⎿ ${lines.slice(0, 4).map((l) => clip(l, 200)).join("\n    ")}`));
      else line(dim(`  ⎿ ${clip(lines[0] ?? "", 160)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`));
      return;
    }
    case "tool.interrupted":
      line(yellow(`  ⎿ interrupted before finishing; not retried`));
      return;
    case "turn.ended": {
      const d = e.data as EventDataMap["turn.ended"];
      turnFailed = d.reason === "error" || d.reason === "aborted";
      if (d.reason === "stopped") line(yellow("[stopped: step budget for this turn used up; send a message to continue]"));
      else if (d.reason === "aborted") line(yellow("[interrupted]"));
      else if (d.reason !== "end") line(yellow(`[turn ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}]`));
      return;
    }
    case "jade/compact/compacted": {
      const d = e.data as { from: number; upTo: number; before: number };
      void countUsage(e);
      line(dim(`[compacted ${d.upTo - d.from} messages, ~${d.before} tokens before]`));
      return;
    }
    case "jade/compact/trimmed": {
      const d = e.data as { saved: number };
      line(dim(`[cleared old tool output, ~${d.saved} tokens]`));
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
      line(yellow(`? ${bold(c.name)}(${summarize(c.name, c.input)})`));
      line(preview(c));
      if (!interactive) {
        line(red("✗ denied: not running interactively"));
        await rt.send({ kind: "approval", toolUseId: c.toolUseId, approved: false, reason: "The user is not available to approve this action." });
        continue;
      }
      const rule = jade.policy.ruleFor(c);
      const always = rule.prefix ? `always allow "${rule.prefix}…"` : `always allow ${rule.tool}`;
      const a = (await ask(`Allow? [y]es / [n]o / [a] ${always} > `)).toLowerCase();
      if (a.startsWith("a")) {
        const s = settings();
        await saveSettings({ ...s, rules: [...s.rules, rule] });
      }
      const approved = a.startsWith("y") || a.startsWith("a");
      const reason = approved ? undefined : (await ask("Tell the agent what to do instead (optional): ")) || "The user rejected this action.";
      await rt.send({ kind: "approval", toolUseId: c.toolUseId, approved, reason });
    }
  }
}

// ---------- 运行 ----------

let running = false;
rl.on("SIGINT", () => {
  if (running) {
    rt.abort("interrupted by user");
    line(yellow("[interrupting…]"));
    return;
  }
  void leave().then(() => process.exit(130));
});

/** 离开会话但保留它：写入 session.detached，插件的收尾写入完成后再退出（4.2） */
async function leave() {
  jade.shutdown();
  try {
    await rt.detach();
  } catch (err) {
    line(red(`[error] ${err instanceof Error ? err.message : String(err)}`));
  }
  line(dim(`Resume with: jade --resume ${sessionId}`));
}

async function guarded(fn: () => Promise<void>) {
  running = true;
  turnFailed = false;
  try {
    await fn();
    await approvePending();
  } catch (err) {
    if (!turnFailed) line(red(`[error] ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    running = false;
  }
}

/** 宿主替用户告诉模型的事（例如 /undo），随下一条消息发出 */
const notes: string[] = [];

async function say(text: string) {
  await index.add({ id: sessionId, cwd, title: clip(text.replace(/\s+/g, " "), 80), at: new Date().toISOString() });
  const content: Block[] = notes.splice(0).map((n) => ({ kind: "text", text: `[Note from jade] ${n}`, origin: { by: "host" }, trust: "trusted" }));
  content.push({ kind: "text", text, origin: { by: "user" }, trust: "trusted" });
  await guarded(() => rt.send({ kind: "message", content }));
}

/** 撤销本会话里还没撤销的最近一次文件写入 */
async function undo() {
  const undone = new Set((rt.state.derived[UNDO_KEY] as UndoState | undefined)?.undone ?? []);
  const cp = (await jade.checkpoints.list(sessionId)).find((c) => !undone.has(c.toolUseId));
  if (!cp) return line(dim("Nothing to undo."));
  const shown = display(cwd, cp.path);
  if (!(await jade.checkpoints.unchangedSince(cp))) {
    line(yellow(`${shown} has changed since the agent wrote it; undoing will discard those changes too.`));
    if (!/^y/i.test(await ask("Undo anyway? [y/N] "))) return;
  }
  await jade.checkpoints.restore(cp);
  await rt.record(UNDO_KEY, { undone: [...undone, cp.toolUseId] } satisfies UndoState);
  const what = cp.before === null ? `deleted ${shown} (the agent had created it)` : `restored ${shown} to its content before the agent's ${cp.tool}`;
  notes.push(`The user undid one of your changes: ${what}. Read the file again before changing it.`);
  line(green(`Undid ${cp.tool}: ${what}.`));
}

/** 恢复会话：先处理插件变化（4.6），再继续日志里没做完的工作 */
async function resumeSession() {
  const held = rt.state.held;
  if (held) {
    line(yellow(`Plugins changed since this session was last used: ${held.plugins.map((p) => `${p.id}@${p.version}`).join(", ")}`));
    if (held.resolution === "abort") {
      line(red("A plugin requires this session to stop. Restore the previous plugins to continue."));
      process.exit(1);
    }
    const ok = /^y/i.test(await ask("Continue with the new plugins? Pending tool calls will be re-checked. [y/N] "));
    await guarded(() => rt.send({ kind: "plugins", approved: ok }));
    if (!ok) process.exit(1);
  }
  await guarded(() => rt.recover());
  // 命令行明确给了 --mode 时覆盖日志里的设置
  if (opts.mode && opts.mode !== settings().mode) await saveSettings({ ...settings(), mode: opts.mode });
  line(dim(`Resumed ${sessionId} (${rt.state.messages.length} messages, mode ${settings().mode})`));
}

async function command(input: string): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case "help":
      line(COMMANDS.map((c) => `${usageOf(c).padEnd(COMMAND_WIDTH)}${c.about}`).join("\n"));
      break;
    case "mode": {
      const m = rest[0];
      if (m && !(MODES as readonly string[]).includes(m)) line(red(`unknown mode ${m}`));
      else if (m) await saveSettings({ ...settings(), mode: m as Mode });
      line(`mode: ${settings().mode}`);
      break;
    }
    case "undo":
      await undo();
      break;
    case "compact":
      jade.compact.request();
      line(dim("History will be compacted before the next request."));
      break;
    case "sessions":
      for (const s of (await index.list(cwd)).slice(0, 15)) line(`${s.id === sessionId ? "*" : " "} ${s.id}  ${dim(s.at.slice(0, 16))}  ${s.title}`);
      break;
    case "hooks":
      for (const p of ["context.project", "context.build", "model.before", "model.after", "tool.before", "tool.gate", "tool.after", "turn.continue", "event", "session.start", "session.end"]) {
        line(`${p.padEnd(16)} ${rt.hookOrder(p).join(" → ") || dim("(none)")}`);
      }
      break;
    case "rules":
      line(settings().rules.length ? settings().rules.map((r) => `${r.tool}${r.prefix ? ` "${r.prefix}…"` : ""}`).join("\n") : dim("(none)"));
      break;
    case "usage":
      line(`input ${usage.inputTokens}  output ${usage.outputTokens}  cache read ${usage.cacheReadTokens}  cache write ${usage.cacheWriteTokens}`);
      break;
    case "exit":
    case "quit":
      return false;
    default:
      line(red(`unknown command /${cmd}; try /help`));
  }
  return true;
}

if (resumeId) await resumeSession();
else line(dim(`jade · ${display(os.homedir(), cwd)} · mode ${settings().mode} · session ${sessionId}`));

const first = opts.print ?? (opts.prompt.length > 0 ? opts.prompt.join(" ") : undefined);
if (first) await say(first);

if (opts.print === undefined && interactive) {
  for (;;) {
    atPrompt = true;
    const input = (await rl.question(`\n${bold(">")} `)).trim();
    atPrompt = false;
    if (!input) continue;
    if (input.startsWith("/")) {
      if (!(await command(input))) break;
      continue;
    }
    await say(input);
  }
}
await leave();
rl.close();
