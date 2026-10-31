import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryLogStore, MemoryTrustStore, Runtime, type ModelRequest, type Provider } from "uncarved";
import { createJade, inspectPlugin, loadCommands, loadMcpConfig, loadPlugin, loadSkills, type LoadedPlugin } from "../src/index.ts";
import { addPlugin, parseSource, readPluginSettings, readRecords, removePlugin, updatePlugins } from "../src/plugins/install.ts";
import { pluginCli } from "../src/plugin-cli.ts";

async function tmp(prefix: string) {
  return realpathSync.native(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function files(dir: string, entries: Record<string, string>) {
  for (const [rel, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();

const PLUGIN = `export default { id: "x/hello", version: "1.0.0", kernel: "^0.1", commands: [{ name: "hello", run: () => "hi" }] };\n`;

describe("plugin sources", () => {
  test("git URLs, GitHub shorthands, npm packages, tarballs and local directories", async () => {
    const cwd = await tmp("jade-src-");
    await mkdir(path.join(cwd, "local"));
    await writeFile(path.join(cwd, "pkg.tgz"), "");
    expect(await parseSource("https://github.com/a/b", cwd)).toEqual({ kind: "git", location: "https://github.com/a/b", ref: undefined });
    expect(await parseSource("github:a/b#v1", cwd)).toEqual({ kind: "git", location: "https://github.com/a/b.git", ref: "v1" });
    expect(await parseSource("a/b", cwd)).toEqual({ kind: "git", location: "https://github.com/a/b.git", ref: undefined });
    expect(await parseSource("git@github.com:a/b.git", cwd)).toMatchObject({ kind: "git", location: "git@github.com:a/b.git" });
    expect(await parseSource("git+file:///x/y#main", cwd)).toEqual({ kind: "git", location: "file:///x/y", ref: "main" });
    expect(await parseSource("left-pad@1.3.0", cwd)).toEqual({ kind: "npm", location: "left-pad@1.3.0" });
    expect(await parseSource("@scope/pkg", cwd)).toEqual({ kind: "npm", location: "@scope/pkg" });
    expect(await parseSource("npm:foo@latest", cwd)).toEqual({ kind: "npm", location: "foo@latest" });
    expect(await parseSource("pkg.tgz", cwd)).toEqual({ kind: "npm", location: path.join(cwd, "pkg.tgz") });
    expect(await parseSource("./local", cwd)).toEqual({ kind: "local", location: path.join(cwd, "local") });
    await expect(parseSource("./missing", cwd)).rejects.toThrow("does not exist");
  });
});

describe("jade plugin add / update / remove", () => {
  test("a local directory is copied without node_modules and recorded; --link only links, and remove keeps the source", async () => {
    const work = await tmp("jade-inst-");
    const src = await files(path.join(work, "src"), {
      "index.ts": PLUGIN,
      "plugin.json": JSON.stringify({ name: "Hello Plugin", version: "1.0.0" }),
      "node_modules/junk/index.js": "",
    });
    const pluginsDir = path.join(work, "home", "plugins");
    const r = await addPlugin("./src", { pluginsDir, cwd: work });
    expect(r.name).toBe("hello-plugin");
    expect(r.info.kind).toBe("module");
    expect(await readdir(r.dir)).toEqual(["index.ts", "plugin.json"]);
    expect((await readRecords(pluginsDir))["hello-plugin"]).toMatchObject({ kind: "local", source: src, version: "1.0.0" });
    // 没有留下临时目录
    expect((await readdir(pluginsDir)).filter((n) => n.startsWith(".staging"))).toEqual([]);
    await expect(addPlugin("./src", { pluginsDir, cwd: work })).rejects.toThrow("already installed");

    const linked = await addPlugin(src, { pluginsDir, cwd: work, link: true, name: "dev" });
    expect((await lstat(linked.dir)).isSymbolicLink()).toBe(true);
    expect((await updatePlugins(["dev"], { pluginsDir, cwd: work }))[0]!.status).toBe("linked");
    expect(await removePlugin("dev", pluginsDir)).toBe(true);
    expect(await stat(path.join(src, "index.ts")).then(() => true)).toBe(true);
    expect(await removePlugin("hello-plugin", pluginsDir)).toBe(true);
    expect(await readRecords(pluginsDir)).toEqual({});
    expect(await removePlugin("hello-plugin", pluginsDir)).toBe(false);
  });

  test("a directory that is not a plugin is rejected and nothing is left behind", async () => {
    const work = await tmp("jade-inst-");
    await files(path.join(work, "src"), { "README.md": "hi" });
    const pluginsDir = path.join(work, "plugins");
    await expect(addPlugin("./src", { pluginsDir, cwd: work })).rejects.toThrow("no index.ts");
    expect(await readdir(pluginsDir)).toEqual([]);
  });

  test("git: clones a subdirectory at a ref, update fetches new commits", async () => {
    const work = await tmp("jade-git-");
    const repo = await files(path.join(work, "repo"), { "plugins/hello/index.ts": PLUGIN, "README.md": "" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    const url = `git+${pathToFileURL(repo).href}`;
    const pluginsDir = path.join(work, "plugins");
    const r = await addPlugin(`${url}#main`, { pluginsDir, cwd: work, subdir: "plugins/hello" });
    expect(r.name).toBe("hello");
    expect(await readdir(r.dir)).toEqual(["index.ts"]);
    const first = r.record.commit!;
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    expect(await updatePlugins([], { pluginsDir, cwd: work })).toEqual([{ name: "hello", status: "current", to: first.slice(0, 7) }]);
    await writeFile(path.join(repo, "plugins", "hello", "extra.md"), "new");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "two");
    const [u] = await updatePlugins(["hello"], { pluginsDir, cwd: work });
    expect(u).toMatchObject({ name: "hello", status: "updated", from: first.slice(0, 7) });
    expect(await readFile(path.join(pluginsDir, "hello", "extra.md"), "utf8")).toBe("new");
    expect((await readRecords(pluginsDir)).hello!.commit).not.toBe(first);
    expect((await readdir(pluginsDir)).filter((n) => n.startsWith("."))).toEqual([".installed.json"]);
  }, 60_000);

  test("npm: a packed tarball installs under the package name without its scope", async () => {
    const work = await tmp("jade-npm-");
    const pkg = await files(path.join(work, "pkg"), { "package.json": JSON.stringify({ name: "@me/jade-hello", version: "0.4.0" }), "index.ts": PLUGIN });
    execFileSync(process.execPath, ["pm", "pack", "--destination", work], { cwd: pkg, stdio: "pipe" });
    const tgz = (await readdir(work)).find((n) => n.endsWith(".tgz"))!;
    const pluginsDir = path.join(work, "plugins");
    const r = await addPlugin(path.join(work, tgz), { pluginsDir, cwd: work });
    expect(r.name).toBe("jade-hello");
    expect(r.record).toMatchObject({ kind: "npm", version: "0.4.0" });
    expect((await readdir(r.dir)).sort()).toEqual(["index.ts", "package.json"]);
  }, 60_000);

  test("the plugin's dependencies are installed", async () => {
    const work = await tmp("jade-deps-");
    const dep = await files(path.join(work, "dep"), { "package.json": JSON.stringify({ name: "dep-x", version: "2.0.0", main: "i.js" }), "i.js": "module.exports = 42;" });
    await files(path.join(work, "src"), {
      "package.json": JSON.stringify({ name: "with-deps", version: "1.0.0", dependencies: { "dep-x": `file:${dep.split(path.sep).join("/")}` } }),
      "index.ts": PLUGIN,
    });
    const r = await addPlugin("./src", { pluginsDir: path.join(work, "plugins"), cwd: work });
    expect(await stat(path.join(r.dir, "node_modules", "dep-x", "i.js")).then(() => true)).toBe(true);
  }, 60_000);
});

describe("jade plugin CLI", () => {
  test("list, disable and enable; jade/policy cannot be disabled", async () => {
    const work = await tmp("jade-cli-");
    const home = path.join(work, "home");
    await files(path.join(home, "plugins", "hello"), { "index.ts": PLUGIN });
    const out: string[] = [];
    const o = { home, cwd: work, root: work, trust: new MemoryTrustStore(), out: (t: string) => out.push(t), err: (t: string) => out.push(t) };
    expect(await pluginCli(["disable", "jade/web"], o)).toBe(0);
    expect(await pluginCli(["disable", "jade/policy"], o)).toBe(1);
    expect(await pluginCli(["disable", "hello"], o)).toBe(0);
    expect((await readPluginSettings(home)).disabled).toEqual(["hello", "jade/web"]);
    expect(await pluginCli(["enable", "hello"], o)).toBe(0);
    expect((await readPluginSettings(home)).disabled).toEqual(["jade/web"]);
    out.length = 0;
    expect(await pluginCli(["list"], o)).toBe(0);
    const text = out.join("\n").replace(/\x1b\[\d+m/g, "");
    expect(text).toMatch(/jade\/web .* disabled/);
    expect(text).toMatch(/jade\/policy .* required/);
    expect(text).toContain("hello");
    expect(text).toContain("copied by hand");
    expect(await pluginCli(["remove", "hello"], o)).toBe(0);
    await expect(pluginCli(["frobnicate"], o)).rejects.toThrow("unknown command");
  });

  test("--project installs into the repository and records trust, so jade does not ask again", async () => {
    const work = await tmp("jade-cli-");
    await files(path.join(work, "src"), { "index.ts": PLUGIN });
    const trust = new MemoryTrustStore();
    const o = { home: path.join(work, "home"), cwd: work, root: work, trust, out: () => {}, err: () => {} };
    expect(await pluginCli(["add", "./src", "--project", "--name", "hello"], o)).toBe(0);
    const dir = path.join(work, ".jade", "plugins", "hello");
    const loaded = await loadPlugin({ name: "hello", dir, layer: "project" }, { trust, confirm: async () => { throw new Error("asked"); } });
    expect(loaded.kind).toBe("module");
  });
});

describe("plugins that carry skills, commands and MCP servers", () => {
  test("a content-only plugin and a Claude Code plugin layout", async () => {
    const work = await tmp("jade-bundle-");
    const kit = await files(path.join(work, "home", "plugins", "kit"), {
      "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: deploy the app\n---\nsteps",
      "commands/ship.md": "---\ndescription: ship it\n---\nShip $ARGUMENTS",
      "mcp.json": JSON.stringify({ mcpServers: { kitsrv: { command: "node", args: ["${JADE_PLUGIN_DIR}/server.js"] } } }),
    });
    const cc = await files(path.join(work, "home", "plugins", "cc"), {
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "cc-tools",
        version: "1.2.0",
        description: "from Claude Code",
        commands: "./cmds",
        mcpServers: { ccsrv: { command: "${CLAUDE_PLUGIN_ROOT}/bin/srv" } },
      }),
      "cmds/lint.md": "Lint the code",
      "hooks/hooks.json": "{}",
    });
    const kitInfo = await inspectPlugin(kit);
    expect(kitInfo).toMatchObject({ kind: "content", bundle: { skills: [path.join(kit, "skills")], commands: [path.join(kit, "commands")], mcp: { file: path.join(kit, "mcp.json") }, unsupported: [] } });
    const ccInfo = await inspectPlugin(cc);
    expect(ccInfo).toMatchObject({ kind: "content", name: "cc-tools", version: "1.2.0", bundle: { commands: [path.join(cc, "cmds")], unsupported: ["hooks"] } });
    const loaded = await loadPlugin({ name: "kit", dir: kit, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => true });
    expect(loaded.kind).toBe("content");
    expect(loaded.create).toBeUndefined();

    const home = path.join(work, "home");
    const cwd = await tmp("jade-bundle-cwd-");
    const { skills } = await loadSkills({ home, root: cwd, cwd, userHome: work, plugins: [{ plugin: "kit", dir: path.join(kit, "skills"), layer: "user" }] });
    expect(skills).toMatchObject([{ name: "deploy", plugin: "kit", layer: "user" }]);
    // 用户自己的同名命令优先于插件带的
    await files(path.join(home, "commands"), { "lint.md": "my lint" });
    const commands = await loadCommands({
      home,
      root: cwd,
      cwd,
      plugins: [
        { plugin: "kit", dir: path.join(kit, "commands"), layer: "user" },
        { plugin: "cc", dir: path.join(cc, "cmds"), layer: "user" },
      ],
    });
    expect(commands.map((c) => [c.name, c.plugin, c.body])).toEqual([
      ["lint", undefined, "my lint"],
      ["ship", "kit", "Ship $ARGUMENTS"],
    ]);
    const { servers } = await loadMcpConfig({
      home,
      root: cwd,
      cwd,
      env: {},
      plugins: [
        { plugin: "kit", dir: kit, layer: "user", file: kitInfo.bundle.mcp!.file },
        { plugin: "cc", dir: cc, layer: "user", file: ccInfo.bundle.mcp!.file, servers: ccInfo.bundle.mcp!.servers },
      ],
    });
    expect(servers.map((x) => [x.name, x.plugin, x.config.command, x.config.args])).toEqual([
      ["kitsrv", "kit", "node", [`${kit}/server.js`]],
      ["ccsrv", "cc", `${cc}/bin/srv`, undefined],
    ]);
  });
});

describe("built-in plugins", () => {
  const provider: Provider = { id: "none", complete: () => Promise.reject(new Error("unused")) };
  const fakePlugin = (name: string, plugin: object): LoadedPlugin => ({
    name,
    dir: path.join(os.tmpdir(), name),
    layer: "user",
    kind: "module",
    entry: "index.ts",
    info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
    create: async () => ({ version: "1.0.0", kernel: "^0.1", ...plugin }) as never,
  });
  const tool = (name: string) => ({
    name,
    description: "",
    inputSchema: { type: "object" },
    effect: "read" as const,
    concurrency: "safe" as const,
    idempotent: true,
    execute: async () => ({ content: "" }),
  });
  const system = async (plugins: import("uncarved").Plugin[]) => {
    const requests: ModelRequest[] = [];
    const p: Provider = {
      id: "x",
      async complete(req) {
        requests.push(req);
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: p, plugins });
    await rt.send({ kind: "message", content: [{ kind: "text", text: "hi", origin: { by: "user" }, trust: "trusted" }] });
    return requests[0]!.system.map((s) => s.text).join("\n");
  };

  test("every built-in is its own plugin; disabled ones take their tools, prompt text and commands with them", async () => {
    const cwd = await tmp("jade-builtin-");
    const home = await tmp("jade-builtin-home-");
    const all = await createJade({ cwd, home, store: new MemoryLogStore(), provider, env: {} });
    expect(all.plugins.map((p) => p.id)).toEqual([
      "jade/policy",
      "jade/prompts",
      "jade/fs",
      "jade/shell",
      "jade/web",
      "jade/todo",
      "jade/memory",
      "jade/task",
      "jade/skills",
      "jade/mcp",
      "jade/checks",
      "jade/compact",
      "jade/budget",
      "jade/repeats",
    ]);
    expect([...all.commands.keys()]).toEqual(["memory", "skills", "mcp", "checks", "compact"]);
    expect(await system(all.plugins)).toContain("Use the task tool");
    all.shutdown();

    const some = await createJade({ cwd, home, store: new MemoryLogStore(), provider, env: {}, disabled: ["jade/task", "jade/todo", "jade/memory", "jade/policy"] });
    expect(some.warnings.join("\n")).toContain("jade/policy cannot be disabled");
    expect(some.plugins.map((p) => p.id)).toContain("jade/policy");
    expect(some.plugins.map((p) => p.id)).not.toContain("jade/memory");
    expect(some.tools.map((t) => t.name)).not.toContain("task");
    expect(some.tools.map((t) => t.name)).not.toContain("memory");
    expect(some.memory).toBeUndefined();
    expect(some.commands.has("memory")).toBe(false);
    expect(some.builtins.find((b) => b.id === "jade/task")).toMatchObject({ state: "disabled" });
    const text = await system(some.plugins);
    expect(text).not.toContain("task tool");
    expect(text).not.toContain("todo_write");
    some.shutdown();
  });

  test("a plugin replaces a built-in and may reuse its tool names; jade/policy cannot be replaced", async () => {
    const cwd = await tmp("jade-builtin-");
    const home = await tmp("jade-builtin-home-");
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider,
      env: {},
      extensions: [
        fakePlugin("myweb", { id: "me/web", replaces: ["jade/web"], tools: [tool("web_fetch")] }),
        fakePlugin("bad", { id: "me/policy", replaces: ["jade/policy"] }),
        // 代替 jade/todo，但工具名和 jade/fs 的重复：被拒绝，jade/todo 恢复
        fakePlugin("clash", { id: "me/todo", replaces: ["jade/todo"], tools: [tool("read_file")] }),
      ],
    });
    expect(jade.builtins.find((b) => b.id === "jade/web")).toMatchObject({ state: "replaced", by: "me/web" });
    expect(jade.builtins.find((b) => b.id === "jade/todo")).toMatchObject({ state: "on" });
    expect(jade.builtins.find((b) => b.id === "jade/policy")).toMatchObject({ state: "on" });
    expect(jade.plugins.map((p) => p.id)).toEqual(expect.arrayContaining(["me/web", "me/policy", "jade/policy", "jade/todo"]));
    expect(jade.plugins.map((p) => p.id)).not.toContain("jade/web");
    expect(jade.plugins.map((p) => p.id)).not.toContain("me/todo");
    expect(jade.warnings.join("\n")).toContain("cannot replace jade/policy");
    expect(jade.warnings.join("\n")).toContain("tool read_file already exists");
    // 能用这个清单创建运行时：没有重复的 id 和工具名
    await Runtime.create({ store: new MemoryLogStore(), provider, plugins: jade.plugins });
    jade.shutdown();
  });
});
