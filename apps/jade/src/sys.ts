// 跨运行时的进程、可执行文件查找和 glob：只用 Node 的标准库，Bun 和 Node ≥22.18 下走同一套代码。

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

/** jade 自己的版本号，src 和 dist 下都从包根目录的 package.json 读 */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

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

/** 同步运行，忽略输出和错误；用于退出前的清理 */
export function runSync(cmd: string[], opts: { env?: NodeJS.ProcessEnv } = {}): void {
  nodeSpawnSync(cmd[0]!, cmd.slice(1), { stdio: "ignore", windowsHide: true, env: opts.env });
}

export async function text(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
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

/**
 * 编译 glob，返回匹配函数。路径用正斜杠、相对于搜索根目录。
 * 和原先的 Bun.Glob#match 一致：* 也匹配点开头的文件，反斜杠是转义符而不是分隔符
 */
export function globMatcher(pattern: string): (rel: string) => boolean {
  return picomatch(pattern, { dot: true, windows: false });
}

/** 找 npm 的 CLI 脚本，用当前的 node 运行它：Windows 上 npm 是 .cmd，不经过 shell 不能直接执行 */
export function npmCommand(): string[] | undefined {
  const dirs = [path.dirname(process.execPath)];
  const onPath = which(process.platform === "win32" ? "npm.cmd" : "npm");
  if (onPath) dirs.push(path.dirname(onPath));
  for (const dir of dirs) {
    for (const cli of [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
      if (existsSync(cli)) return [process.execPath, cli];
    }
  }
  // POSIX 上 npm 本身就是可执行的脚本
  if (onPath && process.platform !== "win32") return [onPath];
  return undefined;
}
