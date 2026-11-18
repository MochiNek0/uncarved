// jade/mcp：从旧 jade 的 test/mcp-skills.test.ts 移植 MCP 的部分，加上经插件宿主的端到端测试（配置文件、项目层服务的确认、/mcp）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block } from "uncarved";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { manageMcp } from "../plugins/mcp/install.ts";
import { expandEnv, loadMcpConfig, McpClient, McpToolCache, mcpToolName, mcpTools, type McpServerEntry } from "../plugins/mcp/mcp.ts";
import type { SessionManager, UI } from "../src/index.ts";
import { featureHost, msg, reply, results, tempDir, textOf, use } from "./feature-host.ts";
import { plain as plainText } from "../plugins/tui/screen.ts";
import type { Text } from "@uncarved/jade-api";
/** 插件给的是带样式的文字（Text）：只比文字 */
const shown = (r: unknown) => plainText(r as Text);

const SERVER = path.join(import.meta.dir, "fixtures", "mcp-server.ts");

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

const fakeServer = { command: process.execPath, args: [SERVER] };
const ui: UI = { interactive: false, notify: () => {}, select: async () => undefined, input: async () => undefined };
const ctxFor = (sessions: SessionManager): CommandContext => ({ signal: new AbortController().signal, ui, sessions, print: () => {} });
type Host = Awaited<ReturnType<typeof featureHost>>["host"];
/** 执行 /mcp */
const mcp = (host: Host, args: string) => host.service<Commands>("commands@1")!.get("mcp")!.command.run(args, ctxFor(host.sessions));
/** /mcp 显示有服务连上了 */
const mcpConnected = async (host: Host) => /connected/.test(shown(await mcp(host, "")));

describe("MCP config", () => {
  test("user, .mcp.json and .jade/mcp.json are merged with nearer files winning; ${VAR} is expanded", async () => {
    const root = await tempDir("jade-mcp-");
    const home = await tempDir("jade-mcp-home-");
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
  test("connects, pages through tools and maps them to jade tools", async () => {
    const cwd = await tempDir("jade-mcp-");
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
  }, 20_000);

  test("reconnects after the server exits; an aborted call is cancelled on the server", async () => {
    const cwd = await tempDir("jade-mcp-");
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
    const cwd = await tempDir("jade-mcp-");
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
    const cwd = await tempDir("jade-mcp-");
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

describe("jade/mcp plugin", () => {
  test("tools of servers in $JADE_HOME/mcp.json are in the session; their instructions are untrusted system text", async () => {
    const home = await tempDir("jade-mcp-home-");
    const mark = path.join(home, "mark.txt");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: { ...fakeServer, env: { MCP_MARK: mark } } } }));
    const { host, state } = await featureHost({ home, config: { "jade/approval": { mode: "yolo" } } });
    try {
      state.script.push({ content: [use("e", "mcp__fake__echo", { text: "hi" }), use("p", "mcp__fake__picture", {}), use("f", "mcp__fake__fail", {})], stopReason: "tool_use" }, reply("ok"));
      const s = await host.sessions.open();
      await s.send(msg("go"));
      const instr = state.requests[0]!.system.find((x) => x.text.includes("Use echo for testing."))!;
      expect(instr.trust).toBe("untrusted");
      expect(state.requests[0]!.tools.map((t) => t.name)).toContain("mcp__fake__weird_name_with_chars");
      const [e, p, f] = results(state.requests[1]!);
      expect(textOf(e!.content)).toBe("echo: hi");
      expect(p!.content.map((b) => b.kind)).toEqual(["image", "text"]);
      expect(f!.isError).toBe(true);
      expect(textOf(f!.content)).toBe("it broke");
      const listed = shown(await host.service<Commands>("commands@1")!.get("mcp")!.command.run("", ctxFor(host.sessions)));
      expect(listed).toContain("fake");
      expect(listed).toContain("connected");
      expect(listed).toContain("echo");
      // 每个服务、合计都估算了每次请求占多少 token
      expect(listed).toMatch(/fake .*≈\d+ tokens/);
      expect(listed).toMatch(/≈\d+ tokens in every request/);
    } finally {
      await host.close();
    }
    // 进程作用域关闭时服务进程被关掉
    const pid = Number(/start (\d+)/.exec(await readFile(mark, "utf8"))![1]);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 30_000);

  test("ask mode asks before a tool that is not declared read-only", async () => {
    const home = await tempDir("jade-mcp-home-");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: fakeServer } }));
    const { host, state } = await featureHost({ home });
    try {
      state.answers.push("deny");
      state.script.push({ content: [use("e", "mcp__fake__echo", { text: "a" }), use("p", "mcp__fake__picture", {})], stopReason: "tool_use" }, reply("ok"));
      const s = await host.sessions.open();
      await s.send(msg("go"));
      expect(state.selects.map((x) => x.title)).toEqual(["Allow mcp__fake__picture?"]);
      const [e, p] = results(state.requests[1]!);
      expect(textOf(e!.content)).toBe("echo: a");
      expect(p!.isError).toBe(true);
    } finally {
      await host.close();
    }
  }, 30_000);

  test("a failed start is retried in the next session instead of breaking MCP until jade restarts", async () => {
    const home = await tempDir("jade-mcp-home-");
    const cwd = await tempDir("jade-mcp-repo-");
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repo: fakeServer } }));
    // 确认记录写不进去（这里是个目录）：确认之后记录失败
    await mkdir(path.join(home, "state", "confirmed.json"), { recursive: true });
    const w = await featureHost({ home, cwd });
    try {
      w.state.answers.push("yes", "yes");
      w.state.script.push(reply("ok"), reply("ok"));
      await (await w.host.sessions.open()).send(msg("hi"));
      expect(w.state.requests[0]!.tools.some((t) => t.name.startsWith("mcp__"))).toBe(false);

      await rm(path.join(home, "state", "confirmed.json"), { recursive: true });
      await (await w.host.sessions.open()).send(msg("again"));
      expect(w.state.requests[1]!.tools.map((t) => t.name)).toContain("mcp__repo__echo");
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("a server jade connected to before is not waited for: the session starts with its tools from last time and calls wait for it", async () => {
    const home = await tempDir("jade-mcp-home-");
    const delay = path.join(home, "delay.txt");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: { ...fakeServer, env: { MCP_DELAY_FILE: delay } } } }));
    const config = { "jade/approval": { mode: "yolo" } };
    // 第一次：没连上过，照常等它连上，记下它的工具
    const first = await featureHost({ home, config });
    try {
      first.state.script.push(reply("ok"));
      await (await first.host.sessions.open()).send(msg("hi"));
      expect(first.state.requests[0]!.tools.map((t) => t.name)).toContain("mcp__fake__echo");
    } finally {
      await first.host.close();
    }
    const cached = JSON.parse(await readFile(path.join(home, "state", "mcp-tools.json"), "utf8")) as { servers: Record<string, { tools: unknown[] }> };
    expect(Object.values(cached.servers).map((e) => e.tools.length)).toEqual([6]);

    // 第二次：服务要 7 秒才启动好（超过等待的 5 秒），会话不等它，工具和说明照样有，调用时等它连上
    await writeFile(delay, "7000");
    const second = await featureHost({ home, config });
    try {
      second.state.script.push({ content: [use("e", "mcp__fake__echo", { text: "late" })], stopReason: "tool_use" }, reply("ok"));
      const started = Date.now();
      const s = await second.host.sessions.open();
      expect(Date.now() - started).toBeLessThan(4000);
      await s.send(msg("go"));
      expect(second.state.requests[0]!.tools.map((t) => t.name)).toContain("mcp__fake__echo");
      expect(second.state.requests[0]!.system.some((x) => x.text.includes("Use echo for testing."))).toBe(true);
      expect(textOf(results(second.state.requests[1]!)[0]!.content)).toBe("echo: late");
      // 工具没变：不用提示开新会话
      expect(second.state.notes.join("\n")).not.toContain("/clear");
    } finally {
      await second.host.close();
    }
  }, 60_000);

  test("a server used for the first time that takes longer than the startup wait gets its tools from the next turn after it connects, without /clear", async () => {
    const home = await tempDir("jade-mcp-home-");
    const delay = path.join(home, "delay.txt");
    // 比第一次用时等的 5 秒长
    await writeFile(delay, "6500");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: { ...fakeServer, env: { MCP_DELAY_FILE: delay } } } }));
    const { host, state } = await featureHost({ home, config: { "jade/approval": { mode: "yolo" } } });
    try {
      state.script.push(reply("one"), reply("two"));
      const started = Date.now();
      const s = await host.sessions.open();
      expect(Date.now() - started).toBeLessThan(6400);
      await s.send(msg("right away"));
      expect(state.requests[0]!.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual([]);
      for (let i = 0; i < 100 && !(await mcpConnected(host)); i++) await new Promise((r) => setTimeout(r, 100));
      await s.send(msg("later"));
      expect(state.requests[1]!.tools.map((t) => t.name)).toContain("mcp__fake__echo");
      expect(state.requests[1]!.system.some((x) => x.text.includes("Use echo for testing."))).toBe(true);
      // 同一个会话
      expect(state.requests[1]!.messages.length).toBeGreaterThan(state.requests[0]!.messages.length);
      expect(state.notes.join("\n")).not.toContain("/clear");
    } finally {
      await host.close();
    }
  }, 30_000);

  test("notifications/tools/list_changed updates the session's tools from the next turn", async () => {
    const home = await tempDir("jade-mcp-home-");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: { ...fakeServer, env: { MCP_GROW: "1" } } } }));
    const { host, state } = await featureHost({ home, config: { "jade/approval": { mode: "yolo" } } });
    try {
      state.script.push({ content: [use("g", "mcp__fake__grow", {})], stopReason: "tool_use" }, reply("grown"), { content: [use("x", "mcp__fake__extra", {})], stopReason: "tool_use" }, reply("ok"));
      const s = await host.sessions.open();
      await s.send(msg("grow"));
      expect(state.requests[0]!.tools.map((t) => t.name)).not.toContain("mcp__fake__extra");
      // 服务重新列出工具是异步的：等它记进缓存
      for (let i = 0; i < 50; i++) {
        const c = new McpToolCache(home);
        await c.load();
        const { servers } = await loadMcpConfig({ home, root: home, cwd: home });
        if (c.get(servers[0]!)?.tools.some((t) => t.name === "extra")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await s.send(msg("use it"));
      expect(state.requests[2]!.tools.map((t) => t.name)).toContain("mcp__fake__extra");
      expect(textOf(results(state.requests[3]!)[0]!.content)).toBe("called extra");
    } finally {
      await host.close();
    }
  }, 30_000);

  test("/mcp add starts the server and /mcp remove stops it, both from the next turn and without restarting jade", async () => {
    const home = await tempDir("jade-mcp-home-");
    const { host, state } = await featureHost({ home, config: { "jade/approval": { mode: "yolo" } } });
    try {
      state.script.push(reply("one"), reply("two"), reply("three"));
      const s = await host.sessions.open();
      await s.send(msg("before"));
      expect(state.requests[0]!.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual([]);
      const added = shown(await mcp(host, `add fake -- "${process.execPath}" "${SERVER}"`));
      expect(added).toContain("its tools are available from the next turn");
      for (let i = 0; i < 100 && !(await mcpConnected(host)); i++) await new Promise((r) => setTimeout(r, 100));
      await s.send(msg("added"));
      expect(state.requests[1]!.tools.map((t) => t.name)).toContain("mcp__fake__echo");
      expect(shown(await mcp(host, "remove fake"))).toContain("jade stops it");
      await s.send(msg("removed"));
      expect(state.requests[2]!.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual([]);
    } finally {
      await host.close();
    }
  }, 30_000);

  test("when a server's tools changed since last time, a tool it no longer offers fails clearly and the session gets the new list from the next turn", async () => {
    const home = await tempDir("jade-mcp-home-");
    const delay = path.join(home, "delay.txt");
    await writeFile(delay, "1500");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: { ...fakeServer, env: { MCP_DELAY_FILE: delay } } } }));
    // 上次连上时它还有一个 gone 工具
    const { servers } = await loadMcpConfig({ home, root: home, cwd: home });
    const cache = new McpToolCache(home);
    await cache.put(servers[0]!, { tools: [{ name: "gone", description: "Removed since.", inputSchema: { type: "object" } }, { name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
    const { host, state } = await featureHost({ home, config: { "jade/approval": { mode: "yolo" } } });
    try {
      state.script.push({ content: [use("g", "mcp__fake__gone", {})], stopReason: "tool_use" }, reply("ok"));
      const s = await host.sessions.open();
      await s.send(msg("go"));
      expect(state.requests[0]!.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual(["mcp__fake__gone", "mcp__fake__echo"]);
      const [g] = results(state.requests[1]!);
      expect(g!.isError).toBe(true);
      expect(textOf(g!.content)).toContain('no longer offers the tool "gone"');
      // 下一轮起是服务现在的工具，不用 /clear
      state.script.push(reply("again"));
      await s.send(msg("again"));
      expect(state.requests[2]!.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual(["mcp__fake__echo", "mcp__fake__picture", "mcp__fake__fail", "mcp__fake__crash", "mcp__fake__slow", "mcp__fake__weird_name_with_chars"]);
      expect(state.notes.join("\n")).not.toContain("/clear");
      // 记下了新的工具：下一个会话用新的
      const next = new McpToolCache(home);
      await next.load();
      expect(next.get(servers[0]!)!.tools.map((t) => t.name)).toEqual(["echo", "picture", "fail", "crash", "slow", "weird.name/with:chars"]);
    } finally {
      await host.close();
    }
  }, 30_000);

  test("a server from the repository's .mcp.json starts only after the user confirms it, once per configuration", async () => {
    const home = await tempDir("jade-mcp-home-");
    const cwd = await tempDir("jade-mcp-repo-");
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repo: fakeServer } }));

    // 不能提问：不启动
    let w = await featureHost({ home, cwd });
    try {
      w.state.interactive = false;
      w.state.script.push(reply("ok"));
      await (await w.host.sessions.open()).send(msg("hi"));
      expect(w.state.requests[0]!.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual([]);
      expect(w.state.notes.join("\n")).toContain("[skipped] MCP server repo: not confirmed (run jade interactively");
    } finally {
      await w.host.close();
    }

    // 用户拒绝：不启动，不记
    w = await featureHost({ home, cwd });
    try {
      w.state.answers.push("no");
      w.state.script.push(reply("ok"));
      await (await w.host.sessions.open()).send(msg("hi"));
      expect(w.state.selects[0]!.title).toContain('MCP server "repo" from .mcp.json is new or changed');
      expect(w.state.selects[0]!.detail).toContain(`runs: ${process.execPath}`);
      expect(w.state.requests[0]!.tools.some((t) => t.name.startsWith("mcp__repo__"))).toBe(false);
    } finally {
      await w.host.close();
    }

    // 用户同意：启动，记下；下次不再问
    for (const round of [1, 2]) {
      w = await featureHost({ home, cwd });
      try {
        w.state.answers.push("yes");
        w.state.script.push(reply("ok"));
        await (await w.host.sessions.open()).send(msg("hi"));
        expect(w.state.selects).toHaveLength(round === 1 ? 1 : 0);
        expect(w.state.requests[0]!.tools.map((t) => t.name)).toContain("mcp__repo__echo");
      } finally {
        await w.host.close();
      }
    }
    expect(await readFile(path.join(home, "state", "confirmed.json"), "utf8")).toContain(".mcp.json");

    // 配置变了：重新确认
    await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { ...fakeServer, env: { X: "1" } } } }));
    w = await featureHost({ home, cwd });
    try {
      w.state.answers.push("no");
      w.state.script.push(reply("ok"));
      await (await w.host.sessions.open()).send(msg("hi"));
      expect(w.state.selects).toHaveLength(1);
    } finally {
      await w.host.close();
    }
  }, 60_000);
});

describe("/mcp add and remove", () => {
  test("write $JADE_HOME/mcp.json, or <cwd>/.jade/mcp.json with --project; other content is kept; loadMcpConfig reads them", async () => {
    const home = await tempDir("jade-mcp-home-");
    const cwd = await tempDir("jade-mcp-cwd-");
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ note: "keep", mcpServers: { old: { command: "x" } } }));

    expect(await manageMcp(["add", "fs", "--env", "TOKEN=${MY_TOKEN}", "npx", "-y", "@scope/server", "--root", "."], { home, cwd, cmd: "/mcp" })).toContain("restart jade");
    expect(await manageMcp(["add", "web", "--project", "--url", "https://example.com/mcp", "--header", "Authorization: Bearer ${K}"], { home, cwd, cmd: "/mcp" })).toContain("confirm");
    const user = JSON.parse(await readFile(path.join(home, "mcp.json"), "utf8"));
    expect(user.note).toBe("keep");
    expect(user.mcpServers.fs).toEqual({ command: "npx", args: ["-y", "@scope/server", "--root", "."], env: { TOKEN: "${MY_TOKEN}" } });
    const project = JSON.parse(await readFile(path.join(cwd, ".jade", "mcp.json"), "utf8"));
    expect(project.mcpServers.web).toEqual({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${K}" } });

    const { servers } = await loadMcpConfig({ home, root: cwd, cwd, env: { MY_TOKEN: "t", K: "k" } });
    expect(servers.map((s) => [s.name, s.layer])).toEqual([["old", "user"], ["fs", "user"], ["web", "project"]]);

    await expect(manageMcp(["add", "fs", "--", "other"], { home, cwd, cmd: "/mcp" })).rejects.toThrow("already has");
    await manageMcp(["add", "fs", "--force", "--", "other", "--flag"], { home, cwd, cmd: "/mcp" });
    expect(JSON.parse(await readFile(path.join(home, "mcp.json"), "utf8")).mcpServers.fs).toEqual({ command: "other", args: ["--flag"] });

    expect(await manageMcp(["remove", "web", "--project"], { home, cwd, cmd: "/mcp" })).toContain("removed");
    expect(JSON.parse(await readFile(path.join(cwd, ".jade", "mcp.json"), "utf8")).mcpServers).toEqual({});
    await expect(manageMcp(["remove", "web"], { home, cwd, cmd: "/mcp" })).rejects.toThrow("no MCP server named web");
  });

  test("bad arguments and a broken config file are reported, and the file is left alone", async () => {
    const home = await tempDir("jade-mcp-home-");
    const env = { home, cwd: home, cmd: "/mcp" };
    await expect(manageMcp(["add", "x"], env)).rejects.toThrow("give a command or --url");
    await expect(manageMcp(["add", "x", "--url", "ftp://h"], env)).rejects.toThrow("http");
    await expect(manageMcp(["add", "x", "--url", "https://h", "cmd"], env)).rejects.toThrow("not both");
    await expect(manageMcp(["add", "bad name!", "cmd"], env)).rejects.toThrow("the name may only contain");
    await expect(manageMcp(["add", "x", "--env", "NOEQUALS", "cmd"], env)).rejects.toThrow("KEY=VALUE");
    await writeFile(path.join(home, "mcp.json"), "{ broken");
    await expect(manageMcp(["add", "x", "cmd"], env)).rejects.toThrow("fix it by hand");
    expect(await readFile(path.join(home, "mcp.json"), "utf8")).toBe("{ broken");
  });

  test("/mcp add through the plugin does not need the servers to connect", async () => {
    const home = await tempDir("jade-mcp-home-");
    const { host } = await featureHost({ home });
    try {
      const run = (args: string) => host.service<Commands>("commands@1")!.get("mcp")!.command.run(args, ctxFor(host.sessions));
      expect(shown(await run(`add fake "${process.execPath}" "${SERVER}"`))).toContain("added MCP server fake");
      expect(JSON.parse(await readFile(path.join(home, "mcp.json"), "utf8")).mcpServers.fake).toEqual({ command: process.execPath, args: [SERVER] });
      expect(shown(await run("add"))).toContain("usage: /mcp add");
    } finally {
      await host.close();
    }
  }, 30_000);
});
