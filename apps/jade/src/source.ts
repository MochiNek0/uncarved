// 插件来源的识别（5.4）：本地目录、npm 包、git 仓库。
// 只判断来源，不下载，也不执行插件代码；下载在 fetch.ts。
//
// 可以写：
// - 本地目录：相对或绝对路径；
// - npm：包名（可以带 @版本）、npm:<包管理器认识的写法>、本地或远程的 .tgz；
// - git：https://…、git@…、ssh://…、git+…、github:user/repo、user/repo，可以带 #分支、tag 或提交。

import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PluginSourceSpec } from "./api.ts";
export type { PluginSourceSpec, SourceKind } from "./api.ts";

/** 识别一个来源。本地路径在这里就已经解析成绝对路径；不检查插件的 plugin.json */
export async function parseSource(text: string, cwd: string): Promise<PluginSourceSpec> {
  const spec = text.trim();
  if (!spec) throw new Error("no plugin source given");

  if (spec.startsWith("npm:")) {
    const inner = spec.slice(4);
    // npm: 里也可以写本地路径（npm install ./dir、file:./dir）；相对路径要按 jade 的工作目录解析，而不是下载目录
    const location = /^(\.|\/|[a-zA-Z]:[\\/]|file:)/.test(inner) ? path.resolve(cwd, expandHome(inner.replace(/^file:/, ""))) : inner;
    return { kind: "npm", location, spec };
  }

  const [base, ref] = splitRef(spec);
  const git = (location: string): PluginSourceSpec => ({ kind: "git", location, ...(ref ? { ref } : {}), spec });
  const npm = (location = spec): PluginSourceSpec => ({ kind: "npm", location, spec });

  for (const [prefix, host] of [
    ["github:", "github.com"],
    ["gitlab:", "gitlab.com"],
    ["bitbucket:", "bitbucket.org"],
  ] as const) {
    if (base.startsWith(prefix)) return git(`https://${host}/${base.slice(prefix.length).replace(/\.git$/, "")}.git`);
  }
  if (base.startsWith("git+")) return git(base.slice(4));
  if (/^(git@|ssh:\/\/|git:\/\/)/.test(base)) return git(base);
  if (/^https?:\/\//.test(base)) {
    // 直接的包下载地址按 npm 包处理；其余 URL 都是仓库
    if (/\.(tgz|tar\.gz)$/i.test(base)) return npm(spec);
    return git(base);
  }

  const local = path.resolve(cwd, expandHome(spec));
  const info = await stat(local).catch(() => undefined);
  if (info?.isDirectory()) return { kind: "local", location: local, spec };
  if (info?.isFile()) {
    if (/\.(tgz|tar\.gz)$/i.test(local)) return { kind: "npm", location: local, spec };
    throw new Error(`${spec} is a file; give a plugin directory, a .tgz package, a git URL or an npm package`);
  }

  // user/repo：本地没有这个路径时按 GitHub 仓库处理（npm 的包名不含 /，带作用域的以 @ 开头）
  if (/^[\w.-]+\/[\w.-]+$/.test(base) && !base.startsWith(".")) {
    return git(`https://github.com/${base.replace(/\.git$/, "")}.git`);
  }

  if (/^(\.|\/|[a-zA-Z]:[\\/])/.test(spec)) throw new Error(`${spec}: no such directory`);
  return npm();
}

/** "url#ref" 拆成两部分；# 在开头（如 #foo）不算 */
function splitRef(s: string): [string, string | undefined] {
  const i = s.lastIndexOf("#");
  return i > 0 ? [s.slice(0, i), s.slice(i + 1) || undefined] : [s, undefined];
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}
