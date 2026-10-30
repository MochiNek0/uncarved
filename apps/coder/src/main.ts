#!/usr/bin/env bun
// coder：基于 uncarved 内核的编程 Agent 命令行宿主。
//
// 宿主负责内核不管的事：配置目录、会话索引、项目层插件的确认、审批界面、渲染、中断。

import { readdir } from "node:fs/promises";
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
  type Event,
  type EventDataMap,
  type PendingCall,
  type Plugin,
  type Usage,
} from "uncarved";
import { createCoder } from "./distro.ts";
import { MODES, POLICY_KEY, type Mode, type PolicySettings } from "./plugins/policy.ts";
import { providerFromEnv, withRetry } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { display } from "./tools/fs.ts";
import type { ShellProgress } from "./tools/shell.ts";
import type { TaskProgress } from "./tools/task.ts";

const HELP = `Usage: coder [options] [prompt]

  -p, --print <prompt>   run one prompt and exit
  -c, --continue         continue the most recent session in this directory
  -r, --resume <id>      resume a session by id
  -m, --mode <mode>      permission mode: ${MODES.join(" | ")} (default ask)
      --cwd <dir>        working directory (default: current directory)
  -h, --help

Commands in the session: /help /mode /compact /sessions /hooks /rules /usage /exit
Data lives in $CODER_HOME (default ~/.uncarved-coder).`;

const COMMANDS = `/mode [${MODES.join("|")}]  show or change the permission mode
/compact            compact the history before the next request
/sessions           recent sessions in this directory
/hooks              execution order of every extension point
/rules              "always allow" rules of this session
/usage              token usage of this session
/exit               quit (the session stays resumable)`;

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
  console.error(`coder: ${msg}\n\n${HELP}`);
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
const home = process.env.CODER_HOME ?? path.join(os.homedir(), ".uncarved-coder");
const store = new JsonlLogStore(path.join(home, "sessions"));
const trust = new JsonlTrustStore(path.join(home, "trust.jsonl"));
const index = new SessionIndex(path.join(home, "index.jsonl"));
const interactive = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
const ask = async (q: string) => (interactive ? (await rl.question(q)).trim() : "");

const provider = withRetry(providerFromEnv(), {
  onRetry: ({ attempt, delayMs, error }) => line(yellow(`[retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${error.message}]`)),
});

const coder = await createCoder({
  cwd,
  home,
  store,
  provider,
  mode: opts.mode,
  projectPlugins: await projectPlugins(),
  compactTokens: process.env.CODER_COMPACT_TOKENS ? Number(process.env.CODER_COMPACT_TOKENS) : undefined,
});

/** .coder/plugins/<name>/index.ts：项目层插件，首次加载（及内容变化后）要用户确认（7.1） */
async function projectPlugins(): Promise<Plugin[]> {
  const root = path.join(cwd, ".coder", "plugins");
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
  ? await Runtime.resume({ store, provider, plugins: coder.plugins, sessionId: resumeId })
  : await Runtime.create({ store, provider, plugins: coder.plugins });
const sessionId = rt.state.sessionId;

// 权限设置记在日志里（derived），关卡从那里读，恢复会话后仍然有效
const settings = () => coder.policy.settings(rt.state.derived);
const saveSettings = (next: PolicySettings) => rt.record(POLICY_KEY, next);

// ---------- 渲染 ----------

const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const addUsage = (u?: Usage) => {
  for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u?.[k] ?? 0;
};
if (resumeId) for (const e of await readAll(store, sessionId)) if (e.type === "model.responded") addUsage((e as Event<"model.responded">).data.usage);

const toolNames = new Map<string, string>();
let streamed = false;
let thinking = false;
/** 每个工具已经显示了多少行进度输出 */
const progressLines = new Map<string, number>();
const MAX_PROGRESS_LINES = 20;

function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "bash") return clip(String(i.command ?? "").split("\n")[0]!, 120);
  if (name === "task") return String(i.description ?? "");
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
        return;
      }
      streamed = true;
      if (n.delta.kind === "thinking") {
        if (!thinking) line(dim("thinking…"));
        thinking = true;
        write(dim(n.delta.text));
      } else {
        if (thinking) line();
        thinking = false;
        write(n.delta.text);
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

function renderEvent(e: Event) {
  switch (e.type) {
    case "model.responded": {
      const d = e.data as EventDataMap["model.responded"];
      addUsage(d.usage);
      for (const b of d.content) if (b.kind === "tool_use") toolNames.set(b.id, b.name);
      // 不支持流式的 provider：直接打印最终文本
      if (!streamed) write(textOf(d.content));
      streamed = false;
      thinking = false;
      if (!atLineStart) write("\n");
      return;
    }
    case "tool.decided": {
      const d = e.data as EventDataMap["tool.decided"];
      const name = toolNames.get(d.toolUseId) ?? "?";
      if (d.decision === "ask") return;
      const head = `${bold(name)}(${summarize(name, d.input)})`;
      if (d.decision === "deny") line(red(`✗ ${head}`) + dim(d.reason ? ` — ${clip(d.reason, 200)}` : ""));
      else if (d.decidedBy !== "user") line(cyan("● ") + head);
      return;
    }
    case "tool.completed": {
      const d = e.data as EventDataMap["tool.completed"];
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
      if (d.reason === "stopped") line(yellow("[stopped: step budget for this turn used up; send a message to continue]"));
      else if (d.reason === "aborted") line(yellow("[interrupted]"));
      else if (d.reason !== "end") line(yellow(`[turn ended: ${d.reason}${d.error ? ` — ${d.error}` : ""}]`));
      return;
    }
    case "coder/compact/compacted": {
      const d = e.data as { from: number; upTo: number; before: number };
      line(dim(`[compacted ${d.upTo - d.from} messages, ~${d.before} tokens before]`));
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
      const rule = coder.policy.ruleFor(c);
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
  try {
    await rt.detach();
  } catch (err) {
    line(red(`[error] ${err instanceof Error ? err.message : String(err)}`));
  }
  line(dim(`Resume with: coder --resume ${sessionId}`));
}

async function guarded(fn: () => Promise<void>) {
  running = true;
  try {
    await fn();
    await approvePending();
  } catch (err) {
    line(red(`[error] ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    running = false;
  }
}

async function say(text: string) {
  await index.add({ id: sessionId, cwd, title: clip(text.replace(/\s+/g, " "), 80), at: new Date().toISOString() });
  await guarded(() => rt.send({ kind: "message", content: [{ kind: "text", text, origin: { by: "user" }, trust: "trusted" }] }));
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
      line(COMMANDS);
      break;
    case "mode": {
      const m = rest[0];
      if (m && !(MODES as readonly string[]).includes(m)) line(red(`unknown mode ${m}`));
      else if (m) await saveSettings({ ...settings(), mode: m as Mode });
      line(`mode: ${settings().mode}`);
      break;
    }
    case "compact":
      coder.compact.request();
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
else line(dim(`coder · ${display(os.homedir(), cwd)} · mode ${settings().mode} · session ${sessionId}`));

const first = opts.print ?? (opts.prompt.length > 0 ? opts.prompt.join(" ") : undefined);
if (first) await say(first);

if (opts.print === undefined && interactive) {
  for (;;) {
    const input = (await rl.question(`\n${bold(">")} `)).trim();
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
