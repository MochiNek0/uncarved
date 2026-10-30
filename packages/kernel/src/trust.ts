// 项目层插件的信任确认。对应宪法 7.1。
//
// 导入一个模块就会执行它的代码，所以确认必须发生在 import 之前：
// 项目层插件只能经 loadProjectPlugin 加载，Runtime 拒绝其他途径注册的项目层插件。

import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "./plugin.ts";

export interface TrustRecord {
  /** 插件目录内容的哈希，见 hashDir */
  hash: string;
  /** 确认时的目录，仅供展示 */
  path: string;
  at: string;
}

export interface TrustStore {
  has(hash: string): Promise<boolean>;
  add(record: TrustRecord): Promise<void>;
}

export class MemoryTrustStore implements TrustStore {
  #records = new Map<string, TrustRecord>();

  async has(hash: string): Promise<boolean> {
    return this.#records.has(hash);
  }

  async add(record: TrustRecord): Promise<void> {
    this.#records.set(record.hash, { ...record });
  }
}

/** 向用户请求确认。由发行版提供界面，内核不提供默认实现 */
export type ConfirmTrust = (request: { path: string; hash: string; files: string[] }) => Promise<boolean>;

export class UntrustedPlugin extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`project plugin ${path}: ${detail}`);
    this.name = "UntrustedPlugin";
    this.path = path;
  }
}

const confirmed = new WeakSet<Plugin>();
/** 本进程已导入的目录及其哈希。模块按路径缓存，内容变化后无法重新导入 */
const imported = new Map<string, string>();

export function isConfirmed(p: Plugin): boolean {
  return confirmed.has(p);
}

/** requireTrust 的结果，只能由它创建，只能使用一次 */
export interface TrustGrant {
  readonly hash: string;
  readonly path: string;
}
const grants = new WeakSet<TrustGrant>();

export interface TrustOptions {
  trust: TrustStore;
  confirm: ConfirmTrust;
  now?: () => string;
}

/** 查确认记录，没有就请求确认并保存；拒绝时抛出 UntrustedPlugin。必须在执行任何项目层代码之前调用 */
export async function requireTrust(
  request: { path: string; hash: string; files: string[] },
  opts: TrustOptions,
): Promise<TrustGrant> {
  const { path: p, hash } = request;
  if (!(await opts.trust.has(hash))) {
    if (!(await opts.confirm(request))) throw new UntrustedPlugin(p, "not confirmed");
    await opts.trust.add({ hash, path: p, at: (opts.now ?? (() => new Date().toISOString()))() });
  }
  const grant: TrustGrant = Object.freeze({ hash, path: p });
  grants.add(grant);
  return grant;
}

/** 凭确认结果把插件标记为项目层，Runtime 只接受这样标记过的项目层插件 */
export function asProjectPlugin(plugin: Plugin, grant: TrustGrant): Plugin {
  if (!grants.delete(grant)) throw new UntrustedPlugin(grant.path, "trust grant is not valid or already used");
  const p: Plugin = { ...plugin, layer: "project" };
  confirmed.add(p);
  return p;
}

/**
 * 加载项目层插件：先对整个目录计算哈希，未确认过的内容先请求确认，通过后才 import。
 * 入口模块的默认导出必须是 Plugin，加载后 layer 固定为 "project"。
 */
export async function loadProjectPlugin(dir: string, opts: TrustOptions & { entry?: string }): Promise<Plugin> {
  const root = path.resolve(dir);
  const { hash, files } = await hashDir(root);
  await checkImports(root, files);
  const grant = await requireTrust({ path: root, hash, files }, opts);

  const prev = imported.get(root);
  if (prev !== undefined && prev !== hash) throw new UntrustedPlugin(root, "changed since it was imported; restart to load it");
  imported.set(root, hash);

  const mod = (await import(pathToFileURL(path.join(root, opts.entry ?? "index.ts")).href)) as { default?: Plugin };
  if (!mod.default || typeof mod.default.id !== "string") throw new UntrustedPlugin(root, "default export is not a plugin");
  return asProjectPlugin(mod.default, grant);
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** import/export ... from "x"、import "x"、import("x")、require("x") 里的模块名 */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`]*)\1/g;
/** import( / require( 后面不是字符串字面量：模块名在运行时才确定 */
const COMPUTED = /\b(?:import|require)\s*\(\s*(?!["'`][^"'`$]*["'`]\s*\))/;
/** 只导入类型的语句，编译后不存在，不加载任何代码 */
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*(["'`])[^"'`]*\1/gs;
/** 内核自己的包目录：插件从这里导入的是宿主已经在运行的代码 */
const KERNEL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 哈希只覆盖插件目录，所以插件代码不能加载目录之外的文件，否则那些文件变了也不会重新确认（7.1）。
 * 每个模块名都解析成文件：必须在插件目录内（包括插件自带的 node_modules），或者是内核自身、Node 内置模块。
 * 无法静态确定的动态 import 一律拒绝。
 *
 * 这只能防住正常写法的 import：插件是任意代码，可以在运行时读文件再 eval，那属于用户确认过的代码自己的行为
 */
async function checkImports(root: string, files: string[]): Promise<void> {
  const within = (dir: string, target: string) => {
    const out = path.relative(dir, target);
    return out !== ".." && !out.startsWith(`..${path.sep}`) && !path.isAbsolute(out);
  };
  const kernelDir = await realpath(KERNEL_DIR);
  const realRoot = await realpath(root);
  for (const rel of files) {
    if (!CODE_FILE.test(rel)) continue;
    const file = path.join(root, rel);
    const code = (await readFile(file, "utf8")).replace(TYPE_ONLY, "");
    if (COMPUTED.test(code)) throw new UntrustedPlugin(root, `${rel}: dynamic import with a computed specifier is not allowed`);
    for (const [, , spec] of code.matchAll(SPECIFIER)) {
      if (isBuiltin(spec!)) continue;
      let target: string;
      if (spec!.startsWith("file:")) target = fileURLToPath(spec!);
      else if (spec!.startsWith(".") || path.isAbsolute(spec!)) target = path.resolve(path.dirname(file), spec!);
      else {
        // 包名按 Node 的规则解析（会解析符号链接），看它最终落在哪里
        try {
          target = createRequire(file).resolve(spec!);
        } catch {
          throw new UntrustedPlugin(root, `${rel}: cannot resolve ${JSON.stringify(spec)}`);
        }
        if (within(kernelDir, target)) continue;
      }
      if (!within(root, target) && !within(realRoot, target)) {
        throw new UntrustedPlugin(root, `${rel}: imports ${JSON.stringify(spec)} from outside the plugin directory`);
      }
    }
  }
}

/**
 * 目录内容哈希：按相对路径排序，依次计入 路径、长度、内容。
 * 符号链接可能指向目录之外，一律拒绝
 */
export async function hashDir(root: string): Promise<{ hash: string; files: string[] }> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const rel = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/");
    if (e.isSymbolicLink()) throw new UntrustedPlugin(root, `symbolic link not allowed: ${rel}`);
    if (e.isFile()) files.push(rel);
  }
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) {
    const content = await readFile(path.join(root, rel));
    h.update(`${rel}\0${content.length}\0`).update(content);
  }
  return { hash: h.digest("hex"), files };
}
