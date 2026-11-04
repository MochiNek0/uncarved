// 自定义命令：commands 目录里的每个 Markdown 文件是一个斜杠命令，文件名就是命令名，内容是发给模型的提示词。
//
// 用户层在 $JADE_HOME/commands，项目层在仓库根目录到工作目录之间每一级的 .jade/commands；
// 同名时离工作目录近的覆盖远的，项目层覆盖用户层。命令在启动时读一次。
//
// 文件开头可以有 YAML 风格的 front matter（只认 description 和 argument-hint 两个键）：
//   ---
//   description: 审查当前的改动
//   argument-hint: [文件或目录]
//   ---
// 正文里的 $ARGUMENTS 换成命令后面的全部参数，$1…$9 换成按空白分开的第几个参数；
// 正文里没有这些占位符而命令带了参数时，参数接在正文后面。

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Jade } from "./distro.ts";
import type { CommandInfo } from "./ui/screen.ts";

export interface CustomCommand {
  name: string;
  description: string;
  /** 参数提示，显示在菜单里 */
  args?: string;
  body: string;
  /** 文件的绝对路径 */
  file: string;
  layer: "user" | "project";
  /** 来自哪个插件 */
  plugin?: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]*$/i;

/** 解析一个命令文件 */
export function parseCommand(name: string, text: string, file: string, layer: CustomCommand["layer"]): CustomCommand {
  let body = text.replace(/^﻿/, "");
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (fm) {
    for (const line of fm[1]!.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
    body = body.slice(fm[0].length);
  }
  body = body.trim();
  const firstLine = body.split("\n").find((l) => l.trim() !== "")?.replace(/^#+\s*/, "").trim() ?? "";
  return {
    name,
    description: meta.description || (firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine) || "(custom command)",
    args: meta["argument-hint"] || undefined,
    body,
    file,
    layer,
  };
}

/** 把参数填进命令正文，得到要发给模型的消息 */
export function expandCommand(cmd: Pick<CustomCommand, "body">, args: string): string {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  let used = false;
  const text = cmd.body
    .replace(/\$ARGUMENTS\b/g, () => {
      used = true;
      return args.trim();
    })
    .replace(/\$([1-9])\b/g, (_, n: string) => {
      used = true;
      return words[Number(n) - 1] ?? "";
    });
  return !used && args.trim() ? `${text}\n\n${args.trim()}` : text;
}

async function loadDir(dir: string, layer: CustomCommand["layer"], into: Map<string, CustomCommand>, plugin?: string) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    if (!n.toLowerCase().endsWith(".md")) continue;
    const name = n.slice(0, -3).toLowerCase();
    if (!NAME.test(name)) continue;
    const file = path.join(dir, n);
    try {
      const cmd = parseCommand(name, await readFile(file, "utf8"), file, layer);
      into.set(name, plugin ? { ...cmd, plugin } : cmd);
    } catch {
      // 读不了的文件（目录、权限）跳过
    }
  }
}

/** 读取用户层和项目层的命令；root 是仓库根目录（不在仓库里时等于 cwd） */
export async function loadCommands(opts: {
  home: string;
  root: string;
  cwd: string;
  /** 插件带的 commands 目录，优先级低于同一层的 commands 目录 */
  plugins?: { plugin: string; dir: string; layer: CustomCommand["layer"] }[];
}): Promise<CustomCommand[]> {
  const out = new Map<string, CustomCommand>();
  const fromPlugins = async (layer: CustomCommand["layer"]) => {
    for (const p of opts.plugins ?? []) if (p.layer === layer) await loadDir(p.dir, layer, out, p.plugin);
  };
  await fromPlugins("user");
  await loadDir(path.join(opts.home, "commands"), "user", out);
  await fromPlugins("project");
  for (const d of projectDirs(opts.root, opts.cwd)) await loadDir(path.join(d, ".jade", "commands"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 从仓库根目录到工作目录的每一级目录，远的在前；工作目录不在仓库里时只有工作目录 */
export function projectDirs(root: string, cwd: string): string[] {
  const rel = path.relative(root, cwd);
  const inside = rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  if (!inside) return [cwd];
  const dirs = [root];
  if (rel) for (const seg of rel.split(path.sep)) dirs.push(path.join(dirs.at(-1)!, seg));
  return dirs;
}

/**
 * 斜杠命令同名时谁生效：宿主命令 > 内置插件的命令 > 自定义命令和 skill > 第三方插件（第三方之间先到先得）。
 * 内置插件和第三方插件之间的先后由 createJade 定（jade.commands 里内置插件优先；内置插件被代替或停用时，第三方插件可以用它的命令名）；
 * 这里再让第三方插件给宿主命令、自定义命令和 skill 让位。返回菜单里内置插件的和第三方插件的命令，以及被忽略的命令的警告
 */
export function pluginMenu(
  commands: Jade["commands"],
  taken: { host: Set<string>; custom: { has(name: string): boolean }; skill: { has(name: string): boolean } },
): { builtin: CommandInfo[]; plugins: CommandInfo[]; warnings: string[] } {
  const out = { builtin: [] as CommandInfo[], plugins: [] as CommandInfo[], warnings: [] as string[] };
  for (const [name, { plugin, command: c, builtin }] of commands) {
    if (builtin) {
      out.builtin.push({ name: c.name, args: c.args, about: c.description ?? "" });
      continue;
    }
    const what = taken.host.has(name) ? "a built-in command" : taken.custom.has(name) ? "a custom command" : taken.skill.has(name) ? "a skill" : undefined;
    if (what) out.warnings.push(`command /${c.name} of plugin ${plugin} is ignored: ${what} has that name`);
    else out.plugins.push({ name: c.name, args: c.args, about: `${c.description ?? ""} (plugin ${plugin})`.trim() });
  }
  return out;
}
