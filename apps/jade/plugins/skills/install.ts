// /skills add|update|remove：从 git 仓库、npm 包或本地目录安装 skill。
//
// 不加 --project 装到 $JADE_HOME/skills/<名字>，加了装到 <工作目录>/.jade/skills/<名字>。
// 来源的写法和下载复用核心的 source.ts、fetch.ts（和 jade plugins add 同一份）：先下到 skills 目录里的 .staging-*
// （以 . 开头，查找 skill 时跳过），找到 SKILL.md 后再换进正式目录。
// 安装记录在 skills 目录的 .installed.json（按名字），update 按它重新下载；记录里有安装时的内容哈希，
// 装好后手动改过的默认不覆盖，要加 --force。skill 只是文字和附带的文件：安装不执行任何东西，也不装依赖。

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchSource, inSubdir } from "../../src/fetch.ts";
import { treeHash } from "../../src/hash.ts";
import { parseSource, type PluginSourceSpec } from "../../src/source.ts";
import { NAME, parseSkill } from "./skills.ts";

export interface SkillRecord {
  name: string;
  /** 用户写的来源 */
  source: string;
  /** 解析后的来源（git 地址、npm 写法或绝对路径）；更新时直接用它 */
  location: string;
  kind: PluginSourceSpec["kind"];
  ref?: string;
  subdir?: string;
  commit?: string;
  /** 安装时 skill 目录的内容哈希 */
  hash: string;
  installedAt: string;
  updatedAt?: string;
}

export interface InstallOptions {
  /** $JADE_HOME/skills 或 <工作目录>/.jade/skills */
  root: string;
  /** 解析相对路径用 */
  cwd: string;
  /** 只用来源里的这个子目录 */
  subdir?: string;
  /** 已有同名 skill，或装好后被手动改过时，照样替换 */
  force?: boolean;
  log?: (text: string) => void;
}

/** 不加 --project 装到 $JADE_HOME/skills，加了装到 <工作目录>/.jade/skills */
export const skillsRoot = (home: string, cwd: string, project: boolean) => (project ? path.join(cwd, ".jade", "skills") : path.join(home, "skills"));

const RECORDS = ".installed.json";

export async function readRecords(root: string): Promise<Record<string, SkillRecord>> {
  let text: string;
  try {
    text = await readFile(path.join(root, RECORDS), "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, SkillRecord>;
  } catch (e) {
    throw new Error(`${path.join(root, RECORDS)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function writeRecords(root: string, records: Record<string, SkillRecord>): Promise<void> {
  await writeFile(path.join(root, RECORDS), JSON.stringify(records, null, 2) + "\n");
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** 安装一个 skill，返回它的名字和目录 */
export async function addSkill(spec: string, opts: InstallOptions): Promise<{ name: string; dir: string }> {
  const source = await parseSource(spec, opts.cwd);
  const record = await install(source, opts);
  return { name: record.name, dir: path.join(path.resolve(opts.root), record.name) };
}

/** 按安装记录重新下载；没给名字时更新这个目录里所有装过的 skill。返回每个 skill 一行结果 */
export async function updateSkills(names: readonly string[], opts: Omit<InstallOptions, "subdir">): Promise<string[]> {
  const root = path.resolve(opts.root);
  const records = await readRecords(root);
  const lines: string[] = [];
  for (const name of names.length ? names : Object.keys(records).sort()) {
    const rec = records[name];
    if (!rec) {
      lines.push(`${name}: not installed with "/skills add"${(await exists(path.join(root, name))) ? "; update it by hand" : ""}`);
      continue;
    }
    try {
      const dir = path.join(root, name);
      if (!opts.force && (await exists(dir)) && (await treeHash(dir)) !== rec.hash) {
        lines.push(`${name}: changed since it was installed; add --force to overwrite the changes`);
        continue;
      }
      const source: PluginSourceSpec = { kind: rec.kind, location: rec.location, spec: rec.source, ...(rec.ref ? { ref: rec.ref } : {}) };
      const next = await install(source, { ...opts, force: true, ...(rec.subdir ? { subdir: rec.subdir } : {}) }, rec);
      lines.push(next.hash === rec.hash ? `current ${name}` : `updated ${name}`);
    } catch (e) {
      lines.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return lines;
}

/** 删掉一个 skill 目录和它的安装记录；手动放进去的也能删 */
export async function removeSkill(name: string, root: string): Promise<string> {
  if (!NAME.test(name)) throw new Error(`invalid skill name ${JSON.stringify(name)}`);
  root = path.resolve(root);
  const dir = path.join(root, name);
  if (!(await exists(path.join(dir, "SKILL.md")))) throw new Error(`there is no skill ${name} in ${root}`);
  await rm(dir, { recursive: true, force: true });
  const records = await readRecords(root);
  if (records[name]) {
    delete records[name];
    await writeRecords(root, records);
  }
  return dir;
}

/** 下载、找到 SKILL.md、换进正式目录、写安装记录。更新时 prev 给出原来的记录（名字不变） */
async function install(source: PluginSourceSpec, opts: InstallOptions, prev?: SkillRecord): Promise<SkillRecord> {
  const root = path.resolve(opts.root);
  // 本地来源包含 skills 目录时，staging 会被复制进去（甚至递归复制自己）
  if (source.kind === "local") {
    const from = opts.subdir ? inSubdir(source.location, opts.subdir) : source.location;
    const rel = path.relative(from, root);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      throw new Error(`${source.location} contains the skills directory; give the skill's own directory, or use --path`);
    }
  }
  await mkdir(root, { recursive: true });
  const records = await readRecords(root);
  const staging = path.join(root, `.staging-${randomBytes(4).toString("hex")}`);
  try {
    const { root: fetched, commit } = await fetchSource(source, staging, opts.log);
    const dir = opts.subdir ? inSubdir(fetched, opts.subdir) : fetched;
    if (!(await exists(path.join(dir, "SKILL.md")))) throw new Error(await noSkillMessage(source.spec, dir, fetched));
    const name = prev?.name ?? skillName(parseSkill(await readFile(path.join(dir, "SKILL.md"), "utf8")).meta.name, source, opts.subdir);
    const target = path.join(root, name);
    if (!opts.force && (await exists(target))) {
      throw new Error(`skill ${name} is already installed in ${target}; run "/skills update ${name}", or add --force to replace it`);
    }
    const hash = await treeHash(dir);
    await rm(target, { recursive: true, force: true });
    await rename(dir, target);
    const now = new Date().toISOString();
    const record: SkillRecord = {
      name,
      source: source.spec,
      location: source.location,
      kind: source.kind,
      ...(source.ref ? { ref: source.ref } : {}),
      ...(opts.subdir ? { subdir: opts.subdir } : {}),
      ...(commit ? { commit } : {}),
      hash,
      installedAt: prev?.installedAt ?? now,
      ...(prev ? { updatedAt: now } : {}),
    };
    records[name] = record;
    await writeRecords(root, records);
    return record;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** SKILL.md 里的 name；没有时用 --path 的最后一段，再没有就用仓库名、包名或目录名 */
function skillName(declared: string | undefined, source: PluginSourceSpec, subdir?: string): string {
  const fromSource =
    source.kind === "npm"
      ? source.location.replace(/^@[^/]+\//, "").replace(/@.*$/, "").replace(/\.(tgz|tar\.gz)$/i, "")
      : source.location.replace(/[\\/]+$/, "").replace(/\.git$/, "");
  const candidates = [declared, subdir && path.basename(subdir.replace(/[\\/]+$/, "")), path.basename(fromSource)];
  const name = candidates.find((c) => c && NAME.test(c));
  if (!name) throw new Error(`could not tell the skill's name; give it a "name:" in SKILL.md`);
  return name;
}

/** 来源里没有 SKILL.md 时：列出它里面的 skill，提示用 --path 选一个 */
async function noSkillMessage(spec: string, dir: string, fetched: string): Promise<string> {
  let found: string[] = [];
  try {
    found = (await readdir(fetched, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name === "SKILL.md")
      .map((e) => path.relative(fetched, e.parentPath).split(path.sep).join("/"))
      .filter((d) => d && !d.split("/").some((seg) => seg === "node_modules" || seg.startsWith(".")))
      .sort();
  } catch {
    // 没有可列的
  }
  const where = path.relative(fetched, dir).split(path.sep).join("/");
  const head = `${spec}${where ? ` (--path ${where})` : ""} has no SKILL.md`;
  if (found.length === 0) return `${head}; it is not a skill`;
  const shown = found.slice(0, 20).map((d) => `  ${d}`).join("\n") + (found.length > 20 ? `\n  … ${found.length - 20} more` : "");
  return `${head}. It contains these skills; pick one with --path <dir>:\n${shown}`;
}
