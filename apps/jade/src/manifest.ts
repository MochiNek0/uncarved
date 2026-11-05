// 发现插件、读取并校验 plugin.json：不执行插件代码（原则 4）。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ConfigKey, Manifest, PluginLayer, PluginSource } from "./api.ts";

export interface LayerRoot {
  layer: PluginLayer;
  /** 这个目录下的每个子目录是一个插件 */
  root: string;
}

/** 读不出清单的插件目录 */
export interface BrokenSource {
  dir: string;
  layer: PluginLayer;
  error: string;
}

const SERVICE = /^[a-z0-9][\w.\-/]*@\d+$/i;
/** 核心自己的身份（调用方 id、交给内核的插件 id），插件不能用 */
const RESERVED_IDS: ReadonlySet<string> = new Set(["jade", "jade/core"]);
const ID = /^[a-z0-9][\w.\-]*(\/[a-z0-9][\w.\-]*)*$/i;

/** 插件 id 的形状；救援 CLI 用它拒绝带路径分隔符或 .. 的 id */
export function isPluginId(value: string): boolean {
  return ID.test(value);
}

/** 按层级顺序发现插件；层级内按目录名排序，结果稳定 */
export async function discover(roots: LayerRoot[]): Promise<{ sources: PluginSource[]; broken: BrokenSource[] }> {
  const sources: PluginSource[] = [];
  const broken: BrokenSource[] = [];
  for (const { layer, root } of roots) {
    let names: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      // . 开头的是安装时的临时目录（.staging-*、.old-*），不是插件。
      // --link 装的是符号链接/junction，Dirent 里不算目录，用 stat 跟过去再判断。
      names = entries.filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name).sort();
    } catch {
      continue; // 层级目录不存在：没有插件
    }
    for (const name of names) {
      const dir = path.resolve(root, name);
      const info = await stat(dir).catch((e: unknown) => e as Error);
      if (info instanceof Error) {
        broken.push({ dir, layer, error: `not a readable directory: ${info.message}` });
        continue;
      }
      if (!info.isDirectory()) continue;
      try {
        const raw: unknown = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
        sources.push({ manifest: parseManifest(raw), dir, layer });
      } catch (e) {
        broken.push({ dir, layer, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { sources, broken };
}

/** 校验清单的形状，出错时抛出说明哪个字段不对的错误 */
export function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("plugin.json: expected an object");
  const m = raw as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof m[k] !== "string" || m[k] === "") throw new Error(`plugin.json: "${k}" must be a non-empty string`);
    return m[k] as string;
  };
  const services = (k: string) => {
    const v = m[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !SERVICE.test(s))) {
      throw new Error(`plugin.json: "${k}" must be a list of services like "commands@1"`);
    }
    return v as string[];
  };
  const id = str("id");
  if (!ID.test(id)) throw new Error(`plugin.json: invalid id "${id}"`);
  if (RESERVED_IDS.has(id)) throw new Error(`plugin.json: id "${id}" is reserved for the core`);
  const manifest: Manifest = { id, version: str("version"), api: str("api") };
  if (parseCaret(manifest.api) === undefined) throw new Error(`plugin.json: "api" must be a ^ range like "^1", got "${manifest.api}"`);

  if ((m.entry === undefined) === (m.runtime === undefined)) throw new Error(`plugin.json: exactly one of "entry" and "runtime" is required`);
  if (m.entry !== undefined) manifest.entry = str("entry");
  if (m.runtime !== undefined) {
    const r = m.runtime as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || typeof r.command !== "string" || (r.args !== undefined && !(Array.isArray(r.args) && r.args.every((a) => typeof a === "string")))) {
      throw new Error(`plugin.json: "runtime" must be { command: string, args?: string[] }`);
    }
    manifest.runtime = { command: r.command, ...(r.args ? { args: r.args as string[] } : {}) };
  }

  for (const k of ["provides", "requires", "optional"] as const) {
    const v = services(k);
    if (v) manifest[k] = v;
  }
  if (m.replaces !== undefined) {
    if (!Array.isArray(m.replaces) || m.replaces.some((s) => typeof s !== "string")) throw new Error(`plugin.json: "replaces" must be a list of plugin ids`);
    manifest.replaces = m.replaces as string[];
  }
  if (m.frontend !== undefined) {
    const f = m.frontend as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null || typeof f.name !== "string" || (f.default !== undefined && typeof f.default !== "boolean") || (f.flag !== undefined && typeof f.flag !== "string")) {
      throw new Error(`plugin.json: "frontend" must be { name: string, default?: boolean, flag?: string }`);
    }
    manifest.frontend = { name: f.name, ...(f.default !== undefined ? { default: f.default as boolean } : {}), ...(f.flag !== undefined ? { flag: f.flag as string } : {}) };
  }
  if (m.config !== undefined) {
    const c = m.config as Record<string, unknown> | null;
    const bad = (k: string) => new Error(`plugin.json: "config.${k}" must be { default?, description?: string, project?: boolean }`);
    if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(`plugin.json: "config" must be an object of keys`);
    manifest.config = {};
    for (const [k, raw] of Object.entries(c)) {
      const v = raw as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(k);
      if ((v.description !== undefined && typeof v.description !== "string") || (v.project !== undefined && typeof v.project !== "boolean")) throw bad(k);
      manifest.config[k] = { ...v } as ConfigKey;
    }
  }
  return manifest;
}

/** "^1"、"^1.2"、"^0.3.1" → 数字列表；格式不对返回 undefined */
function parseCaret(range: string): number[] | undefined {
  const m = /^\^(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(range);
  return m ? m.slice(1).filter((x) => x !== undefined).map(Number) : undefined;
}

/** semver 的 ^ 规则，和内核的 satisfiesCaret 一致：第一个非零位（未写出的位不算）不变，且不低于范围本身 */
export function satisfiesCaret(range: string, version: string): boolean {
  const want = parseCaret(range);
  if (!want) return false;
  const have = version.split(".").map(Number);
  const fixed = want.findIndex((x) => x !== 0);
  const last = fixed === -1 ? want.length - 1 : fixed;
  for (let i = 0; i <= last; i++) if (have[i] !== want[i]) return false;
  for (let i = last + 1; i < 3; i++) {
    const h = have[i] ?? 0;
    const w = want[i] ?? 0;
    if (h !== w) return h > w;
  }
  return true;
}
