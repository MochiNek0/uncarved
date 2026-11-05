// 跨运行时的进程和 glob：只用 Node 的标准库，Bun 和 Node ≥22.18 下走同一套代码。

import { spawn as nodeSpawn } from "node:child_process";
import picomatch from "picomatch";

type Stdio = "pipe" | "ignore";

export interface Proc {
  pid: number;
  /** stdout 为 "pipe" 时才有；Node 的 Readable 可以直接 for await 读出 Uint8Array */
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** 进程退出时 resolve 退出码；被信号杀掉时为 null */
  exited: Promise<number | null>;
  kill(): void;
}

export interface SpawnOptions {
  cwd?: string;
  stdout?: Stdio;
  stderr?: Stdio;
  /** POSIX 上自成进程组，便于连同子进程一起杀掉 */
  detached?: boolean;
  /** 子进程的环境变量，默认继承 process.env */
  env?: NodeJS.ProcessEnv;
}

const EMPTY: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {} };

/**
 * 启动进程，等到确实启动了才返回。程序不存在（ENOENT）等启动错误会 reject，
 * 调用方用 try/catch 判断"没装"，和 Bun.spawn 同步抛错的用法一致
 */
export function spawn(cmd: string[], opts: SpawnOptions = {}): Promise<Proc> {
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    stdio: ["ignore", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
    detached: opts.detached ?? false,
    env: opts.env,
    // Windows 上不弹出控制台窗口
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      // 启动之后的错误（例如 kill 一个已经退出的进程）不应该变成未处理的异常
      child.on("error", () => {});
      resolve({
        pid: child.pid!,
        stdout: child.stdout ?? EMPTY,
        stderr: child.stderr ?? EMPTY,
        exited,
        kill: () => void child.kill(),
      });
    });
  });
}

/** 运行一条命令，返回 stdout 文本和退出码；启动失败时 reject */
export async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<{ code: number | null; stdout: string }> {
  const proc = await spawn(cmd, { cwd: opts.cwd, stderr: "ignore" });
  const [stdout, code] = await Promise.all([text(proc.stdout), proc.exited]);
  return { code, stdout };
}

export async function text(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/**
 * 编译 glob，返回匹配函数。路径用正斜杠、相对于搜索根目录。
 * 和原先的 Bun.Glob#match 一致：* 也匹配点开头的文件，反斜杠是转义符而不是分隔符
 */
export function globMatcher(pattern: string): (rel: string) => boolean {
  return picomatch(pattern, { dot: true, windows: false });
}
