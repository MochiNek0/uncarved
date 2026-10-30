// bash 工具：在工作目录里执行一条 shell 命令。输出边读边通过 ctx.progress 推给宿主。

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
      const proc = Bun.spawn([shell, "-c", command], {
        cwd: opts.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout);
      const kill = () => proc.kill();
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
