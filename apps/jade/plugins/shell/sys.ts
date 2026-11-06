// 跨运行时的进程和可执行文件查找：只用 Node 的标准库，Bun 和 Node ≥22.18 下走同一套代码。

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
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
