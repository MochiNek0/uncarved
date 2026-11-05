// 把插件来源下载到 staging 目录（5.4）：
// - git：clone（可以指定分支、tag 或提交），删掉 .git；
// - npm：用包管理器把包安装到一个空目录，再把包目录复制过来；
// - 本地目录：复制（不复制 node_modules 和 .git）。
//
// 下载完检查 plugin.json，安装 package.json 里的 dependencies（--ignore-scripts，不执行插件的代码），
// 然后返回插件目录、提交、清单和内容哈希。清理 staging 是调用方的事。

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "./api.ts";
import { treeHash } from "./hash.ts";
import { parseManifest } from "./manifest.ts";
import type { PluginSourceSpec } from "./source.ts";

export interface Fetched {
  /** 插件目录（staging 里的某个子目录） */
  dir: string;
  /** git 安装的提交 */
  commit?: string;
  manifest: Manifest;
  /** 插件源码的哈希，安装/更新时记进安装记录 */
  hash: string;
}

export async function fetchPlugin(
  source: PluginSourceSpec,
  staging: string,
  subdir?: string,
  log?: (text: string) => void,
): Promise<Fetched> {
  await mkdir(staging, { recursive: true });
  let root: string;
  let commit: string | undefined;
  if (source.kind === "git") {
    ({ root, commit } = await fetchGit(source, staging, log));
  } else if (source.kind === "npm") {
    root = await fetchNpm(source.location, staging, log);
  } else {
    root = path.join(staging, "local");
    log?.(`copying ${source.location}`);
    await cp(source.location, root, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)$/.test(src),
    });
  }

  const dir = subdir ? inSubdir(root, subdir) : root;
  const manifest = await readPluginManifest(dir);
  const hash = await treeHash(dir);
  await installDependencies(dir, log);
  return { dir, commit, manifest, hash };
}

/** 读一个插件目录的 plugin.json；不是插件时给出能看懂的错误 */
export async function readPluginManifest(dir: string): Promise<Manifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  } catch (e) {
    throw new Error(`${dir}: not a jade plugin (${e instanceof Error ? e.message : String(e)})`);
  }
  return parseManifest(raw);
}

/** 把 --path 限制在来源目录里，不能跑到外面去 */
export function inSubdir(root: string, subdir: string): string {
  const full = path.resolve(root, subdir);
  const rel = path.relative(root, full);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`--path ${subdir} points outside the source`);
  }
  return full;
}

// ---------- git ----------

async function fetchGit(source: PluginSourceSpec, staging: string, log?: (text: string) => void): Promise<{ root: string; commit: string }> {
  const root = path.join(staging, "repo");
  log?.(`cloning ${source.location}${source.ref ? ` (${source.ref})` : ""}`);
  try {
    await run("git", ["clone", "--depth", "1", ...(source.ref ? ["--branch", source.ref] : []), "--", source.location, root], staging);
  } catch (err) {
    // --branch 不认提交哈希：完整克隆后再切过去
    if (!source.ref) throw err;
    await rm(root, { recursive: true, force: true });
    await run("git", ["clone", "--", source.location, root], staging);
    await run("git", ["checkout", "--detach", source.ref], root);
  }
  const commit = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  await rm(path.join(root, ".git"), { recursive: true, force: true });
  return { root, commit };
}

// ---------- npm ----------

async function fetchNpm(spec: string, staging: string, log?: (text: string) => void): Promise<string> {
  const work = path.join(staging, "npm");
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, "package.json"), JSON.stringify({ name: "jade-plugin-download", private: true }));
  log?.(`downloading ${spec}`);
  const pm = packageManager();
  await run(pm.cmd, [...pm.prefix, ...pm.add(spec)], work);

  const deps = Object.keys((JSON.parse(await readFile(path.join(work, "package.json"), "utf8")).dependencies ?? {}) as Record<string, string>);
  if (deps.length !== 1) throw new Error(`could not tell which package ${spec} installed`);
  const root = path.join(staging, "package");
  // 包的依赖装在外层的 node_modules 里；复制过去之后在插件目录里重新安装
  await cp(path.join(work, "node_modules", deps[0]!), root, { recursive: true, dereference: true });
  // bun 在包目录里留下的标记，不属于插件
  await rm(path.join(root, ".bun-tag"), { force: true });
  await rm(work, { recursive: true, force: true });
  return root;
}

async function installDependencies(dir: string, log?: (text: string) => void): Promise<void> {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return;
  }
  if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) return;
  log?.("installing dependencies");
  const pm = packageManager();
  await run(pm.cmd, [...pm.prefix, ...pm.install], dir);
}

interface PackageManager {
  cmd: string;
  /** 放在子命令前面的参数（npm 的 CLI 脚本路径） */
  prefix: string[];
  add(spec: string): string[];
  install: string[];
}

/** 跑在 Bun 下用 bun 自己；跑在 Node 下用 npm（Windows 上的 npm.cmd 不能直接执行，用 node 运行 npm 的 CLI 脚本） */
function packageManager(): PackageManager {
  if (process.versions.bun) {
    return {
      cmd: process.execPath,
      prefix: [],
      add: (spec) => ["add", "--ignore-scripts", spec],
      install: ["install", "--production", "--ignore-scripts"],
    };
  }
  const npm = npmCommand();
  if (!npm) throw new Error("npm was not found; it is needed to install plugins from npm or plugins with dependencies");
  const quiet = ["--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"];
  return {
    cmd: npm[0]!,
    prefix: npm.slice(1),
    add: (spec) => ["install", ...quiet, spec],
    install: ["install", "--omit=dev", ...quiet],
  };
}

/** npm 的 node 脚本；没有 npm 时返回 undefined */
function npmCommand(): string[] | undefined {
  const dirs = [path.dirname(process.execPath)];
  const onPath = which(process.platform === "win32" ? "npm.cmd" : "npm");
  if (onPath) dirs.push(path.dirname(onPath));
  for (const dir of dirs) {
    for (const cli of [
      path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]) {
      if (existsSync(cli)) return [process.execPath, cli];
    }
  }
  // POSIX 上 npm 本身就是可执行的脚本
  if (onPath && process.platform !== "win32") return [onPath];
  return undefined;
}

/** 在 PATH 里找一个可执行文件；Windows 上按 PATHEXT 补扩展名 */
function which(bin: string): string | undefined {
  const win = process.platform === "win32";
  const exts = win ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  for (const raw of dirs) {
    const dir = raw.replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const ext of exts) {
      if (win && ext === "" && !path.extname(bin)) continue;
      const file = path.join(dir, bin + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (!win) accessSync(file, constants.X_OK);
        return file;
      } catch {
        // 继续找
      }
    }
  }
  return undefined;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const detail = `${stderr || stdout}`.trim().split(/\r?\n/).slice(-6).join("\n");
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        const name = args[0]?.endsWith(".js") ? `npm ${args[1]}` : `${path.basename(cmd)} ${args[0]}`;
        reject(new Error(missing ? `${cmd} is not installed or not on PATH` : `${name} failed${detail ? `:\n${detail}` : ""}`));
      },
    );
  });
}
