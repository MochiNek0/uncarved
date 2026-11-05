// 执行检查命令：用 bash（Windows 上是 Git Bash）执行一条命令，收集输出，超时或中止时连同子进程一起杀掉。
// 进程和 shell 的查找从 jade/shell 的 sys.ts、shell.ts 复制：插件之间不共享代码（只能共享类型）。
// 只用 Node 的标准库，Bun 和 Node ≥22.18 下走同一套代码。

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

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

/** 同步运行，忽略输出和错误；用于退出前的清理 */
export function runSync(cmd: string[], opts: { env?: NodeJS.ProcessEnv } = {}): void {
  nodeSpawnSync(cmd[0]!, cmd.slice(1), { stdio: "ignore", windowsHide: true, env: opts.env });
}

/** which 的结果，按 PATH 和 PATHEXT 记；找不到的过一会儿再查（会话中途装上的工具能用上） */
const found = new Map<string, { file: string | undefined; at: number }>();
const MISS_TTL_MS = 30_000;

/**
 * 在 PATH 里找可执行文件，找不到返回 undefined。Windows 上按 PATHEXT 补扩展名；带路径分隔符时只检查那个文件。
 * 结果会记住：编辑后检查每批修改都要找 ruff、go，每次同步扫一遍 PATH 要几毫秒，期间事件循环停住
 */
export function which(bin: string): string | undefined {
  if (bin.includes("/") || (process.platform === "win32" && bin.includes("\\"))) return lookup(bin);
  const key = `${bin}\0${process.env.PATH ?? process.env.Path ?? ""}\0${process.env.PATHEXT ?? ""}`;
  const hit = found.get(key);
  if (hit && (hit.file !== undefined || Date.now() - hit.at < MISS_TTL_MS)) return hit.file;
  const file = lookup(bin);
  found.set(key, { file, at: Date.now() });
  return file;
}

function lookup(bin: string): string | undefined {
  const win = process.platform === "win32";
  const exts = win ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const ok = (file: string) => {
    try {
      if (!statSync(file).isFile()) return false;
      if (!win) accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const tryAll = (base: string) => {
    for (const ext of exts) {
      // Windows 上没有扩展名的文件不能直接执行（例如 npm 旁边那个给 Git Bash 用的 sh 脚本）
      if (win && ext === "" && !path.extname(base)) continue;
      if (ok(base + ext)) return base + ext;
    }
    return undefined;
  };
  if (bin.includes("/") || (win && bin.includes("\\"))) return tryAll(path.resolve(bin));
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = tryAll(path.join(dir.replace(/^"(.*)"$/, "$1"), bin));
    if (found) return found;
  }
  return undefined;
}

const MAX_OUTPUT_CHARS = 30_000;

export interface RunResult {
  /** 超时被杀掉时为 null */
  code: number | null;
  /** stdout 和 stderr 合在一起，超长时保留首尾 */
  output: string;
  timedOut: boolean;
}

export type RunCommand = (command: string, opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;

/** 用 shell（默认 JADE_SHELL，否则 bash）执行命令；找不到 shell 时返回说明 */
export function commandRunner(shell = process.env.JADE_SHELL ?? "bash"): { run: RunCommand } | { unavailable: string } {
  const executable = findShell(shell);
  if (!executable) {
    const hint = process.platform === "win32" ? "install Git for Windows, or set JADE_SHELL to the path of a bash executable" : "set JADE_SHELL to the path of a shell";
    return { unavailable: `${shell} was not found, so edit-time checks are off; ${hint}` };
  }
  const env = shellEnv(executable);
  const run: RunCommand = async (command, { cwd, timeoutMs, signal }) => {
    signal?.throwIfAborted();
    const proc = await spawn([executable, "-c", command], { cwd, env, detached: process.platform !== "win32" });
    let timedOut = false;
    const kill = () => killTree(executable, env, proc.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
      signal?.throwIfAborted();
      return { code: timedOut ? null : code, output: [stdout, stderr].filter(Boolean).join("\n"), timedOut };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  };
  return { run };
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
function shellEnv(executable: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "win32") return undefined;
  const m = /^(.*\\Git)\\usr\\bin\\(bash|sh)\.exe$/i.exec(executable);
  if (!m) return undefined;
  const root = m[1]!;
  // Windows 的环境变量名不分大小写，展开成普通对象后要沿用原来的键名（通常是 Path），否则会同时出现 Path 和 PATH
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = [path.join(root, "usr", "bin"), path.join(root, "mingw64", "bin")];
  return { ...env, [key]: [...dirs, env[key]].filter(Boolean).join(path.delimiter) };
}

/**
 * 只杀 shell 本身不够：它启动的子进程还占着 stdout/stderr 管道，读取会一直等到它们退出。
 * POSIX 上杀整个进程组。Windows 上 Git Bash（msys）模拟 fork，Windows 进程树里看不到父子关系，
 * 要先在 msys 里按 WINPID 找到 shell 的 msys PID（它也是进程组号）杀掉整组；taskkill /T 兜底非 msys 的 shell
 */
function killTree(shell: string, env: NodeJS.ProcessEnv | undefined, pid: number) {
  try {
    if (process.platform !== "win32") return process.kill(-pid, "SIGKILL");
    const script = `for d in /proc/[0-9]*; do [ "$(cat "$d/winpid" 2>/dev/null)" = "${pid}" ] && kill -9 -- "-\${d#/proc/}"; done`;
    try {
      runSync([shell, "-c", script], { env });
    } catch {
      // 不是 msys/cygwin 的 shell
    }
    runSync(["taskkill", "/T", "/F", "/PID", String(pid)]);
  } catch {
    // 已经退出
  }
}

/**
 * 返回截好的输出：超过 MAX_OUTPUT_CHARS 时保留开头和结尾各一半，中间截掉。
 * 边读边截，输出再多也只占几倍 MAX_OUTPUT_CHARS 的内存
 */
async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const half = MAX_OUTPUT_CHARS / 2;
  const decoder = new TextDecoder();
  let head = "";
  let tail = "";
  let total = 0;
  const add = (text: string) => {
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
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) add(text);
  }
  const rest = decoder.decode();
  if (rest) add(rest);
  if (total <= MAX_OUTPUT_CHARS) return (head + tail).trimEnd();
  return `${head}\n… (${total - MAX_OUTPUT_CHARS} characters omitted) …\n${tail.slice(-half)}`.trimEnd();
}
