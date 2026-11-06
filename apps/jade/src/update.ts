// jade 本身的升级：查 npm 上的最新版本，按 jade 的安装方式（npm、bun、pnpm、yarn 全局安装）升级。
// jade update 直接用这里（核心命令，插件坏了也能升级）；启动时的检查和后台升级在 jade/update 插件里，也用这里。
// 启动时的检查每天最多一次，结果缓存在 $JADE_HOME/update-check.json，查不到时什么也不说

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand, which } from "./fetch.ts";

export const PACKAGE = "@uncarved/jade";
/** 正在运行的 jade 的版本 */
export const VERSION: string = JSON.parse(readFileSync(path.join(packageDir(), "package.json"), "utf8")).version;
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
/** 后台升级最多跑这么久；锁文件比这更旧就当作上次升级的进程已经不在了 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 同一个版本升级失败后，隔这么久才再自动试 */
const RETRY_FAILED_MS = 24 * 60 * 60 * 1000;

/** 比较 x.y.z 版本号：a 比 b 新时为 true。带预发布后缀的只比主版本号，主版本号相同时正式版算更新 */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { parts: core!.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return d > 0;
  }
  return !x.pre && y.pre;
}

/** 从 npm registry 读最新版本号；网络不通、超时或返回不对时 reject */
export async function fetchLatest(signal?: AbortSignal): Promise<string> {
  const res = await fetch(LATEST_URL, {
    headers: { accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) throw new Error("npm registry gave no version");
  return version;
}

interface CheckCache {
  checkedAt: number;
  latest: string;
}

/**
 * 启动时用：有比当前更新的版本时返回它的版本号。距上次查询不到一天时用缓存，不发请求；
 * JADE_UPDATE_CHECK=off 时不查。任何错误都当作没有新版本
 */
export async function newerVersion(home: string, opts: { now?: number; current?: string; latest?: () => Promise<string> } = {}): Promise<string | undefined> {
  if (/^(0|off|false|no)$/i.test(process.env.JADE_UPDATE_CHECK?.trim() ?? "")) return undefined;
  const now = opts.now ?? Date.now();
  const current = opts.current ?? VERSION;
  const file = path.join(home, "update-check.json");
  let cache: CheckCache | undefined;
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as Partial<CheckCache>;
    if (typeof c.checkedAt === "number" && typeof c.latest === "string") cache = c as CheckCache;
  } catch {}
  if (!cache || now - cache.checkedAt >= CHECK_EVERY_MS || now < cache.checkedAt) {
    try {
      cache = { checkedAt: now, latest: await (opts.latest ?? fetchLatest)() };
    } catch {
      return undefined;
    }
    await mkdir(home, { recursive: true })
      .then(() => writeFile(file, JSON.stringify(cache) + "\n"))
      .catch(() => {});
  }
  return isNewer(cache.latest, current) ? cache.latest : undefined;
}

export type Install = { kind: "npm" | "bun" | "pnpm" | "yarn"; dir: string } | { kind: "dev"; dir: string };

/**
 * 看 jade 的包目录（解析符号链接后）在哪：不在 node_modules 里就是仓库里的开发版或 npm link；
 * 在 bun、pnpm、yarn 的全局目录里按对应工具算，其余按 npm 算
 */
export function detectInstall(dir: string = packageDir()): Install {
  const p = dir.replace(/\\/g, "/");
  if (!/\/node_modules\//.test(p)) return { kind: "dev", dir };
  if (/\/\.bun\/install\/global\//.test(p)) return { kind: "bun", dir };
  if (/\/pnpm\/|\/\.pnpm\//.test(p)) return { kind: "pnpm", dir };
  if (/\/yarn\/global\//i.test(p)) return { kind: "yarn", dir };
  return { kind: "npm", dir };
}

/** jade 的包根目录：src/update.ts 和 dist/update.js 都在它下面一层 */
function packageDir(): string {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** 给用户看的升级命令 */
export function upgradeHint(kind: Install["kind"] = detectInstall().kind): string {
  const spec = `${PACKAGE}@latest`;
  if (kind === "bun") return `bun add -g ${spec}`;
  if (kind === "pnpm") return `pnpm add -g ${spec}`;
  if (kind === "yarn") return `yarn global add ${spec}`;
  return `npm install -g ${spec}`;
}

/** 实际执行的升级命令；找不到对应的程序时为 undefined */
function upgradeCommand(kind: Install["kind"]): string[] | undefined {
  const spec = `${PACKAGE}@latest`;
  if (kind === "npm") {
    const npm = npmCommand();
    return npm && [...npm, "install", "-g", spec];
  }
  const bin = which(process.platform === "win32" && kind !== "bun" ? `${kind}.cmd` : kind);
  if (!bin) return undefined;
  if (kind === "bun") return [bin, "add", "-g", spec];
  if (kind === "pnpm") return [bin, "add", "-g", spec];
  return [bin, "global", "add", spec];
}

/** jade update：返回退出码。输出直接写到终端，安装命令的输出也直接显示 */
export async function updateCli(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(`Usage: jade update [--check]\n\n  Upgrade jade to the latest version on npm.\n  --check   only report whether a newer version exists`);
    return 0;
  }
  const unknown = args.find((a) => a !== "--check");
  if (unknown) {
    console.error(`jade update: unknown option ${unknown}`);
    return 2;
  }
  let latest: string;
  try {
    latest = await fetchLatest();
  } catch (err) {
    console.error(`jade update: could not reach the npm registry: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!isNewer(latest, VERSION)) {
    console.log(`jade ${VERSION} is up to date${latest !== VERSION ? ` (npm has ${latest})` : ""}.`);
    return 0;
  }
  const install = detectInstall();
  if (args.includes("--check")) {
    console.log(`jade ${latest} is available (you have ${VERSION}). Run: ${install.kind === "dev" ? upgradeHint("npm") : upgradeHint(install.kind)}`);
    return 0;
  }
  if (install.kind === "dev") {
    console.error(`jade update: this jade runs from ${install.dir}, not from a global install (a checkout or npm link); update it with git, or install the package with: ${upgradeHint("npm")}`);
    return 1;
  }
  const cmd = upgradeCommand(install.kind);
  if (!cmd) {
    console.error(`jade update: ${install.kind} was not found; run: ${upgradeHint(install.kind)}`);
    return 1;
  }
  console.log(`Updating jade ${VERSION} → ${latest} with ${install.kind}…`);
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
    child.on("error", () => resolve(-1));
    child.on("exit", (c) => resolve(c));
  });
  if (code !== 0) {
    console.error(`jade update: ${install.kind} failed${code === -1 ? " to start" : ` (exit ${code})`}. Run it yourself: ${upgradeHint(install.kind)}`);
    return 1;
  }
  console.log(`jade ${latest} is installed.`);
  return 0;
}

const off = (v: string | undefined) => /^(0|off|false|no)$/i.test(v?.trim() ?? "");

/** 自动升级是否打开：JADE_AUTO_UPDATE=off 关闭；JADE_UPDATE_CHECK=off 时连检查都不做 */
export function autoUpdateEnabled(): boolean {
  return !off(process.env.JADE_AUTO_UPDATE) && !off(process.env.JADE_UPDATE_CHECK);
}

export type AutoUpdateResult =
  /** 装好了，下次启动生效 */
  | { status: "installed" }
  /** 别的 jade 正在升级，或者这个版本不久前刚失败过：这次不试 */
  | { status: "skipped"; why: "busy" | "failed-recently" | "unsupported" }
  | { status: "failed"; log: string };

interface Attempt {
  version: string;
  at: number;
  ok: boolean;
}

/**
 * 在后台把 jade 升级到 latest。安装进程和 jade 脱离：jade 先退出时它照常装完，不会留下装了一半的包。
 * 多个 jade 同时启动时用 $JADE_HOME/update.lock 保证只有一个在装；输出写进 $JADE_HOME/update.log
 */
export async function autoUpdate(home: string, latest: string, opts: { install?: Install; command?: string[] } = {}): Promise<AutoUpdateResult> {
  const install = opts.install ?? detectInstall();
  if (install.kind === "dev") return { status: "skipped", why: "unsupported" };
  const cmd = opts.command ?? upgradeCommand(install.kind);
  if (!cmd) return { status: "skipped", why: "unsupported" };

  const attemptFile = path.join(home, "update-attempt.json");
  const last = await readFile(attemptFile, "utf8")
    .then((t) => JSON.parse(t) as Attempt)
    .catch(() => undefined);
  if (last && !last.ok && last.version === latest && Date.now() - last.at < RETRY_FAILED_MS) return { status: "skipped", why: "failed-recently" };

  await mkdir(home, { recursive: true });
  const lock = path.join(home, "update.lock");
  if (!(await takeLock(lock))) return { status: "skipped", why: "busy" };

  const log = path.join(home, "update.log");
  let ok = false;
  try {
    const fd = openSync(log, "w");
    try {
      ok = await new Promise<boolean>((resolve) => {
        const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
        const timer = setTimeout(() => resolve(false), INSTALL_TIMEOUT_MS);
        timer.unref();
        child.on("error", () => resolve(false));
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
        // jade 退出时不等它，它自己装完
        child.unref();
      });
    } finally {
      closeSync(fd);
    }
  } catch {
    ok = false;
  } finally {
    await rm(lock, { force: true }).catch(() => {});
  }
  await writeFile(attemptFile, JSON.stringify({ version: latest, at: Date.now(), ok } satisfies Attempt) + "\n").catch(() => {});
  return ok ? { status: "installed" } : { status: "failed", log };
}

/** 新建锁文件；已经有了且不算太旧时返回 false，太旧的（上次的进程不在了）删掉重来 */
async function takeLock(lock: string): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const h = await open(lock, "wx");
      await h.writeFile(String(process.pid));
      await h.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age < INSTALL_TIMEOUT_MS) return false;
      await rm(lock, { force: true }).catch(() => {});
    }
  }
  return false;
}
