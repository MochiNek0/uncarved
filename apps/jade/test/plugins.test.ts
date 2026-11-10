// jade/plugins：/plugins 列出每个插件的状态和原因、每个服务的提供者；数据来自核心的 jade@1 服务。

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginHost } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import type { UI } from "../src/api.ts";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");
/** 这些测试要用的 bundled 插件；其余的停用 */
const KEEP = new Set(["commands", "plugins"]);

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
});

const ui: UI = { interactive: true, notify: () => {}, select: async () => undefined, input: async () => undefined };

test("/plugins lists every plugin's state, why it is not active, and who provides each service", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jade-plugins-"));
  tmp.push(home);
  const plugin = async (name: string, manifest: object, code: string) => {
    const dir = path.join(home, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(dir, "index.mjs"), code);
  };
  await plugin("bad", { id: "test/bad" }, `export default { process() { throw new Error("oops"); } };`);
  await plugin("elsewhere", { id: "test/elsewhere", requires: ["nothing@1"] }, `export default {};`);
  const disabled: string[] = [];
  for (const name of await readdir(BUNDLED)) {
    if (KEEP.has(name)) continue;
    try {
      disabled.push((JSON.parse(await readFile(path.join(BUNDLED, name, "plugin.json"), "utf8")) as { id: string }).id);
    } catch {
      // 别处正在写的插件目录
    }
  }
  await writeFile(path.join(home, "plugins.json"), JSON.stringify({ disabled }));

  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: BUNDLED },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    report: () => {},
  });
  try {
    const ctx: CommandContext = { signal: new AbortController().signal, ui, sessions: host.sessions, print: () => {} };
    const command = host.service<Commands>("commands@1")!.get("plugins")!.command;

    const list = (await command.run("", ctx)) as string;
    expect(list).toMatch(/jade\/commands@\d+\.\d+\.\d+ {2}bundled {2}active/);
    expect(list).toMatch(/jade\/plugins@\d+\.\d+\.\d+ {2}bundled {2}active/);
    expect(list).toContain("test/bad@1.0.0  user  failed  oops");
    expect(list).toContain("test/elsewhere@1.0.0  user  skipped  requires nothing@1, which no plugin provides");
    expect(list).toContain("services:");
    expect(list).toContain("  commands@1  jade/commands");
    expect(list).toContain("  jade@1  jade");

    // 单个插件：状态、原因和目录
    const one = (await command.run("bad", ctx)) as string;
    expect(one).toContain("test/bad@1.0.0  user  failed  oops");
    expect(one).toContain(path.join(home, "plugins", "bad"));

    expect(await command.run("nope", ctx)).toContain("No plugin matches nope");
  } finally {
    await host.close();
  }
});
