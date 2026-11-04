// 插件的安装、更新、卸载（jade plugin …）。
//
// 来源有三种：
// - git：https://…、git@…、github:user/repo、user/repo（本地没有这个路径时），可以用 #ref 指定分支、tag 或提交；
// - npm：包名（可以带 @版本）、npm:<任意 bun add 认识的写法>、本地的 .tgz；
// - 本地目录：复制过来；--link 时只建一个链接，方便开发插件。
// 先下载到插件目录里的 .staging-* 临时目录（以 . 开头，发现插件时会跳过），检查确实是插件、装好依赖之后再改名就位，
// 失败时不会留下装了一半的插件。安装记录在插件目录的 .installed.json 里，jade plugin update 按记录重新下载。
//
// 安装不执行插件的代码；插件的 package.json 有 dependencies 时安装依赖（Bun 下用 bun，Node 下用 npm，都不运行安装脚本）。

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectPlugin, type PluginInfo } from "./loader.ts";
import { npmCommand } from "../sys.ts";

export type SourceKind = "git" | "npm" | "local";

export interface PluginSource {
  kind: SourceKind;
  /** git：仓库地址；npm：交给 bun add 的写法；local：绝对路径 */
  location: string;
  /** git 的分支、tag 或提交 */
  ref?: string;
}

export interface InstallRecord {
  /** 用户写的来源（本地路径换成了绝对路径） */
  source: string;
  kind: SourceKind | "link";
  /** 只安装来源里的这个子目录 */
  subdir?: string;
  /** git：安装的提交 */
  commit?: string;
  version?: string;
  installedAt: string;
  updatedAt?: string;
}

export interface InstallOptions {
  /** 插件目录：$JADE_HOME/plugins 或 <仓库>/.jade/plugins */
  pluginsDir: string;
  /** 解析相对路径用 */
  cwd: string;
  /** 安装后的目录名，默认取插件声明的 name、包名或仓库名 */
  name?: string;
  subdir?: string;
  /** 本地目录：建链接而不是复制 */
  link?: boolean;
  /** 已经有同名插件时替换它 */
  force?: boolean;
  /** 进度（正在下载、正在安装依赖） */
  log?: (text: string) => void;
}

export interface Installed {
  name: string;
  dir: string;
  record: InstallRecord;
  info: PluginInfo;
}

/** 插件目录名 */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const RECORDS = ".installed.json";

/** 识别来源的种类 */
export async function parseSource(spec: string, cwd: string): Promise<PluginSource> {
  const s = spec.trim();
  if (!s) throw new Error("no plugin source given");
  if (s.startsWith("npm:")) return { kind: "npm", location: s.slice(4) };
  const [base, ref] = splitRef(s);
  if (/^github:/.test(base)) return { kind: "git", location: `https://github.com/${base.slice(7).replace(/\.git$/, "")}.git`, ref };
  if (/^gitlab:/.test(base)) return { kind: "git", location: `https://gitlab.com/${base.slice(7).replace(/\.git$/, "")}.git`, ref };
  if (/^git\+/.test(base)) return { kind: "git", location: base.slice(4), ref };
  if (/^(git@|ssh:\/\/|git:\/\/)/.test(base)) return { kind: "git", location: base, ref };
  if (/^https?:\/\//.test(base)) {
    if (/\.(tgz|tar\.gz)$/.test(base)) return { kind: "npm", location: s };
    return { kind: "git", location: base, ref };
  }
  const local = path.resolve(cwd, s.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
  const info = await stat(local).catch(() => undefined);
  if (info?.isDirectory()) return { kind: "local", location: local };
  if (info?.isFile()) {
    if (/\.(tgz|tar\.gz)$/.test(local)) return { kind: "npm", location: local };
    throw new Error(`${s} is a file; give a plugin directory, a .tgz package, a git URL or an npm package`);
  }
  // user/repo：本地没有这个路径时按 GitHub 仓库处理（npm 的包名不含 /，带作用域的以 @ 开头）
  if (/^[\w.-]+\/[\w.-]+$/.test(base) && !s.startsWith(".")) {
    return { kind: "git", location: `https://github.com/${base.replace(/\.git$/, "")}.git`, ref };
  }
  if (/^(\.|\/|[a-zA-Z]:[\\/])/.test(s)) throw new Error(`${s} does not exist`);
  return { kind: "npm", location: s };
}

/** "url#ref" 拆成两部分 */
function splitRef(s: string): [string, string | undefined] {
  const i = s.lastIndexOf("#");
  return i > 0 ? [s.slice(0, i), s.slice(i + 1) || undefined] : [s, undefined];
}

export async function addPlugin(spec: string, opts: InstallOptions): Promise<Installed> {
  const source = await parseSource(spec, opts.cwd);
  await mkdir(opts.pluginsDir, { recursive: true });

  if (opts.link) {
    if (source.kind !== "local") throw new Error("--link only works with a local directory");
    const dir = opts.subdir ? inSubdir(source.location, opts.subdir) : source.location;
    const info = await inspectPlugin(dir);
    const name = pickName(opts.name, info, dir);
    const target = path.join(opts.pluginsDir, name);
    await makeRoom(target, name, opts.force);
    await symlink(dir, target, process.platform === "win32" ? "junction" : "dir");
    const record: InstallRecord = { source: dir, kind: "link", installedAt: now(), ...(info.version ? { version: info.version } : {}) };
    await saveRecord(opts.pluginsDir, name, record);
    return { name, dir: target, record, info };
  }

  const staging = path.join(opts.pluginsDir, `.staging-${randomBytes(4).toString("hex")}`);
  try {
    const fetched = await fetchInto(source, staging, opts.subdir, opts.log);
    const name = pickName(opts.name, fetched.info, opts.subdir ?? nameHint(source));
    const target = path.join(opts.pluginsDir, name);
    await makeRoom(target, name, opts.force);
    await rename(fetched.dir, target);
    const record: InstallRecord = {
      source: source.kind === "local" ? source.location : spec.trim(),
      kind: source.kind,
      ...(opts.subdir ? { subdir: opts.subdir } : {}),
      ...(fetched.commit ? { commit: fetched.commit } : {}),
      ...(fetched.info.version ? { version: fetched.info.version } : {}),
      installedAt: now(),
    };
    await saveRecord(opts.pluginsDir, name, record);
    return { name, dir: target, record, info: fetched.info };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export interface UpdateResult {
  name: string;
  status: "updated" | "current" | "linked" | "unmanaged" | "failed";
  from?: string;
  to?: string;
  error?: string;
}

/** 按安装记录重新下载；没给名字时更新这个插件目录里所有用 jade plugin add 装的插件 */
export async function updatePlugins(names: string[], opts: Omit<InstallOptions, "name" | "subdir" | "link" | "force">): Promise<UpdateResult[]> {
  const records = await readRecords(opts.pluginsDir);
  const targets = names.length ? names : Object.keys(records).sort();
  const out: UpdateResult[] = [];
  for (const name of targets) {
    const rec = records[name];
    const target = path.join(opts.pluginsDir, name);
    if (!rec) {
      const exists = await stat(target).catch(() => undefined);
      out.push({ name, status: exists ? "unmanaged" : "failed", ...(exists ? {} : { error: "not installed" }) });
      continue;
    }
    if (rec.kind === "link") {
      out.push({ name, status: "linked" });
      continue;
    }
    const staging = path.join(opts.pluginsDir, `.staging-${randomBytes(4).toString("hex")}`);
    try {
      opts.log?.(`${name}: fetching ${rec.source}`);
      const source = await parseSource(rec.source, opts.cwd);
      const fetched = await fetchInto(source, staging, rec.subdir, opts.log);
      const from = rec.commit?.slice(0, 7) ?? rec.version;
      const to = fetched.commit?.slice(0, 7) ?? fetched.info.version;
      // git 看提交，npm 看版本；本地目录每次都重新复制
      const same = rec.kind === "git" ? rec.commit === fetched.commit : rec.kind === "npm" ? rec.version !== undefined && rec.version === fetched.info.version : false;
      if (same && (await stat(target).catch(() => undefined))) {
        out.push({ name, status: "current", to });
        continue;
      }
      const old = path.join(opts.pluginsDir, `.old-${randomBytes(4).toString("hex")}`);
      const had = Boolean(await lstat(target).catch(() => undefined));
      if (had) await rename(target, old);
      try {
        await rename(fetched.dir, target);
      } catch (err) {
        if (had) await rename(old, target).catch(() => {});
        throw err;
      }
      if (had) await removeDir(old);
      const next: InstallRecord = {
        ...rec,
        ...(fetched.commit ? { commit: fetched.commit } : {}),
        ...(fetched.info.version ? { version: fetched.info.version } : {}),
        updatedAt: now(),
      };
      await saveRecord(opts.pluginsDir, name, next);
      out.push({ name, status: "updated", from, to });
    } catch (err) {
      out.push({ name, status: "failed", error: err instanceof Error ? err.message : String(err) });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
  return out;
}

/** 删除插件目录（链接只删链接本身）和安装记录；不存在时返回 false */
export async function removePlugin(name: string, pluginsDir: string): Promise<boolean> {
  if (!PLUGIN_NAME.test(name)) throw new Error(`invalid plugin name ${JSON.stringify(name)}`);
  const target = path.join(pluginsDir, name);
  const existed = Boolean(await lstat(target).catch(() => undefined));
  if (existed) await removeDir(target);
  const records = await readRecords(pluginsDir);
  const recorded = name in records;
  if (recorded) {
    delete records[name];
    await writeRecords(pluginsDir, records);
  }
  return existed || recorded;
}

export async function readRecords(pluginsDir: string): Promise<Record<string, InstallRecord>> {
  try {
    const json = JSON.parse(await readFile(path.join(pluginsDir, RECORDS), "utf8"));
    return typeof json?.plugins === "object" && json.plugins !== null ? json.plugins : {};
  } catch {
    return {};
  }
}

async function writeRecords(pluginsDir: string, records: Record<string, InstallRecord>) {
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path.join(pluginsDir, RECORDS), `${JSON.stringify({ plugins: sorted }, null, 2)}\n`);
}

async function saveRecord(pluginsDir: string, name: string, record: InstallRecord) {
  const records = await readRecords(pluginsDir);
  records[name] = record;
  await writeRecords(pluginsDir, records);
}

// ---------- 下载 ----------

/** 下载到 staging 里，返回插件目录（staging 里的某个子目录） */
async function fetchInto(source: PluginSource, staging: string, subdir: string | undefined, log?: (text: string) => void) {
  await mkdir(staging, { recursive: true });
  let root: string;
  let commit: string | undefined;
  if (source.kind === "git") {
    root = path.join(staging, "repo");
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
    commit = (await run("git", ["rev-parse", "HEAD"], root)).trim();
    await rm(path.join(root, ".git"), { recursive: true, force: true });
  } else if (source.kind === "npm") {
    const work = path.join(staging, "npm");
    await mkdir(work);
    await writeFile(path.join(work, "package.json"), JSON.stringify({ name: "jade-plugin-download", private: true }));
    log?.(`downloading ${source.location}`);
    const pm = packageManager();
    await run(pm.cmd, [...pm.prefix, ...pm.add(source.location)], work);
    const deps = Object.keys((JSON.parse(await readFile(path.join(work, "package.json"), "utf8")).dependencies ?? {}) as Record<string, string>);
    if (deps.length !== 1) throw new Error(`could not tell which package ${source.location} installed`);
    root = path.join(staging, "package");
    // 包的依赖装在外层的 node_modules 里，复制过去之后重新安装
    await cp(path.join(work, "node_modules", deps[0]!), root, { recursive: true, dereference: true });
    // bun 在包目录里留下的标记，不属于插件
    await rm(path.join(root, ".bun-tag"), { force: true });
    await rm(work, { recursive: true, force: true });
  } else {
    root = path.join(staging, "local");
    log?.(`copying ${source.location}`);
    await cp(source.location, root, {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|\.git)$/.test(src),
    });
  }
  const dir = subdir ? inSubdir(root, subdir) : root;
  const info = await inspectPlugin(dir);
  await installDependencies(dir, log);
  return { dir, commit, info };
}

async function installDependencies(dir: string, log?: (text: string) => void) {
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

function inSubdir(root: string, subdir: string): string {
  const full = path.resolve(root, subdir);
  const rel = path.relative(root, full);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`--path ${subdir} points outside the source`);
  return full;
}

function nameHint(source: PluginSource): string {
  if (source.kind === "npm") return source.location.replace(/^(@[^/]+\/)?/, "").replace(/@.*$/, "").replace(/\.(tgz|tar\.gz)$/, "");
  return source.location.replace(/[\\/]+$/, "").replace(/\.git$/, "");
}

/** --name，否则插件声明的名字，否则来源的最后一段；整理成合法的目录名 */
function pickName(given: string | undefined, info: PluginInfo, hint: string): string {
  if (given !== undefined) {
    if (!PLUGIN_NAME.test(given)) throw new Error(`--name may only contain lowercase letters, digits, '.', '_' and '-'`);
    return given;
  }
  const raw = info.name ?? path.basename(hint);
  const name = raw
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  if (!PLUGIN_NAME.test(name)) throw new Error(`cannot derive a directory name from ${JSON.stringify(raw)}; pass --name`);
  return name;
}

async function makeRoom(target: string, name: string, force?: boolean) {
  if (!(await lstat(target).catch(() => undefined))) return;
  if (!force) throw new Error(`plugin ${name} is already installed (${target}); use jade plugin update, or --force to replace it`);
  await removeDir(target);
}

/** 链接（包括 Windows 的 junction）只删链接本身，不碰它指向的目录 */
async function removeDir(p: string) {
  const info = await lstat(p);
  if (info.isSymbolicLink()) {
    await unlink(p).catch(() => rmdir(p));
    return;
  }
  await rm(p, { recursive: true, force: true });
}

const now = () => new Date().toISOString();

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
    return { cmd: process.execPath, prefix: [], add: (spec) => ["add", "--ignore-scripts", spec], install: ["install", "--production"] };
  }
  const npm = npmCommand();
  if (!npm) throw new Error("npm was not found; it is needed to install plugins from npm or plugins with dependencies");
  const quiet = ["--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
  return { cmd: npm[0]!, prefix: npm.slice(1), add: (spec) => ["install", ...quiet, spec], install: ["install", "--omit=dev", ...quiet] };
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      if (err) {
        const detail = `${stderr || stdout}`.trim().split(/\r?\n/).slice(-6).join("\n");
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        const name = args[0]?.endsWith(".js") ? `npm ${args[1]}` : `${path.basename(cmd)} ${args[0]}`;
        reject(new Error(missing ? `${cmd} is not installed or not on PATH` : `${name} failed${detail ? `:\n${detail}` : ""}`));
      } else resolve(stdout);
    });
  });
}

// ---------- 启用、停用 ----------

/** $JADE_HOME/plugins.json：只有用户层能停用插件，仓库不能停用用户的插件或内置插件 */
export interface PluginSettings {
  /** 停用的插件的 id：内置插件（jade/web）或第三方插件（plugin.json 的 id） */
  disabled: string[];
}

export async function readPluginSettings(home: string): Promise<PluginSettings> {
  try {
    const json = JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8"));
    const disabled = Array.isArray(json?.disabled) ? json.disabled.filter((x: unknown): x is string => typeof x === "string") : [];
    return { disabled };
  } catch {
    return { disabled: [] };
  }
}

export async function setDisabled(home: string, name: string, disabled: boolean): Promise<boolean> {
  const s = await readPluginSettings(home);
  const has = s.disabled.includes(name);
  if (has === disabled) return false;
  const next = disabled ? [...s.disabled, name].sort() : s.disabled.filter((x) => x !== name);
  await mkdir(home, { recursive: true });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8"));
  } catch {
    // 不存在或格式不对时重写
  }
  await writeFile(path.join(home, "plugins.json"), `${JSON.stringify({ ...json, disabled: next }, null, 2)}\n`);
  return true;
}

/** 插件目录里的子目录名（不含 . 开头的临时目录） */
export async function installedNames(pluginsDir: string): Promise<string[]> {
  try {
    const names = (await readdir(pluginsDir)).filter((n) => !n.startsWith("."));
    const out: string[] = [];
    for (const n of names.sort()) if ((await stat(path.join(pluginsDir, n)).catch(() => undefined))?.isDirectory()) out.push(n);
    return out;
  } catch {
    return [];
  }
}
