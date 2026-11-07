// 项目层插件的信任确认。对应宪法 7.1。
//
// 导入一个模块就会执行它的代码，所以确认必须发生在 import 之前：
// 项目层插件只能经 loadProjectPlugin 加载，Runtime 拒绝其他途径注册的项目层插件。

import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HookSpec } from "./hooks.ts";
import type { Plugin } from "./plugin.ts";
import type { Tool } from "./types.ts";

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

/**
 * 插件的一个子集：只留下 keep 选中的工具和 hook，其余字段不变。例如宿主只把第三方插件的工具级 hook 交给子 Agent。
 * 只能去掉、不能加入，所以已确认的项目层插件的子集仍然算已确认（运行的仍是确认过的代码）
 */
export function subsetPlugin(plugin: Plugin, keep: { tools?: (t: Tool) => boolean; hooks?: (h: HookSpec) => boolean }): Plugin {
  const p: Plugin = {
    ...plugin,
    tools: plugin.tools?.filter((t) => keep.tools?.(t) ?? true),
    hooks: plugin.hooks?.filter((h) => keep.hooks?.(h) ?? true),
  };
  if (confirmed.has(plugin)) confirmed.add(p);
  return p;
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
 * 入口模块的默认导出是 Plugin，或者返回 Plugin 的工厂函数（用 context 调用一次）。加载后 layer 固定为 "project"。
 */
export async function loadProjectPlugin(dir: string, opts: TrustOptions & { entry?: string; context?: unknown }): Promise<Plugin> {
  return (await loadProjectPluginFactory(dir, opts))(opts.context);
}

/**
 * 同 loadProjectPlugin，但返回一个工厂：宿主可以多次创建插件实例（例如每个会话一套），
 * 每次都传入自己的 context。确认只发生一次，工厂创建的每个实例都算作已确认的项目层插件。
 * 默认导出是 Plugin 对象时，工厂每次返回它的一份浅拷贝
 */
export async function loadProjectPluginFactory(
  dir: string,
  opts: TrustOptions & { entry?: string },
): Promise<(context?: unknown) => Promise<Plugin>> {
  const { module, mark } = await importProjectModule(dir, opts);
  const exported = (module as { default?: unknown }).default;
  if (typeof exported !== "function" && !isPluginLike(exported)) {
    throw new UntrustedPlugin(path.resolve(dir), "default export is neither a plugin nor a function returning one");
  }
  return async (context?: unknown) => {
    const made = typeof exported === "function" ? await (exported as (c: unknown) => unknown)(context) : exported;
    if (!isPluginLike(made)) throw new UntrustedPlugin(path.resolve(dir), "plugin factory did not return a plugin");
    return mark(made);
  };
}

/** importProjectModule 的结果 */
export interface ProjectModule {
  /** 入口模块的命名空间对象 */
  module: unknown;
  /**
   * 把由这份代码创建的插件标记为已确认的项目层插件（layer 固定为 "project"），返回标记后的浅拷贝。
   * 可以多次调用，例如宿主每个会话用这份代码创建一个插件。只能交给 Runtime 由这个模块创建的插件
   */
  mark(plugin: Plugin): Plugin;
}

/**
 * 确认并导入一个项目层插件目录的入口模块，模块的形状由宿主决定（7.1）。
 * 依次：对整个目录计算哈希、检查入口在目录内、检查 import 不出目录、未确认过的内容请求确认、
 * 等过确认的再核对一次哈希（早已确认过的不再算）、导入。任何一步不通过都抛 UntrustedPlugin，且不执行插件的任何代码。
 * 只想加载默认导出内核插件的模块时，用 loadProjectPlugin / loadProjectPluginFactory
 */
export async function importProjectModule(dir: string, opts: TrustOptions & { entry?: string }): Promise<ProjectModule> {
  const root = path.resolve(dir);
  const { hash, files } = await hashDir(root);
  // 入口必须是哈希过的文件，否则 "../x.js" 这样的入口会导入从未确认过的代码
  const entry = path.relative(root, path.resolve(root, opts.entry ?? "index.ts")).split(path.sep).join("/");
  if (!files.includes(entry)) throw new UntrustedPlugin(root, `entry ${JSON.stringify(opts.entry ?? "index.ts")} is not a file in the plugin directory`);
  await checkImports(root, files);
  const known = await opts.trust.has(hash);
  const grant = await requireTrust({ path: root, hash, files }, opts);
  // 等用户确认可能要很久，期间目录可能被改：确认的必须就是要导入的内容。
  // 早已确认过、没有等待的不再算一遍：带依赖的目录每次启动要多花一两秒，而且算的期间同样可能被改，并不更安全
  if (!known && (await hashDir(root)).hash !== hash) {
    grants.delete(grant);
    throw new UntrustedPlugin(root, "changed while waiting for confirmation");
  }

  const prev = imported.get(root);
  if (prev !== undefined && prev !== hash) throw new UntrustedPlugin(root, "changed since it was imported; restart to load it");
  imported.set(root, hash);

  const module: unknown = await import(pathToFileURL(path.join(root, entry)).href);
  // 凭据当场用掉：之后由 mark 直接标记这份代码创建的插件，它们的代码就是刚才确认并导入的代码
  if (!grants.delete(grant)) throw new UntrustedPlugin(root, "trust grant is not valid or already used");
  return {
    module,
    mark(plugin: Plugin): Plugin {
      const p: Plugin = { ...plugin, layer: "project" };
      confirmed.add(p);
      return p;
    },
  };
}

function isPluginLike(v: unknown): v is Plugin {
  return typeof v === "object" && v !== null && typeof (v as Plugin).id === "string";
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** import/export ... from "x"、import "x"、import("x")、require("x") 里的模块名 */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`]*)\1/g;
/** import( / require( 后面不是字符串字面量：模块名在运行时才确定 */
const COMPUTED = /\b(?:import|require)\s*\(\s*(?!["'`][^"'`$]*["'`]\s*\))/;
/** createRequire 返回的函数可以换个名字调用，SPECIFIER 认不出它加载的模块 */
const CREATE_REQUIRE = /\bcreateRequire\b/;
/** 类型声明文件不会被执行 */
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
/** 只导入类型的语句，编译后不存在，不加载任何代码 */
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*(["'`])[^"'`]*\1/gs;
/** 内核自己的包目录：插件从这里导入的是宿主已经在运行的代码 */
const KERNEL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 哈希只覆盖插件目录，所以插件代码不能加载目录之外的文件，否则那些文件变了也不会重新确认（7.1）。
 * 每个模块名都解析成文件：必须在插件目录内（包括插件自带的 node_modules），或者是内核自身、Node 内置模块。
 * 插件自己的代码里，无法静态确定的动态 import 和 createRequire 一律拒绝。
 * 插件自带的依赖（node_modules 下）只检查写成字面量的模块名：依赖里常见的 require(变量)、可选依赖
 * 属于依赖自己的运行时行为，和 eval 一样不在检查范围内；找不到的模块运行时也加载不到，跳过。
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
    if (!CODE_FILE.test(rel) || DECLARATION_FILE.test(rel)) continue;
    const dependency = rel.split("/").includes("node_modules");
    const file = path.join(root, rel);
    const code = (await readFile(file, "utf8")).replace(TYPE_ONLY, "");
    if (!dependency) {
      if (COMPUTED.test(code)) throw new UntrustedPlugin(root, `${rel}: dynamic import with a computed specifier is not allowed`);
      if (CREATE_REQUIRE.test(code)) throw new UntrustedPlugin(root, `${rel}: createRequire is not allowed`);
    }
    for (const [, , spec] of code.matchAll(SPECIFIER)) {
      if (isBuiltin(spec!)) continue;
      let target: string;
      if (spec!.startsWith("file:")) target = fileURLToPath(spec!);
      else if (spec!.startsWith(".") || path.isAbsolute(spec!)) target = path.resolve(path.dirname(file), spec!);
      else {
        // 只需知道包落在哪个目录：exports 里的路径不能指出包目录，所以不必按导入条件解析到具体文件。
        // 用 require 的规则解析会漏掉只声明了 import 条件的包（包括内核自己）
        const found = await packageDir(path.dirname(file), spec!);
        if (found === undefined) {
          if (dependency) continue;
          throw new UntrustedPlugin(root, `${rel}: cannot resolve ${JSON.stringify(spec)}`);
        }
        target = found;
        if (within(kernelDir, target)) continue;
      }
      if (!within(root, target) && !within(realRoot, target)) {
        throw new UntrustedPlugin(root, `${rel}: imports ${JSON.stringify(spec)} from outside the plugin directory`);
      }
    }
  }
}

/** 按 Node 查找 node_modules 的规则找到包目录，解析符号链接后返回；找不到返回 undefined */
async function packageDir(from: string, spec: string): Promise<string | undefined> {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const found = await realpath(path.join(dir, "node_modules", name)).catch(() => undefined);
      if (found !== undefined) return found;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * 目录内容哈希：按相对路径排序，依次计入 路径、长度、内容。
 * 符号链接可能指向目录之外，一律拒绝。例外是 node_modules/.bin 下包管理器生成的命令链接：
 * 代码不会 import 它们，不计入哈希
 */
export async function hashDir(root: string): Promise<{ hash: string; files: string[] }> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const rel = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/");
    if (e.isSymbolicLink()) {
      if (/(^|\/)node_modules\/\.bin\//.test(rel)) continue;
      throw new UntrustedPlugin(root, `symbolic link not allowed: ${rel}`);
    }
    if (e.isFile()) files.push(rel);
  }
  files.sort();
  const h = createHash("sha256");
  // 并发读取、按顺序计入：串行读几千个文件（带依赖的插件目录）要一秒以上
  const reads: Promise<Buffer>[] = [];
  const start = (i: number) => {
    if (i < files.length) reads[i] = readFile(path.join(root, files[i]!));
  };
  for (let i = 0; i < HASH_CONCURRENCY; i++) start(i);
  try {
    for (const [i, rel] of files.entries()) {
      const content = await reads[i]!;
      start(i + HASH_CONCURRENCY);
      h.update(`${rel}\0${content.length}\0`).update(content);
    }
  } finally {
    // 出错提前退出时，还在读的不要变成未处理的拒绝
    for (const r of reads) r?.catch(() => {});
  }
  return { hash: h.digest("hex"), files };
}

/** hashDir 同时读取的文件数 */
const HASH_CONCURRENCY = 32;
