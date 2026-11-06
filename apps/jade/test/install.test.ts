// jade plugins add / update / remove：本地目录、npm 包、git 仓库的安装与更新。
// 只复制/下载，不执行插件代码。

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashDir, MemoryTrustStore } from "uncarved";
import { discover } from "../src/manifest.ts";
import { pluginsCommand, type PluginsCommandOptions } from "../src/rescue.ts";
import { addPlugin, installDir, readRecords, updatePlugins } from "../src/install.ts";
import { parseSource } from "../src/source.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
});

const has = (cmd: string, args: string[] = ["--version"]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const HAS_GIT = has("git");
const HAS_TAR = has("tar");

async function world() {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-install-")));
  const src = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-src-")));
  tmp.push(home, src);
  const roots = [
    { layer: "bundled" as const, root: path.join(home, "bundled") },
    { layer: "user" as const, root: path.join(home, "plugins") },
    { layer: "project" as const, root: path.join(home, "project") },
  ];
  await mkdir(roots[1]!.root, { recursive: true });
  const trust = new MemoryTrustStore();
  const opts: PluginsCommandOptions = { roots, home, flags: [], safe: false, trust };
  /** 在 src 下写一个插件目录，返回它的路径 */
  const plugin = async (dir: string, manifest: object = {}, code = "export default {};") => {
    const target = path.join(src, dir);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(target, "index.mjs"), code);
    return target;
  };
  return { home, src, roots, trust, opts, plugin };
}

const versionOf = async (dir: string) => (JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8")) as { version: string }).version;

describe("parseSource", () => {
  test("recognises local directories, npm packages and git repositories", async () => {
    const { src, plugin } = await world();
    const dir = await plugin("local", { id: "test/local" });

    expect(await parseSource(dir, src)).toMatchObject({ kind: "local", location: dir });
    expect(await parseSource("./local", src)).toMatchObject({ kind: "local", location: dir });

    expect(await parseSource("github:user/repo#v1.2.0", src)).toEqual({
      kind: "git",
      location: "https://github.com/user/repo.git",
      ref: "v1.2.0",
      spec: "github:user/repo#v1.2.0",
    });
    expect(await parseSource("https://example.com/plugin.git#dev", src)).toMatchObject({
      kind: "git",
      location: "https://example.com/plugin.git",
      ref: "dev",
    });
    expect(await parseSource("git+ssh://git@example.com/plugin.git", src)).toMatchObject({ kind: "git", location: "ssh://git@example.com/plugin.git" });
    expect(await parseSource("user/repo", src)).toMatchObject({ kind: "git", location: "https://github.com/user/repo.git" });

    expect(await parseSource("npm:@scope/name@1.2.3", src)).toEqual({ kind: "npm", location: "@scope/name@1.2.3", spec: "npm:@scope/name@1.2.3" });
    expect(await parseSource("some-package@next", src)).toEqual({ kind: "npm", location: "some-package@next", spec: "some-package@next" });
    expect(await parseSource("npm:./local", src)).toEqual({ kind: "npm", location: path.resolve(src, "local"), spec: "npm:./local" });
    expect(await parseSource("https://example.com/plugin.tgz", src)).toMatchObject({ kind: "npm" });
  });

  test("a missing path is an error, but a non-path is an npm package name", async () => {
    const { src } = await world();
    await expect(parseSource(path.join(src, "nope"), src)).rejects.toThrow("no such directory");
    await expect(parseSource("./nope", src)).rejects.toThrow("no such directory");
    expect(await parseSource("jade-plugin-example", src)).toMatchObject({ kind: "npm" });
  });
});

describe("jade plugins add: local directories", () => {
  test("copies a plugin directory into the user layer, where the next launch finds it", async () => {
    const { home, roots, opts, plugin } = await world();
    const from = await plugin("hello", { id: "test/hello" });

    expect(await pluginsCommand(["add", from], opts)).toBe(`installed test/hello@1.0.0 into ${path.join(home, "plugins", "test__hello")}`);
    expect(await readFile(path.join(home, "plugins", "test__hello", "index.mjs"), "utf8")).toBe("export default {};");
    // 源代码不动
    expect((await stat(from)).isDirectory()).toBe(true);

    const { sources } = await discover(roots);
    expect(sources.map((s) => [s.manifest.id, s.layer])).toContainEqual(["test/hello", "user"]);
    expect(await readRecords(path.join(home, "plugins"))).toMatchObject({
      "test/hello": { id: "test/hello", dir: "test__hello", kind: "local", version: "1.0.0" },
    });
  });

  test("refuses a directory that is not a plugin, and one that is already installed", async () => {
    const { src, opts, plugin } = await world();
    await mkdir(path.join(src, "empty"));
    await expect(pluginsCommand(["add", path.join(src, "empty")], opts)).rejects.toThrow("plugin.json");
    await expect(pluginsCommand(["add", path.join(src, "nope")], opts)).rejects.toThrow("no such directory");

    const from = await plugin("taken", { id: "test/taken" });
    await pluginsCommand(["add", from], opts);
    await expect(pluginsCommand(["add", from], opts)).rejects.toThrow("already installed");
    // --force 可以覆盖
    await expect(pluginsCommand(["add", from, "--force"], opts)).resolves.toContain("installed test/taken@1.0.0");
  });

  test("a plugin disabled by id is enabled again by installing it (and its fault record is dropped)", async () => {
    const { home, opts, plugin } = await world();
    await writeFile(path.join(home, "plugins.json"), JSON.stringify({ disabled: ["test/again"] }));
    await mkdir(path.join(home, "state"), { recursive: true });
    await writeFile(path.join(home, "state", "faults.json"), JSON.stringify({ streaks: { "test/again": { count: 3, last: "boom" } }, autoDisabled: ["test/again"] }));
    const text = await pluginsCommand(["add", await plugin("again", { id: "test/again" })], opts);
    expect(text).toContain("test/again was disabled; installing it enabled it again.");
    expect(JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8"))).toEqual({ disabled: [] });
    expect(JSON.parse(await readFile(path.join(home, "state", "faults.json"), "utf8"))).toEqual({ streaks: {}, autoDisabled: [], unattributed: [] });
  });

  test("--path installs one plugin from a repository with several of them", async () => {
    const { home, src, opts, plugin } = await world();
    await plugin("mono/packages/hello", { id: "test/mono" }, "export const n = 1;\n");

    expect(await pluginsCommand(["add", path.join(src, "mono"), "--path", "packages/hello"], opts)).toContain("installed test/mono@1.0.0");
    const installed = path.join(home, "plugins", "test__mono");
    expect(await readRecords(path.join(home, "plugins"))).toMatchObject({ "test/mono": { subdir: "packages/hello" } });

    await writeFile(path.join(src, "mono", "packages", "hello", "plugin.json"), JSON.stringify({ id: "test/mono", version: "1.1.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(src, "mono", "packages", "hello", "index.mjs"), "export const n = 2;\n");
    expect(await pluginsCommand(["update"], opts)).toContain("updated test/mono 1.0.0 → 1.1.0");
    expect(await readFile(path.join(installed, "index.mjs"), "utf8")).toBe("export const n = 2;\n");
  });

  test("refuses a local source that contains the plugins directory", async () => {
    const { home, opts } = await world();
    await expect(pluginsCommand(["add", home], opts)).rejects.toThrow("contains the plugins directory");
  });
});

describe("jade plugins update: local directories", () => {
  test("re-copies when the source changes, and reports current when it did not", async () => {
    const { home, opts, plugin } = await world();
    const from = await plugin("local-update", { id: "test/local-update" }, "export const n = 1;\n");
    await pluginsCommand(["add", from], opts);
    const installed = path.join(home, "plugins", "test__local-update");

    expect(await pluginsCommand(["update"], opts)).toBe("current test/local-update (1.0.0)");

    await writeFile(path.join(from, "index.mjs"), "export const n = 2;\n");
    await writeFile(path.join(from, "plugin.json"), JSON.stringify({ id: "test/local-update", version: "1.1.0", api: "^1", entry: "index.mjs" }));
    const table = await pluginsCommand(["update", "test/local-update"], opts);
    expect(table).toContain("updated test/local-update 1.0.0 → 1.1.0");
    expect(table).toContain("restart jade");
    expect(await readFile(path.join(installed, "index.mjs"), "utf8")).toBe("export const n = 2;\n");
    expect(await versionOf(installed)).toBe("1.1.0");
  });

  test("refuses to overwrite local edits unless --force is given", async () => {
    const { home, opts, plugin } = await world();
    const from = await plugin("edited", { id: "test/edited" }, "export const n = 1;\n");
    await pluginsCommand(["add", from], opts);
    const installed = path.join(home, "plugins", "test__edited");
    await writeFile(path.join(installed, "index.mjs"), "// my edit\n");

    expect(await pluginsCommand(["update"], opts)).toContain('test/edited: changed locally; run "jade plugins update --force test/edited"');
    expect(await readFile(path.join(installed, "index.mjs"), "utf8")).toBe("// my edit\n");

    await pluginsCommand(["update", "--force"], opts);
    expect(await readFile(path.join(installed, "index.mjs"), "utf8")).toBe("export const n = 1;\n");
  });

  test("an id that is not installed fails without touching anything", async () => {
    const { opts } = await world();
    expect(await pluginsCommand(["update", "test/nope"], opts)).toContain("test/nope: not installed");
  });

  test("a hand-copied plugin is reported as unmanaged", async () => {
    const { home, opts } = await world();
    const dir = path.join(home, "plugins", "test__manual");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "test/manual", version: "1.0.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(dir, "index.mjs"), "export default {};");
    expect(await pluginsCommand(["update", "test/manual"], opts)).toContain('not installed with "jade plugins add"');
  });
});

describe("jade plugins add --link", () => {
  test("links a local directory, discovers it, and removes only the link", async () => {
    const { home, roots, opts, plugin } = await world();
    const from = await plugin("linked", { id: "test/linked" }, "export default { process() {} };\n");
    const target = path.join(home, "plugins", "test__linked");

    const text = await pluginsCommand(["add", from, "--link"], opts);
    expect(text).toContain("link");
    expect(await readFile(path.join(target, "index.mjs"), "utf8")).toBe("export default { process() {} };\n");
    expect((await discover(roots)).sources.map((s) => s.manifest.id)).toContain("test/linked");
    expect(await pluginsCommand(["update", "test/linked"], opts)).toContain("linked test/linked");

    await pluginsCommand(["remove", "test/linked"], opts);
    expect(existsSync(target)).toBe(false);
    // 链接指向的源目录没被删
    expect(existsSync(path.join(from, "index.mjs"))).toBe(true);
  });
});

describe("jade plugins add --project", () => {
  test("installs into the project layer and records trust for this content", async () => {
    const { home, trust, opts, plugin } = await world();
    const from = await plugin("project-plugin", { id: "test/project" });

    const text = await pluginsCommand(["add", from, "--project"], opts);
    const dir = path.join(home, "project", "test__project");
    expect(text).toContain(`installed test/project@1.0.0 into ${dir}`);
    expect(text).toContain("project plugin");
    expect(await readRecords(path.join(home, "project"))).toMatchObject({ "test/project": { dir: "test__project" } });
    expect(await trust.has((await hashDir(dir)).hash)).toBe(true);

    await expect(pluginsCommand(["remove", "test/project", "--project"], opts)).resolves.toContain("removed test/project");
    expect(existsSync(dir)).toBe(false);
  });

  test("a trusted project plugin loads without asking again", async () => {
    const { home, roots, trust, opts, plugin } = await world();
    const from = await plugin("project-load", { id: "test/project-load" }, "export default { process() {} };\n");
    await pluginsCommand(["add", from, "--project"], opts);
    const { PluginHost } = await import("../src/host.ts");
    const host = await PluginHost.start({ roots, home, report: () => {}, trust: { trust, confirm: async () => false } });
    try {
      expect(host.status().find((p) => p.id === "test/project-load")?.state).toBe("active");
    } finally {
      await host.close();
    }
  });

  test("updating a project plugin trusts the new content", async () => {
    const { home, trust, opts, plugin } = await world();
    const from = await plugin("project-update", { id: "test/project-update" }, "export const n = 1;\n");
    await pluginsCommand(["add", from, "--project"], opts);
    const dir = path.join(home, "project", "test__project-update");
    const before = (await hashDir(dir)).hash;

    await writeFile(path.join(from, "plugin.json"), JSON.stringify({ id: "test/project-update", version: "1.1.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(from, "index.mjs"), "export const n = 2;\n");
    expect(await pluginsCommand(["update", "test/project-update", "--project"], opts)).toContain("updated test/project-update 1.0.0 → 1.1.0");

    const after = (await hashDir(dir)).hash;
    expect(after).not.toBe(before);
    expect(await trust.has(after)).toBe(true);
  });
});

describe("jade plugins add: git", () => {
  test("clones a repository, records the commit, and updates to a new commit", async () => {
    if (!HAS_GIT) return;
    const { home, opts } = await world();
    const repo = path.join(home, "repo-source");
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(path.join(repo, "plugin.json"), JSON.stringify({ id: "test/git", version: "1.0.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(repo, "index.mjs"), "export const n = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const source = `git+${pathToFileURL(repo).href}`;
    expect(await pluginsCommand(["add", source], opts)).toContain("installed test/git@1.0.0");
    const installed = path.join(home, "plugins", "test__git");
    const read = async (file: string) => (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
    expect(await read(path.join(installed, "index.mjs"))).toBe("export const n = 1;\n");
    expect((await readRecords(path.join(home, "plugins")))["test/git"]).toMatchObject({ kind: "git", commit: first });

    expect(await pluginsCommand(["update", "test/git"], opts)).toContain("current test/git");

    await writeFile(path.join(repo, "plugin.json"), JSON.stringify({ id: "test/git", version: "1.1.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(repo, "index.mjs"), "export const n = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "two");
    const second = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const text = await pluginsCommand(["update", "test/git"], opts);
    expect(text).toContain(`updated test/git ${first.slice(0, 7)} → ${second.slice(0, 7)}`);
    expect(await read(path.join(installed, "index.mjs"))).toBe("export const n = 2;\n");
    expect((await readRecords(path.join(home, "plugins")))["test/git"]).toMatchObject({ commit: second, version: "1.1.0" });
  });
});

describe("jade plugins add: npm", () => {
  test("installs a .tgz package and updates it when the tarball changes", async () => {
    if (!HAS_TAR) return;
    const { home, opts } = await world();
    const pkg = path.join(home, "pkg");
    await mkdir(pkg, { recursive: true });
    const writePackage = async (version: string, n: number) => {
      await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "jade-test-plugin", version, type: "module" }));
      await writeFile(path.join(pkg, "plugin.json"), JSON.stringify({ id: "test/npm", version, api: "^1", entry: "index.mjs" }));
      await writeFile(path.join(pkg, "index.mjs"), `export const n = ${n};\n`);
    };
    const tarball = path.join(home, "plugin.tgz");
    const pack = () => {
      const stage = path.join(home, `pack-${Date.now()}`);
      cpSync(pkg, path.join(stage, "package"), { recursive: true });
      // 相对路径：Git 自带的 GNU tar 会把 C:\… 当成远程主机
      execFileSync("tar", ["-czf", path.basename(tarball), "-C", path.basename(stage), "package"], { cwd: home, stdio: "ignore" });
      rmSync(stage, { recursive: true, force: true });
    };

    await writePackage("1.0.0", 1);
    pack();
    expect(await pluginsCommand(["add", tarball], opts)).toContain("installed test/npm@1.0.0 into");
    const installed = path.join(home, "plugins", "test__npm");
    expect(await readFile(path.join(installed, "index.mjs"), "utf8")).toBe("export const n = 1;\n");
    expect((await readRecords(path.join(home, "plugins")))["test/npm"]).toMatchObject({ kind: "npm", version: "1.0.0" });

    expect(await pluginsCommand(["update", "test/npm"], opts)).toBe("current test/npm (1.0.0)");

    await writePackage("1.1.0", 2);
    pack();
    const text = await pluginsCommand(["update", "test/npm"], opts);
    expect(text).toContain("updated test/npm 1.0.0 → 1.1.0");
    expect(await readFile(path.join(installed, "index.mjs"), "utf8")).toBe("export const n = 2;\n");
    expect((await readRecords(path.join(home, "plugins")))["test/npm"]).toMatchObject({ version: "1.1.0" });
  });

  test("update finds a relative .tgz from another working directory", async () => {
    if (!HAS_TAR) return;
    const { home } = await world();
    const pkg = path.join(home, "stage", "package");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "jade-test-plugin", version: "1.0.0", type: "module" }));
    await writeFile(path.join(pkg, "plugin.json"), JSON.stringify({ id: "test/npm", version: "1.0.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(pkg, "index.mjs"), "export const n = 1;\n");
    execFileSync("tar", ["-czf", "plugin.tgz", "-C", "stage", "package"], { cwd: home, stdio: "ignore" });

    const root = path.join(home, "plugins");
    await addPlugin("./plugin.tgz", { root, cwd: home });
    const elsewhere = path.join(home, "elsewhere");
    await mkdir(elsewhere);
    const [result] = await updatePlugins(["test/npm"], { root, cwd: elsewhere });
    expect(result).toMatchObject({ status: "current" });
  });
});

describe("jade plugins update: the recorded source", () => {
  test("a git record is not turned into a local directory that happens to share its name", async () => {
    const { home, plugin } = await world();
    const root = path.join(home, "plugins");
    await mkdir(path.join(root, "test__git"), { recursive: true });
    // 用 user/repo 装的 git 插件（老记录只有用户写的原文）
    await writeFile(
      path.join(root, ".installed.json"),
      JSON.stringify({ plugins: { "test/git": { id: "test/git", dir: "test__git", source: "acme/tool", kind: "git", installedAt: "x" } } }),
    );
    // 运行 update 的目录里正好有 ./acme/tool
    const cwd = path.dirname(path.dirname(await plugin("acme/tool", { id: "test/git" })));
    const [result] = await updatePlugins(["test/git"], { root, cwd });
    expect(result).toMatchObject({ status: "failed" });
    expect((await readRecords(root))["test/git"]).toMatchObject({ kind: "git", source: "acme/tool" });
    expect(existsSync(path.join(root, "test__git", "plugin.json"))).toBe(false);
  });
});

describe("jade plugins remove", () => {
  test("removes the directory from the user layer and its install record", async () => {
    const { home, roots, opts, plugin } = await world();
    await pluginsCommand(["add", await plugin("bye", { id: "test/bye" })], opts);
    const dir = path.join(home, "plugins", "test__bye");
    expect(await readRecords(path.join(home, "plugins"))).toHaveProperty("test/bye");

    expect(await pluginsCommand(["remove", "test/bye"], opts)).toContain("removed test/bye");
    await expect(stat(dir)).rejects.toThrow();
    expect((await readRecords(path.join(home, "plugins")))["test/bye"]).toBeUndefined();
    expect((await discover(roots)).sources).toEqual([]);
  });

  test("refuses an id that is not installed, and a path that would leave the user layer", async () => {
    const { opts } = await world();
    await expect(pluginsCommand(["remove", "test/nope"], opts)).rejects.toThrow("is not installed");
    await expect(pluginsCommand(["remove", "../../etc"], opts)).rejects.toThrow("refusing to remove");
  });
});

describe("plugin directories", () => {
  test("staging and old directories are not mistaken for plugins", async () => {
    const { home, roots } = await world();
    for (const name of [".staging-abc", ".old-def"]) {
      const dir = path.join(home, "plugins", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "plugin.json"), "not json");
    }
    const { sources, broken } = await discover(roots);
    expect(sources).toEqual([]);
    expect(broken).toEqual([]);
  });

  test("installDir keeps a plugin id inside the plugins directory", () => {
    const root = path.resolve("/plugins");
    expect(installDir(root, "test/hello")).toBe(path.join(root, "test__hello"));
  });
});

test("usage errors still name every subcommand", async () => {
  const { opts } = await world();
  await expect(pluginsCommand(["add"], { ...opts })).rejects.toThrow("usage: jade plugins");
  await expect(pluginsCommand(["frobnicate", "x"], { ...opts })).rejects.toThrow("usage: jade plugins");
  await expect(pluginsCommand(["--help"], { ...opts })).resolves.toContain("add <source>");
});
