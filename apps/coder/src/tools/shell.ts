// bash 工具：在工作目录里执行一条 shell 命令。输出边读边通过 ctx.progress 推给宿主。

import { existsSync } from "node:fs";
import path from "node:path";
import type { Tool } from "uncarved";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

export interface ShellOptions {
  cwd: string;
  /** 默认 CODER_SHELL 环境变量，否则 bash（Windows 上是 Git Bash） */
  shell?: string;
}

export function shellTool(opts: ShellOptions): Tool {
  const shell = opts.shell ?? process.env.CODER_SHELL ?? "bash";
  const executable = realShell(shell);
  return {
    name: "bash",
    description:
      `Run a shell command with ${shell} -c in the working directory and return its exit code, stdout and stderr. ` +
      `Each call starts a fresh shell: cd and environment variables do not persist. ` +
      `Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s (timeout_ms, max ${MAX_TIMEOUT_MS / 1000}s). ` +
      "Do not start interactive programs or servers that never exit. Prefer read_file/grep/glob over cat/grep/find.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, timeout_ms: { type: "integer" } },
      required: ["command"],
      additionalProperties: false,
    },
    effect: "external",
    concurrency: "exclusive",
    idempotent: false,
    async execute(input, { signal, progress }) {
      const { command, timeout_ms } = input as { command: string; timeout_ms?: number };
      const timeout = Math.min(Math.max(timeout_ms ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const proc = Bun.spawn([executable, "-c", command], {
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // 自成进程组，超时/中断时能连同子进程一起杀掉
        detached: process.platform !== "win32",
      });
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
}

/** ctx.progress 推送的内容 */
export interface ShellProgress {
  kind: "output";
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * Git for Windows 的 bin\bash.exe、bin\sh.exe 只是启动器，真正的 shell 是它启动的 usr\bin 下的同名程序。
 * killTree 按 WINPID 找 msys 进程，用启动器的 pid 找不到，所以直接启动真正的 shell
 */
function realShell(shell: string): string {
  if (process.platform !== "win32") return shell;
  const m = /^(.*\\Git)\\bin\\(bash|sh)\.exe$/i.exec(Bun.which(shell) ?? "");
  if (!m) return shell;
  const real = path.join(m[1]!, "usr", "bin", `${m[2]}.exe`);
  return existsSync(real) ? real : shell;
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

async function collect(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (!text) continue;
    out += text;
    onChunk(text);
  }
  return out + decoder.decode();
}

/** 保留开头和结尾，中间截掉 */
function clip(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s.trimEnd();
  const half = MAX_OUTPUT_CHARS / 2;
  return `${s.slice(0, half)}\n… (${s.length - MAX_OUTPUT_CHARS} characters omitted) …\n${s.slice(-half)}`.trimEnd();
}
