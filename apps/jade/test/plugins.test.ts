import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, MemoryTrustStore, readAll, Runtime, type Block, type ModelRequest, type ModelResponse, type Provider } from "uncarved";
import { clearProviders, collectProviders, createJade, DISPOSE_TIMEOUT_MS, discoverPlugins, listModels, loadPlugin, openPluginHost, pluginProviders, providerFromEnv, providerInfo, registerProviders, resolvePlugins, SEARCH_PROVIDERS, visionFromEnv, type FoundPlugin, type LoadedPlugin } from "../src/index.ts";
import type { HostContext, SessionControl } from "../src/plugins/loader.ts";

const MODEL = { by: "model", provider: "scripted", model: "scripted-1" } as const;
type Step = Omit<ModelResponse, "model">;
const use = (id: string, name: string, input: unknown): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
const reply = (t: string): Step => ({ content: [{ kind: "text", text: t, origin: MODEL, trust: "trusted" }], stopReason: "end" });
const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });
const EXAMPLES = path.join(import.meta.dir, "..", "examples", "plugins");

function scripted(script: Step[]) {
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    id: "scripted",
    async complete(req) {
      requests.push(structuredClone(req));
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return { model: "scripted-1", ...next };
    },
  };
  return { provider, requests };
}

async function dirs() {
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-plugins-")));
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-plugins-home-")));
  return { cwd, home };
}

/** 把示例插件复制到 <base>/plugins/<name> */
async function install(base: string, name: string) {
  const dir = path.join(base, "plugins", name);
  await cp(path.join(EXAMPLES, name), dir, { recursive: true });
  return dir;
}

const resultText = (req: ModelRequest) =>
  req.messages
    .at(-1)!
    .content.flatMap((b) => (b.kind === "tool_result" ? b.content : []))
    .flatMap((b) => (b.kind === "text" ? [b.text] : []))
    .join("\n");

describe("plugin discovery", () => {
  test("user plugins, then project plugins from the repository root down; a nearer directory with the same name wins", async () => {
    const { cwd: root, home } = await dirs();
    const sub = path.join(root, "pkg");
    for (const d of [
      path.join(home, "plugins", "a"),
      path.join(root, ".jade", "plugins", "b"),
      path.join(root, ".jade", "plugins", "c"),
      path.join(root, ".jade", "plugins", ".hidden"),
      path.join(sub, ".jade", "plugins", "c"),
    ])
      await mkdir(d, { recursive: true });
    await writeFile(path.join(root, ".jade", "plugins", "not-a-dir.ts"), "");
    const found = await discoverPlugins({ home, root, cwd: sub });
    expect(found.map((f) => [f.layer, f.name, path.relative(root, f.dir).split(path.sep).join("/")])).toEqual([
      ["user", "a", path.relative(root, path.join(home, "plugins", "a")).split(path.sep).join("/")],
      ["project", "b", ".jade/plugins/b"],
      ["project", "c", "pkg/.jade/plugins/c"],
    ]);
  });

  test("plugin.json problems are reported, a directory without an entry is rejected", async () => {
    const { cwd } = await dirs();
    const at = async (name: string, json?: string): Promise<FoundPlugin> => {
      const dir = path.join(cwd, name);
      await mkdir(dir, { recursive: true });
      if (json !== undefined) await writeFile(path.join(dir, "plugin.json"), json);
      return { name, dir, layer: "user" };
    };
    const opts = { trust: new MemoryTrustStore(), confirm: async () => true };
    await expect(loadPlugin(await at("empty"), opts)).rejects.toThrow("no index.ts");
    await expect(loadPlugin(await at("broken", "{"), opts)).rejects.toThrow("plugin.json");
    await expect(loadPlugin(await at("both", JSON.stringify({ entry: "a.ts", command: "x" })), opts)).rejects.toThrow("not both");
    await expect(loadPlugin(await at("args", JSON.stringify({ command: "x", args: "a" })), opts)).rejects.toThrow('"args"');
    // 有代码的插件要在 plugin.json 里写 id
    await expect(loadPlugin(await at("no-id", JSON.stringify({ entry: "a.ts" })), opts)).rejects.toThrow('"id" is required');
    await expect(loadPlugin(await at("no-id-process", JSON.stringify({ command: "x" })), opts)).rejects.toThrow('"id" is required');
    await expect(loadPlugin(await at("bad-id", JSON.stringify({ id: "a b", entry: "a.ts" })), opts)).rejects.toThrow('"id" must be');
  });

  test("plugins are told apart by the id in plugin.json before any of their code runs", async () => {
    const { cwd: root, home } = await dirs();
    const write = async (dir: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
      }
    };
    // 被执行就会留下记号：停用的、重复的插件都不应该被执行
    const code = (mark: string) => `globalThis.__jadeRan = [...(globalThis.__jadeRan ?? []), ${JSON.stringify(mark)}];\nexport default (ctx) => ctx.definePlugin({});\n`;
    const user = (name: string) => path.join(home, "plugins", name);
    const project = (name: string) => path.join(root, ".jade", "plugins", name);
    await write(user("keep"), { "plugin.json": JSON.stringify({ id: "me/keep", version: "1.0.0" }), "index.js": code("keep") });
    await write(user("off"), { "plugin.json": JSON.stringify({ id: "me/off", version: "1.0.0" }), "index.js": code("off") });
    await write(project("same-id"), { "plugin.json": JSON.stringify({ id: "me/keep", version: "2.0.0" }), "index.js": code("same-id") });
    await write(project("reserved"), { "plugin.json": JSON.stringify({ id: "jade/web", version: "1.0.0" }), "index.js": code("reserved") });
    await write(project("broken"), { "plugin.json": "{" });
    await write(project("docs"), { "skills/x/SKILL.md": "---\nname: x\ndescription: x\n---\n" });
    const r = await resolvePlugins(await discoverPlugins({ home, root, cwd: root }), new Set(["me/off"]));
    expect(r.plugins.map((p) => `${p.layer}:${p.name}:${p.id}`)).toEqual(["user:keep:me/keep", "project:docs:docs"]);
    expect(r.broken.map((b) => b.found.name)).toEqual(["broken"]);
    expect(r.warnings.join("\n")).toContain(`plugin ${project("same-id")} is skipped: plugin ${user("keep")} already has the id me/keep`);
    expect(r.warnings.join("\n")).toContain("the id jade/web is reserved");
    expect((globalThis as { __jadeRan?: string[] }).__jadeRan).toBeUndefined();

    // 加载、创建实例：ctx.definePlugin 补上清单里的 id 和 version
    const loaded = await loadPlugin(r.plugins[0]!, { trust: new MemoryTrustStore(), confirm: async () => false });
    expect(loaded.id).toBe("me/keep");
    const jade = await createJade({ cwd: root, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: [loaded] });
    expect(jade.extensions.map((e) => `${e.plugin.id} ${e.plugin.version}`)).toEqual(["me/keep 1.0.0"]);
    expect((globalThis as { __jadeRan?: string[] }).__jadeRan).toEqual(["keep"]);
    delete (globalThis as { __jadeRan?: string[] }).__jadeRan;
    jade.shutdown();
  });
});

describe("in-process plugins", () => {
  test("a project plugin is confirmed once, gets a fresh instance per session, and its gate and notices work", async () => {
    const { cwd, home } = await dirs();
    const dir = await install(path.join(cwd, ".jade"), "protect-files");
    const asked: string[] = [];
    const confirm = async (r: { path: string }) => (asked.push(r.path), true);
    const loaded = await loadPlugin({ name: "protect-files", dir, layer: "project" }, { trust: new MemoryTrustStore(), confirm });
    expect(asked).toEqual([dir]);

    const s = scripted([{ content: [use("w", "write_file", { path: ".env", content: "X=1" })], stopReason: "tool_use" }, reply("ok")]);
    const store = new MemoryLogStore();
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, extensions: [loaded], mode: "yolo" });
    expect(jade.warnings).toEqual([]);
    expect(jade.extensions.map((e) => e.plugin.layer)).toEqual(["project"]);
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("go"));
    // 即使是 yolo，插件的拒绝也优先
    expect(resultText(s.requests[1]!)).toContain("is protected by the project");
    const notices = (await readAll(store, rt.state.sessionId)).filter((e) => e.type === "example/protect-files/notice");
    expect(notices.map((e) => (e.data as { level: string }).level)).toEqual(["warning"]);

    const again = await createJade({ cwd, home, store, provider: s.provider, env: {}, extensions: [loaded] });
    expect(again.extensions[0]!.plugin).not.toBe(jade.extensions[0]!.plugin);
    expect(asked).toHaveLength(1);
  });

  test("a user plugin factory gets jade's context; its tool runs and its commands are collected", async () => {
    const { cwd, home } = await dirs();
    execFileSync("git", ["init", "-q"], { cwd });
    await writeFile(path.join(cwd, "a.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"], { cwd });
    await writeFile(path.join(cwd, "a.txt"), "two\n");

    const dir = await install(home, "git-review");
    const loaded = await loadPlugin({ name: "git-review", dir, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => false });
    const s = scripted([{ content: [use("d", "git_diff", {})], stopReason: "tool_use" }, reply("ok")]);
    const store = new MemoryLogStore();
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, extensions: [loaded] });
    expect(jade.warnings.filter((w) => w.includes("plugin"))).toEqual([]);
    expect([...jade.commands].filter(([, c]) => !c.builtin).map(([k]) => k)).toEqual(["review", "branch"]);
    const plugin = jade.extensions[0]!.plugin;
    expect(plugin.layer).toBe("user");
    // definePlugin 推出了 needs（这个插件没有 hook）并填上了 kernel
    expect(plugin.kernel).toBe("^0.1");

    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("go"));
    // effect 为 read 的工具在 ask 模式下也直接执行
    expect(resultText(s.requests[1]!)).toContain("+two");

    const ui = { interactive: false, log: () => {}, select: async () => undefined, input: async () => undefined };
    const ctx = { sessionId: rt.state.sessionId, cwd, signal: new AbortController().signal, derived: {}, ui, note: () => {} };
    expect(await jade.commands.get("review")!.command.run("naming", ctx)).toEqual({ prompt: expect.stringContaining("Focus on: naming.") });
    expect(await jade.commands.get("branch")!.command.run("", ctx)).toContain("first");
    jade.shutdown();
  });

  test("broken plugins are skipped with a warning instead of stopping jade", async () => {
    const { cwd, home } = await dirs();
    const fake = (name: string, make: () => unknown, id = `x/${name}`): LoadedPlugin => ({
      name,
      id,
      dir: path.join(home, "plugins", name),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => make() as never,
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
    const s = scripted([]);
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: s.provider,
      env: {},
      extensions: [
        fake("throws", () => {
          throw new Error("boom");
        }),
        fake("old", () => ({ id: "x/old", version: "1.0.0", kernel: "^9" })),
        fake("undeclared", () => ({ id: "x/undeclared", version: "1.0.0", kernel: "^0.1", hooks: [{ kind: "observe", point: "event", fn: () => {} }] })),
        fake("other-id", () => ({ id: "x/something-else", version: "1.0.0", kernel: "^0.1" })),
        fake("clash-id", () => ({ id: "jade/policy", version: "1.0.0", kernel: "^0.1" }), "jade/policy"),
        fake("bare-jade", () => ({ id: "jade", version: "1.0.0", kernel: "^0.1" }), "jade"),
        fake("jade-ns", () => ({ id: "jade/extra", version: "1.0.0", kernel: "^0.1" }), "jade/extra"),
        fake("clash-tool", () => ({ id: "x/clash-tool", version: "1.0.0", kernel: "^0.1", tools: [tool("read_file")] })),
        fake("good", () => ({
          id: "x/good",
          version: "1.0.0",
          kernel: "^0.1",
          tools: [tool("good_tool")],
          commands: [{ name: "ok", run: () => "fine" }, { name: "bad name", run: () => "" }, { name: "norun" }],
        })),
        fake("dup-command", () => ({ id: "x/dup-command", version: "1.0.0", kernel: "^0.1", commands: [{ name: "OK", run: () => "" }] })),
      ],
    });
    const warned = (name: string) => jade.warnings.find((w) => w.includes(name)) ?? "";
    expect(warned("plugin x/throws")).toContain("boom");
    expect(warned("plugin x/old")).toContain("requires kernel ^9");
    expect(warned("plugin x/undeclared")).toContain("undeclared capabilities");
    expect(warned("plugin x/other-id")).toContain('its id "x/something-else" does not match "id" in plugin.json');
    expect(warned("plugin jade/policy ")).toContain("already has the id jade/policy");
    expect(warned("plugin jade ")).toContain("the id jade is reserved");
    expect(warned("plugin jade/extra ")).toContain("the id jade/extra is reserved");
    expect(warned("plugin x/clash-tool")).toContain("tool read_file already exists");
    expect(jade.warnings.filter((w) => w.includes("plugin x/good (")).length).toBe(2);
    expect(warned("x/dup-command")).toContain("x/good already provides it");
    expect(jade.extensions.map((e) => e.plugin.id)).toEqual(["x/good", "x/dup-command"]);
    expect([...jade.commands].filter(([, c]) => !c.builtin).map(([k]) => k)).toEqual(["ok"]);
    // 剩下的插件能正常组成运行时
    await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: jade.plugins });
  });

  test("sub-agents run third-party tool hooks, but not their tools or other hooks", async () => {
    const { cwd, home } = await dirs();
    await writeFile(path.join(cwd, "a.txt"), "token=SECRET\n");
    let turns = 0;
    const plugin = {
      id: "x/redact",
      version: "1.0.0",
      kernel: "^0.1",
      needs: ["transform:tool.after", "observe:model.after"],
      tools: [{ name: "x_tool", description: "", inputSchema: { type: "object" }, effect: "read", concurrency: "safe", idempotent: true, execute: async () => ({ content: "" }) }],
      hooks: [
        {
          kind: "transform",
          point: "tool.after",
          fn: (o: { content: Block[] }) => ({ ...o, content: o.content.map((b) => (b.kind === "text" ? { ...b, text: b.text.replaceAll("SECRET", "[redacted]") } : b)) }),
        },
        { kind: "observe", point: "model.after", fn: () => void turns++ },
      ],
    };
    const loaded: LoadedPlugin = {
      name: "redact",
      id: "x/redact",
      dir: path.join(home, "plugins", "redact"),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => plugin as never,
    };
    const s = scripted([
      { content: [use("t", "task", { description: "read", prompt: "read a.txt" })], stopReason: "tool_use" },
      { content: [use("r", "read_file", { path: "a.txt" })], stopReason: "tool_use" },
      reply("the token is [redacted]"),
      reply("done"),
    ]);
    const store = new MemoryLogStore();
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, extensions: [loaded], mode: "yolo", browser: null });
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("go"));
    // 子 Agent 读到的文件内容也脱敏了
    expect(resultText(s.requests[2]!)).toContain("token=[redacted]");
    expect(resultText(s.requests[2]!)).not.toContain("SECRET");
    // 插件的工具只给主 Agent；observe hook 只看到主 Agent 的两次回复
    expect(s.requests[0]!.tools.map((t) => t.name)).toContain("x_tool");
    expect(s.requests[1]!.tools.map((t) => t.name)).not.toContain("x_tool");
    expect(turns).toBe(2);
    jade.shutdown();
  });

  test("a plugin can call the current model with ctx.complete, outside the session", async () => {
    const { cwd, home } = await dirs();
    let complete: ((...a: Parameters<HostContext["complete"]>) => ReturnType<HostContext["complete"]>) | undefined;
    const loaded: LoadedPlugin = {
      name: "asker",
      id: "x/asker",
      dir: path.join(home, "plugins", "asker"),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async (host) => ((complete = host.complete), { id: "x/asker", version: "1.0.0", kernel: "^0.1" }) as never,
    };
    const s = scripted([reply("next: run the tests")]);
    const store = new MemoryLogStore();
    await createJade({ cwd, home, store, provider: s.provider, env: {}, extensions: [loaded] });
    const res = await complete!({ system: "predict", prompt: "the chat so far" }, new AbortController().signal);
    expect(res).toMatchObject({ text: "next: run the tests", model: "scripted-1" });
    expect(s.requests[0]!.tools).toEqual([]);
    expect(s.requests[0]!.system.map((x) => x.text)).toEqual(["predict"]);
    expect(s.requests[0]!.messages[0]!.content[0]).toMatchObject({ kind: "text", text: "the chat so far" });
  });

  test("ctx.status is collected; responder, suggest and beforeSend are no longer offered and are ignored with a warning", async () => {
    const { cwd, home } = await dirs();
    const statuses: [string, string | undefined][] = [];
    const fake = (name: string, extra: (host: HostContext) => Record<string, unknown>): LoadedPlugin => ({
      name,
      id: `x/${name}`,
      dir: path.join(home, "plugins", name),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async (host) => ({ id: `x/${name}`, version: "1.0.0", kernel: "^0.1", ...extra(host) }) as never,
    });
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      onStatus: (p, t) => void statuses.push([p, t]),
      extensions: [
        fake("old", () => ({ suggest: { next: async () => "x" }, beforeSend: (t: string) => t, responder: { approve: async () => ({ approved: true }) } })),
        fake("upper", (host) => (host.status("upper", "ready"), {})),
      ],
    });
    expect(jade.warnings.filter((w) => w.includes("plugin x/old"))).toEqual([
      "plugin x/old (user): responder is ignored: jade does not offer it to plugins",
      "plugin x/old (user): suggest is ignored: jade does not offer it to plugins",
      "plugin x/old (user): beforeSend is ignored: jade does not offer it to plugins",
    ]);
    // 其余部分照常加载
    expect(jade.extensions.map((e) => e.plugin.id)).toEqual(["x/old", "x/upper"]);
    expect(statuses).toEqual([["upper", "ready"]]);
  });

  test("jade never rewrites a plugin instance: what it keeps is on the extension, what it ignores stays where it was", async () => {
    const { cwd, home } = await dirs();
    const approve = async () => ({ approved: true });
    const run = () => {};
    const tool = { name: "x_tool", description: "d", effect: "read" as const, inputSchema: { type: "object" }, execute: async () => ({ content: "ok" }) };
    // 项目层插件：实例就是内核认的那个对象，jade 只能读
    const made = {
      id: "x/repo",
      version: "1.0.0",
      kernel: "^0.1",
      tools: [tool],
      responder: { approve },
      providers: [],
      dispose: "later",
      beforeSend: 1,
      suggest: { next: "nope" },
      renderers: [{ tool: "x_tool", summary: () => "s" }, { tool: "read_file", summary: () => "x" }],
      commands: [{ name: "ok", run }, { name: "bad name", run }],
      keys: [{ key: "Ctrl+G", run }, { key: "ctrl+c", run }],
    };
    const before = { ...made, renderers: [...made.renderers], commands: [...made.commands], keys: [...made.keys] };
    const source: LoadedPlugin = {
      name: "repo",
      id: "x/repo",
      dir: path.join(cwd, ".jade", "plugins", "repo"),
      layer: "project",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => made as never,
    };
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: [source] });
    const [ext] = jade.extensions;
    expect(ext!.plugin).toBe(made as never);
    // 实例的每个字段都还是原来的值（同一个对象、同一个数组、同样的内容）
    expect(Object.keys(made)).toEqual(Object.keys(before));
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      if (Array.isArray(before[k])) expect(made[k]).toEqual(before[k] as never);
      else expect(made[k]).toBe(before[k] as never);
    }
    expect(made.keys[0]!.key).toBe("Ctrl+G");
    // jade 用的是检查过、留下的
    expect(ext!.commands.map((c) => c.name)).toEqual(["ok"]);
    expect(ext!.keys.map((k) => k.key)).toEqual(["ctrl+g"]);
    expect(ext!.renderers.map((r) => r.tool)).toEqual(["x_tool"]);
    expect(jade.renderers.get("x_tool")?.plugin).toBe("x/repo");
    expect(jade.renderers.get("read_file")?.plugin).not.toBe("x/repo");
    const warned = jade.warnings.filter((w) => w.includes("plugin x/repo")).join("\n");
    for (const what of ["responder is ignored", "providers is ignored", "dispose is ignored", "beforeSend is ignored", "suggest is ignored", 'renderer for "read_file"', 'command "bad name"', 'key "ctrl+c"'])
      expect(warned).toContain(what);
    // dispose 不是函数：不调用，也不出错
    expect(await jade.dispose()).toEqual([]);
    jade.shutdown();
  });
});

const python = (() => {
  try {
    execFileSync("python", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("out-of-process plugins", () => {
  test.skipIf(!python)("a Python plugin from plugin.json redacts secrets in tool output; a project one is confirmed with its command", async () => {
    const { cwd, home } = await dirs();
    await writeFile(path.join(cwd, "creds.txt"), "key = AKIAABCDEFGHIJKLMNOP\nok");
    const dir = await install(path.join(cwd, ".jade"), "redact-secrets");
    const asked: (string | undefined)[] = [];
    const loaded = await loadPlugin(
      { name: "redact-secrets", dir, layer: "project" },
      { trust: new MemoryTrustStore(), confirm: async (r) => (asked.push(r.command), true) },
    );
    try {
      expect(asked).toEqual(["python redact.py"]);
      expect(loaded.kind).toBe("process");
      const s = scripted([{ content: [use("r", "read_file", { path: "creds.txt" })], stopReason: "tool_use" }, reply("ok")]);
      const store = new MemoryLogStore();
      const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, extensions: [loaded] });
      expect(jade.warnings.filter((w) => w.includes("plugin"))).toEqual([]);
      const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
      await rt.send(msg("go"));
      const seen = resultText(s.requests[1]!);
      expect(seen).toContain("[REDACTED]");
      expect(seen).not.toContain("AKIA");
      expect(seen).toContain("ok");
    } finally {
      await loaded.close!();
    }
    expect(loaded.process!.exited).toBeDefined();
  }, 20_000);

  test("a process plugin declares slash commands in its initialize reply; jade runs them over jade/command", async () => {
    const { cwd, home } = await dirs();
    const dir = path.join(home, "plugins", "greet");
    await mkdir(dir, { recursive: true });
    // 最小的进程外插件：一行一条 JSON-RPC
    await writeFile(
      path.join(dir, "main.ts"),
      `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const manifest = { id: "x/greet", version: "1.0.0", kernel: "^0.1", hooks: [], commands: [
  { name: "hello", description: "say hello", args: "[name]" },
  { name: "ask", instant: true },
  { name: "bad name" },
] };
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  const p = msg.params;
  const result =
    msg.method === "initialize" ? manifest
    : msg.method === "shutdown" ? {}
    : msg.method === "jade/command" && p.name === "hello" ? { text: "Hello, " + (p.args || "world") + " from " + p.sessionId }
    : msg.method === "jade/command" && p.name === "ask" ? { prompt: "explain " + p.args }
    : undefined;
  send(result ? { id: msg.id, result } : { id: msg.id, error: { code: -32601, message: "unknown " + msg.method } });
  if (msg.method === "shutdown") process.exit(0);
}
`,
    );
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "x/greet", command: process.execPath, args: ["main.ts"] }));
    const loaded = await loadPlugin({ name: "greet", dir, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => true });
    try {
      const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: [loaded] });
      expect(jade.warnings.filter((w) => w.includes("greet"))).toEqual([
        'plugin x/greet (user): command "bad name" is ignored: it needs a name of letters, digits, - and _, and a run function',
      ]);
      const hello = jade.commands.get("hello")!;
      expect(hello.plugin).toBe("x/greet");
      expect([hello.command.description, hello.command.args, hello.command.instant]).toEqual(["say hello", "[name]", false]);
      expect(jade.commands.get("ask")!.command.instant).toBe(true);
      const ctx = { sessionId: "s1", cwd, signal: new AbortController().signal, derived: {}, ui: { interactive: false, log: () => {}, select: async () => undefined as never, input: async () => undefined }, note: () => {} };
      expect(await hello.command.run("jade", ctx)).toBe("Hello, jade from s1");
      expect(await jade.commands.get("ask")!.command.run("this", ctx)).toEqual({ prompt: "explain this" });
      jade.shutdown();
    } finally {
      await loaded.close!();
    }
  }, 20_000);
});

describe("session commands use the public SessionControl", () => {
  const ui = { interactive: true, log: () => {}, select: async () => undefined as never, input: async () => undefined };
  const control = (over: Partial<SessionControl> = {}): SessionControl & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      messages: () => [],
      record: async (k) => void calls.push(`record ${k}`),
      list: async () => [
        { id: "s-current", title: "now", at: new Date().toISOString() },
        { id: "s-older", title: "before", at: new Date().toISOString() },
      ],
      clear: async () => void calls.push("clear"),
      reload: async () => void calls.push("reload"),
      resume: async (id) => void calls.push(`resume ${id}`),
      retry: async () => false,
      ...over,
    };
  };

  test("/clear, /resume and /retry come from jade/sessions and go through ctx.session", async () => {
    const { cwd, home } = await dirs();
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {} });
    expect(["clear", "resume", "retry", "undo"].map((n) => jade.commands.get(n)?.plugin)).toEqual(["jade/sessions", "jade/sessions", "jade/sessions", "jade/undo"]);
    const session = control();
    const ctx = { sessionId: "s-current", cwd, signal: new AbortController().signal, derived: {}, ui, note: () => {}, session };
    await jade.commands.get("clear")!.command.run("", ctx);
    // 前缀匹配到唯一的会话
    await jade.commands.get("resume")!.command.run("s-o", ctx);
    expect(await jade.commands.get("resume")!.command.run("s-current", ctx)).toContain("current session");
    expect(await jade.commands.get("retry")!.command.run("", ctx)).toContain("Nothing to retry");
    expect(session.calls).toEqual(["clear", "resume s-older"]);
    // 不给 session（instant 命令或别的宿主）时说明原因
    await expect(Promise.resolve(jade.commands.get("clear")!.command.run("", { ...ctx, session: undefined }))).rejects.toThrow(/session control/);
    jade.shutdown();
  });

  test("/search comes from jade/web: it writes the key to $JADE_HOME/.env and reloads the session", async () => {
    const { cwd, home } = await dirs();
    const env: Record<string, string | undefined> = {};
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env });
    expect(jade.commands.get("search")?.plugin).toBe("jade/web");
    const session = control();
    const picks: unknown[] = [];
    const inputs: { title: string; mask?: boolean }[] = [];
    const ctx = {
      sessionId: "s",
      cwd,
      signal: new AbortController().signal,
      derived: {},
      note: () => {},
      session,
      ui: {
        interactive: true,
        log: () => {},
        select: async (_t: string, choices: { value: unknown }[]) => picks.shift() ?? choices[0]!.value,
        input: async (title: string, o?: { mask?: boolean }) => (inputs.push({ title, mask: o?.mask }), "key-1"),
      },
    };
    const first = SEARCH_PROVIDERS[0]!;
    expect(await jade.commands.get("search")!.command.run("", ctx as never)).toContain(`Web search is on with ${first.name}`);
    expect(inputs).toEqual([{ title: `${first.name} API key`, mask: true }]);
    expect(env[first.env]).toBe("key-1");
    expect(await readFile(path.join(home, ".env"), "utf8")).toContain(`${first.env}=key-1`);
    // 再选同一个服务、选 Remove：从 .env 里删掉
    picks.push(first.name, "off");
    expect(await jade.commands.get("search")!.command.run("", ctx as never)).toContain("removed");
    expect(env[first.env]).toBeUndefined();
    expect(session.calls).toEqual(["reload", "reload"]);
    jade.shutdown();
  });

  test("disabling jade/sessions removes its commands", async () => {
    const { cwd, home } = await dirs();
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, disabled: ["jade/sessions"] });
    expect(jade.commands.has("clear")).toBe(false);
    expect(jade.commands.has("undo")).toBe(true);
    expect(jade.builtins.find((b) => b.id === "jade/sessions")).toMatchObject({ state: "disabled" });
    jade.shutdown();
  });

  test("/undo restores the last turn's files and records it under its own key", async () => {
    const { cwd, home } = await dirs();
    const store = new MemoryLogStore();
    const s = scripted([{ content: [use("w", "write_file", { path: "new.txt", content: "hi\n" })], stopReason: "tool_use" }, reply("done")]);
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, mode: "yolo" });
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("write it"));
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(true);
    const notes: string[] = [];
    const session = control({ messages: () => structuredClone(rt.state.messages), record: (k, v) => rt.record(k, v) });
    const ctx = { sessionId: rt.state.sessionId, cwd, signal: new AbortController().signal, derived: rt.state.derived, ui, note: (t: string) => void notes.push(t), session };
    expect(await jade.commands.get("undo")!.command.run("", ctx)).toContain("Undid 1 change");
    expect(existsSync(path.join(cwd, "new.txt"))).toBe(false);
    expect(rt.state.derived["jade/undo"]).toEqual({ undone: ["w"] });
    expect(notes[0]).toContain("undid your changes");
    expect(await jade.commands.get("undo")!.command.run("", { ...ctx, derived: rt.state.derived })).toContain("Nothing to undo");
    jade.shutdown();
  });

  test("/undo shows paths relative to the project when jade runs from a linked directory", async () => {
    const { cwd: real, home } = await dirs();
    // 目录链接（Windows 上是 junction，不需要管理员权限）：jade/fs 记下的路径经过它，插件看到的 cwd 是解析过的
    const cwd = path.join(path.dirname(real), `${path.basename(real)}-link`);
    await symlink(real, cwd, "junction");
    const store = new MemoryLogStore();
    const s = scripted([{ content: [use("w", "write_file", { path: "a.txt", content: "1\n" }), use("v", "write_file", { path: "b.txt", content: "2\n" })], stopReason: "tool_use" }, reply("done")]);
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, mode: "yolo" });
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("write them"));
    const notes: string[] = [];
    const bodies: string[] = [];
    const session = control({ messages: () => structuredClone(rt.state.messages), record: (k, v) => rt.record(k, v) });
    const yes = { ...ui, select: async (_t: string, _c: unknown, o?: { body?: string }) => (bodies.push(o?.body ?? ""), true) as never };
    const ctx = { sessionId: rt.state.sessionId, cwd, signal: new AbortController().signal, derived: rt.state.derived, ui: yes, note: (t: string) => void notes.push(t), session };
    const out = String(await jade.commands.get("undo")!.command.run("", ctx));
    expect(bodies[0]).toContain("delete  a.txt");
    expect(out).toContain("delete  b.txt");
    expect(notes[0]).toContain("deleted a.txt (you had created it)");
    jade.shutdown();
  });

  test("/undo also restores files that a third-party tool saved through ctx.checkpoints", async () => {
    const { cwd, home } = await dirs();
    const file = path.join(cwd, "notes.txt");
    await writeFile(file, "old");
    const plugin: LoadedPlugin = {
      name: "stamp",
      id: "x/stamp",
      dir: path.join(home, "plugins", "stamp"),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async (host) =>
        ({
          id: "x/stamp",
          version: "1.0.0",
          kernel: "^0.1",
          tools: [
            {
              name: "stamp",
              description: "overwrite notes.txt",
              inputSchema: { type: "object" },
              effect: "write",
              concurrency: "exclusive",
              async execute(_input: unknown, ctx: { sessionId: string; toolUseId: string }) {
                const after = "new";
                await host.checkpoints.save(ctx.sessionId, { toolUseId: ctx.toolUseId, tool: "stamp", path: file, before: await readFile(file, "utf8"), afterHash: createHash("sha256").update(after).digest("hex") });
                await writeFile(file, after);
                return { content: "ok" };
              },
            },
          ],
        }) as never,
    };
    const store = new MemoryLogStore();
    const s = scripted([{ content: [use("t", "stamp", {})], stopReason: "tool_use" }, reply("done")]);
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, mode: "yolo", extensions: [plugin] });
    expect(jade.warnings.filter((w) => w.includes("stamp"))).toEqual([]);
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("stamp it"));
    expect(await readFile(file, "utf8")).toBe("new");
    const session = control({ messages: () => structuredClone(rt.state.messages), record: (k, v) => rt.record(k, v) });
    const ctx = { sessionId: rt.state.sessionId, cwd, signal: new AbortController().signal, derived: rt.state.derived, ui, note: () => {}, session };
    expect(await jade.commands.get("undo")!.command.run("", ctx)).toContain("Undid 1 change");
    expect(await readFile(file, "utf8")).toBe("old");
    jade.shutdown();
  });
});

describe("model services from plugins", () => {
  const def = (kind: string, made: Provider = { id: kind, complete: async () => ({ model: "m", content: [], stopReason: "end" }) }) => ({
    kind,
    model: (env: Record<string, string | undefined>) => env.FOO_MODEL ?? "foo-1",
    via: () => "the Foo API",
    create: async () => made,
    listModels: async () => ["foo-1", "foo-2"],
  });

  test("JADE_PROVIDER picks a registered plugin service; unknown names still fail", async () => {
    clearProviders();
    try {
      expect(registerProviders([{ plugin: "x/foo", def: def("foo") }])).toEqual([]);
      expect(registerProviders([{ plugin: "x/again", def: def("foo") }, { plugin: "x/bad", def: def("openai") }])).toEqual([
        "plugin x/again: provider foo is ignored: plugin x/foo already provides it",
        "plugin x/bad: provider openai is ignored: it is a built-in provider",
      ]);
      const env = { JADE_PROVIDER: "foo", FOO_MODEL: "foo-2", JADE_EFFORT: "whatever" };
      expect(providerInfo(env)).toEqual({ kind: "foo", model: "foo-2" });
      expect((await providerFromEnv(env)).id).toBe("foo");
      expect(await listModels(env)).toEqual(["foo-1", "foo-2"]);
      // 插件的服务默认不算能看图片
      expect(visionFromEnv(env)).toBe(false);
      await expect(providerFromEnv({ JADE_PROVIDER: "nope" })).rejects.toThrow(/openai-compat, openai, anthropic, foo.*no plugin provides it/);
      // jade 自己的设置写错时同样报错
      await expect(providerFromEnv({ ...env, JADE_RPM: "lots" })).rejects.toThrow(/JADE_RPM/);
      await expect(providerFromEnv({ ...env, JADE_IDLE_TIMEOUT: "abc" })).rejects.toThrow(/JADE_IDLE_TIMEOUT/);
      // 没注册时 providerInfo 不报错（插件可能还没加载），只是没有模型名
      expect(providerInfo({ JADE_PROVIDER: "nope" })).toEqual({ kind: "nope", model: "" });
    } finally {
      clearProviders();
    }
  });

  test("only user plugins can provide services, and malformed ones are skipped", async () => {
    const { home } = await dirs();
    const fake = (name: string, layer: "user" | "project", providers: unknown): LoadedPlugin => ({
      name,
      id: `x/${name}`,
      dir: path.join(home, "plugins", name),
      layer,
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      providers,
      create: async () => {
        throw new Error("collecting providers must not create plugin instances");
      },
    });
    const { providers, warnings } = collectProviders([
      fake("good", "user", [
        { ...def("foo"), settings: [{ env: "FOO_KEY", label: "key" }, { env: "JADE_MAX_TOKENS", label: "x" }, { env: "FOO_KEY", label: "again" }] },
        { kind: "bad name", model: () => "", create: () => ({}) },
      ]),
      fake("repo", "project", [def("bar")]),
      fake("odd", "user", def("baz")),
    ]);
    expect(providers.map((p) => `${p.plugin}:${p.def.kind}`)).toEqual(["x/good:foo"]);
    // 不能用 jade 自己的变量，也不能重复
    expect(providers[0]!.def.settings!.map((x) => x.env)).toEqual(["FOO_KEY"]);
    const text = warnings.join("\n");
    expect(text).toContain('setting "JADE_MAX_TOKENS" is ignored');
    expect(text).toContain("setting FOO_KEY is ignored: it is listed twice");
    expect(text).toContain('provider "bad name" is ignored');
    expect(text).toContain("plugin x/repo (project): providers are ignored: only user plugins can provide model services");
    expect(text).toContain("plugin x/odd (user): providers is ignored: it must be an array");
  });

  test("dispose: used instances on jade.dispose (once), unused ones right away; errors and timeouts become warnings", async () => {
    const { cwd, home } = await dirs();
    const disposed: string[] = [];
    const fake = (name: string, id: string, dispose: unknown, sourceId = id): LoadedPlugin => ({
      name,
      id: sourceId,
      dir: path.join(home, "plugins", name),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => ({ id, version: "1.0.0", kernel: "^0.1", dispose }) as never,
    });
    const record = (name: string) => async () => void disposed.push(name);
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      extensions: [
        fake("a", "x/a", record("a")),
        fake("other-id", "x/b", record("other-id"), "x/other-id"),
        fake("dup", "x/a", record("dup")),
        fake("bad", "x/bad", () => {
          throw new Error("boom");
        }),
        fake("slow", "x/slow", () => new Promise(() => {})),
        fake("odd", "x/odd", "not a function"),
      ],
    });
    // id 和清单不一致的、id 重复被拒绝的：创建时就收尾
    expect(disposed.sort()).toEqual(["dup", "other-id"]);
    expect(jade.warnings.join("\n")).toContain("plugin x/odd (user): dispose is ignored: it must be a function");
    const started = Date.now();
    const warnings = await jade.dispose();
    expect(disposed.sort()).toEqual(["a", "dup", "other-id"]);
    expect(warnings).toEqual(["plugin x/bad (user): dispose failed: boom", `plugin x/slow (user): dispose did not finish within ${DISPOSE_TIMEOUT_MS / 1000}s`]);
    // 同时进行：总共只等一个时限
    expect(Date.now() - started).toBeLessThan(DISPOSE_TIMEOUT_MS + 2000);
    // 只执行一次
    expect(await jade.dispose()).toEqual(warnings);
    expect(disposed).toHaveLength(3);
    jade.shutdown();
  }, 20_000);

  test("a module exports its providers; the plugin instance does not provide them", async () => {
    const { cwd, home } = await dirs();
    const dir = path.join(home, "plugins", "foo");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "x/foo", version: "1.0.0" }));
    await writeFile(
      path.join(dir, "index.ts"),
      `export const providers = [{ kind: "foo", model: () => "f1", create: () => ({ id: "foo", complete: async () => ({ model: "f1", content: [], stopReason: "end" }) }) }];
export default () => ({ id: "x/foo", version: "1.0.0", kernel: "^0.1", providers: [{ kind: "late", model: () => "", create: () => ({}) }] });
`,
    );
    const loaded = await loadPlugin({ name: "foo", dir, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => false });
    // 加载就能读到，不用创建插件实例
    expect(collectProviders([loaded]).providers.map((p) => `${p.plugin}:${p.def.kind}`)).toEqual(["x/foo:foo"]);
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: [loaded] });
    // 工厂函数返回的 providers 不认，提示改成导出
    expect(jade.warnings.join("\n")).toContain("providers is ignored: export it from the plugin module instead");
    jade.shutdown();
  });
});

describe("input box, keys and send", () => {
  /** 写一个进程内插件：工厂把拿到的 input、send 记在 globalThis 上，返回给定的 keys */
  async function plugin(base: string, name: string, keys: string) {
    const dir = path.join(base, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: `x/${name}`, version: "1.0.0" }));
    await writeFile(
      path.join(dir, "index.js"),
      `export default (ctx) => {
  globalThis.__jadeCtx = { ...globalThis.__jadeCtx, ${JSON.stringify(name)}: ctx };
  return ctx.definePlugin({ keys: ${keys} });
};
`,
    );
    return dir;
  }
  type Seen = Record<string, { input?: { insert(t: string): void }; send?(t: string): void }>;

  test("only user plugins get ctx.input and ctx.send; send names the plugin", async () => {
    const { cwd, home } = await dirs();
    const user = await plugin(home, "voice", "[]");
    const repo = await plugin(path.join(cwd, ".jade"), "repo", "[]");
    const opts = { trust: new MemoryTrustStore(), confirm: async () => true };
    const inserted: string[] = [];
    const sent: [string, string][] = [];
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      extensions: [await loadPlugin({ name: "voice", dir: user, layer: "user" }, opts), await loadPlugin({ name: "repo", dir: repo, layer: "project" }, opts)],
      input: { text: () => "", insert: (t) => void inserted.push(t), set: () => {} },
      send: (p, t) => void sent.push([p, t]),
    });
    const seen = (globalThis as { __jadeCtx?: Seen }).__jadeCtx!;
    seen.voice!.input!.insert("hello");
    seen.voice!.send!("go");
    expect(inserted).toEqual(["hello"]);
    expect(sent).toEqual([["x/voice", "go"]]);
    expect(seen.repo!.input).toBeUndefined();
    expect(seen.repo!.send).toBeUndefined();
    jade.shutdown();
  });

  test("keys are normalized; malformed, reserved and taken keys are skipped", async () => {
    const { cwd, home } = await dirs();
    const run = "run: () => {}";
    const a = await plugin(home, "a", `[{ key: "Ctrl+G", description: "talk", ${run} }, { key: "ctrl+r", ${run} }, { key: "f2", ${run} }, { key: "alt+v" }]`);
    const b = await plugin(home, "b", `[{ key: "ctrl+g", ${run} }, { key: "alt+1", ${run} }]`);
    const opts = { trust: new MemoryTrustStore(), confirm: async () => true };
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      extensions: [await loadPlugin({ name: "a", dir: a, layer: "user" }, opts), await loadPlugin({ name: "b", dir: b, layer: "user" }, opts)],
    });
    expect([...jade.keys].map(([k, v]) => `${k} ${v.plugin}`)).toEqual(["ctrl+g x/a", "alt+1 x/b"]);
    const warnings = jade.warnings.join("\n");
    expect(warnings).toContain('key "ctrl+r" is ignored');
    expect(warnings).toContain('key "f2" is ignored');
    expect(warnings).toContain('key "alt+v" is ignored');
    expect(warnings).toContain("plugin x/b: key ctrl+g is ignored: plugin x/a already uses it");
    jade.shutdown();
  });

  test("a process plugin's keys go over jade/key; only a user one sees and changes the input box or sends", async () => {
    const { cwd, home } = await dirs();
    // 同一个进程外插件分别装在用户层和项目层
    const script = `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  const p = msg.params;
  // 不回复：jade 中止时发 $/cancel
  if (msg.method === "jade/key" && p.text === "hang") continue;
  const result =
    msg.method === "initialize" ? { id: "x/" + process.env.NAME, version: "1.0.0", kernel: "^0.1", hooks: [], keys: [{ key: process.env.KEY, description: "shout" }] }
    : msg.method === "shutdown" ? {}
    : msg.method === "jade/key" ? { set: String(p.text).toUpperCase() + " " + p.key + " " + p.sessionId, insert: "!", send: "seen " + p.text }
    : undefined;
  send(result ? { id: msg.id, result } : { id: msg.id, error: { code: -32601, message: "unknown " + msg.method } });
  if (msg.method === "shutdown") process.exit(0);
}
`;
    const make = async (base: string, name: string, key: string) => {
      const dir = path.join(base, "plugins", name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "main.ts"), script);
      await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: `x/${name}`, command: process.execPath, args: ["main.ts"], env: { NAME: name, KEY: key } }));
      return dir;
    };
    const opts = { trust: new MemoryTrustStore(), confirm: async () => true };
    const user = await loadPlugin({ name: "shout", dir: await make(home, "shout", "Ctrl+T"), layer: "user" }, opts);
    const repo = await loadPlugin({ name: "repo", dir: await make(path.join(cwd, ".jade"), "repo", "alt+r"), layer: "project" }, opts);
    try {
      let text = "hi";
      const sent: [string, string][] = [];
      const jade = await createJade({
        cwd,
        home,
        store: new MemoryLogStore(),
        provider: scripted([]).provider,
        env: {},
        extensions: [user, repo],
        input: { text: () => text, insert: (t) => void (text += t), set: (t) => void (text = t) },
        send: (p, t) => void sent.push([p, t]),
      });
      expect([...jade.keys].map(([k, v]) => `${k} ${v.plugin} ${v.key.description}`)).toEqual(["ctrl+t x/shout shout", "alt+r x/repo shout"]);
      await jade.keys.get("ctrl+t")!.key.run({ key: "ctrl+t", sessionId: "s1", signal: new AbortController().signal });
      expect(text).toBe("HI ctrl+t s1!");
      expect(sent).toEqual([["x/shout", "seen hi"]]);
      // 项目层：拿不到输入框的内容，回复里的 set、insert、send 不起作用
      await jade.keys.get("alt+r")!.key.run({ key: "alt+r", sessionId: "s1", signal: new AbortController().signal });
      expect(text).toBe("HI ctrl+t s1!");
      expect(sent).toHaveLength(1);
      // 插件不回复时，signal 中止就结束，不会一直挂着
      text = "hang";
      const ac = new AbortController();
      const pending = jade.keys.get("ctrl+t")!.key.run({ key: "ctrl+t", sessionId: "s1", signal: ac.signal });
      ac.abort(new Error("the session ended"));
      await expect(Promise.resolve(pending)).rejects.toThrow();

      // 准备下一个会话的一套（进程还是同一个）：当前这套的快捷键还是用当前的输入框，进程对象上不挂会话的东西
      let other = "next";
      const next = await createJade({
        cwd,
        home,
        store: new MemoryLogStore(),
        provider: scripted([]).provider,
        env: {},
        extensions: [user, repo],
        input: { text: () => other, insert: (t) => void (other += t), set: (t) => void (other = t) },
      });
      const proc = jade.extensions.find((e) => e.plugin.id === "x/shout")!.plugin;
      expect(next.extensions.find((e) => e.plugin.id === "x/shout")!.plugin).toBe(proc);
      expect(next.keys.get("ctrl+t")!.key).not.toBe(jade.keys.get("ctrl+t")!.key);
      expect("keys" in proc).toBe(false);
      text = "a";
      await jade.keys.get("ctrl+t")!.key.run({ key: "ctrl+t", sessionId: "s1", signal: new AbortController().signal });
      expect([text, other]).toEqual(["A ctrl+t s1!", "next"]);
      await next.keys.get("ctrl+t")!.key.run({ key: "ctrl+t", sessionId: "s2", signal: new AbortController().signal });
      expect([text, other]).toEqual(["A ctrl+t s1!", "NEXT ctrl+t s2!"]);
      next.shutdown();
      jade.shutdown();
    } finally {
      await Promise.all([user.close!(), repo.close!()]);
    }
  }, 20_000);

  test("the notes example: a tool with its own display, keys on the input box, send and a command", async () => {
    const { cwd, home } = await dirs();
    const loaded = await loadPlugin({ name: "notes", dir: await install(home, "notes"), layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => false });
    let text = "buy milk";
    const sent: [string, string][] = [];
    const statuses: string[] = [];
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      extensions: [loaded],
      input: { text: () => text, insert: (t) => void (text += t), set: (t) => void (text = t) },
      send: (p, t) => void sent.push([p, t]),
      onStatus: (_p, t) => void statuses.push(t ?? ""),
    });
    expect(jade.warnings.filter((w) => w.includes("notes"))).toEqual([]);
    expect(statuses).toEqual(["0 notes"]);
    // ctrl+t：输入框里的文字记成一条笔记，清空输入框
    await jade.keys.get("ctrl+t")!.key.run({ key: "ctrl+t", sessionId: "s1", signal: new AbortController().signal });
    expect(await readFile(path.join(cwd, "NOTES.md"), "utf8")).toBe("- buy milk\n");
    expect(text).toBe("");
    expect(statuses.at(-1)).toBe("1 notes");
    await jade.keys.get("ctrl+g")!.key.run({ key: "ctrl+g", sessionId: "s1", signal: new AbortController().signal });
    expect(sent).toEqual([["example/notes", expect.stringContaining("NOTES.md")]]);
    const ui = { interactive: false, log: () => {}, select: async () => undefined as never, input: async () => undefined };
    const ctx = { sessionId: "s", cwd, signal: new AbortController().signal, derived: {}, ui, note: () => {} };
    expect(await jade.commands.get("notes")!.command.run("", ctx)).toBe("- buy milk");

    // 工具和它的显示：before 记下执行前的条数，result 显示前后的数量
    const r = jade.renderers.get("add_note")!.renderer;
    const input = { text: "call the bank about the card" };
    expect(r.summary!(input)).toBe("call the bank about the card");
    expect(await r.preview!(input)).toContain("+ call the bank");
    const before = r.before!(input);
    const tool = jade.extensions[0]!.plugin.tools!.find((t) => t.name === "add_note")!;
    const out = await tool.execute(input, {} as never);
    expect(r.result!({ input, text: String(out.content), isError: false, before })).toEqual({ line: "NOTES.md: 1 → 2 notes" });
    jade.shutdown();
  });

  test.skipIf(!python)("the text-keys example: a Python plugin's commands and keys", async () => {
    const { cwd, home } = await dirs();
    const loaded = await loadPlugin({ name: "text-keys", dir: await install(home, "text-keys"), layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => false });
    try {
      let text = "hello world";
      const sent: [string, string][] = [];
      const jade = await createJade({
        cwd,
        home,
        store: new MemoryLogStore(),
        provider: scripted([]).provider,
        env: {},
        extensions: [loaded],
        input: { text: () => text, insert: (t) => void (text += t), set: (t) => void (text = t) },
        send: (p, t) => void sent.push([p, t]),
      });
      expect(jade.warnings.filter((w) => w.includes("text-keys"))).toEqual([]);
      const ui = { interactive: false, log: () => {}, select: async () => undefined as never, input: async () => undefined };
      const ctx = { sessionId: "s", cwd, signal: new AbortController().signal, derived: {}, ui, note: () => {} };
      expect(await jade.commands.get("wc")!.command.run("one two three", ctx)).toBe("3 words, 13 characters");
      expect(await jade.commands.get("explain")!.command.run("closures", ctx)).toEqual({ prompt: expect.stringContaining("closures") });
      await jade.keys.get("alt+u")!.key.run({ key: "alt+u", sessionId: "s1", signal: new AbortController().signal });
      expect(text).toBe("HELLO WORLD");
      await jade.keys.get("alt+d")!.key.run({ key: "alt+d", sessionId: "s1", signal: new AbortController().signal });
      expect(text).toMatch(/^HELLO WORLD\d{4}-\d\d-\d\d$/);
      text = "what is here?";
      await jade.keys.get("alt+s")!.key.run({ key: "alt+s", sessionId: "s1", signal: new AbortController().signal });
      expect(sent).toEqual([["example/text-keys", "In this directory: what is here?"]]);
      expect(text).toBe("");
      jade.shutdown();
    } finally {
      await loaded.close!();
    }
  }, 20_000);
});

describe("plugin host (process scope)", () => {
  test("reads manifests before loading, loads once, registers user providers, reports project ones, and closes processes quietly", async () => {
    const { cwd: root, home } = await dirs();
    const write = async (dir: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
      }
      return dir;
    };
    const svc = (kind: string) => `{ kind: "${kind}", model: () => "m", create: () => ({ id: "${kind}", complete: async () => ({ model: "m", content: [], stopReason: "end" }) }) }`;
    await write(path.join(home, "plugins", "svc"), {
      "plugin.json": JSON.stringify({ id: "me/svc", version: "1.0.0" }),
      "index.js": `export const providers = [${svc("host-svc")}];\nexport default (ctx) => ctx.definePlugin({});\n`,
    });
    // 项目层插件导出的服务不认，但要提示；为了读出它，模块不能被执行第二次
    await write(path.join(root, ".jade", "plugins", "repo-svc"), {
      "plugin.json": JSON.stringify({ id: "repo/svc", version: "1.0.0" }),
      "index.js": `globalThis.__jadeRepoRuns = (globalThis.__jadeRepoRuns ?? 0) + 1;\nexport const providers = [${svc("repo-svc")}];\nexport default (ctx) => ctx.definePlugin({});\n`,
    });
    await write(path.join(home, "plugins", "proc"), {
      "plugin.json": JSON.stringify({ id: "me/proc", command: process.execPath, args: ["main.ts"] }),
      "main.ts": `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  send({ id: msg.id, result: msg.method === "initialize" ? { id: "me/proc", version: "1.0.0", kernel: "^0.1", hooks: [] } : {} });
  if (msg.method === "shutdown") process.exit(0);
}
`,
    });
    await write(path.join(home, "plugins", "kit"), { "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: d\n---\n" });
    await write(path.join(home, "plugins", "broken"), { "index.js": "export default {};" });
    await write(path.join(home, "plugins", "off"), { "plugin.json": JSON.stringify({ id: "me/off", version: "1.0.0" }), "index.js": "throw new Error('disabled plugins must not run');" });

    const reports: string[] = [];
    clearProviders();
    const host = await openPluginHost({
      home,
      root,
      cwd: root,
      disabled: new Set(["me/off"]),
      trust: new MemoryTrustStore(),
      confirm: async () => true,
      report: (kind, text) => void reports.push(`${kind}: ${text}`),
    });
    try {
      // 清单读完就知道带了什么内容，不用等加载
      expect(host.plugins.map((p) => p.id)).toEqual(["kit", "me/proc", "me/svc", "repo/svc"]);
      expect(host.bundled((b) => b.skills).map((b) => b.plugin)).toEqual(["kit"]);
      expect(host.loaded).toEqual([]);
      expect(reports).toEqual([]);

      const loaded = await host.load();
      expect(await host.load()).toBe(loaded);
      expect(loaded.map((p) => p.id)).toEqual(["kit", "me/proc", "me/svc", "repo/svc"]);
      expect(host.loaded).toEqual(loaded);
      expect(pluginProviders().map((p) => `${p.plugin}:${p.def.kind}`)).toEqual(["me/svc:host-svc"]);
      expect((globalThis as { __jadeRepoRuns?: number }).__jadeRepoRuns).toBe(1);
      expect(reports).toEqual([
        expect.stringMatching(/^skipped: plugin .*broken: plugin\.json: "id" is required/),
        "warning: plugin repo/svc (project): providers are ignored: only user plugins can provide model services",
      ]);

      const proc = loaded.find((p) => p.id === "me/proc")!;
      await host.close();
      await host.close();
      expect(proc.process!.exited).toBeDefined();
      // 关闭时进程退出是预期的，不报告
      expect(reports).toHaveLength(2);
    } finally {
      await host.close();
      clearProviders();
      delete (globalThis as { __jadeRepoRuns?: number }).__jadeRepoRuns;
    }
  }, 20_000);

  test("a process plugin that exits by itself is reported once; its calls fail after that and it is not restarted", async () => {
    const { cwd: root, home } = await dirs();
    const dir = path.join(home, "plugins", "dies");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "me/dies", command: process.execPath, args: ["main.ts"] }));
    await writeFile(
      path.join(dir, "main.ts"),
      `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  if (msg.method === "jade/command" && msg.params.name === "die") process.exit(3);
  send({ id: msg.id, result: msg.method === "initialize" ? { id: "me/dies", version: "1.0.0", kernel: "^0.1", hooks: [], commands: [{ name: "die" }, { name: "ping" }] } : { text: "pong" } });
  if (msg.method === "shutdown") process.exit(0);
}
`,
    );
    const reports: string[] = [];
    const host = await openPluginHost({ home, root, cwd: root, disabled: new Set(), trust: new MemoryTrustStore(), confirm: async () => true, report: (kind, text) => void reports.push(`${kind}: ${text}`) });
    try {
      const loaded = await host.load();
      const jade = await createJade({ cwd: root, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: loaded });
      const ctx = { sessionId: "s", cwd: root, signal: new AbortController().signal, derived: {}, ui: {} as never, note: () => {} };
      expect(await jade.commands.get("ping")!.command.run("", ctx as never)).toBe("pong");
      await expect(Promise.resolve(jade.commands.get("die")!.command.run("", ctx as never))).rejects.toThrow();
      const proc = loaded.find((p) => p.id === "me/dies")!;
      while (!proc.process!.exited) await new Promise((r) => setTimeout(r, 20));
      expect(proc.process!.exited).toEqual({ code: 3, signal: null });
      expect(reports).toEqual(["warning: plugin me/dies exited (code 3); its hooks fail until jade restarts. /plugins shows its stderr"]);
      // 之后的调用按出错处理；再加载也是同一个（已经退出的）进程，不重启
      await expect(Promise.resolve(jade.commands.get("ping")!.command.run("", ctx as never))).rejects.toThrow();
      expect(await host.load()).toBe(loaded);
      const next = await createJade({ cwd: root, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: loaded });
      await expect(Promise.resolve(next.commands.get("ping")!.command.run("", ctx as never))).rejects.toThrow();
      expect(reports).toHaveLength(1);
      jade.shutdown();
      next.shutdown();
    } finally {
      await host.close();
    }
  }, 20_000);
});

describe("tool renderers", () => {
  test("a plugin can only render its own tools, once each", async () => {
    const { cwd, home } = await dirs();
    const tool = { name: "deploy", description: "", inputSchema: { type: "object" }, effect: "read", concurrency: "safe", idempotent: true, execute: async () => ({ content: "" }) };
    const summary = () => "x";
    const loaded: LoadedPlugin = {
      name: "deploy",
      id: "x/deploy",
      dir: path.join(home, "plugins", "deploy"),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () =>
        ({
          id: "x/deploy",
          version: "1.0.0",
          kernel: "^0.1",
          tools: [tool],
          renderers: [{ tool: "deploy", summary }, { tool: "deploy", summary }, { tool: "bash", summary }, { tool: "deploy", result: "nope" }],
        }) as never,
    };
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: [loaded] });
    expect([...jade.renderers].filter(([, v]) => !v.plugin.startsWith("jade/")).map(([k, v]) => `${k} ${v.plugin}`)).toEqual(["deploy x/deploy"]);
    const warnings = jade.warnings.join("\n");
    expect(warnings).toContain('renderer for "deploy" is ignored: the tool already has a renderer');
    expect(warnings).toContain('renderer for "bash" is ignored: a plugin can only render its own tools');
    expect(warnings).toContain('renderer for "deploy" is ignored: it needs a tool name, and summary, details, preview, before and result must be functions');
    jade.shutdown();
  });
});
