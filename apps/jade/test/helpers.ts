import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginHost, type HostOptions, type Manifest, type PluginLayer } from "../src/index.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

/** 一个 JADE_HOME，带 bundled、user、project 三个插件目录 */
export async function world() {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-")));
  tmp.push(home);
  const roots = (["bundled", "user", "project"] as const).map((layer) => ({ layer, root: path.join(home, "roots", layer) }));
  const reports: string[] = [];
  const plugin = async (layer: PluginLayer, m: Partial<Manifest> & { id: string }, code: string) => {
    const dir = path.join(home, "roots", layer, m.id.replaceAll("/", "__"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...m }));
    await writeFile(path.join(dir, "index.mjs"), code);
    return dir;
  };
  const start = (extra: Partial<Pick<HostOptions, "flags" | "safe" | "trust">> = {}) => PluginHost.start({ roots, home, report: (m) => reports.push(m), ...extra });
  return { home, roots, reports, plugin, start };
}

export const info = (host: PluginHost, id: string) => host.status().find((p) => p.id === id)!;
