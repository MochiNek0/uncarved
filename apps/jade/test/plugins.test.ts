import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, MemoryTrustStore, readAll, Runtime, type Block, type ModelRequest, type ModelResponse, type Provider } from "uncarved";
import { clearProviders, createJade, discoverPlugins, listModels, loadPlugin, providerFromEnv, providerInfo, registerProviders, SEARCH_PROVIDERS, visionFromEnv, type FoundPlugin, type LoadedPlugin } from "../src/index.ts";
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
    const fake = (name: string, make: () => unknown): LoadedPlugin => ({
      name,
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
        fake("undeclared", () => ({ id: "x/u", version: "1.0.0", kernel: "^0.1", hooks: [{ kind: "observe", point: "event", fn: () => {} }] })),
        fake("clash-id", () => ({ id: "jade/policy", version: "1.0.0", kernel: "^0.1" })),
        fake("clash-tool", () => ({ id: "x/t", version: "1.0.0", kernel: "^0.1", tools: [tool("read_file")] })),
        fake("good", () => ({
          id: "x/good",
          version: "1.0.0",
          kernel: "^0.1",
          tools: [tool("good_tool")],
          commands: [{ name: "ok", run: () => "fine" }, { name: "bad name", run: () => "" }, { name: "norun" }],
        })),
        fake("dup-command", () => ({ id: "x/dup", version: "1.0.0", kernel: "^0.1", commands: [{ name: "OK", run: () => "" }] })),
      ],
    });
    const warned = (name: string) => jade.warnings.find((w) => w.includes(name)) ?? "";
    expect(warned("plugin throws")).toContain("boom");
    expect(warned("plugin old")).toContain("requires kernel ^9");
    expect(warned("plugin undeclared")).toContain("undeclared capabilities");
    expect(warned("plugin clash-id")).toContain("already has the id jade/policy");
    expect(warned("plugin clash-tool")).toContain("tool read_file already exists");
    expect(jade.warnings.filter((w) => w.includes("plugin good")).length).toBe(2);
    expect(warned("x/dup")).toContain("x/good already provides it");
    expect(jade.extensions.map((e) => e.plugin.id)).toEqual(["x/good", "x/dup"]);
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

  test("suggest, beforeSend and ctx.status are collected; only the first suggest is used", async () => {
    const { cwd, home } = await dirs();
    const statuses: [string, string | undefined][] = [];
    const fake = (name: string, extra: (host: HostContext) => Record<string, unknown>): LoadedPlugin => ({
      name,
      dir: path.join(home, "plugins", name),
      layer: "user",
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async (host) => ({ id: `x/${name}`, version: "1.0.0", kernel: "^0.1", ...extra(host) }) as never,
    });
    const next = async () => "run the tests";
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      onStatus: (p, t) => void statuses.push([p, t]),
      extensions: [
        fake("ghost", () => ({ suggest: { next } })),
        fake("ghost2", () => ({ suggest: { next } })),
        fake("bad", () => ({ suggest: { next: "nope" }, beforeSend: 1 })),
        fake("upper", (host) => (host.status("upper", "ready"), { beforeSend: (t: string) => t.toUpperCase() })),
      ],
    });
    expect(jade.suggester?.plugin).toBe("x/ghost");
    expect(jade.warnings.find((w) => w.includes("x/ghost2"))).toContain("x/ghost already provides it");
    expect(jade.warnings.filter((w) => w.includes("plugin bad")).join("\n")).toContain("suggest is ignored");
    expect(jade.warnings.filter((w) => w.includes("plugin bad")).join("\n")).toContain("beforeSend is ignored");
    expect(jade.beforeSend.map((b) => b.plugin)).toEqual(["x/upper"]);
    expect(await jade.beforeSend[0]!.fn("hi", { sessionId: "s", signal: new AbortController().signal })).toBe("HI");
    expect(statuses).toEqual([["upper", "ready"]]);
  });

  test("only user plugins can provide a responder", async () => {
    const { cwd, home } = await dirs();
    const fake = (name: string, layer: "user" | "project", responder: unknown): LoadedPlugin => ({
      name,
      dir: path.join(home, "plugins", name),
      layer,
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => ({ id: `x/${name}`, version: "1.0.0", kernel: "^0.1", responder }) as never,
    });
    const approve = async () => ({ approved: true });
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      extensions: [fake("phone", "user", { approve }), fake("repo", "project", { approve }), fake("broken", "user", { approve: "yes" })],
    });
    expect(jade.responders.map((r) => r.plugin)).toEqual(["x/phone"]);
    expect(jade.warnings.find((w) => w.includes("plugin repo"))).toContain("only user plugins can answer approvals");
    expect(jade.warnings.find((w) => w.includes("plugin broken"))).toContain("must be functions");
    // 被忽略的插件其余部分照常加载
    expect(jade.extensions.map((e) => e.plugin.id)).toEqual(["x/phone", "x/repo", "x/broken"]);
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
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ command: process.execPath, args: ["main.ts"] }));
    const loaded = await loadPlugin({ name: "greet", dir, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => true });
    try {
      const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: scripted([]).provider, env: {}, extensions: [loaded] });
      expect(jade.warnings.filter((w) => w.includes("greet"))).toEqual([
        'plugin greet (user): command "bad name" is ignored: it needs a name of letters, digits, - and _, and a run function',
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

  test("/undo also restores files that a third-party tool saved through ctx.checkpoints", async () => {
    const { cwd, home } = await dirs();
    const file = path.join(cwd, "notes.txt");
    await writeFile(file, "old");
    const plugin: LoadedPlugin = {
      name: "stamp",
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
      // 没注册时 providerInfo 不报错（插件可能还没加载），只是没有模型名
      expect(providerInfo({ JADE_PROVIDER: "nope" })).toEqual({ kind: "nope", model: "" });
    } finally {
      clearProviders();
    }
  });

  test("only user plugins can provide services, and malformed ones are skipped", async () => {
    const { cwd, home } = await dirs();
    const fake = (name: string, layer: "user" | "project", providers: unknown): LoadedPlugin => ({
      name,
      dir: path.join(home, "plugins", name),
      layer,
      kind: "module",
      entry: "index.ts",
      info: { kind: "module", entry: "index.ts", json: {}, bundle: { skills: [], commands: [], unsupported: [] } },
      create: async () => ({ id: `x/${name}`, version: "1.0.0", kernel: "^0.1", providers }) as never,
    });
    const jade = await createJade({
      cwd,
      home,
      store: new MemoryLogStore(),
      provider: scripted([]).provider,
      env: {},
      extensions: [
        fake("good", "user", [
          { ...def("foo"), settings: [{ env: "FOO_KEY", label: "key" }, { env: "JADE_MAX_TOKENS", label: "x" }, { env: "FOO_KEY", label: "again" }] },
          { kind: "bad name", model: () => "", create: () => ({}) },
        ]),
        fake("repo", "project", [def("bar")]),
      ],
    });
    expect(jade.providers.map((p) => `${p.plugin}:${p.def.kind}`)).toEqual(["x/good:foo"]);
    // 不能用 jade 自己的变量，也不能重复
    expect(jade.providers[0]!.def.settings!.map((x) => x.env)).toEqual(["FOO_KEY"]);
    expect(jade.warnings.join("\n")).toContain('setting "JADE_MAX_TOKENS" is ignored');
    expect(jade.warnings.join("\n")).toContain("setting FOO_KEY is ignored: it is listed twice");
    expect(jade.warnings.join("\n")).toContain('provider "bad name" is ignored');
    expect(jade.warnings.join("\n")).toContain("plugin repo (project): providers are ignored: only user plugins can provide model services");
    jade.shutdown();
  });
});

describe("input box, keys and send", () => {
  /** 写一个进程内插件：工厂把拿到的 input、send 记在 globalThis 上，返回给定的 keys */
  async function plugin(base: string, name: string, keys: string) {
    const dir = path.join(base, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "index.js"),
      `export default (ctx) => {
  globalThis.__jadeCtx = { ...globalThis.__jadeCtx, ${JSON.stringify(name)}: ctx };
  return { id: "x/${name}", version: "1.0.0", kernel: "^0.1", keys: ${keys} };
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
    expect(sent).toEqual([["voice", "go"]]);
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
});

describe("tool renderers", () => {
  test("a plugin can only render its own tools, once each", async () => {
    const { cwd, home } = await dirs();
    const tool = { name: "deploy", description: "", inputSchema: { type: "object" }, effect: "read", concurrency: "safe", idempotent: true, execute: async () => ({ content: "" }) };
    const summary = () => "x";
    const loaded: LoadedPlugin = {
      name: "deploy",
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
    expect([...jade.renderers].map(([k, v]) => `${k} ${v.plugin}`)).toEqual(["deploy x/deploy"]);
    const warnings = jade.warnings.join("\n");
    expect(warnings).toContain('renderer for "deploy" is ignored: the tool already has a renderer');
    expect(warnings).toContain('renderer for "bash" is ignored: a plugin can only render its own tools');
    expect(warnings).toContain('renderer for "deploy" is ignored: it needs a tool name, and summary, preview and result must be functions');
    jade.shutdown();
  });
});
