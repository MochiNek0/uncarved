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
  type Plugin,
  type UserInput,
} from "uncarved";
import { hasProvider, loadEnvFile } from "./config.ts";
import { createJade, type Jade } from "./distro.ts";
import { describeRule, MODES, POLICY_KEY, type AllowRule, type Mode, type PolicySettings } from "./plugins/policy.ts";
import { compactThreshold, contextWindowFromEnv } from "./context.ts";
import { InputHistory } from "./history.ts";
import { MEMORY_SCOPES, type MemoryScope } from "./memory.ts";
import { attachMentions, mentionCandidates } from "./mentions.ts";
import { providerFromEnv, providerInfo, switchable, withRetry } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { UNDO_KEY, type UndoState } from "./tools/checkpoint.ts";
import { display } from "./tools/fs.ts";
import type { ApproveSubagent, SubagentApproval } from "./tools/task.ts";
import { bold, dim, green, plainScreen, red, yellow, type CommandInfo, type Screen } from "./ui/screen.ts";
import { configurator } from "./ui/configure.ts";
import { clip, preview, shortPath, summarize } from "./ui/render.ts";
import { transcript } from "./ui/transcript.ts";
import { tuiScreen } from "./ui/tui.tsx";

const HELP = `Usage: jade [options] [prompt]

  -p, --print <prompt>   run one prompt and exit
  -c, --continue         continue the most recent session in this directory
  -r, --resume [id]      resume a session by id, or pick one from a list
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
  { name: "undo", about: "restore the file changed by the agent's most recent write_file/edit_file/multi_edit" },
  { name: "retry", about: "request the model again after a failed request, without sending another message" },
  { name: "usage", about: "token usage of this session, including sub-agents and compaction" },
  { name: "resume", args: "[id]", about: "pick a recent session in this directory and switch to it" },
  { name: "memory", args: "[text]", about: "see and remove what jade remembers across sessions, or remember text" },
  { name: "rules", about: `"always allow" rules of this session` },
  { name: "hooks", about: "execution order of every extension point" },
  { name: "exit", about: "quit (the session stays resumable)" },
];
/** 运行中也立即执行的命令（不碰运行时，或者只读） */
const INSTANT = new Set(["help", "model", "usage", "memory", "rules", "hooks", "exit", "quit"]);

const KEYS = `Keys: enter send · \\ or alt+enter new line · ↑↓ history · @ reference a file · esc interrupt · ctrl+c twice to exit
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
  // 不带 id 时从列表里选
  else if (a === "-r" || a === "--resume") opts.resume = argv[i + 1] === undefined || argv[i + 1]!.startsWith("-") ? "" : argv[++i]!;
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
/** 模型的上下文窗口：JADE_CONTEXT_WINDOW，/model 改配置后更新 */
let contextWindow = 0;
try {
  contextWindow = contextWindowFromEnv();
} catch (err) {
  fail(errorText(err));
}
/** 压缩阈值：JADE_COMPACT_TOKENS，否则由上下文窗口推出 */
const compactAt = () => compactTokens ?? compactThreshold(contextWindow);

const modelLabel = () => (hasProvider() ? providerInfo().model || "(no model)" : "(no model)");

// 界面在启动过程中就已经可以输入；启动完成前提交的内容先存着，完成后再处理
let ready = false;
const early: string[] = [];

const inputs = new InputHistory(path.join(home, "history.jsonl"), cwd);

const screen: Screen = tui
  ? tuiScreen({
      status: { cwd: shortPath(cwd), branch: await gitBranch(cwd), model: modelLabel(), mode: opts.mode ?? "ask" },
      version: VERSION,
      commands: COMMANDS,
      history: await inputs.load(),
      handlers: {
        submit: (text) => {
          inputs.add(text).catch(() => {});
          if (ready) onSubmit(text);
          else early.push(text);
        },
        interrupt: () => ready && interrupt(),
        exit: () => (ready ? void quit() : process.exit(130)),
        files: () => mentionCandidates(cwd),
      },
    })
  : plainScreen({ interactive: Boolean(process.stdin.isTTY) });

/** 压缩、子 Agent 和主循环共用；/model 改配置后换掉里面的实现 */
const provider = switchable({
  id: "unconfigured",
  complete: () => Promise.reject(new Error("no model is configured; use /model")),
});

/** /model 的交互：改配置后换掉 provider、更新上下文窗口和状态栏 */
const configure = configurator({
  screen,
  envFile,
  apply: () => {
    provider.set(retrying(providerFromEnv()));
    contextWindow = contextWindowFromEnv();
  },
  contextWindow: () => contextWindow,
  onApplied: () => screen.status({ model: modelLabel() }),
});

if (!hasProvider()) {
  screen.log(bold("Welcome to jade.") + " No model is configured yet; let's set one up.");
  if (!(await configure.provider())) {
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
const makeJade = (mode?: Mode) =>
  createJade({
    cwd,
    home,
    store,
    provider,
    mode,
    projectPlugins: extraPlugins,
    compactTokens: compactAt,
    approveSubagent,
    sharedRules: (): AllowRule[] => [...settings().rules, ...pendingRules],
  });

let jade: Jade = await makeJade(opts.mode);
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
if (resumeId === "") {
  if (!tui) {
    await screen.close();
    fail("--resume without an id needs a terminal to pick from; pass the id");
  }
  resumeId = await pickSession();
} else if (resumeId) resumeId = await findSession(resumeId);
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
const settings = (): PolicySettings => jade.policy.settings(rt.state.derived);
const saveSettings = async (next: PolicySettings) => {
  await rt.record(POLICY_KEY, next);
  screen.status({ mode: next.mode });
};

// ---------- 渲染 ----------

const view = transcript({ screen, cwd, store, contextWindow: () => contextWindow, canRetry: () => canRetry() });
rt.subscribe(view.onNotice);

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

// ---------- 审批 ----------

type Call = { toolUseId: string; name: string; input: unknown };

/** 问用户是否允许一个调用；选了"总是允许"时交给 remember 记下规则 */
async function ask(c: Call, who: string, remember: (rule: AllowRule) => Promise<void> | void): Promise<SubagentApproval> {
  const head = `${c.name}(${summarize(cwd, c.name, c.input)})`;
  if (!screen.interactive) {
    screen.log(red(`✗ ${who}${head} denied: not running interactively`));
    return { approved: false, reason: "The user is not available to approve this action." };
  }
  const rule = jade.policy.ruleFor(c);
  const always = rule.command !== undefined ? "this exact command" : describeRule(rule);
  const answer = await screen.select(
    `Allow ${who}${head}?`,
    [
      { label: "Yes", value: "yes" as const },
      { label: `Yes, and always allow ${always} in this session`, value: "always" as const },
      { label: "No, and tell jade what to do instead", value: "no" as const },
    ],
    { body: preview(c) },
  );
  if (answer === "always") await remember(rule);
  const approved = answer === "yes" || answer === "always";
  const reason = approved
    ? undefined
    : (answer === "no" ? await screen.input("What should jade do instead? (optional)") : undefined) || "The user rejected this action.";
  screen.log(approved ? green(`✓ ${who}${head}`) : red(`✗ ${who}${head}`) + dim(reason ? ` — ${clip(reason, 200)}` : ""));
  return { approved, reason };
}

async function approvePending() {
  while (rt.state.phase === "awaiting") {
    for (const c of rt.state.batch.filter((x) => x.decision === "ask")) {
      const answer = await ask(c, "", async (rule) => {
        const s = settings();
        await saveSettings({ ...s, rules: [...s.rules, rule] });
      });
      await rt.send({ kind: "approval", toolUseId: c.toolUseId, ...answer });
    }
  }
}

/**
 * 子 Agent 审批时选了"总是允许"的规则：主会话这时正在执行 task 工具，日志写不进去，
 * 先在这里生效（sharedRules），这一轮结束后再记进日志
 */
const pendingRules: AllowRule[] = [];
/** 并行的子 Agent 一次只问一个 */
let subagentAsking: Promise<unknown> = Promise.resolve();

function approveSubagent(...[c, signal]: Parameters<ApproveSubagent>): Promise<SubagentApproval> {
  const turn = subagentAsking.then(() => {
    signal.throwIfAborted();
    // 中断时不再等用户回答；对话框由用户自己关掉
    return abortable(ask(c, "sub-agent ", (rule) => void pendingRules.push(rule)), signal);
  });
  subagentAsking = turn.catch(() => {});
  return turn;
}

async function savePendingRules() {
  if (pendingRules.length === 0) return;
  const s = settings();
  await saveSettings({ ...s, rules: [...s.rules, ...pendingRules.splice(0)] });
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

// ---------- 运行 ----------

/** 正在执行一轮对话（或一个需要独占运行时的命令） */
let running = false;
/** running 期间那段工作；退出时等它收尾 */
let work: Promise<void> | undefined;

/** 独占运行时执行 fn；同一时间只有一个 */
async function occupy(fn: () => Promise<void>) {
  running = true;
  work = fn();
  try {
    await work;
  } finally {
    running = false;
    work = undefined;
    screen.busy(undefined);
  }
}

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
  // 中断后等这一轮收尾，再写 session.detached；pump 看到 quitting 就不再取排队的输入
  await work?.catch(() => {});
  await leave();
  await closeScreen();
  process.exit(code);
}

/**
 * 换成另一个会话：/clear 开始新会话，/resume 恢复 id 指定的会话。当前会话保持可恢复；
 * 新会话用一套新的插件和运行时，权限模式沿用（恢复的会话用它日志里的设置）。
 * 恢复失败时留在当前会话
 */
async function switchSession(id?: string) {
  const mode = settings().mode;
  const next = await makeJade(mode);
  let nextRt: Runtime;
  try {
    nextRt = id
      ? await Runtime.resume({ store, provider, plugins: next.plugins, sessionId: id })
      : await Runtime.create({ store, provider, plugins: next.plugins });
  } catch (err) {
    next.shutdown();
    return screen.log(red(`[error] could not resume ${id}: ${errorText(err)}`));
  }
  await leave();
  const old = sessionId;
  jade = next;
  rt = nextRt;
  rt.subscribe(view.onNotice);
  sessionId = rt.state.sessionId;
  view.reset();
  notes.length = 0;
  pendingRules.length = 0;
  screen.clear();
  screen.status({ session: sessionId, mode: settings().mode, context: undefined, cache: undefined });
  if (!id) return screen.log(dim(`Started a new session. The previous one can be resumed with /resume or: jade --resume ${old}`));
  if (!(await resumeSession())) {
    screen.log(dim("Starting a new session instead."));
    await switchSession();
  }
}

/** 从这个目录最近的会话里选一个；取消或没有时返回 undefined */
async function pickSession(current?: string): Promise<string | undefined> {
  const all = (await index.list(cwd)).filter((s) => s.id !== current).slice(0, 50);
  if (all.length === 0) {
    screen.log(dim(`No other sessions in ${shortPath(cwd)}.`));
    return undefined;
  }
  return screen.select(
    "Resume which session?",
    all.map((s) => ({ label: s.title || "(untitled)", value: s.id, hint: `${ago(s.at)} · ${s.id}` })),
  );
}

/** 这个目录的会话里 id 等于 arg 或以它开头的唯一一个；都不是时原样返回，交给 Runtime.resume 去找 */
async function findSession(arg: string): Promise<string> {
  const hits = (await index.list(cwd)).filter((s) => s.id.startsWith(arg));
  return hits.find((s) => s.id === arg)?.id ?? (hits.length === 1 ? hits[0]!.id : arg);
}

/** 显示用的相对时间 */
function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}

process.on("SIGINT", () => (running ? interrupt() : void quit(130)));

async function guarded(fn: () => Promise<void>) {
  view.turnFailed = false;
  try {
    await fn();
    await approvePending();
  } catch (err) {
    if (!view.turnFailed) screen.log(red(`[error] ${errorText(err)}`));
  } finally {
    screen.endStream();
  }
}

/** 宿主替用户告诉模型的事（例如 /undo），随下一条消息发出 */
const notes: string[] = [];
const hostNote = (text: string): Block => ({ kind: "text", text: `[Note from jade] ${text}`, origin: { by: "host" }, trust: "trusted" });

/** 本进程里已经记进会话索引的会话：每个会话每次运行只记一次，索引不随消息数增长 */
const indexed = new Set<string>();

async function say(text: string) {
  if (!indexed.has(sessionId)) {
    indexed.add(sessionId);
    await index.add({ id: sessionId, cwd, title: clip(text.replace(/\s+/g, " "), 80), at: new Date().toISOString() });
  }
  const content: Block[] = notes.splice(0).map(hostNote);
  content.push({ kind: "text", text, origin: { by: "user" }, trust: "trusted" });
  // @ 引用的文件和目录：内容随消息发出，模型不用再读一遍
  const refs = await attachMentions(text, { cwd, tools: jade.tools, sessionId, signal: AbortSignal.timeout(30_000) });
  for (const f of refs.failed) screen.log(yellow(`[@${f.path} not attached: ${clip(f.reason, 200)}]`));
  if (refs.attached.length) screen.log(dim(`[attached ${refs.attached.map((p) => `@${p}`).join(", ")}]`));
  content.push(...refs.blocks);
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
  view.lastEnd = undefined;
  await guarded(() => rt.send(input));
  // 回复被输出上限截断：让模型接着做，而不是把半截任务丢给用户
  for (let i = 0; i < MAX_CONTINUES && view.lastEnd === "max_tokens"; i++) {
    screen.log(dim(`[asking the model to continue (${i + 1}/${MAX_CONTINUES})]`));
    view.lastEnd = undefined;
    await guarded(() => rt.send({ kind: "message", content: [hostNote(CONTINUE_NOTE)] }));
  }
  await savePendingRules().catch((err) => screen.log(red(`[error] ${errorText(err)}`)));
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
  await view.replay(await readAll(store, sessionId), tui);
}

/** 恢复会话：先显示之前的对话，处理插件变化（4.6），再继续日志里没做完的工作。插件变化后不能继续时返回 false */
async function resumeSession(): Promise<boolean> {
  await replayHistory();
  const held = rt.state.held;
  if (held) {
    screen.log(yellow(`Plugins changed since this session was last used: ${held.plugins.map((p) => `${p.id}@${p.version}`).join(", ")}`));
    if (held.resolution === "abort") {
      screen.log(red("A plugin requires this session to stop. Restore the previous plugins to continue."));
      return false;
    }
    const ok =
      (await screen.select("Continue with the new plugins? Pending tool calls will be re-checked.", [
        { label: "Yes, continue", value: true },
        { label: "No", value: false },
      ])) ?? false;
    await guarded(() => rt.send({ kind: "plugins", approved: ok }));
    if (!ok) return false;
  }
  await guarded(() => rt.recover());
  // 命令行明确给了 --mode 时覆盖日志里的设置
  if (opts.mode && opts.mode !== settings().mode) await saveSettings({ ...settings(), mode: opts.mode });
  screen.log(dim(`Resumed ${sessionId} (${rt.state.messages.length} messages, mode ${settings().mode})`));
  return true;
}

/** /memory：不带参数时列出记忆，可以删掉一条或新加一条；带参数时记下这段话 */
async function manageMemory(text: string) {
  const { memory } = jade;
  if (!text) {
    const entries = (await Promise.all(MEMORY_SCOPES.map(async (scope) => (await memory.list(scope)).map((t) => ({ scope, text: t }))))).flat();
    const choice = await screen.select<{ scope: MemoryScope; text: string } | "add">(
      entries.length ? "Memory: choose an entry to remove it, or add one" : "jade does not remember anything yet",
      [{ label: "Add a memory…", value: "add" as const }, ...entries.map((e) => ({ label: e.text, value: e, hint: e.scope }))],
      { body: dim(`user (all projects): ${memory.files.user}\nproject: ${memory.files.project}`) },
    );
    if (!choice) return;
    if (choice !== "add") {
      const ok = await screen.select(
        `Remove this ${choice.scope} memory?`,
        [
          { label: "No", value: false },
          { label: "Yes, remove it", value: true },
        ],
        { body: choice.text },
      );
      if (!ok) return;
      await memory.remove(choice.scope, choice.text);
      notes.push(`The user removed this ${choice.scope} memory, so stop following it: ${choice.text}`);
      return screen.log(green(`Removed from ${choice.scope} memory: ${choice.text}`));
    }
    text = (await screen.input("What should jade remember?", { placeholder: "e.g. Reply in Chinese; run tests with bun test" })) ?? "";
    if (!text) return;
  }
  const scope = await screen.select<MemoryScope>("Remember it for", [
    { label: "All projects", value: "user", hint: "user memory" },
    { label: "This project only", value: "project", hint: "project memory" },
  ]);
  if (!scope) return;
  const added = await memory.add(scope, text);
  if (added) notes.push(`The user saved a ${scope} memory; follow it from now on: ${text}`);
  screen.log(added ? green(`Saved to ${scope} memory.`) : dim(`The ${scope} memory already has this.`));
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
      await configure.model(rest[0]);
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
      await switchSession();
      break;
    case "compact":
      jade.compact.request();
      screen.log(dim("History will be compacted before the next request."));
      break;
    case "resume":
    case "sessions": {
      const id = rest[0] ? await findSession(rest[0]) : await pickSession(sessionId);
      if (!id) break;
      if (id === sessionId) screen.log(dim("That is the current session."));
      else await switchSession(id);
      break;
    }
    case "memory":
      await manageMemory(input.slice(1).replace(/^\S+\s*/, "").trim());
      break;
    case "hooks":
      for (const p of ["context.project", "context.build", "model.before", "model.after", "tool.before", "tool.gate", "tool.after", "turn.continue", "event", "session.start", "session.end"]) {
        screen.log(`${p.padEnd(16)} ${rt.hookOrder(p).join(" → ") || dim("(none)")}`);
      }
      break;
    case "rules":
      screen.log(settings().rules.length ? settings().rules.map(describeRule).join("\n") : dim("(none)"));
      break;
    case "usage":
      screen.log(
        `input ${view.usage.inputTokens}  output ${view.usage.outputTokens}  cache read ${view.usage.cacheReadTokens}  cache write ${view.usage.cacheWriteTokens}  ` +
          `cache hit ${percent(view.usage.cacheReadTokens, view.usage.inputTokens)}`,
      );
      screen.log(
        dim(
          `context window ${contextWindow}${process.env.JADE_CONTEXT_WINDOW ? " (JADE_CONTEXT_WINDOW)" : " (default)"}, ` +
            `compacts at ${compactAt()}${compactTokens !== undefined ? " (JADE_COMPACT_TOKENS)" : ""}`,
        ),
      );
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

const echo = view.echo;

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
  let exit = false;
  await occupy(async () => {
    while (queue.length > 0 && !quitting) {
      const text = queue.shift()!;
      screen.queued(queue);
      echo(text);
      if (text.startsWith("/")) {
        try {
          if (!(await command(text))) {
            exit = true;
            return;
          }
        } catch (err) {
          screen.log(red(`[error] ${errorText(err)}`));
        }
      } else await say(text);
    }
  });
  if (exit) await quit();
}

// ---------- 开始 ----------

if (resumeId) {
  let ok = false;
  await occupy(async () => void (ok = await resumeSession()));
  if (!ok) {
    await screen.close();
    process.exit(1);
  }
}
else if (tui) screen.log(dim("Type / for commands, /model to configure the model, esc to interrupt."));
else screen.log(dim(`jade · ${shortPath(cwd)} · ${modelLabel()} · mode ${settings().mode} · session ${sessionId}`));
screen.status({ mode: settings().mode, session: sessionId });

const first = opts.print ?? (opts.prompt.length > 0 ? opts.prompt.join(" ") : undefined);
if (tui) {
  // 之后由输入框驱动：onSubmit → pump
  ready = true;
  for (const text of [...(first ? [first] : []), ...early.splice(0)]) onSubmit(text);
} else {
  if (first) await occupy(() => say(first));
  await leave();
  await closeScreen();
}
