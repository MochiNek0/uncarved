// 安装和删除用户层插件：`jade plugins add <目录>`、`jade plugins remove <id>`。
//
// 插件就是一个带 plugin.json 的目录，所以"安装"是从本地目录复制到 $JADE_HOME/plugins/<id>：
// 不执行插件的任何代码（和救援 CLI 一样）。从 npm 或 git 安装要决定的东西更多（包里的目录布局、
// 更新时怎么处理本地改动），先不做。

import { cp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parseManifest } from "./manifest.ts";
import { readFaults, readPluginsConfig, writeFaults, writePluginsConfig } from "./state.ts";

/** 用户层插件的目录名：id 里的 / 换成 __ */
export const installDir = (root: string, id: string) => path.join(root, id.replaceAll("/", "__"));

const exists = (p: string) => stat(p).then(
  () => true,
  () => false,
);

/** 从本地目录安装一个插件；不是插件、已经装过时抛出 */
export async function addPlugin(source: string, opts: { root: string; cwd: string }): Promise<{ id: string; version: string; dir: string }> {
  const from = path.resolve(opts.cwd, source);
  let info;
  try {
    info = await stat(from);
  } catch {
    throw new Error(`${source}: no such directory`);
  }
  if (!info.isDirectory()) throw new Error(`${source} is not a directory (a plugin is a directory with a plugin.json)`);
  const manifest = parseManifest(JSON.parse(await readFile(path.join(from, "plugin.json"), "utf8")));
  const dir = installDir(path.resolve(opts.root), manifest.id);
  if (await exists(dir)) throw new Error(`${manifest.id} is already installed in ${dir}; run "jade plugins remove ${manifest.id}" first`);
  await cp(from, dir, { recursive: true });
  return { id: manifest.id, version: manifest.version, dir };
}

/** 删掉用户层里这个 id 的插件目录；找不到、或路径跑到用户层之外时抛出 */
export async function removePlugin(id: string, opts: { root: string }): Promise<string> {
  const root = path.resolve(opts.root);
  const dir = path.resolve(installDir(root, id));
  const rel = path.relative(root, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to remove ${dir}: it is not inside ${root}`);
  if (!(await exists(dir))) throw new Error(`${id} is not installed in ${root}`);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

/** 安装、删除之后清掉这个 id 的停用记录和连续崩溃记录 */
export async function forgetPluginState(home: string, id: string): Promise<void> {
  const config = await readPluginsConfig(home);
  if (config.disabled.includes(id)) {
    config.disabled = config.disabled.filter((d) => d !== id);
    await writePluginsConfig(home, config);
  }
  const faults = await readFaults(home);
  if (faults.streaks[id] || faults.autoDisabled.includes(id)) {
    delete faults.streaks[id];
    faults.autoDisabled = faults.autoDisabled.filter((d) => d !== id);
    await writeFaults(home, faults);
  }
}
