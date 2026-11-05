// 跨运行时的进程和可执行文件查找：只用 Node 的标准库，Bun 和 Node ≥22.18 下走同一套代码。
// 和 jade/shell 里的 sys.ts 是同一份：插件之间不共享代码（见 docs/design/jade.md 3.5）。

import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export interface Proc {
  pid: number;
  /** 进程退出时 resolve 退出码；被信号杀掉时为 null */
  exited: Promise<number | null>;
  kill(): void;
}

export interface SpawnOptions {
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore";
}

/**
 * 启动进程，等到确实启动了才返回。程序不存在（ENOENT）等启动错误会 reject，
 * 调用方用 try/catch 判断"没装"，和 Bun.spawn 同步抛错的用法一致
 */
export function spawn(cmd: string[], opts: SpawnOptions = {}): Promise<Proc> {
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
    stdio: ["ignore", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
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
      resolve({ pid: child.pid!, exited, kill: () => void child.kill() });
    });
  });
}

/** which 的结果，按 PATH 和 PATHEXT 记；找不到的过一会儿再查 */
const found = new Map<string, { file: string | undefined; at: number }>();
const MISS_TTL_MS = 30_000;

/** 在 PATH 里找可执行文件，找不到返回 undefined。Windows 上按 PATHEXT 补扩展名；带路径分隔符时只检查那个文件 */
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
      // Windows 上没有扩展名的文件不能直接执行
      if (win && ext === "" && !path.extname(base)) continue;
      if (ok(base + ext)) return base + ext;
    }
    return undefined;
  };
  if (bin.includes("/") || (win && bin.includes("\\"))) return tryAll(path.resolve(bin));
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const hit = tryAll(path.join(dir.replace(/^"(.*)"$/, "$1"), bin));
    if (hit) return hit;
  }
  return undefined;
}
