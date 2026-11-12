// bash 工具：在工作目录里执行一条 shell 命令。输出边读边通过 ctx.progress 推给宿主。
//
// run_in_background 的命令立即返回一个编号，进程留在后台（开发服务器、watch 等）；
// 用 bash_output 读取它的新输出，kill_shell 停止它。后台进程只属于本进程，宿主退出时调用 shutdown 全部杀掉。

import { existsSync } from "node:fs";
import path from "node:path";
import type { Tool } from "uncarved";
import type { ToolMeta } from "@uncarved/jade-api";
import { runSync, spawn as spawnProc, which, type Proc } from "./sys.ts";
import type { RunCommand, RunResult } from "@uncarved/jade-api/services";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
/** 后台进程最多缓存这么多还没读取的输出，超出的丢弃最早的部分 */
const MAX_BUFFER_CHARS = 1_000_000;

export interface ShellOptions {
  cwd: string;
  /** 默认 JADE_SHELL 环境变量，否则 bash（Windows 上是 Git Bash） */
  shell?: string;
  /** 后台命令自己结束时调用（被 kill_shell、shutdown 停掉的不算） */
  onExit?(bg: { id: string; command: string; exitCode: number | null }): void;
}

export interface ShellTools {
  /** bash、bash_output、kill_shell；找不到 shell 时为空 */
  tools: Tool[];
  /** 实际执行的 shell 程序；找不到时为 undefined */
  executable?: string;
  /** 找不到 shell 时的说明，宿主显示给用户 */
  unavailable?: string;
  /** 杀掉所有还在运行的后台进程 */
  shutdown(): void;
  /** 本会话启动过的后台命令 */
  list(): { id: string; command: string; status: string }[];
  /** 停掉一个后台命令（连同它启动的进程）；没有这个编号时返回 false */
  kill(id: string): Promise<boolean>;
  /** 宿主和插件自己执行一条命令（不经过模型和审批），找不到 shell 时为 undefined */
  run?: RunCommand;
}

/** 只要 bash 工具时用（测试） */
export function shellTool(opts: ShellOptions): Tool {
  const { tools, unavailable } = shellTools(opts);
  if (!tools[0]) throw new Error(unavailable);
  return tools[0];
}

interface Background {
  id: string;
  command: string;
  proc: Tagged;
  /** 还没被 bash_output 读走的输出 */
  unread: string;
  /** 因超出缓存而丢弃的字符数，下次读取时告诉模型 */
  dropped: number;
  exitCode?: number | null;
  /** 是被停掉的（kill_shell、shutdown），不是自己结束的 */
  killed?: boolean;
}

export function shellTools(opts: ShellOptions): ShellTools {
  const shell = opts.shell ?? process.env.JADE_SHELL ?? "bash";
  const found = findShell(shell);
  // 找不到 shell 时不提供这几个工具：否则模型每次调用都要用户先批准，执行时才失败，模型还会反复重试
  if (!found) {
    const hint = process.platform === "win32" ? "install Git for Windows, or set JADE_SHELL to the path of a bash executable" : "set JADE_SHELL to the path of a shell";
    return { tools: [], unavailable: `${shell} was not found, so the bash tool is disabled; ${hint}`, shutdown() {}, list: () => [], kill: async () => false };
  }
  const executable = found;
  const env = shellEnv(executable);
  const background = new Map<string, Background>();
  let nextId = 1;

  const spawn = (command: string, cwd = opts.cwd) => launch(executable, env, command, cwd);

  async function startBackground(command: string): Promise<string> {
    const id = `bg${nextId++}`;
    const bg: Background = { id, command, proc: await spawn(command), unread: "", dropped: 0 };
    const append = (text: string) => {
      bg.unread += text;
      if (bg.unread.length > MAX_BUFFER_CHARS) {
        bg.dropped += bg.unread.length - MAX_BUFFER_CHARS;
        bg.unread = bg.unread.slice(-MAX_BUFFER_CHARS);
      }
    };
    // 输出只进 unread，不另外累积：后台进程可能一直运行
    void Promise.all([collect(bg.proc.stdout, append, false), collect(bg.proc.stderr, append, false)]).catch(() => {});
    void bg.proc.exited.then((code) => {
      bg.exitCode = code;
      if (!bg.killed) opts.onExit?.({ id, command, exitCode: code });
    });
    background.set(id, bg);
    return id;
  }

  const status = (bg: Background) => (bg.exitCode === undefined ? "running" : `exited with code ${bg.exitCode}`);
  /** 停掉一个还在运行的后台命令，等它退出 */
  const stop = async (bg: Background) => {
    if (bg.exitCode !== undefined) return;
    bg.killed = true;
    killTree(executable, env, bg.proc);
    await bg.proc.exited;
  };

  const bash: Tool & { meta: ToolMeta } = {
    name: "bash",
    meta: { shell: "command" },
    description:
      `Run a shell command with ${shell} -c in the working directory and return its exit code, stdout and stderr. ` +
      `Each call starts a fresh shell: cd and environment variables do not persist. ` +
      `Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s (timeout_ms, max ${MAX_TIMEOUT_MS / 1000}s). ` +
      "Set run_in_background for servers, watchers and other long-running commands: it returns an id at once, " +
      "then read new output with bash_output and stop it with kill_shell. " +
      "Never start interactive programs. Prefer read_file/grep/glob over cat/grep/find.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, timeout_ms: { type: "integer" }, run_in_background: { type: "boolean" } },
      required: ["command"],
      additionalProperties: false,
    },
    effect: "external",
    concurrency: "exclusive",
    idempotent: false,
    async execute(input, { signal, progress }) {
      const { command, timeout_ms, run_in_background } = input as { command: string; timeout_ms?: number; run_in_background?: boolean };
      if (run_in_background) {
        const id = await startBackground(command);
        return { content: `Started background shell ${id}. Read its output with bash_output, stop it with kill_shell.` };
      }
      const timeout = Math.min(Math.max(timeout_ms ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const proc = await spawn(command);
      let timedOut = false;
      const killed = giveUp();
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(executable, env, proc);
        killed.start();
      }, timeout);
      const kill = () => {
        killTree(executable, env, proc);
        killed.start();
      };
      signal.addEventListener("abort", kill, { once: true });
      try {
        const [stdout, stderr, code] = await Promise.all([
          collect(proc.stdout, (text) => progress({ kind: "output", stream: "stdout", text }), true, killed.done),
          collect(proc.stderr, (text) => progress({ kind: "output", stream: "stderr", text }), true, killed.done),
          Promise.race([proc.exited, killed.done.then(() => null)]),
        ]);
        signal.throwIfAborted();
        const parts = [
          timedOut
            ? `Timed out after ${timeout}ms (killed). If it needs longer, raise timeout_ms (max ${MAX_TIMEOUT_MS / 1000}s); for servers and watchers use run_in_background.`
            : `Exit code ${code}`,
        ];
        if (stdout) parts.push(`<stdout>\n${stdout}\n</stdout>`);
        if (stderr) parts.push(`<stderr>\n${stderr}\n</stderr>`);
        return { content: parts.join("\n"), isError: timedOut || code !== 0 };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
      }
    },
  };

  const idSchema = {
    type: "object",
    properties: { id: { type: "string", description: "id returned by bash with run_in_background" } },
    required: ["id"],
    additionalProperties: false,
  };
  const find = (id: string) => background.get(id);
  const unknown = (id: string) => ({
    content: `No background shell ${id}${background.size ? `; known: ${[...background.keys()].join(", ")}` : ""}`,
    isError: true,
  });

  const bashOutput: Tool = {
    name: "bash_output",
    description:
      "Return the output a background shell (started with bash run_in_background) has produced since the last bash_output call, " +
      "and whether it is still running. stdout and stderr are interleaved.",
    inputSchema: idSchema,
    effect: "read",
    concurrency: "safe",
    // 读走的输出不会再出现
    idempotent: false,
    async execute(input) {
      const { id } = input as { id: string };
      const bg = find(id);
      if (!bg) return unknown(id);
      const { unread, dropped } = bg;
      bg.unread = "";
      bg.dropped = 0;
      const title = bg.command.split("\n")[0]!;
      const head = `${id} (${title.length > 100 ? title.slice(0, 100) + "…" : title}): ${status(bg)}`;
      const note = dropped > 0 ? `\n(${dropped} earlier characters were dropped)` : "";
      return { content: unread ? `${head}${note}\n<output>\n${clip(unread)}\n</output>` : `${head}${note}\n(no new output)` };
    },
  };

  const killShell: Tool = {
    name: "kill_shell",
    description: "Stop a background shell started with bash run_in_background, together with the processes it started.",
    inputSchema: idSchema,
    // 只能停掉本会话自己启动、已经批准过的进程
    effect: "read",
    concurrency: "exclusive",
    idempotent: true,
    async execute(input) {
      const { id } = input as { id: string };
      const bg = find(id);
      if (!bg) return unknown(id);
      await stop(bg);
      return { content: `${id} stopped (${status(bg)})` };
    },
  };

  const run: RunCommand = (command, opts) => capture(executable, env, command, opts);

  return {
    tools: [bash, bashOutput, killShell],
    executable,
    run,
    shutdown() {
      for (const bg of background.values()) {
        if (bg.exitCode !== undefined) continue;
        bg.killed = true;
        killTree(executable, env, bg.proc);
      }
    },
    list: () => [...background.values()].map((bg) => ({ id: bg.id, command: bg.command, status: status(bg) })),
    async kill(id) {
      const bg = background.get(id);
      if (!bg) return false;
      await stop(bg);
      return true;
    },
  };
}

/**
 * 执行一条命令并把输出收下来（不经过模型、不推进度）；超时或中止时连同子进程一起杀掉。
 * 后台命令和别的插件（`shell@1`，例如 jade/checks）都用它
 */
export async function capture(executable: string, env: NodeJS.ProcessEnv | undefined, command: string, opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (text: string) => void }): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const proc = await launch(executable, env, command, opts.cwd);
  // 输出一到就推给调用方（用户自己执行的命令要边跑边看）；它出错不影响命令
  const onOutput = (text: string) => {
    try {
      opts.onOutput?.(text);
    } catch {
      // 调用方的错
    }
  };
  let timedOut = false;
  const killed = giveUp();
  const kill = () => {
    killTree(executable, env, proc);
    killed.start();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  opts.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout, onOutput, true, killed.done),
      collect(proc.stderr, onOutput, true, killed.done),
      Promise.race([proc.exited, killed.done.then(() => null)]),
    ]);
    opts.signal?.throwIfAborted();
    return { code: timedOut ? null : code, output: [stdout, stderr].filter(Boolean).join("\n"), timedOut };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
  }
}

/** ctx.progress 推送的内容 */
export interface ShellProgress {
  kind: "output";
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * 找到要执行的 shell 程序，找不到返回 undefined。
 *
 * Windows 上 Git for Windows 安装时默认只把 Git\cmd 加进 PATH，PATH 里通常找不到 bash，
 * 所以 bash、sh 还要从 git.exe 的位置和常见安装目录找 Git 的安装目录。
 * Git 的 bin\bash.exe、bin\sh.exe 只是启动器，真正的 shell 是它启动的 usr\bin 下的同名程序；
 * killTree 按 WINPID 找 msys 进程，用启动器的 pid 找不到，所以直接用 usr\bin 下的。
 * Git Bash 优先于 PATH 里别的 bash（例如 System32\bash.exe 是 WSL 的启动器，看不到 Windows 路径）
 */
export function findShell(shell: string): string | undefined {
  const found = which(shell);
  if (process.platform !== "win32") return found;
  const name = /^(bash|sh)(\.exe)?$/i.exec(shell)?.[1]?.toLowerCase();
  if (!name) return found;
  const inGit = (root: string) => {
    const real = path.join(root, "usr", "bin", `${name}.exe`);
    return existsSync(real) ? real : undefined;
  };
  const m = /^(.*\\Git)\\(usr\\)?bin\\(bash|sh)\.exe$/i.exec(found ?? "");
  if (m) return inGit(m[1]!) ?? found;
  // git.exe 在 Git\cmd、Git\bin 或 Git\mingw64\bin 下
  const git = which("git");
  const roots = git ? [path.dirname(path.dirname(git)), path.dirname(path.dirname(path.dirname(git)))] : [];
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]) {
    if (base) roots.push(path.join(base, "Git"));
  }
  for (const root of roots) {
    const real = inGit(root);
    if (real) return real;
  }
  return found;
}

/**
 * 直接执行 Git 的 usr\bin\bash.exe 时没有经过 bin\bash.exe 启动器，启动器会把 /usr/bin、/mingw64/bin 加进 PATH；
 * 不补上的话 PATH 里只有 Windows 的目录，cat、grep、head、sed 都找不到，find 还会变成 Windows 的 find.exe。
 * 不是 Git Bash 时返回 undefined，继承当前环境
 */
export function shellEnv(executable: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "win32") return undefined;
  const m = /^(.*\\Git)\\usr\\bin\\(bash|sh)\.exe$/i.exec(executable);
  if (!m) return undefined;
  const root = m[1]!;
  // Windows 的环境变量名不分大小写，展开成普通对象后要沿用原来的键名（通常是 Path），否则会同时出现 Path 和 PATH
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = [path.join(root, "usr", "bin"), path.join(root, "mingw64", "bin")];
  return { ...env, [key]: [...dirs, env[key]].filter(Boolean).join(path.delimiter) };
}

/** 启动的命令和它的标记（killTree 用） */
type Tagged = Proc & { tag: string };

/** 标记用的环境变量：命令启动的进程都继承它，killTree 在 Windows 上靠它把它们找出来 */
const TAG = "JADE_SHELL_TAG";
let launched = 0;

/** 启动 shell 执行一条命令 */
async function launch(executable: string, env: NodeJS.ProcessEnv | undefined, command: string, cwd: string | undefined): Promise<Tagged> {
  const tag = `${process.pid}-${Date.now().toString(36)}-${++launched}`;
  const proc = await spawnProc([executable, "-c", command], {
    cwd,
    env: process.platform === "win32" ? { ...(env ?? process.env), [TAG]: tag } : env,
    // 自成进程组，超时/中断时能连同子进程一起杀掉
    detached: process.platform !== "win32",
  });
  return Object.assign(proc, { tag });
}

/**
 * 只杀 shell 本身不够：它启动的子进程还占着 stdout/stderr 管道，读取会一直等到它们退出。
 * POSIX 上杀整个进程组。Windows 上 Git Bash（msys）模拟 fork，Windows 进程树里看不到父子关系；
 * 按 WINPID 找也不行：msys 的 exec（bash -c "npm login" 直接换成 npm 那个脚本）会换一个 Windows 进程，
 * 我们手里的 pid 只剩一个空壳。所以启动时在环境变量里放一个标记，这里在 msys 的 /proc 里把带标记的进程
 * 找出来，连同它们的进程组（里面有 node 这类不是 msys 的子进程）一起杀掉
 */
function killTree(shell: string, env: NodeJS.ProcessEnv | undefined, proc: Tagged) {
  try {
    if (process.platform !== "win32") return process.kill(-proc.pid, "SIGKILL");
    const script =
      `for d in /proc/[0-9]*; do ` +
      `if grep -qa "${TAG}=${proc.tag}" "$d/environ" 2>/dev/null || [ "$(cat "$d/winpid" 2>/dev/null)" = "${proc.pid}" ]; then ` +
      `kill -9 -- "-$(cat "$d/pgid")" "\${d#/proc/}" 2>/dev/null; fi; done`;
    // 先按 Windows 的进程树杀：cmd、node 这类不是 msys 的进程启动的子进程只有这里找得到，先杀掉它们的父进程就找不到了
    runSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)]);
    try {
      // 用没有标记的环境变量跑，免得它把自己也算进去
      runSync([shell, "-c", script], { env });
    } catch {
      // 不是 msys/cygwin 的 shell
    }
  } catch {
    // 已经退出
  }
}

/** 杀掉之后最多再等这么久就不等了：没杀干净的进程还占着输出管道时，读取永远等不到结束，这一轮（和整个界面）就卡在那里 */
const KILL_GRACE_MS = 2000;

/** start 之后过 KILL_GRACE_MS，done 就 resolve；不 start 永远不 resolve */
function giveUp(): { start(): void; done: Promise<void> } {
  let start = () => {};
  const done = new Promise<void>((resolve) => {
    start = () => void setTimeout(resolve, KILL_GRACE_MS);
  });
  return { start, done };
}

/**
 * 返回截好的输出：超过 MAX_OUTPUT_CHARS 时保留开头和结尾各一半，中间截掉。
 * 边读边截，输出再多也只占几倍 MAX_OUTPUT_CHARS 的内存。keep 为 false 时只推给 onChunk，不累积，返回空串
 */
async function collect(stream: AsyncIterable<Uint8Array>, onChunk: (text: string) => void, keep = true, stop?: Promise<void>): Promise<string> {
  const half = MAX_OUTPUT_CHARS / 2;
  const decoder = new TextDecoder();
  let head = "";
  let tail = "";
  let total = 0;
  const add = (text: string) => {
    onChunk(text);
    if (!keep) return;
    total += text.length;
    if (head.length < half) {
      const n = half - head.length;
      head += text.slice(0, n);
      text = text.slice(n);
    }
    tail += text;
    // 攒到两倍再截，不用每块都复制
    if (tail.length > 2 * half) tail = tail.slice(-half);
  };
  // stop：不再等（进程杀掉之后管道还被别的进程占着），返回已经读到的
  const it = stream[Symbol.asyncIterator]();
  const stopped = stop?.then(() => undefined);
  for (;;) {
    const r = await (stopped ? Promise.race([it.next(), stopped]) : it.next());
    if (!r) {
      void Promise.resolve(it.return?.()).catch(() => {});
      break;
    }
    if (r.done) break;
    const text = decoder.decode(r.value, { stream: true });
    if (text) add(text);
  }
  const rest = decoder.decode();
  if (rest) add(rest);
  if (total <= MAX_OUTPUT_CHARS) return (head + tail).trimEnd();
  return `${head}\n… (${total - MAX_OUTPUT_CHARS} characters omitted) …\n${tail.slice(-half)}`.trimEnd();
}

/** 保留开头和结尾，中间截掉 */
function clip(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s.trimEnd();
  const half = MAX_OUTPUT_CHARS / 2;
  return `${s.slice(0, half)}\n… (${s.length - MAX_OUTPUT_CHARS} characters omitted) …\n${s.slice(-half)}`.trimEnd();
}
