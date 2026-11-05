import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, Runtime, type Block, type ModelRequest, type ModelResponse, type Provider } from "uncarved";
import {
  createJade,
  expandEnv,
  loadMcpConfig,
  loadSkills,
  McpClient,
  mcpToolName,
  mcpTools,
  parseSkill,
  skillTool,
  type McpServerEntry,
} from "../src/index.ts";

const MODEL = { by: "model", provider: "scripted", model: "scripted-1" } as const;
type Step = Omit<ModelResponse, "model">;
const use = (id: string, name: string, input: unknown): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
const reply = (t: string): Step => ({ content: [{ kind: "text", text: t, origin: MODEL, trust: "trusted" }], stopReason: "end" });
const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });
const SERVER = path.join(import.meta.dir, "fixtures", "mcp-server.ts");

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
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-mcp-")));
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-mcp-home-")));
  return { cwd, home };
}

const results = (req: ModelRequest) => req.messages.at(-1)!.content.filter((b) => b.kind === "tool_result") as Extract<Block, { kind: "tool_result" }>[];
const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n");

const open: McpClient[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

function fake(cwd: string, env: Record<string, string> = {}): McpClient {
  const entry: McpServerEntry = { name: "fake", layer: "user", file: "mcp.json", config: { command: process.execPath, args: [SERVER], env } };
  const c = new McpClient(entry, { cwd });
  open.push(c);
  return c;
}

describe("MCP config", () => {
  test("user, .mcp.json and .jade/mcp.json are merged with nearer files winning; ${VAR} is expanded", async () => {
    const { cwd: root, home } = await dirs();
    const sub = path.join(root, "pkg");
    await mkdir(path.join(sub, ".jade"), { recursive: true });
    await writeFile(
      path.join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "user-b" }, web: { type: "http", url: "${HOST:-https://d.example}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } } }),
    );
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { b: { command: "repo-b", args: ["--k=${KEY}"] }, old: { type: "sse", url: "https://x" } } }));
    await writeFile(path.join(sub, ".jade", "mcp.json"), JSON.stringify({ mcpServers: { c: { command: "node", cwd: "tools" }, "bad name": { command: "x" }, d: {} } }));
    const { servers, warnings } = await loadMcpConfig({ home, root, cwd: sub, env: { KEY: "k1", TOKEN: "t" } });
    expect(servers.map((s) => [s.name, s.layer])).toEqual([
      ["a", "user"],
      ["b", "project"],
      ["web", "user"],
      ["c", "project"],
    ]);
    expect(servers.find((s) => s.name === "b")!.config.args).toEqual(["--k=k1"]);
    expect(servers.find((s) => s.name === "web")!.config).toMatchObject({ url: "https://d.example/mcp", headers: { Authorization: "Bearer t" } });
    expect(servers.find((s) => s.name === "c")!.config.cwd).toBe(path.join(sub, ".jade", "tools"));
    expect(warnings.join("\n")).toContain("legacy");
    expect(warnings.join("\n")).toContain('"bad name"');
    expect(warnings.join("\n")).toContain('needs "command"');

    // 缺少的环境变量：跳过这个服务
    const missing = await loadMcpConfig({ home, root, cwd: sub, env: {} });
    expect(missing.servers.map((s) => s.name)).not.toContain("b");
    expect(missing.warnings.join("\n")).toContain("KEY is not set");
    expect(expandEnv("${A}-${B:-x}", { A: "1" }, [])).toBe("1-x");
  });

  test("tool names follow mcp__server__tool, are cleaned and stay within 64 characters", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(mcpToolName("a.b", "x/y:z")).toBe("mcp__a_b__x_y_z");
    const long = mcpToolName("server", "t".repeat(100));
    expect(long.length).toBe(64);
    expect(long).not.toBe(mcpToolName("server", "t".repeat(99)));
  });
});

describe("MCP stdio client", () => {
  test("connects, pages through tools, maps them to jade tools and calls them inside a session", async () => {
    const { cwd, home } = await dirs();
    const client = fake(cwd);
    await client.connect();
    expect(client.status).toBe("connected");
    expect(client.serverInfo).toEqual({ name: "fake", version: "1.2.3" });
    expect(client.tools.map((t) => t.name)).toEqual(["echo", "picture", "fail", "crash", "slow", "weird.name/with:chars"]);

    const tools = mcpTools([client]);
    const echo = tools.find((t) => t.name === "mcp__fake__echo")!;
    expect([echo.effect, echo.concurrency]).toEqual(["read", "safe"]);
    expect(tools.find((t) => t.name === "mcp__fake__picture")!.effect).toBe("external");
    expect(mcpTools([client], { readOnly: true }).map((t) => t.name)).toEqual(["mcp__fake__echo"]);

    const s = scripted([
      { content: [use("e", "mcp__fake__echo", { text: "hi" }), use("p", "mcp__fake__picture", {}), use("f", "mcp__fake__fail", {})], stopReason: "tool_use" },
      reply("ok"),
    ]);
    const store = new MemoryLogStore();
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, mcp: [client], mode: "yolo" });
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("go"));
    // 服务的使用说明进了系统提示词，标为 untrusted
    const instr = s.requests[0]!.system.find((x) => x.text.includes("Use echo for testing."))!;
    expect(instr.trust).toBe("untrusted");
    const [e, p, f] = results(s.requests[1]!);
    expect(textOf(e!.content)).toBe("echo: hi");
    expect(p!.content.map((b) => b.kind)).toEqual(["image", "text"]);
    expect((p!.content[0] as { source: unknown }).source).toEqual({ type: "base64", media_type: "image/png", data: "aGk=" });
    expect(f!.isError).toBe(true);
    expect(textOf(f!.content)).toBe("it broke");
    jade.shutdown();
  }, 20_000);

  test("ask mode asks before a tool that is not declared read-only", async () => {
    const { cwd, home } = await dirs();
    const client = fake(cwd);
    await client.connect();
    const s = scripted([{ content: [use("e", "mcp__fake__echo", { text: "a" }), use("p", "mcp__fake__picture", {})], stopReason: "tool_use" }]);
    const store = new MemoryLogStore();
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, mcp: [client] });
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("go"));
    expect(rt.state.batch.map((c) => [c.name, c.decision])).toEqual([
      ["mcp__fake__echo", "allow"],
      ["mcp__fake__picture", "ask"],
    ]);
    jade.shutdown();
  }, 20_000);

  test("reconnects after the server exits; an aborted call is cancelled on the server", async () => {
    const { cwd } = await dirs();
    const mark = path.join(cwd, "mark.txt");
    const client = fake(cwd, { MCP_MARK: mark });
    await client.connect();
    const tools = mcpTools([client]);
    const run = (name: string, signal = new AbortController().signal) =>
      tools.find((t) => t.name === name)!.execute({ text: "x" }, { sessionId: "s", toolUseId: "t", signal, parent: { sessionId: "s", eventId: "e" }, progress: () => {} });

    const crashed = await run("mcp__fake__crash");
    expect(crashed.isError).toBe(true);
    expect(String(crashed.content)).toContain("exited");
    const again = await run("mcp__fake__echo");
    expect(textOf(again.content as Block[])).toBe("echo: x");
    expect((await readFile(mark, "utf8")).match(/start/g)).toHaveLength(2);

    const ac = new AbortController();
    const slow = run("mcp__fake__slow", ac.signal);
    setTimeout(() => ac.abort(new Error("stop")), 200);
    await expect(slow).rejects.toThrow("stop");
    await new Promise((r) => setTimeout(r, 300));
    expect(await readFile(mark, "utf8")).toContain("cancelled");
  }, 20_000);

  test.skipIf(process.platform !== "win32")("on Windows a command that is a .cmd script on PATH (like npx) starts through cmd.exe", async () => {
    const { cwd } = await dirs();
    const bin = path.join(cwd, "bin with space");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "fake-mcp.cmd"), `@"${process.execPath}" %*\r\n`);
    const entry: McpServerEntry = {
      name: "cmd",
      layer: "user",
      file: "mcp.json",
      config: { command: "fake-mcp", args: [SERVER], env: { PATH: `${bin};${process.env.PATH ?? ""}` } },
    };
    const saved = process.env.PATH;
    // 按 jade 自己的 PATH 查找命令（和 Claude Code 一样），所以要改的是当前进程的 PATH
    process.env.PATH = `${bin};${saved ?? ""}`;
    try {
      const c = new McpClient(entry, { cwd });
      open.push(c);
      await c.connect();
      const r = await c.callTool("echo", { text: 'a "quoted" & arg' }, new AbortController().signal);
      expect(r.content).toEqual([{ type: "text", text: 'echo: a "quoted" & arg' }]);
    } finally {
      process.env.PATH = saved;
    }
  }, 20_000);

  test("a server that cannot start fails with a reason instead of hanging", async () => {
    const { cwd } = await dirs();
    const entry: McpServerEntry = { name: "nope", layer: "user", file: "mcp.json", config: { command: "definitely-not-a-command-xyz" } };
    const c = new McpClient(entry, { cwd });
    open.push(c);
    await expect(c.connect()).rejects.toThrow();
    expect(c.status).toBe("failed");
    expect(mcpTools([c])).toEqual([]);
  }, 40_000);
});

describe("MCP streamable HTTP client", () => {
  test("JSON and SSE replies, the session id header and auth headers", async () => {
    const seen: { method?: string; session: string | null; auth: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        const body = (await req.json()) as { id?: number; method: string; params?: { name?: string } };
        seen.push({ method: body.method, session: req.headers.get("mcp-session-id"), auth: req.headers.get("authorization") });
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === "initialize") {
          return Response.json(
            { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "web" } } },
            { headers: { "mcp-session-id": "sess-1" } },
          );
        }
        if (body.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
        }
        // tools/call 用 SSE 回复，前面先来一条通知
        const events = [
          { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
          { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "found it" }] } },
        ];
        return new Response(events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const entry: McpServerEntry = {
        name: "web",
        layer: "user",
        file: "mcp.json",
        config: { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: "Bearer t" } },
      };
      const c = new McpClient(entry, { cwd: os.tmpdir() });
      open.push(c);
      await c.connect();
      expect(c.tools.map((t) => t.name)).toEqual(["lookup"]);
      const r = await c.callTool("lookup", {}, new AbortController().signal);
      expect(r.content).toEqual([{ type: "text", text: "found it" }]);
      expect(seen.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
      expect(seen[0]!.session).toBeNull();
      expect(seen.slice(1).every((x) => x.session === "sess-1" && x.auth === "Bearer t")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("skills", () => {
  async function skill(base: string, name: string, text: string, files: Record<string, string> = {}) {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), text);
    for (const [f, c] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), c);
    }
    return dir;
  }

  test("parses front matter, including multi-line descriptions", () => {
    const { meta, body } = parseSkill("---\nname: pdf\ndescription: >\n  Work with PDFs.\n  Use for PDF files.\nlicense: MIT\n---\n# Steps\n1. go\n");
    expect(meta).toEqual({ name: "pdf", description: "Work with PDFs. Use for PDF files.", license: "MIT" });
    expect(body).toBe("# Steps\n1. go");
  });

  test("found in ~/.claude/skills, $JADE_HOME/skills and the project's .claude/.jade skills; nearer wins", async () => {
    const { cwd: root, home } = await dirs();
    const userHome = await mkdtemp(path.join(os.tmpdir(), "jade-skills-user-"));
    await skill(path.join(userHome, ".claude", "skills"), "review", "---\ndescription: claude review\n---\nA");
    await skill(path.join(home, "skills"), "review", "---\ndescription: jade review\n---\nB");
    await skill(path.join(root, ".claude", "skills"), "deploy", "---\nname: deploy\ndescription: deploy it\n---\nC");
    await skill(path.join(root, ".jade", "skills"), "nodesc", "");
    await skill(path.join(root, ".jade", "skills"), "fallback", "# Uses the first line\nbody");
    const { skills, warnings } = await loadSkills({ home, root, cwd: root, userHome });
    expect(skills.map((x) => [x.name, x.description, x.layer])).toEqual([
      ["deploy", "deploy it", "project"],
      ["fallback", "Uses the first line", "project"],
      ["review", "jade review", "user"],
    ]);
    expect(warnings.join("\n")).toContain("no description");
  });

  test("the skill list is in the system prompt; the skill tool loads instructions and its files are readable without asking", async () => {
    const { cwd, home } = await dirs();
    const dir = await skill(path.join(home, "skills"), "release", "---\ndescription: cut a release\n---\nRun scripts/release.sh, then read notes.md.", {
      "notes.md": "release notes template",
      "scripts/release.sh": "echo",
    });
    const { skills } = await loadSkills({ home, root: cwd, cwd, userHome: home });
    const s = scripted([
      { content: [use("k", "skill", { name: "release" })], stopReason: "tool_use" },
      { content: [use("r", "read_file", { path: path.join(dir, "notes.md") })], stopReason: "tool_use" },
      reply("done"),
    ]);
    const store = new MemoryLogStore();
    const jade = await createJade({ cwd, home, store, provider: s.provider, env: {}, skills });
    const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("make a release"));
    const listed = s.requests[0]!.system.find((x) => x.text.startsWith("# Skills"))!;
    expect(listed.text).toContain("- release: cut a release");
    expect(listed.trust).toBe("trusted");
    const loaded = textOf(results(s.requests[1]!)[0]!.content);
    expect(loaded).toContain(`Its directory is ${dir}`);
    expect(loaded).toContain("scripts/release.sh");
    expect(loaded).toContain("Run scripts/release.sh");
    expect(loaded).not.toContain("description:");
    // ask 模式下读 skill 目录里的文件不用问（工作目录之外的其他文件仍然要问）
    expect(textOf(results(s.requests[2]!)[0]!.content)).toContain("release notes template");
    jade.shutdown();

    const unknown = await skillTool(skills).execute({ name: "nope" }, {} as never);
    expect(unknown.isError).toBe(true);
  });
});
