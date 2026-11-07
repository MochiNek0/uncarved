// jade/tui 的前端：把会话接到终端界面上。旧 jade 的 main.ts 里属于界面的部分：
// 输入排队、斜杠命令、esc 中断、换会话后重新显示对话、状态栏。
//
// 这里不认识任何具体功能：命令来自 commands@1，快捷键来自 keys@1，工具和事件怎么显示来自 renderers@1，
// 模式来自 modes@1，模型名来自 models@1。

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Block } from "uncarved";
import type { Frontend, OpenOptions, Session, SessionManager, SessionUI, UI } from "../../src/api.ts";
import type { CommandContext, Commands } from "../commands/index.ts";
import type { Keys } from "../keys/index.ts";
import type { Compact } from "../compact/index.ts";
import type { Models } from "../models/index.ts";
import type { Modes } from "../modes/index.ts";
import type { Renderers } from "../renderers/index.ts";
import { InputHistory } from "./history.ts";
import { mentionCandidates } from "./mentions.ts";
import type { SessionIndex } from "../sessions/index.ts";
import { dim, red, safeScreen, yellow, type CommandInfo, type Screen } from "./screen.ts";
import { transcript, type Transcript } from "./transcript.ts";

/**
 * 界面（ink、React）用到时才加载：--help、参数出错、不在终端里时都不需要它，导入一次要几百毫秒。
 * React 在加载时按 NODE_ENV 选开发版或生产版，开发版做大量检查，流式输出时 CPU 翻倍。
 * 用户没设 NODE_ENV 时只在加载期间设成 production，加载完还原，免得传给之后 shell 工具、MCP 等子进程。
 * ink 依赖的 yoga 有顶层 await，只能异步加载，做不到同步设置再还原：加载期间还没有会话，工具和 MCP 都没启动，
 * 这时可能启动的子进程只有 git（不读它）和后台的 npm 自动升级（全局安装本来就不装 devDependencies）
 */
async function loadTui(): Promise<typeof import("./tui.ts")> {
  if (process.env.NODE_ENV !== undefined) return import("./tui.ts");
  process.env.NODE_ENV = "production";
  try {
    return await import("./tui.ts");
  } finally {
    delete process.env.NODE_ENV;
  }
}

const USAGE = `usage: jade [prompt] [--resume <session id> | --continue]

Starts the terminal interface. With a prompt, sends it first.
  -c, --continue  continue the most recent session in this directory
  -r, --resume    resume a session by id (inside jade, /resume lists them)
Run one prompt without the interface: jade -p <prompt> (jade -p --help for more)
jade's own commands (plugins, update, --safe): jade help`;

/** 前端自己的命令：帮助和退出。其余命令都来自 commands@1 */
const OWN: CommandInfo[] = [
  { name: "help", about: "list the commands and keys" },
  { name: "exit", about: "quit (the session stays resumable)" },
];

const KEYS =
  "Keys: enter send · \\ or alt+enter new line · ↑↓ history · esc interrupt (twice to also move queued messages back to the input) · ↑ on the first line edits queued messages · ctrl+o expand · ctrl+c twice to exit";

/** 第二次 esc 算作"再按一次"的时间窗口 */
const SECOND_ESC_MS = 3000;

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "";
  }
})();

const errorText = (e: unknown) => {
  // 经过膜的错误包着插件的名字；用户要看的是原因
  const cause = e instanceof Error && e.name === "PluginError" && e.cause instanceof Error ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
};

/** 测试用：换掉终端（假的 stdin、stdout）。不设时用 process.stdin、process.stdout */
export const terminal: { io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } } = {};

export interface FrontendServices {
  home: string;
  cwd: string;
  commands: Commands;
  keys: Keys;
  renderers: Renderers;
  modes?: Modes;
  models?: Models;
  /** 自动压缩的阈值，状态栏显示 */
  compact?: Compact;
  /** 会话索引（jade/sessions），--continue 用 */
  index?: SessionIndex;
}

/** 状态栏上插件的一段最多显示这么多字符（超出的截断，换行并成空格） */
const MAX_SEGMENT = 80;

/**
 * ui@1：界面出来之前的提示先攒着，出来之后显示；界面关掉之后写到 stderr。
 * 前端运行期间才能提问；会话里的插件经 UI.session 拿到自己的状态栏段落和输入框（4.3）
 */
export class ScreenBridge {
  screen: Screen | undefined;
  #early: string[] = [];
  /** 会话打开期间的提示：打开之后要清屏，先攒着，清屏之后再显示 */
  #held: string[] | undefined;
  #closed = false;
  /** 状态栏上各插件的一段：会话 id → 插件 id → 文字 */
  #segments = new Map<string, Map<string, string>>();
  /** 界面现在显示哪个会话；换会话时由前端调用 show */
  #session: string | undefined;

  readonly ui: UI = {
    interactive: true,
    notify: (message, level = "info") => {
      const text = level === "error" ? red(`[error] ${message}`) : level === "warning" ? yellow(`[warning] ${message}`) : dim(message);
      if (this.#held) this.#held.push(text);
      else if (this.screen) this.screen.log(text);
      else if (this.#closed) process.stderr.write(`jade: ${message}\n`);
      else this.#early.push(text);
    },
    select: async (req, signal) => {
      if (!this.screen) return undefined;
      return this.screen.select(req.title, req.options.map((o) => ({ label: o.label, value: o.value, ...(o.hint ? { hint: o.hint } : {}) })), { ...(req.detail ? { body: req.detail } : {}), ...(signal ? { signal } : {}) });
    },
    input: async (req, signal) => {
      if (!this.screen) return undefined;
      return this.screen.input(req.title, { ...(req.initial ? { initial: req.initial } : {}), ...(req.placeholder ? { placeholder: req.placeholder } : {}), ...(req.mask ? { mask: true } : {}), ...(signal ? { signal } : {}) });
    },
    session: ({ session, plugin }) => this.#sessionUI(session, plugin),
  };

  attach(screen: Screen): void {
    this.screen = screen;
    for (const t of this.#early.splice(0)) screen.log(t);
  }

  /** 开始攒提示，直到 release */
  hold(): void {
    this.#held ??= [];
  }

  /** 显示攒下的提示，之后的照常显示 */
  release(): void {
    const held = this.#held ?? [];
    this.#held = undefined;
    for (const t of held) {
      if (this.screen) this.screen.log(t);
      else this.#early.push(t);
    }
  }

  detach(): void {
    this.screen = undefined;
    this.#closed = true;
  }

  /** 界面换到另一个会话：显示它的插件段落（之前那个会话的留着，换回去还在） */
  show(session: string | undefined): void {
    this.#session = session;
    this.#apply();
  }

  #apply(): void {
    if (!this.screen) return;
    const segments = this.#session === undefined ? undefined : this.#segments.get(this.#session);
    this.screen.status({ plugins: [...(segments ?? [])].map(([plugin, text]) => ({ plugin, text })) });
  }

  /** 一个插件在一个会话里的界面。作用域关闭时核心调用 dispose，这里把它的段落去掉 */
  #sessionUI(session: string, plugin: string): SessionUI {
    const bridge = this;
    let gone = false;
    const apply = () => {
      if (bridge.#session === session) bridge.#apply();
    };
    return {
      status(text) {
        if (gone) return;
        // 每次现取：别的插件 dispose 可能已经把空的 map 删了
        let segments = bridge.#segments.get(session);
        if (text === undefined) segments?.delete(plugin);
        else {
          if (!segments) bridge.#segments.set(session, (segments = new Map()));
          segments.set(plugin, clipSegment(text));
        }
        apply();
      },
      draft: {
        text: () => bridge.screen?.draft?.text() ?? "",
        insert: (text) => bridge.screen?.draft?.insert(text),
        set: (text) => bridge.screen?.draft?.set(text),
        hint: (text) => bridge.screen?.draft?.hint(text),
      },
      dispose() {
        gone = true;
        const segments = bridge.#segments.get(session);
        segments?.delete(plugin);
        if (segments?.size === 0) bridge.#segments.delete(session);
        apply();
      },
    };
  }
}

/** 状态栏的一段是一行：空白并成一个空格，长的截断 */
function clipSegment(text: string): string {
  const one = String(text).replace(/\s+/g, " ").trim();
  return one.length > MAX_SEGMENT ? `${one.slice(0, MAX_SEGMENT - 1)}…` : one;
}

export function tuiFrontend(services: FrontendServices, bridge: ScreenBridge): Frontend {
  return {
    run: (opts) => run(services, bridge, opts),
  };
}

function parse(argv: readonly string[]): { prompt?: string; resume?: string; cont?: boolean; help?: boolean } | string {
  const out: { prompt?: string; resume?: string; cont?: boolean; help?: boolean } = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-c" || a === "--continue") out.cont = true;
    else if (a === "--resume" || a === "-r") {
      const id = argv[++i];
      if (!id) return `${a} needs a session id (inside jade, /resume lists the sessions)`;
      out.resume = id;
    } else if (a.startsWith("-")) return `unknown option ${a}`;
    else words.push(a);
  }
  if (out.cont && out.resume) return "--continue and --resume both pick the session; use one of them";
  if (words.length > 0) out.prompt = words.join(" ");
  return out;
}

async function run(services: FrontendServices, bridge: ScreenBridge, opts: Parameters<Frontend["run"]>[0]): Promise<number> {
  const args = parse(opts.argv);
  if (typeof args === "string") {
    process.stderr.write(`${args}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const io = terminal.io;
  if (!(io ?? process).stdin.isTTY || !(io ?? process).stdout.isTTY) {
    process.stderr.write(`jade's terminal interface needs a terminal. To run one prompt, use: jade -p <prompt>\n`);
    return 2;
  }

  const { cwd, home, commands, keys, renderers, modes, models, compact, index } = services;
  const sessions = opts.sessions;
  // --continue：这个目录里最近用过的会话（索引由 jade/sessions 在收到第一条消息时写）
  if (args.cont && !index) {
    process.stderr.write("jade: --continue needs the jade/sessions plugin, which is not enabled\n");
    return 2;
  }
  const resumed = args.cont ? (await index!.list(cwd))[0]?.id : args.resume;
  if (args.cont && !resumed) {
    process.stderr.write(`jade: no session to continue in ${cwd}\n`);
    return 2;
  }
  const history = new InputHistory(path.join(home, "history.jsonl"), cwd);
  const [past, branch, { tuiScreen }] = await Promise.all([history.load(), gitBranch(cwd), loadTui()]);

  /** 菜单里的命令：前端自己的 + 注册表里的，每次打开菜单时取 */
  const commandList = (): CommandInfo[] => [
    ...OWN,
    ...commands
      .list()
      .filter((c) => !OWN.some((o) => o.name === c.name))
      .map((c) => ({ name: c.name, ...(c.args ? { args: c.args } : {}), about: `${c.description ?? ""}${c.plugin.startsWith("jade/") ? "" : ` (plugin ${c.plugin})`}`.trim() })),
  ];

  let ready = false;
  const early: string[] = [];
  let finish!: (code: number) => void;
  const finished = new Promise<number>((r) => (finish = r));

  // 插件、工具输出和模型的文字都经过 safeScreen 显示：只留颜色，去掉能搅乱终端的控制序列
  const screen: Screen = safeScreen(
    tuiScreen({
      status: { cwd: shortPath(cwd), ...(branch ? { branch } : {}), model: models?.current()?.model ?? "(no model)", mode: modes?.current() ?? "" },
      version: VERSION,
      commands: commandList,
      history: past,
      ...(io ? { io } : {}),
      handlers: {
        submit: (text) => {
          history.add(text).catch(() => {});
          if (ready) onSubmit(text);
          else early.push(text);
        },
        // 输入 @ 时列工作目录里的文件
        files: () => mentionCandidates(cwd),
        interrupt: () => ready && interrupt(),
        unqueue: () => takeBack(),
        exit: () => void quit(0),
        cycleMode: () => void key("shift+tab"),
        key: (spec) => key(spec),
      },
    }),
  );
  bridge.attach(screen);

  const keyAbort = new AbortController();
  /** 插件的快捷键：找到了就在后台执行 */
  function key(spec: string): boolean {
    const found = keys.get(spec);
    if (!found) return false;
    const signal = keyAbort.signal;
    Promise.resolve()
      .then(() => found.key.run({ key: spec, signal }))
      .catch((e) => {
        if (!signal.aborted) screen.log(yellow(`[warning] plugin ${found.plugin}: ${spec} failed: ${errorText(e)}`));
      });
    return true;
  }

  const offMode = modes?.subscribe((mode) => screen.status({ mode }));
  // /model 换了配置：状态栏跟着换
  const offModel = models?.subscribe?.(() => screen.status({ model: models.current()?.model ?? "(no model)" }));

  // ---------- 会话 ----------

  let current: Session | undefined;
  let unsubscribe: (() => void) | undefined;
  const canRetry = () => current?.state.phase === "idle" && current.state.messages.at(-1)?.role === "user";

  const view: Transcript = transcript({
    screen,
    cwd,
    contextWindow: () => models?.current()?.contextWindow ?? 0,
    maxTokens: () => models?.current()?.maxTokens,
    ...(compact ? { compactAt: () => compact.threshold() } : {}),
    canRetry,
    renderer: (tool) => renderers.forTool(tool),
    eventRenderer: (type) => renderers.forEvent(type),
  });

  /** 换成另一个会话：清屏，恢复的会话重新显示之前的对话，然后继续日志里没做完的工作 */
  async function adopt(s: Session, resumed: boolean): Promise<void> {
    unsubscribe?.();
    current = s;
    view.reset();
    screen.clear();
    screen.status({ session: s.id, context: undefined, cache: undefined, spent: undefined, speed: undefined });
    // 状态栏上插件自己的段落跟着换：新会话的显示出来，旧会话的留着（换回去还在）
    bridge.show(s.id);
    if (resumed) await view.replay(await s.history(), true);
    bridge.release();
    unsubscribe = s.subscribe(view.onNotice);
    if (!resumed) return;
    const held = s.state.held;
    if (held) {
      screen.log(yellow(`Plugins changed since this session was last used: ${held.plugins.map((p) => `${p.id}@${p.version}`).join(", ")}`));
      if (held.resolution === "abort") {
        screen.log(red("A plugin requires this session to stop. Restore the previous plugins to continue it, or /clear to start a new one."));
        return;
      }
      const ok =
        (await screen.select("Continue with the new plugins? Pending tool calls will be re-checked.", [
          { label: "Yes, continue", value: true },
          { label: "No", value: false },
        ])) ?? false;
      await guarded(() => s.send({ kind: "plugins", approved: ok }));
      if (!ok) return;
    }
    await guarded(() => s.recover());
    screen.log(dim(`Resumed ${s.id} (${s.state.messages.length} messages)`));
  }

  /** 交给命令的会话管理器：换会话之后界面跟着换 */
  const manager: SessionManager = {
    get current() {
      return sessions.current;
    },
    async open(o?: OpenOptions) {
      // 插件在会话打开时发的提示（例如读了哪些指令文件）留到 adopt 清屏之后再显示
      bridge.hold();
      try {
        const s = await sessions.open(o);
        await adopt(s, o?.resume !== undefined);
        return s;
      } finally {
        bridge.release();
      }
    },
    async close() {
      unsubscribe?.();
      unsubscribe = undefined;
      current = undefined;
      bridge.show(undefined);
      await sessions.close();
    },
  };

  // ---------- 运行 ----------

  /** 等待执行的输入：运行中提交的消息和需要独占会话的命令排在这里，按顺序执行 */
  const queue: string[] = [];
  let running = false;
  let work: Promise<void> | undefined;
  let interruptedAt = 0;
  let interruptPending = false;
  const commandAborts = new Set<AbortController>();
  let quitting = false;

  async function occupy(fn: () => Promise<void>) {
    running = true;
    work = fn();
    try {
      await work;
    } finally {
      running = false;
      work = undefined;
      interruptPending = false;
      screen.busy(undefined);
    }
  }

  /** guarded 里这一轮已经由 turn.ended 显示过原因的错误不再重复显示 */
  async function guarded(fn: () => Promise<void>) {
    view.turnFailed = false;
    view.lastError = undefined;
    try {
      await fn();
    } catch (e) {
      if (!view.turnFailed) screen.log(red(`[error] ${errorText(e)}`));
    } finally {
      screen.endStream();
    }
  }

  function interrupt() {
    if (!running) return;
    const again = interruptPending || Date.now() - interruptedAt < SECOND_ESC_MS;
    interruptedAt = Date.now();
    interruptPending = true;
    for (const ac of commandAborts) ac.abort(new Error("interrupted by user"));
    current?.abort(new Error("interrupted by user"));
    screen.busy("Interrupting");
    if (queue.length === 0) return;
    const n = queue.length;
    if (again) {
      if (takeBack()) screen.log(dim(`[moved ${n} queued message${n > 1 ? "s" : ""} back to the input]`));
      else {
        queue.length = 0;
        screen.queued(queue);
        screen.log(dim(`[cleared ${n} queued message${n > 1 ? "s" : ""}]`));
      }
    } else {
      screen.log(dim(`[${n} queued message${n > 1 ? "s" : ""} will still be sent; press esc again to edit ${n > 1 ? "them" : "it"}]`));
    }
  }

  /** 排队的消息不再自动发送，放回输入框（在已经输入的内容前面，一条一行）；没有可放回的返回 false */
  function takeBack(): boolean {
    if (queue.length === 0 || !screen.draft) return false;
    const typed = screen.draft.text();
    screen.draft.set([...queue.splice(0), ...(typed.trim() ? [typed] : [])].join("\n"));
    screen.queued(queue);
    return true;
  }

  async function quit(code: number) {
    if (quitting) return;
    quitting = true;
    if (running) current?.abort(new Error("exiting"));
    await work?.catch(() => {});
    keyAbort.abort(new Error("exiting"));
    offMode?.();
    offModel?.();
    unsubscribe?.();
    await screen.close();
    bridge.detach();
    // 退出备用屏幕之后，里面的内容就看不到了：告诉用户怎么回来
    if (current && current.state.messages.length > 0) (io?.stdout ?? process.stdout).write(`${dim(`Resume with: jade --resume ${current.id}`)}\n`);
    finish(code);
  }
  opts.signal.addEventListener("abort", () => void quit(130), { once: true });

  /** 发一条用户消息，跑到会话空闲（包括插件排在这一轮之后的工作） */
  async function say(text: string) {
    const s = current;
    if (!s) return screen.log(red("[error] there is no open session. Use /clear or /resume to continue."));
    screen.busy(undefined);
    screen.busy("Working");
    const content: Block[] = [{ kind: "text", text, origin: { by: "user" }, trust: "trusted" }];
    await guarded(async () => {
      await s.send({ kind: "message", content });
      await s.idle();
    });
  }

  const instant = (name: string) => OWN.some((o) => o.name === name) || name === "quit" || commands.get(name)?.command.instant === true;

  /** 执行一条命令；返回 false 表示退出 */
  async function command(input: string): Promise<boolean> {
    const name = input.slice(1).split(/\s+/)[0]!.toLowerCase();
    const rest = input.slice(1).replace(/^\S+\s*/, "");
    if (name === "exit" || name === "quit") return false;
    if (name === "help") {
      const all = commandList();
      const width = Math.max(...all.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length)) + 2;
      screen.log(all.map((c) => `${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(width)}${dim(c.about)}`).join("\n"));
      screen.log(dim(KEYS));
      const pluginKeys = keys.list();
      if (pluginKeys.length > 0) screen.log(dim(`Plugin keys: ${pluginKeys.map((k) => `${k.key}${k.description ? ` ${k.description}` : ""} (${k.plugin})`).join(" · ")}`));
      return true;
    }
    const found = commands.get(name);
    if (!found) {
      screen.log(red(`unknown command /${name}; /help lists the commands`));
      return true;
    }
    const ac = new AbortController();
    commandAborts.add(ac);
    const ctx: CommandContext = { signal: ac.signal, ui: bridge.ui, sessions: manager, print: (t) => screen.log(t) };
    try {
      const result = await found.command.run(rest, ctx);
      if (typeof result === "string") screen.log(result);
      else if (result && typeof result === "object" && typeof result.prompt === "string") {
        if (found.command.instant) screen.log(yellow(`[warning] /${name} is instant and cannot send a prompt`));
        else await say(result.prompt);
      }
    } catch (e) {
      if (!ac.signal.aborted) screen.log(red(`[error] /${name}: ${errorText(e)}`));
    } finally {
      commandAborts.delete(ac);
    }
    return true;
  }

  function onSubmit(text: string) {
    if (quitting) return;
    const name = text.startsWith("/") ? text.slice(1).split(/\s+/)[0]!.toLowerCase() : undefined;
    if (name !== undefined && instant(name)) {
      // 不碰会话的命令运行中也直接执行
      view.echo(text);
      void command(text).then((go) => {
        if (!go) void quit(0);
      });
      return;
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
        if (interruptPending) interruptedAt = Date.now();
        interruptPending = false;
        const text = queue.shift()!;
        screen.queued(queue);
        view.echo(text);
        if (text.startsWith("/")) {
          if (!(await command(text))) {
            exit = true;
            return;
          }
        } else await say(text);
      }
    });
    if (exit) await quit(0);
  }

  // ---------- 开始 ----------

  try {
    let opened = false;
    await occupy(async () => {
      try {
        await manager.open(resumed ? { resume: resumed } : {});
        opened = true;
      } catch (e) {
        screen.log(red(`[error] ${resumed ? `could not resume ${resumed}` : "could not start a session"}: ${errorText(e)}`));
      }
    });
    if (!opened && resumed) {
      // 恢复不了：新开一个，免得界面里没有会话
      screen.log(dim("Starting a new session instead."));
      await occupy(async () => {
        await manager.open().catch((e) => screen.log(red(`[error] could not start a session: ${errorText(e)}`)));
      });
    }
  } catch (e) {
    screen.log(red(`[error] ${errorText(e)}`));
  }
  if (!models?.current()) {
    // /model（jade/models 提供）当场就能配好，不用重启；没有这条命令时只能改文件
    const file = `put ANTHROPIC_API_KEY=... (or OPENAI_API_KEY=...) in ${path.join(home, ".env")}, then restart jade`;
    screen.log(yellow(commands.list().some((c) => c.name === "model") ? `No model is configured yet. Type /model to set one up, or ${file}.` : `No model is configured yet. To set one up, ${file}.`));
  }
  else if (!resumed) screen.log(dim("Type / for commands, esc to interrupt."));
  ready = true;
  for (const text of [...(args.prompt ? [args.prompt] : []), ...early.splice(0)]) onSubmit(text);

  return finished;
}

/** 当前分支；不在仓库里或没有 git 时 undefined */
function gitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });
}

/** 家目录下的路径写成 ~/… */
function shortPath(p: string): string {
  const home = os.homedir();
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : p === home ? "~" : p;
}
