// bash 工具：在工作目录里执行一条 shell 命令。输出边读边通过 ctx.progress 推给宿主。
//
// run_in_background 的命令立即返回一个编号，进程留在后台（开发服务器、watch 等）；
// 用 bash_output 读取它的新输出，kill_shell 停止它。后台进程只属于本进程，宿主退出时调用 shutdown 全部杀掉。

import { existsSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import type { Tool } from "uncarved";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
/** 后台进程最多缓存这么多还没读取的输出，超出的丢弃最早的部分 */
const MAX_BUFFER_CHARS = 1_000_000;

export interface ShellOptions {
  cwd: string;
  /** 默认 JADE_SHELL 环境变量，否则 bash（Windows 上是 Git Bash） */
  shell?: string;
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
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** 还没被 bash_output 读走的输出 */
  unread: string;
  /** 因超出缓存而丢弃的字符数，下次读取时告诉模型 */
  dropped: number;
  exitCode?: number | null;
}

export function shellTools(opts: ShellOptions): ShellTools {
  const shell = opts.shell ?? process.env.JADE_SHELL ?? "bash";
  const found = findShell(shell);
  // 找不到 shell 时不提供这几个工具：否则模型每次调用都要用户先批准，执行时才失败，模型还会反复重试
  if (!found) {
    const hint = process.platform === "win32" ? "install Git for Windows, or set JADE_SHELL to the path of a bash executable" : "set JADE_SHELL to the path of a shell";
    return { tools: [], unavailable: `${shell} was not found, so the bash tool is disabled; ${hint}`, shutdown() {} };
  }
  const executable = found;
  const background = new Map<string, Background>();
  let nextId = 1;

  const spawn = (command: string) =>
    Bun.spawn([executable, "-c", command], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // 自成进程组，超时/中断时能连同子进程一起杀掉
      detached: process.platform !== "win32",
    });

  function startBackground(command: string): string {
    const id = `bg${nextId++}`;
    const bg: Background = { id, command, proc: spawn(command), unread: "", dropped: 0 };
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
    });
    background.set(id, bg);
    return id;
  }

  const status = (bg: Background) => (bg.exitCode === undefined ? "running" : `exited with code ${bg.exitCode}`);

  const bash: Tool = {
    name: "bash",
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
        const id = startBackground(command);
        return { content: `Started background shell ${id}. Read its output with bash_output, stop it with kill_shell.` };
      }
      const timeout = Math.min(Math.max(timeout_ms ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const proc = spawn(command);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(executable, proc.pid);
      }, timeout);
      const kill = () => killTree(executable, proc.pid);
      signal.addEventListener("abort", kill, { once: true });
      try {
        const [stdout, stderr, code] = await Promise.all([
          collect(proc.stdout, (text) => progress({ kind: "output", stream: "stdout", text })),
          collect(proc.stderr, (text) => progress({ kind: "output", stream: "stderr", text })),
          proc.exited,
        ]);
        signal.throwIfAborted();
        const parts = [timedOut ? `Timed out after ${timeout}ms (killed)` : `Exit code ${code}`];
        if (stdout) parts.push(`<stdout>\n${clip(stdout)}\n</stdout>`);
        if (stderr) parts.push(`<stderr>\n${clip(stderr)}\n</stderr>`);
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
      if (bg.exitCode === undefined) {
        killTree(executable, bg.proc.pid);
        await bg.proc.exited;
      }
      return { content: `${id} stopped (${status(bg)})` };
    },
  };

  return {
    tools: [bash, bashOutput, killShell],
    executable,
    shutdown() {
      for (const bg of background.values()) if (bg.exitCode === undefined) killTree(executable, bg.proc.pid);
    },
  };
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
  const found = Bun.which(shell) ?? undefined;
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
  const git = Bun.which("git");
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
 * 只杀 shell 本身不够：它启动的子进程还占着 stdout/stderr 管道，读取会一直等到它们退出。
 * POSIX 上杀整个进程组。Windows 上 Git Bash（msys）模拟 fork，Windows 进程树里看不到父子关系，
 * 要先在 msys 里按 WINPID 找到 shell 的 msys PID（它也是进程组号）杀掉整组；taskkill /T 兜底非 msys 的 shell
 */
function killTree(shell: string, pid: number) {
  try {
    if (process.platform !== "win32") return process.kill(-pid, "SIGKILL");
    const script = `for d in /proc/[0-9]*; do [ "$(cat "$d/winpid" 2>/dev/null)" = "${pid}" ] && kill -9 -- "-\${d#/proc/}"; done`;
    try {
      Bun.spawnSync([shell, "-c", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch {
      // 不是 msys/cygwin 的 shell
    }
    Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // 已经退出
  }
}

/** keep 为 false 时只推给 onChunk，不累积，返回空串 */
async function collect(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void, keep = true): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) continue;
    if (keep) out += text;
    onChunk(text);
  }
  const rest = decoder.decode();
  if (rest) onChunk(rest);
  return keep ? out + rest : "";
}

/** 保留开头和结尾，中间截掉 */
function clip(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s.trimEnd();
  const half = MAX_OUTPUT_CHARS / 2;
  return `${s.slice(0, half)}\n… (${s.length - MAX_OUTPUT_CHARS} characters omitted) …\n${s.slice(-half)}`.trimEnd();
}
