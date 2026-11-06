// 安装、更新、删除用户层或项目层插件（5.4、第 11 节）。
//
// 来源可以是本地目录、npm 包或 git 仓库（见 source.ts）。安装先下载到插件目录里的
// .staging-* 临时目录，检查 plugin.json、装好依赖之后再原子替换正式目录；失败不会留下装了一半的插件。
// 安装记录写在插件目录的 .installed.json 里（按插件 id），jade plugins update 按记录重新下载。
//
// 安装不执行插件的代码；npm 的依赖安装用 --ignore-scripts。

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashDir, type TrustStore } from "uncarved";
import { fetchPlugin, inSubdir, readPluginManifest } from "./fetch.ts";
import { treeHash } from "./hash.ts";
import { isPluginId } from "./manifest.ts";
import { parseSource, type PluginSourceSpec, type SourceKind } from "./source.ts";
import { forgetFaults, readPluginsConfig, writePluginsConfig } from "./state.ts";

/** 用户层/项目层插件的目录名：id 里的 / 换成 __ */
export const installDir = (root: string, id: string) => path.join(root, id.replaceAll("/", "__"));

/** 安装记录：更新时据此重新下载，也用来判断装好的插件有没有被手改过 */
export interface InstallRecord {
  id: string;
  /** 插件目录名（id 去掉 / 替换后的最后一段） */
  dir: string;
  /** 用户写的来源；本地路径是绝对路径 */
  source: string;
  /** 解析后的来源（git 地址、npm 写法或绝对路径）；更新时直接用它，不再按当前目录重新解析 source */
  location?: string;
  kind: SourceKind | "link";
  /** git 的分支、tag 或提交 */
  ref?: string;
  /** 只安装来源里的这个子目录 */
  subdir?: string;
  /** git：安装的提交 */
  commit?: string;
  version?: string;
  /** 安装时插件源码的哈希（不含 node_modules、.git 和包管理器的 lock 文件） */
  hash?: string;
  installedAt: string;
  updatedAt?: string;
}

export interface AddOptions {
  /** $JADE_HOME/plugins 或 <仓库>/.jade/plugins */
  root: string;
  /** 解析相对路径用 */
  cwd: string;
  subdir?: string;
  /** 本地目录：建链接而不是复制 */
  link?: boolean;
  /** 已经有同 id 的插件时替换它 */
  force?: boolean;
  /** 装进项目层：装好后把内容哈希写进信任存储 */
  project?: boolean;
  trust?: TrustStore;
  /** 进度（下载、安装依赖） */
  log?: (text: string) => void;
}

export interface Added {
  id: string;
  version: string;
  dir: string;
  record: InstallRecord;
}

export interface UpdateOptions {
  root: string;
  cwd: string;
  /** 覆盖装好后被手动改过的插件 */
  force?: boolean;
  project?: boolean;
  trust?: TrustStore;
  log?: (text: string) => void;
}

export type UpdateStatus = "updated" | "current" | "linked" | "unmanaged" | "modified" | "failed";

export interface UpdateResult {
  id: string;
  dir: string;
  status: UpdateStatus;
  from?: string;
  to?: string;
  error?: string;
}

/** 从本地目录、npm 包或 git 仓库安装一个插件 */
export async function addPlugin(spec: string, opts: AddOptions): Promise<Added> {
  const source = await parseSource(spec, opts.cwd);
  const root = path.resolve(opts.root);
  await mkdir(root, { recursive: true });
  // 先确认安装记录可读，别等插件已经装好才因为一个坏文件报错
  await readRecords(root);
  // 本地来源如果包含插件目录，staging 会被复制进去（甚至递归复制自己）
  if (source.kind === "local") {
    const from = opts.subdir ? inSubdir(source.location, opts.subdir) : path.resolve(source.location);
    const rel = path.relative(from, root);
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (inside) throw new Error(`${source.location} contains the plugins directory; add the plugin's own directory, or use --path`);
  }

  if (opts.link) {
    if (source.kind !== "local") throw new Error("--link only works with a local directory");
    return addLinked(source.location, opts, root);
  }

  const staging = path.join(root, `.staging-${randomBytes(4).toString("hex")}`);
  try {
    const fetched = await fetchPlugin(source, staging, opts.subdir, opts.log);
    const id = fetched.manifest.id;
    const target = installDir(root, id);
    await replaceDir(root, target, fetched.dir, { force: !!opts.force, label: id });
    const record: InstallRecord = {
      id,
      dir: path.basename(target),
      source: source.kind === "local" ? source.location : source.spec,
      location: source.location,
      kind: source.kind,
      ...(source.ref ? { ref: source.ref } : {}),
      ...(opts.subdir ? { subdir: opts.subdir } : {}),
      ...(fetched.commit ? { commit: fetched.commit } : {}),
      version: fetched.manifest.version,
      hash: fetched.hash,
      installedAt: now(),
    };
    await saveRecord(root, id, record);
    if (opts.project && opts.trust) await trustPlugin(opts.trust, target, opts.log);
    return { id, version: fetched.manifest.version, dir: target, record };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** --link：本地目录只建一个链接，更新时不用重新下载 */
async function addLinked(srcDir: string, opts: AddOptions, root: string): Promise<Added> {
  const dir = opts.subdir ? inSubdir(srcDir, opts.subdir) : srcDir;
  const manifest = await readPluginManifest(dir);
  const target = installDir(root, manifest.id);
  const existing = await lstat(target).catch(() => undefined);
  if (existing) {
    if (!opts.force) {
      throw new Error(`plugin ${manifest.id} is already installed in ${target}; run "jade plugins update ${manifest.id}", "jade plugins remove ${manifest.id}", or add --force`);
    }
    await removeDir(target);
  }
  await symlink(dir, target, process.platform === "win32" ? "junction" : "dir");
  const record: InstallRecord = {
    id: manifest.id,
    dir: path.basename(target),
    source: dir,
    kind: "link",
    version: manifest.version,
    installedAt: now(),
  };
  await saveRecord(root, manifest.id, record);
  if (opts.project && opts.trust) await trustPlugin(opts.trust, target, opts.log);
  return { id: manifest.id, version: manifest.version, dir: target, record };
}

/** 按安装记录重新下载；没给名字时更新这个插件目录里所有用 jade plugins add 装的插件 */
export async function updatePlugins(names: readonly string[], opts: UpdateOptions): Promise<UpdateResult[]> {
  const root = path.resolve(opts.root);
  const records = await readRecords(root);
  const seen = new Set<string>();
  const plan: { record?: InstallRecord; result?: UpdateResult }[] = [];

  if (names.length === 0) {
    for (const id of Object.keys(records).sort()) plan.push({ record: records[id]! });
  } else {
    for (const name of names) {
      const key = records[name] ? name : Object.keys(records).find((k) => records[k]!.id === name || records[k]!.dir === name);
      if (key) {
        if (!seen.has(key)) {
          seen.add(key);
          plan.push({ record: records[key]! });
        }
        continue;
      }
      // 没有安装记录：目录存在就说明是手动放进去的，没目录就是没装
      const dir = installDir(root, name);
      const exists = await lstat(dir).catch(() => undefined);
      plan.push({
        result: exists
          ? { id: name, dir, status: "unmanaged", error: 'not installed with "jade plugins add"; update it by hand' }
          : { id: name, dir, status: "failed", error: "not installed" },
      });
    }
  }

  const out: UpdateResult[] = [];
  for (const item of plan) out.push(item.result ?? (await updateOne(root, item.record!, opts)));
  return out;
}

async function updateOne(root: string, rec: InstallRecord, opts: UpdateOptions): Promise<UpdateResult> {
  const dir = path.join(root, rec.dir || path.basename(installDir(root, rec.id)));
  if (rec.kind === "link") return { id: rec.id, dir, status: "linked" };

  const exists = await lstat(dir).catch(() => undefined);
  const staging = path.join(root, `.staging-${randomBytes(4).toString("hex")}`);
  try {
    let modified = false;
    if (exists && rec.hash) modified = (await treeHash(dir)) !== rec.hash;

    opts.log?.(`${rec.id}: fetching ${rec.source}`);
    const kind = rec.kind as SourceKind;
    // 老记录没有 location，只能按当前目录重新解析；解析出的种类和安装时不同就不更新
    const source: PluginSourceSpec = rec.location
      ? { kind, location: rec.location, ...(rec.ref ? { ref: rec.ref } : {}), spec: rec.source }
      : await parseSource(rec.source, opts.cwd);
    if (source.kind !== kind) {
      throw new Error(`${rec.source} was installed as a ${kind} source but now reads as ${source.kind}; remove it and add it again`);
    }
    const fetched = await fetchPlugin(source, staging, rec.subdir, opts.log);
    if (fetched.manifest.id !== rec.id) {
      throw new Error(`plugin id changed from ${rec.id} to ${fetched.manifest.id}; remove it and add it again`);
    }
    const same = rec.kind === "git" ? rec.commit === fetched.commit : rec.kind === "npm" ? rec.version !== undefined && rec.version === fetched.manifest.version : rec.hash === fetched.hash;
    const to = fetched.commit?.slice(0, 7) ?? fetched.manifest.version;
    if (exists && same && !modified) return { id: rec.id, dir, status: "current", to };
    if (exists && modified && !opts.force) {
      return { id: rec.id, dir, status: "modified", error: `changed locally; run "jade plugins update --force ${rec.id}" to replace it` };
    }

    const from = rec.commit?.slice(0, 7) ?? rec.version;
    await replaceDir(root, dir, fetched.dir, { force: true, label: rec.id });
    const next: InstallRecord = { ...rec, version: fetched.manifest.version, hash: fetched.hash, updatedAt: now() };
    if (fetched.commit) next.commit = fetched.commit;
    else delete next.commit;
    await saveRecord(root, rec.id, next);
    if (opts.project && opts.trust) await trustPlugin(opts.trust, dir, opts.log);
    return { id: rec.id, dir, status: "updated", from, to };
  } catch (e) {
    return { id: rec.id, dir, status: "failed", error: e instanceof Error ? e.message : String(e) };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** 删掉一个插件目录和它的安装记录；链接只删链接本身，不碰它指向的目录 */
export async function removePlugin(id: string, opts: { root: string }): Promise<string> {
  if (!isPluginId(id)) throw new Error(`refusing to remove ${JSON.stringify(id)}: not a plugin id`);
  const root = path.resolve(opts.root);
  const dir = path.resolve(installDir(root, id));
  const rel = path.relative(root, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to remove ${dir}: it is not inside ${root}`);
  if (!(await lstat(dir).catch(() => undefined))) throw new Error(`${id} is not installed in ${root}`);
  // 先读出记录再删目录；记录文件坏了就什么都别动
  const records = await readRecords(root);
  await removeDir(dir);

  const keys = Object.keys(records).filter((k) => k === id || records[k]!.id === id || records[k]!.dir === path.basename(dir));
  for (const key of keys) delete records[key];
  if (keys.length > 0) await writeRecords(root, records);
  return dir;
}

/** 安装记录：<plugins 目录>/.installed.json 的 { plugins: { <id>: InstallRecord } } */
export async function readRecords(root: string): Promise<Record<string, InstallRecord>> {
  const file = recordsPath(root);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const plugins = (raw as { plugins?: unknown } | undefined)?.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return {};
  const out: Record<string, InstallRecord> = {};
  for (const [id, value] of Object.entries(plugins)) {
    const rec = value as Partial<InstallRecord> | null;
    if (typeof rec?.id !== "string" || typeof rec.source !== "string" || typeof rec.kind !== "string") continue;
    out[id] = { ...rec } as InstallRecord;
  }
  return out;
}

async function saveRecord(root: string, id: string, record: InstallRecord): Promise<void> {
  const records = await readRecords(root);
  records[id] = record;
  await writeRecords(root, records);
}

async function writeRecords(root: string, records: Record<string, InstallRecord>): Promise<void> {
  await mkdir(root, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
  const file = recordsPath(root);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ plugins: sorted }, null, 2)}\n`);
  await rename(tmp, file);
}

const recordsPath = (root: string) => path.join(root, ".installed.json");

/** 原子替换：先把旧目录改名，再把新目录放进来；失败时把旧目录放回去 */
async function replaceDir(root: string, target: string, incoming: string, opts: { force: boolean; label: string }): Promise<void> {
  const existing = await lstat(target).catch(() => undefined);
  if (existing && !opts.force) {
    throw new Error(`plugin ${opts.label} is already installed in ${target}; run "jade plugins update ${opts.label}", "jade plugins remove ${opts.label}", or add --force`);
  }
  if (!existing) {
    await rename(incoming, target);
    return;
  }
  const old = path.join(root, `.old-${randomBytes(4).toString("hex")}`);
  await rename(target, old);
  try {
    await rename(incoming, target);
  } catch (e) {
    await rename(old, target).catch(() => {});
    throw e;
  }
  await removeDir(old);
}

/** 链接（包括 Windows 的 junction）只删链接本身 */
async function removeDir(p: string): Promise<void> {
  const info = await lstat(p);
  if (info.isSymbolicLink()) {
    await unlink(p).catch(async () => {
      await rmdir(p);
    });
    return;
  }
  await rm(p, { recursive: true, force: true });
}

/** 项目层插件装好后记下内容哈希，下次启动不用再问；记不下时只提示，安装本身算成功 */
async function trustPlugin(trust: TrustStore, dir: string, log?: (text: string) => void): Promise<void> {
  try {
    const root = path.resolve(dir);
    const { hash } = await hashDir(root);
    if (!(await trust.has(hash))) await trust.add({ hash, path: root, at: now() });
  } catch (e) {
    log?.(`installed, but could not record trust: ${e instanceof Error ? e.message : String(e)}; jade will ask on the next launch`);
  }
}

/** 安装、删除之后清掉这个 id 的停用记录和连续崩溃记录；返回它原来是不是被用户停用了 */
export async function forgetPluginState(home: string, id: string): Promise<boolean> {
  const config = await readPluginsConfig(home);
  const wasDisabled = config.disabled.includes(id);
  if (wasDisabled) {
    config.disabled = config.disabled.filter((d) => d !== id);
    await writePluginsConfig(home, config);
  }
  await forgetFaults(home, id);
  return wasDisabled;
}

const now = () => new Date().toISOString();
