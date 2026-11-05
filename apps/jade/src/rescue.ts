// 救援 CLI：jade plugins list|add|update|remove|enable|disable。
// 只读写 plugins.json、faults.json、安装记录、信任存储和插件目录，不执行任何插件代码（5.4）。

import path from "node:path";
import type { TrustStore } from "uncarved";
import { readPluginManifest } from "./fetch.ts";
import { planPlugins, type HostOptions } from "./host.ts";
import { addPlugin, forgetPluginState, installDir, readRecords, removePlugin, updatePlugins, type InstallRecord, type UpdateResult } from "./install.ts";
import { forgetFaults, readFaults, readPluginsConfig, writeFaults, writePluginsConfig } from "./state.ts";

const USAGE = `usage: jade plugins <command>

  list                                  every plugin's state, services, and where it was installed from
  add <source> [options]                install a plugin
    <source>: a local directory, an npm package (name, name@version, @scope/name,
              npm:<spec>, a .tgz), or a git repository (https://…, git@…,
              github:user/repo, user/repo; add #branch, #tag or #commit at the end)
    --project                           install into <cwd>/.jade/plugins instead of $JADE_HOME/plugins
    --path <dir>                        use this subdirectory of the source
    --link                              local directory: link it instead of copying (for plugin development)
    --force                             replace a plugin with the same id
  update [id…] [--project] [--force]    fetch again what "jade plugins add" installed
                                        (all of them when no id is given); --force replaces local edits
  remove <id> [--project]               delete an installed plugin
  disable <id>                          stop loading a plugin
  enable <id>                           undo disable

Installing never runs the plugin's code; dependencies are installed with --ignore-scripts.`;

export type PluginsCommandOptions = Pick<HostOptions, "roots" | "home" | "flags" | "safe"> & {
  /** 项目层插件的信任记录；--project 安装时用它记下内容哈希 */
  trust?: TrustStore;
  /** 下载进度，写到 stderr */
  log?: (text: string) => void;
};

interface ParsedArgs {
  positionals: string[];
  project: boolean;
  link: boolean;
  force: boolean;
  path?: string;
  help: boolean;
}

/** 执行一条 plugins 子命令，返回要打印的文字；用法错误时抛错 */
export async function pluginsCommand(args: readonly string[], opts: PluginsCommandOptions): Promise<string> {
  if (args[0] === "-h" || args[0] === "--help") return USAGE;
  const [sub = "list", ...tail] = args;
  const parsed = parseArgs(tail);
  if (parsed.help) return USAGE;

  switch (sub) {
    case "list":
    case "ls":
      if (parsed.positionals.length > 0 || parsed.project || parsed.link || parsed.force || parsed.path) throw new Error(USAGE);
      return list(opts);
    case "add":
    case "install": {
      if (parsed.positionals.length !== 1) throw new Error(USAGE);
      const installed = await addPlugin(parsed.positionals[0]!, {
        root: installRoot(opts, parsed),
        cwd: process.cwd(),
        ...(parsed.path ? { subdir: parsed.path } : {}),
        ...(parsed.link ? { link: true } : {}),
        ...(parsed.force ? { force: true } : {}),
        project: parsed.project,
        ...(opts.trust ? { trust: opts.trust } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
      await forgetPluginState(opts.home, installed.id);
      let text = `installed ${installed.id}@${installed.version} into ${installed.dir}`;
      if (installed.record.kind !== "local") text += ` (${origin(installed.record)})`;
      if (parsed.project) text += `\nproject plugin: it will run with your permissions in this repository.`;
      return text;
    }
    case "update":
    case "upgrade": {
      if (parsed.link || parsed.path) throw new Error(USAGE);
      const results = await updatePlugins(parsed.positionals, {
        root: installRoot(opts, parsed),
        cwd: process.cwd(),
        ...(parsed.force ? { force: true } : {}),
        project: parsed.project,
        ...(opts.trust ? { trust: opts.trust } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      });
      // 更新之后清掉连续崩溃记录；用户显式停用的仍然保持停用
      for (const r of results) if (r.status === "updated") await forgetFaults(opts.home, r.id);
      const lines = results.map(describe);
      if (results.some((r) => r.status === "updated")) lines.push("restart jade to load the new versions.");
      return lines.length > 0 ? lines.join("\n") : 'no plugins were installed with "jade plugins add"';
    }
    case "remove":
    case "rm":
    case "uninstall": {
      if (parsed.positionals.length !== 1 || parsed.link || parsed.force || parsed.path) throw new Error(USAGE);
      const id = parsed.positionals[0]!;
      const root = installRoot(opts, parsed);
      // 停用记录按插件 id；给的是目录名时先读清单换成 id
      const manifest = await readPluginManifest(installDir(root, id)).catch(() => undefined);
      const dir = await removePlugin(id, { root });
      await forgetPluginState(opts.home, manifest?.id ?? id);
      return `removed ${id} (${dir})`;
    }
    case "disable":
    case "enable": {
      if (parsed.positionals.length !== 1 || parsed.project || parsed.link || parsed.force || parsed.path) throw new Error(USAGE);
      return enableOrDisable(sub, parsed.positionals[0]!, opts);
    }
    default:
      throw new Error(USAGE);
  }
}

async function enableOrDisable(sub: "enable" | "disable", id: string, opts: PluginsCommandOptions): Promise<string> {
  const { plan } = await planPlugins(opts);
  const known = plan.entries.some((e) => e.source.manifest.id === id);
  const config = await readPluginsConfig(opts.home);
  if (sub === "disable") {
    if (!config.disabled.includes(id)) config.disabled.push(id);
    await writePluginsConfig(opts.home, config);
    return known ? `disabled ${id}` : `disabled ${id} (no installed plugin has this id)`;
  }
  config.disabled = config.disabled.filter((d) => d !== id);
  await writePluginsConfig(opts.home, config);
  // 同时清掉连续崩溃的记录，否则下次启动又被自动停用
  const faults = await readFaults(opts.home);
  faults.autoDisabled = faults.autoDisabled.filter((d) => d !== id);
  delete faults.streaks[id];
  await writeFaults(opts.home, faults);
  return known ? `enabled ${id}` : `enabled ${id} (no installed plugin has this id)`;
}

/** 用户层插件的目录（`jade plugins add` 默认装到这里） */
const userRoot = (opts: Pick<HostOptions, "roots">): string =>
  opts.roots.find((r) => r.layer === "user")?.root ?? path.join(process.env.JADE_HOME ?? "", "plugins");

const projectRoot = (opts: Pick<HostOptions, "roots">): string =>
  opts.roots.find((r) => r.layer === "project")?.root ?? path.join(process.cwd(), ".jade", "plugins");

const installRoot = (opts: Pick<HostOptions, "roots">, parsed: ParsedArgs): string => (parsed.project ? projectRoot(opts) : userRoot(opts));

function parseArgs(tail: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positionals: [], project: false, link: false, force: false, help: false };
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    const value = (name: string) => {
      const v = tail[++i];
      if (v === undefined) throw new Error(`${name} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--project") out.project = true;
    else if (a === "--link") out.link = true;
    else if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--path") out.path = value(a);
    else if (a.startsWith("--path=")) out.path = a.slice("--path=".length);
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${USAGE}`);
    else out.positionals.push(a);
  }
  return out;
}

function describe(r: UpdateResult): string {
  switch (r.status) {
    case "updated": {
      if (r.from && r.to && r.from !== r.to) return `updated ${r.id} ${r.from} → ${r.to}`;
      return `updated ${r.id}${r.to ? ` (${r.to})` : ""}`;
    }
    case "current":
      return `current ${r.id}${r.to ? ` (${r.to})` : ""}`;
    case "linked":
      return `linked ${r.id} (local directory; nothing to fetch)`;
    case "unmanaged":
    case "modified":
    case "failed":
      return `${r.id}: ${r.error}`;
  }
}

/** 按清单和状态文件推算出的状态：不激活插件，所以看不到激活阶段的失败（那些记在连续崩溃次数里） */
async function list(opts: PluginsCommandOptions): Promise<string> {
  const { plan, broken, faults } = await planPlugins(opts);
  const records = new Map<string, InstallRecord>();
  for (const { root } of opts.roots) {
    for (const rec of Object.values(await readRecords(root))) records.set(rec.id, rec);
  }

  const lines: string[] = [];
  for (const e of plan.entries) {
    const m = e.source.manifest;
    const streak = faults.streaks[m.id];
    const note = e.reason ?? (streak ? `faulted in the last ${streak.count} launch(es): ${streak.last}` : "");
    const rec = records.get(m.id);
    lines.push(
      `${m.id}@${m.version}  ${e.source.layer}  ${e.state}${note ? `  ${note}` : ""}${rec ? `  from ${origin(rec)}` : ""}`,
    );
  }
  for (const b of broken) lines.push(`${b.dir}  ${b.layer}  broken  ${b.error}`);
  for (const w of plan.warnings) lines.push(`warning: ${w}`);
  if (plan.providers.size > 0) {
    lines.push("", "services:");
    for (const [service, id] of [...plan.providers].sort()) lines.push(`  ${service}  ${id}`);
  }
  if (faults.unattributed.length > 0) lines.push("", `${faults.unattributed.length} recent error(s) not attributable to any plugin, see state/faults.json`);
  return lines.length > 0 ? lines.join("\n") : "no plugins installed";
}

function origin(rec: InstallRecord): string {
  if (rec.kind === "link") return `link ${rec.source}`;
  const at = rec.commit ? `@${rec.commit.slice(0, 7)}` : "";
  if (rec.kind === "npm") return `${rec.source.startsWith("npm:") ? rec.source : `npm ${rec.source}`}${at}`;
  if (rec.kind === "git") return `${rec.source.startsWith("git+") ? rec.source : `git ${rec.source}`}${at}`;
  return `${rec.source}${at}`;
}
