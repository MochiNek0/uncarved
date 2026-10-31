// jade plugin …：安装、更新、卸载、停用插件。在会话外运行，不需要配置模型。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hashDir, type TrustStore } from "uncarved";
import { BUILTINS, BUILTIN_IDS, REQUIRED_IDS } from "./plugins/builtins.ts";
import {
  addPlugin,
  installedNames,
  readPluginSettings,
  readRecords,
  removePlugin,
  setDisabled,
  updatePlugins,
  type InstallRecord,
} from "./plugins/install.ts";
import { inspectPlugin, type PluginInfo } from "./plugins/loader.ts";
import { bold, dim, green, red, yellow } from "./ui/screen.ts";

export const PLUGIN_HELP = `Usage: jade plugin <command>

  list                          built-in and installed plugins
  add <source> [options]        install a plugin
      <source>: a git URL (https://…, git@…, github:user/repo, user/repo; #branch, #tag or #commit),
                an npm package (name, name@version, @scope/name, npm:<spec>, a .tgz file),
                or a local directory
      --project                 install into <repository>/.jade/plugins instead of $JADE_HOME/plugins
      --name <name>             directory name (default: the plugin's name)
      --path <dir>              use this subdirectory of the source (for repositories with several plugins)
      --link                    local directory: link it instead of copying (for plugin development)
      --force                   replace a plugin with the same name
  update [name…] [--project]    fetch again what jade plugin add installed (all of them when no name is given)
  remove <name> [--project]     delete an installed plugin
  disable <name|id>             stop loading a plugin, or a built-in plugin such as jade/web
  enable <name|id>              undo disable

Plugins are loaded when jade starts; restart running sessions to pick up changes.`;

export interface PluginCliOptions {
  home: string;
  cwd: string;
  /** 仓库根目录（--project 用） */
  root: string;
  /** --project 安装的插件代码已经由用户看过，写进确认记录 */
  trust: TrustStore;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** 返回退出码 */
export async function pluginCli(argv: string[], o: PluginCliOptions): Promise<number> {
  const out = o.out ?? ((t: string) => console.log(t));
  const err = o.err ?? ((t: string) => console.error(t));
  const [sub, ...rest] = argv;
  const flags = { project: false, link: false, force: false } as { project: boolean; link: boolean; force: boolean; name?: string; path?: string };
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--project") flags.project = true;
    else if (a === "--link") flags.link = true;
    else if (a === "--force" || a === "-f") flags.force = true;
    else if (a === "--name") flags.name = value();
    else if (a === "--path") flags.path = value();
    else if (a === "-h" || a === "--help") {
      out(PLUGIN_HELP);
      return 0;
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else args.push(a);
  }
  const userDir = path.join(o.home, "plugins");
  const projectDir = path.join(o.root, ".jade", "plugins");
  const dir = flags.project ? projectDir : userDir;
  const log = (t: string) => err(dim(t));

  switch (sub) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      out(PLUGIN_HELP);
      return 0;
    case "list":
    case "ls":
      await list(o, out);
      return 0;
    case "add":
    case "install": {
      if (args.length !== 1) throw new UsageError("usage: jade plugin add <source> [--project] [--name <name>] [--path <dir>] [--link] [--force]");
      const r = await addPlugin(args[0]!, { pluginsDir: dir, cwd: o.cwd, name: flags.name, subdir: flags.path, link: flags.link, force: flags.force, log });
      if (flags.project && r.info.kind === "module") await trustProject(r.dir, o.trust);
      out(green(`Installed ${bold(r.name)}${r.info.version ? ` ${r.info.version}` : ""} into ${r.dir}`) + dim(` (${origin(r.record)})`));
      for (const line of await provides(r.dir, r.info)) out(`  ${line}`);
      if (r.info.bundle.unsupported.length) out(yellow(`  jade does not support the plugin's ${r.info.bundle.unsupported.join(" and ")} yet; they are ignored`));
      if (flags.project) out(dim("  Commit .jade/plugins to share it; others confirm it the first time jade loads it."));
      out(dim("Restart jade to load it."));
      return 0;
    }
    case "update":
    case "upgrade": {
      const results = await updatePlugins(args, { pluginsDir: dir, cwd: o.cwd, log });
      if (results.length === 0) out(dim(`No plugins were installed with jade plugin add in ${dir}.`));
      let failed = false;
      for (const r of results) {
        if (r.status === "updated") {
          out(green(`${r.name}: updated${r.from || r.to ? ` ${r.from ?? "?"} → ${r.to ?? "?"}` : ""}`));
          if (flags.project) {
            const info = await inspectPlugin(path.join(dir, r.name)).catch(() => undefined);
            if (info?.kind === "module") await trustProject(path.join(dir, r.name), o.trust);
          }
        } else if (r.status === "current") out(`${r.name}: up to date${r.to ? ` (${r.to})` : ""}`);
        else if (r.status === "linked") out(dim(`${r.name}: linked to a local directory; nothing to fetch`));
        else if (r.status === "unmanaged") out(dim(`${r.name}: not installed with jade plugin add; update it by hand`));
        else {
          failed = true;
          err(red(`${r.name}: ${r.error}`));
        }
      }
      if (results.some((r) => r.status === "updated")) out(dim("Restart jade to load the new versions."));
      return failed ? 1 : 0;
    }
    case "remove":
    case "rm":
    case "uninstall": {
      if (args.length !== 1) throw new UsageError("usage: jade plugin remove <name> [--project]");
      if (!(await removePlugin(args[0]!, dir))) {
        err(red(`plugin ${args[0]} is not installed in ${dir}`));
        return 1;
      }
      await setDisabled(o.home, args[0]!, false);
      out(green(`Removed ${args[0]}.`));
      return 0;
    }
    case "disable":
    case "enable": {
      if (args.length !== 1) throw new UsageError(`usage: jade plugin ${sub} <name|id>`);
      const name = args[0]!;
      if (sub === "disable" && REQUIRED_IDS.has(name)) {
        err(red(`${name} cannot be disabled: it decides which tool calls need your approval. Plugins can only make it stricter, with gate hooks.`));
        return 1;
      }
      if (!BUILTIN_IDS.has(name) && !(await knownPlugin(o, name)) && sub === "disable") {
        err(yellow(`note: no built-in or installed plugin is called ${name}; it is disabled anyway in case it is a plugin id`));
      }
      const changed = await setDisabled(o.home, name, sub === "disable");
      out(changed ? green(`${name} ${sub}d.`) + dim(" Restart jade to apply it.") : dim(`${name} is already ${sub}d.`));
      return 0;
    }
    default:
      throw new UsageError(`unknown command ${sub}`);
  }
}

export class UsageError extends Error {}

async function list(o: PluginCliOptions, out: (t: string) => void) {
  const { disabled } = await readPluginSettings(o.home);
  const off = new Set(disabled);
  out(bold("Built-in") + dim("  (jade plugin disable <id> turns one off)"));
  const width = Math.max(...BUILTINS.map((b) => b.id.length)) + 2;
  for (const b of BUILTINS) {
    const state = b.required ? dim(" required") : off.has(b.id) ? yellow(" disabled") : "";
    out(`  ${b.id.padEnd(width)}${dim(b.about)}${state}`);
  }
  for (const [title, dir] of [
    ["User", path.join(o.home, "plugins")],
    ["Project", path.join(o.root, ".jade", "plugins")],
  ] as const) {
    const names = await installedNames(dir);
    out("");
    out(bold(title) + dim(`  ${dir}`));
    if (names.length === 0) {
      out(dim("  (none)"));
      continue;
    }
    const records = await readRecords(dir);
    for (const name of names) {
      const rec = records[name];
      let info: PluginInfo | undefined;
      let problem: string | undefined;
      try {
        info = await inspectPlugin(path.join(dir, name));
      } catch (e) {
        problem = e instanceof Error ? e.message : String(e);
      }
      const version = info?.version ?? rec?.version;
      const state = off.has(name) ? yellow(" disabled") : problem ? red(` broken: ${problem}`) : "";
      out(`  ${bold(name)}${version ? ` ${version}` : ""}${info ? dim(` ${info.kind}`) : ""}${rec ? dim(` · ${origin(rec)}`) : dim(" · copied by hand")}${state}`);
      if (info?.description) out(dim(`    ${info.description}`));
      if (info) for (const line of await provides(path.join(dir, name), info)) out(dim(`    ${line}`));
    }
  }
}

function origin(rec: InstallRecord): string {
  if (rec.kind === "link") return `linked to ${rec.source}`;
  const at = rec.commit ? `@${rec.commit.slice(0, 7)}` : "";
  return `${rec.source}${rec.subdir ? ` (${rec.subdir})` : ""}${at}`;
}

/** 插件带了哪些东西（代码的工具和 hook 要加载后才知道，这里只说它是什么形式） */
async function provides(dir: string, info: PluginInfo): Promise<string[]> {
  const lines: string[] = [];
  if (info.kind === "module") lines.push(`code: ${info.entry}`);
  if (info.kind === "process") lines.push(`process: ${[info.json.command, ...(info.json.args ?? [])].join(" ")}`);
  const skills: string[] = [];
  for (const d of info.bundle.skills) {
    for (const n of await readdir(d).catch(() => [] as string[])) {
      if (await readFile(path.join(d, n, "SKILL.md")).then(() => true, () => false)) skills.push(n);
    }
  }
  if (skills.length) lines.push(`skills: ${skills.sort().join(", ")}`);
  const commands: string[] = [];
  for (const d of info.bundle.commands) for (const n of await readdir(d).catch(() => [] as string[])) if (n.endsWith(".md")) commands.push(`/${n.slice(0, -3)}`);
  if (commands.length) lines.push(`commands: ${commands.sort().join(", ")}`);
  if (info.bundle.mcp) {
    let servers = info.bundle.mcp.servers;
    if (servers === undefined) servers = await readFile(info.bundle.mcp.file, "utf8").then((t) => JSON.parse(t)?.mcpServers, () => undefined);
    const names = servers && typeof servers === "object" ? Object.keys(servers) : [];
    lines.push(`MCP servers: ${names.length ? names.join(", ") : path.relative(dir, info.bundle.mcp.file)}`);
  }
  return lines;
}

async function knownPlugin(o: PluginCliOptions, name: string): Promise<boolean> {
  for (const dir of [path.join(o.home, "plugins"), path.join(o.root, ".jade", "plugins")]) if ((await installedNames(dir)).includes(name)) return true;
  return false;
}

/** 自己用 --project 装的插件不用在启动时再确认一次（别人拉取仓库后第一次加载时仍要确认） */
async function trustProject(dir: string, trust: TrustStore) {
  const root = path.resolve(dir);
  const { hash } = await hashDir(root);
  if (!(await trust.has(hash))) await trust.add({ hash, path: root, at: new Date().toISOString() });
}
