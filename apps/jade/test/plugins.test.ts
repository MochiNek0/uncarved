import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, MemoryTrustStore, readAll, Runtime, type Block, type ModelRequest, type ModelResponse, type Provider } from "uncarved";
import { createJade, discoverPlugins, loadPlugin, type FoundPlugin, type LoadedPlugin } from "../src/index.ts";

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
});
