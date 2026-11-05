// jade plugins add / remove：从本地目录安装用户层插件、删掉它。
// 只复制目录，不执行插件的代码。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginConfig } from "../src/config.ts";
import { discover, pluginsCommand, PluginHost } from "../src/index.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
});

/** 一个 $JADE_HOME（用户层插件目录是 home/plugins）和一个放源插件的目录 */
async function world() {
  const home = path.resolve(await mkdtemp(path.join(os.tmpdir(), "jade-install-")));
  const src = path.resolve(await mkdtemp(path.join(os.tmpdir(), "jade-src-")));
  tmp.push(home, src);
  const roots = [
    { layer: "bundled" as const, root: path.join(home, "bundled") },
    { layer: "user" as const, root: path.join(home, "plugins") },
    { layer: "project" as const, root: path.join(home, "project") },
  ];
  await mkdir(roots[1]!.root, { recursive: true });
  const opts = { roots, home, flags: [], safe: false };
  /** 写一个插件目录：返回它的路径 */
  const plugin = async (dir: string, manifest: object, code = "export default {};") => {
    const target = path.join(src, dir);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(target, "index.mjs"), code);
    return target;
  };
  return { home, src, roots, opts, plugin };
}

describe("jade plugins add", () => {
  test("copies a plugin directory into the user layer, where the next launch finds it", async () => {
    const { home, roots, opts, plugin } = await world();
    const from = await plugin("hello", { id: "test/hello", entry: "index.mjs" });

    expect(await pluginsCommand(["add", from], opts)).toBe(`installed test/hello@1.0.0 into ${path.join(home, "plugins", "test__hello")}`);
    expect(await readFile(path.join(home, "plugins", "test__hello", "index.mjs"), "utf8")).toBe("export default {};");
    // 源代码不动
    expect((await stat(from)).isDirectory()).toBe(true);

    const { sources } = await discover(roots);
    expect(sources.map((s) => [s.manifest.id, s.layer])).toContainEqual(["test/hello", "user"]);
    // 装上的插件能激活
    const host = await PluginHost.start({ roots, home, report: () => {} });
    try {
      expect(host.status().find((p) => p.id === "test/hello")!.state).toBe("active");
    } finally {
      await host.close();
    }
  });

  test("refuses a directory that is not a plugin, and one that is already installed", async () => {
    const { src, opts, plugin } = await world();
    await mkdir(path.join(src, "empty"));
    await expect(pluginsCommand(["add", path.join(src, "empty")], opts)).rejects.toThrow("plugin.json");
    await expect(pluginsCommand(["add", path.join(src, "nope")], opts)).rejects.toThrow("no such directory");

    const from = await plugin("taken", { id: "test/taken" });
    await pluginsCommand(["add", from], opts);
    await expect(pluginsCommand(["add", from], opts)).rejects.toThrow("already installed");
  });

  test("a plugin disabled by id is enabled again by installing it (and its fault record is dropped)", async () => {
    const { home, opts, plugin } = await world();
    await writeFile(path.join(home, "plugins.json"), JSON.stringify({ disabled: ["test/again"] }));
    await mkdir(path.join(home, "state"), { recursive: true });
    await writeFile(path.join(home, "state", "faults.json"), JSON.stringify({ streaks: { "test/again": { count: 3, last: "boom" } }, autoDisabled: ["test/again"] }));
    await pluginsCommand(["add", await plugin("again", { id: "test/again" })], opts);
    expect(JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8"))).toEqual({ disabled: [] });
    expect(JSON.parse(await readFile(path.join(home, "state", "faults.json"), "utf8"))).toEqual({ streaks: {}, autoDisabled: [], unattributed: [] });
  });
});

describe("jade plugins remove", () => {
  test("removes the directory from the user layer", async () => {
    const { home, roots, opts, plugin } = await world();
    await pluginsCommand(["add", await plugin("bye", { id: "test/bye" })], opts);
    expect(await pluginsCommand(["remove", "test/bye"], opts)).toContain("removed test/bye");
    await expect(stat(path.join(home, "plugins", "test__bye"))).rejects.toThrow();
    expect((await discover(roots)).sources).toEqual([]);
  });

  test("refuses an id that is not installed, and a path that would leave the user layer", async () => {
    const { opts } = await world();
    await expect(pluginsCommand(["remove", "test/nope"], opts)).rejects.toThrow("is not installed");
    await expect(pluginsCommand(["remove", "../../etc"], opts)).rejects.toThrow("refusing to remove");
  });
});

test("usage errors still name every subcommand", async () => {
  const { opts } = await world();
  await expect(pluginsCommand(["add"], { ...opts })).rejects.toThrow("usage: jade plugins");
  await expect(pluginsCommand(["frobnicate", "x"], { ...opts })).rejects.toThrow("usage: jade plugins");
  // pluginConfig 只是确认 config.ts 还在导出（安装不碰配置）
  expect(pluginConfig({ manifest: { id: "x", version: "1", api: "^1", entry: "i.js" }, dir: "/x", layer: "user" }, {}, {}).config).toEqual({});
});
