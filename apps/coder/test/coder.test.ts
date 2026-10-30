import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MemoryLogStore,
  ProviderError,
  readAll,
  Runtime,
  type Block,
  type Delta,
  type LogEvent,
  type EventDataMap,
  type LogStore,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type ToolContext,
} from "uncarved";
import {
  createCoder,
  DERIVED_KEY,
  fsTools,
  isSafeCommand,
  POLICY_KEY,
  policy,
  shellTool,
  shellWords,
  validate,
  withRetry,
  type CoderOptions,
  type CompactState,
} from "../src/index.ts";

// ---------- 辅助 ----------

const MODEL = { by: "model" as const, provider: "scripted", model: "scripted-1" };
type Step = Omit<ModelResponse, "model">;

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
  return { provider, requests, script };
}

const text = (t: string): Block => ({ kind: "text", text: t, origin: MODEL, trust: "trusted" });
const use = (id: string, name: string, input: unknown): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
const reply = (t: string): Step => ({ content: [text(t)], stopReason: "end" });
const call = (...uses: Block[]): Step => ({ content: uses, stopReason: "tool_use" });
const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "coder-cwd-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "coder-home-"));
  return { cwd, home };
}

async function setup(script: Step[], extra: Partial<CoderOptions> = {}) {
  const { cwd, home } = await workspace();
  const s = scripted(script);
  const store = extra.store ?? new MemoryLogStore();
  const coder = await createCoder({ cwd, home, store, provider: s.provider, today: "2026-10-30", ...extra });
  const rt = await Runtime.create({ store, provider: s.provider, plugins: coder.plugins });
  return { cwd, home, store, coder, rt, ...s };
}

const events = async (store: LogStore, id: string, type: string) =>
  (await readAll(store, id)).filter((e) => e.type === type) as LogEvent[];

const ctx = (progress: unknown[] = []): ToolContext => ({
  sessionId: "s",
  toolUseId: "t",
  signal: new AbortController().signal,
  parent: { sessionId: "s", eventId: "e" },
  progress: (u) => progress.push(u),
});
const run = async (tools: ReturnType<typeof fsTools>, name: string, input: unknown) => {
  const r = await tools.find((t) => t.name === name)!.execute(input, ctx());
  return { text: typeof r.content === "string" ? r.content : "", isError: r.isError ?? false };
};

// ---------- 工具 ----------

describe("fs tools", () => {
  test("read, edit, write, glob, grep", async () => {
    const { cwd } = await workspace();
    const tools = fsTools(cwd);
    await run(tools, "write_file", { path: "src/a.ts", content: "const a = 1;\nconst b = 2;\n" });
    expect((await run(tools, "read_file", { path: "src/a.ts" })).text).toBe("1\tconst a = 1;\n2\tconst b = 2;");
    expect((await run(tools, "read_file", { path: "src/a.ts", offset: 2, limit: 1 })).text).toBe("2\tconst b = 2;");

    expect((await run(tools, "edit_file", { path: "src/a.ts", old_string: "const", new_string: "let" })).isError).toBe(true);
    await run(tools, "edit_file", { path: "src/a.ts", old_string: "const b", new_string: "let b" });
    expect(await readFile(path.join(cwd, "src/a.ts"), "utf8")).toBe("const a = 1;\nlet b = 2;\n");

    expect((await run(tools, "glob", { pattern: "**/*.ts" })).text).toBe("src/a.ts");
    expect((await run(tools, "grep", { pattern: "let \\w", include: "**/*.ts" })).text).toBe("src/a.ts:2:let b = 2;");
  });

  test("edit_file matches LF text in a CRLF file", async () => {
    const { cwd } = await workspace();
    await writeFile(path.join(cwd, "w.txt"), "one\r\ntwo\r\n");
    const r = await run(fsTools(cwd), "edit_file", { path: "w.txt", old_string: "one\ntwo", new_string: "1\n2" });
    expect(r.isError).toBe(false);
    expect(await readFile(path.join(cwd, "w.txt"), "utf8")).toBe("1\r\n2\r\n");
  });

  test("bash reports exit code and output, streaming it as progress", async () => {
    const { cwd } = await workspace();
    const progress: unknown[] = [];
    const r = await shellTool({ cwd }).execute({ command: "echo hi; exit 3" }, ctx(progress));
    expect(r.content).toBe("Exit code 3\n<stdout>\nhi\n</stdout>");
    expect(r.isError).toBe(true);
    expect(progress).toEqual([{ kind: "output", stream: "stdout", text: "hi\n" }]);
  });

  test("edit_file replace_all treats $ in new_string literally", async () => {
    const { cwd } = await workspace();
    await writeFile(path.join(cwd, "d.txt"), "foo foo");
    await run(fsTools(cwd), "edit_file", { path: "d.txt", old_string: "foo", new_string: "$&$1", replace_all: true });
    expect(await readFile(path.join(cwd, "d.txt"), "utf8")).toBe("$&$1 $&$1");
  });

  test("read_file rejects a non-positive limit; write_file counts lines like read_file", async () => {
    const { cwd } = await workspace();
    const tools = fsTools(cwd);
    await writeFile(path.join(cwd, "e.txt"), "1\n2\n");
    expect(await run(tools, "read_file", { path: "e.txt", limit: 0 })).toEqual({ text: "limit must be at least 1", isError: true });
    expect((await run(tools, "write_file", { path: "f.txt", content: "x\ny\n" })).text).toBe("Wrote 2 lines to f.txt");
    expect((await run(tools, "write_file", { path: "g.txt", content: "x\r\ny" })).text).toBe("Wrote 2 lines to g.txt");
    expect((await run(tools, "write_file", { path: "h.txt", content: "" })).text).toBe("Wrote 0 lines to h.txt");
  });

  test("bash timeout and abort kill the shell's children instead of waiting for them", async () => {
    const { cwd } = await workspace();
    const tool = shellTool({ cwd });
    let t0 = Date.now();
    const r = await tool.execute({ command: "sleep 10; echo done", timeout_ms: 1000 }, ctx());
    expect(r.content).toStartWith("Timed out after 1000ms");
    expect(Date.now() - t0).toBeLessThan(5000);

    const ac = new AbortController();
    setTimeout(() => ac.abort("stop"), 500);
    t0 = Date.now();
    await tool.execute({ command: "sleep 10; echo done" }, { ...ctx(), signal: ac.signal }).catch(() => {});
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20_000);
});

// ---------- 权限 ----------

describe("policy", () => {
  const cwd = path.resolve("/work");
  const tools = [...fsTools(cwd), shellTool({ cwd })];
  const gated = (name: string, input: unknown) => ({ toolUseId: "t", name, input, tool: tools.find((t) => t.name === name)! });
  const decide = (mode: "ask" | "auto-edit" | "yolo" | "readonly", name: string, input: unknown) =>
    policy({ cwd }).decide(gated(name, input), { mode, rules: [] }).decision;
  const inside = path.join(cwd, "a.ts");
  const outside = path.resolve("/etc/passwd");

  test("modes", () => {
    expect(decide("ask", "read_file", { path: inside })).toBe("allow");
    expect(decide("ask", "read_file", { path: outside })).toBe("ask");
    expect(decide("ask", "write_file", { path: inside, content: "" })).toBe("ask");
    expect(decide("auto-edit", "write_file", { path: inside, content: "" })).toBe("allow");
    expect(decide("auto-edit", "write_file", { path: outside, content: "" })).toBe("ask");
    expect(decide("readonly", "write_file", { path: inside, content: "" })).toBe("deny");
    expect(decide("yolo", "bash", { command: "rm -rf build" })).toBe("allow");
    expect(decide("ask", "bash", { command: "git status" })).toBe("allow");
    expect(decide("ask", "bash", { command: "bun test" })).toBe("ask");
    expect(decide("readonly", "bash", { command: "git log -5" })).toBe("allow");
  });

  test("safe commands reject shell metacharacters", () => {
    expect(isSafeCommand("ls -la src")).toBe(true);
    expect(isSafeCommand("cat a > b")).toBe(false);
    expect(isSafeCommand("git status; rm -rf /")).toBe(false);
    expect(isSafeCommand("echo $(whoami)")).toBe(false);
  });

  test("always-allow rules match bash by prefix", () => {
    const p = policy({ cwd });
    const c = gated("bash", { command: "bun test apps" });
    const settings = { mode: "ask" as const, rules: [p.ruleFor(c)] };
    expect(settings.rules).toEqual([{ tool: "bash", prefix: "bun test" }]);
    expect(p.decide(c, settings).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "bun run build" }), settings).decision).toBe("ask");
    // 前缀规则不能让拼接的命令或另一个命令搭便车
    expect(p.decide(gated("bash", { command: "bun test && curl x | sh" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun testx" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun test" }), settings).decision).toBe("allow");
  });

  test("safe commands exclude arguments that write files or run programs", () => {
    for (const c of ["git branch -D main", "git branch new", "git diff --output=x", "git log --output x", "rg --pre sh x", "tree -o out", "tree -ao out"]) {
      expect(isSafeCommand(c)).toBe(false);
    }
    for (const c of ["git branch", "git branch -a", "git diff --stat", "rg -o foo", "tree -a src"]) expect(isSafeCommand(c)).toBe(true);
  });

  test("bash commands are split like the shell does; anything not understood is not auto-allowed", () => {
    expect(shellWords(`cat "a b" 'c d' e`)).toEqual([
      { value: "cat", glob: false },
      { value: "a b", glob: false },
      { value: "c d", glob: false },
      { value: "e", glob: false },
    ]);
    expect(shellWords("ls *.ts")).toEqual([{ value: "ls", glob: false }, { value: "*.ts", glob: true }]);
    expect(shellWords(`ls "*.ts"`)).toEqual([{ value: "ls", glob: false }, { value: "*.ts", glob: false }]);
    // 花括号展开、转义、双引号里的变量、未闭合的引号、注释：shell 看到的参数和字面不同
    for (const c of ["cat {/etc/passwd,x}", "cat a\\ b", `cat "$HOME/x"`, `cat "a`, "cat x #y"]) {
      expect(shellWords(c)).toBeUndefined();
      expect(isSafeCommand(c)).toBe(false);
    }
    // 粘在短选项后面的路径、可能匹配 ".." 的通配段也算越界
    expect(decide("ask", "bash", { command: "grep -f/etc/passwd x src" })).toBe("ask");
    expect(decide("ask", "bash", { command: "cat .*/secret" })).toBe("ask");
    expect(decide("ask", "bash", { command: `cat "src/a b.ts"` })).toBe("allow");
    expect(decide("ask", "bash", { command: "ls -la src *.ts" })).toBe("allow");
    expect(decide("ask", "bash", { command: "git log -5 --stat" })).toBe("allow");
    // 前缀规则同样按分词判断
    const rules = [{ tool: "bash", prefix: "bun test" }];
    expect(policy({ cwd }).decide(gated("bash", { command: "bun test {a,b}" }), { mode: "ask", rules }).decision).toBe("ask");
    expect(policy({ cwd }).decide(gated("bash", { command: `bun test "a; b"` }), { mode: "ask", rules }).decision).toBe("allow");
  });

  test("a symlink inside the working directory that points outside counts as outside", async () => {
    const { cwd: real, home: other } = await workspace();
    await writeFile(path.join(other, "secret"), "x");
    await mkdir(path.join(real, "src"));
    // Windows 上创建目录联接不需要管理员权限
    await symlink(other, path.join(real, "link"), "junction");
    const tools = [...fsTools(real), shellTool({ cwd: real })];
    const p = policy({ cwd: real });
    const ask = (name: string, input: unknown) =>
      p.decide({ toolUseId: "t", name, input, tool: tools.find((t) => t.name === name)! }, { mode: "ask", rules: [] }).decision;
    expect(ask("read_file", { path: path.join(real, "link", "secret") })).toBe("ask");
    expect(ask("bash", { command: "cat link/secret" })).toBe("ask");
    expect(ask("read_file", { path: path.join(real, "src", "new.ts") })).toBe("allow");
  });

  test("reading outside the working directory asks, whichever tool does it", () => {
    // 只读命令的参数指向工作目录之外
    for (const c of ["cat ~/.ssh/id_rsa", "cat /etc/passwd", "ls ..", "grep -r key ../other", "rg --file=/etc/x foo"]) {
      expect(decide("ask", "bash", { command: c })).toBe("ask");
      expect(decide("readonly", "bash", { command: c })).toBe("ask");
    }
    expect(decide("ask", "bash", { command: "cat src/a.ts" })).toBe("allow");
    expect(decide("readonly", "bash", { command: "git log origin/main -5" })).toBe("allow");
    // glob 的 pattern 本身越界
    expect(decide("ask", "glob", { pattern: "../*.env" })).toBe("ask");
    expect(decide("ask", "glob", { pattern: path.resolve("/etc") + "/*" })).toBe("ask");
    expect(decide("ask", "glob", { pattern: "src/**/*.ts" })).toBe("allow");
    // 名为 "..foo" 的目录仍在工作目录里
    expect(decide("ask", "read_file", { path: path.join(cwd, "..foo", "a.ts") })).toBe("allow");
  });

  test("schema validation", () => {
    const schema = fsTools(cwd).find((t) => t.name === "read_file")!.inputSchema;
    expect(validate(schema, { path: "a" })).toBeUndefined();
    expect(validate(schema, {})).toBe("input.path is required");
    expect(validate(schema, { path: "a", offset: 1.5 })).toBe("input.offset must be integer, got number");
    expect(validate(schema, { path: "a", x: 1 })).toBe("input.x is not allowed");
  });
});

// ---------- 整条链路 ----------

describe("coder session", () => {
  test("edit needs approval; the logged input has the resolved path", async () => {
    const { cwd, rt, store, requests } = await setup([
      call(use("u1", "edit_file", { path: "a.txt", old_string: "x", new_string: "y" })),
      reply("done"),
    ]);
    await writeFile(path.join(cwd, "a.txt"), "x\n");

    await rt.send(msg("change x to y"));
    expect(rt.state.phase).toBe("awaiting");
    await rt.send({ kind: "approval", toolUseId: "u1", approved: true });

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("y\n");
    const [decided] = await events(store, rt.state.sessionId, "tool.decided");
    expect((decided!.data as EventDataMap["tool.decided"]).input).toMatchObject({ path: path.join(cwd, "a.txt") });

    // 系统提示词：身份、环境两段，都是 stable
    expect(requests[0]!.system.map((s) => s.stability)).toEqual(["stable", "stable"]);
    expect(requests[0]!.tools.map((t) => t.name)).toContain("task");
  });

  test("invalid arguments are denied with a reason the model can read", async () => {
    const { rt, requests } = await setup([call(use("u1", "read_file", { file: "a" })), reply("ok")]);
    await rt.send(msg("read it"));
    const result = requests[1]!.messages.at(-1)!.content[0]!;
    expect(result.kind).toBe("tool_result");
    if (result.kind !== "tool_result") return;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("input.path is required");
  });

  test("project instructions are untrusted and carry their source", async () => {
    const { cwd, home } = await workspace();
    await writeFile(path.join(cwd, "AGENTS.md"), "Use tabs.");
    await writeFile(path.join(home, "CODER.md"), "Be brief.");
    const s = scripted([reply("ok")]);
    const coder = await createCoder({ cwd, home, store: new MemoryLogStore(), provider: s.provider });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: coder.plugins });
    await rt.send(msg("hi"));
    const [, , user, project] = s.requests[0]!.system;
    expect(user).toMatchObject({ trust: "trusted", origin: { source: { layer: "user", path: "CODER.md" } } });
    expect(project).toMatchObject({ trust: "untrusted", origin: { source: { layer: "project", path: "AGENTS.md" } } });
  });

  test("compaction is recorded once and reused after resume", async () => {
    const store = new MemoryLogStore();
    const { coder, rt, requests, script, cwd, home, provider } = await setup([reply("A"), reply("B")], { store });
    await rt.send(msg("first"));
    await rt.send(msg("second"));

    coder.compact.request();
    script.push(reply("SUMMARY"), reply("C"));
    await rt.send(msg("third"));

    const summarizer = requests[2]!;
    expect(summarizer.tools).toEqual([]);
    const main = requests[3]!;
    expect((main.messages[0]!.content[0] as { text: string }).text).toContain("SUMMARY");
    expect(main.messages.length).toBeLessThan(rt.state.messages.length);
    const compacted = rt.state.derived[DERIVED_KEY] as CompactState;
    expect(compacted.summary).toBe("SUMMARY");
    expect((await events(store, rt.state.sessionId, "coder/compact/compacted")).length).toBe(1);

    // 恢复后直接使用日志里的摘要，不再调用总结
    const again = await createCoder({ cwd, home, store, provider, today: "2026-10-30" });
    const resumed = await Runtime.resume({ store, provider, plugins: again.plugins, sessionId: rt.state.sessionId });
    script.push(reply("D"));
    await resumed.send(msg("fourth"));
    expect(requests.length).toBe(5);
    expect((requests[4]!.messages[0]!.content[0] as { text: string }).text).toContain("SUMMARY");
  });

  test("task runs a read-only sub-agent in its own session", async () => {
    const { rt, store, requests } = await setup([
      call(use("u1", "task", { description: "find config", prompt: "where is the config?" })),
      reply("config is in a.json:1"),
      reply("It is in a.json."),
    ]);
    await rt.send(msg("where is the config?"));

    const [completed] = await events(store, rt.state.sessionId, "tool.completed");
    const d = completed!.data as EventDataMap["tool.completed"];
    expect((d.content[0] as { text: string }).text).toBe("config is in a.json:1");
    const child = await readAll(store, d.child!.sessionId);
    expect(child[0]!.data).toMatchObject({ parent: { sessionId: rt.state.sessionId } });
    expect(child.at(-1)!.type).toBe("session.ended");
    expect(child.at(-1)!.seq).toBe(d.child!.seq);
    // 子 Agent 只有只读工具，提示词是子 Agent 的
    expect(requests[1]!.tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "list_dir", "read_file"]);
  });

  test("permission settings live in the log and survive resume", async () => {
    const store = new MemoryLogStore();
    const { rt, cwd, home, provider, script } = await setup([], { store });
    await rt.record(POLICY_KEY, { mode: "readonly", rules: [] });
    await rt.detach();

    const again = await createCoder({ cwd, home, store, provider, today: "2026-10-30" });
    const resumed = await Runtime.resume({ store, provider, plugins: again.plugins, sessionId: rt.state.sessionId });
    script.push(call(use("u1", "write_file", { path: "a.txt", content: "x" })), reply("ok"));
    await resumed.send(msg("write it"));

    const [decided] = await events(store, rt.state.sessionId, "tool.decided");
    expect(decided!.data).toMatchObject({ decision: "deny", decidedBy: "coder/policy" });
    expect(again.policy.settings(resumed.state.derived).mode).toBe("readonly");
    const types = (await readAll(store, rt.state.sessionId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["session.started", "derived.recorded", "session.detached"]);
  });

  test("task reports the sub-agent's tool calls as progress", async () => {
    const { rt } = await setup([
      call(use("u1", "task", { description: "look", prompt: "list the root" })),
      call(use("c1", "list_dir", { path: "." })),
      reply("empty"),
      reply("done"),
    ]);
    const progress: unknown[] = [];
    rt.subscribe((n) => n.type === "tool-progress" && progress.push(n.update));
    await rt.send(msg("go"));
    expect(progress).toEqual([
      { kind: "task-start", sessionId: expect.any(String), description: "look" },
      { kind: "task-tool", name: "list_dir", input: { path: expect.any(String) }, decision: "allow" },
    ]);
  });

  test("the step budget stops a runaway turn", async () => {
    const loop = Array.from({ length: 5 }, (_, i) => call(use(`u${i}`, "list_dir", { path: "." })));
    const { rt, store } = await setup(loop, { maxSteps: 2 });
    await rt.send(msg("go"));
    const [ended] = await events(store, rt.state.sessionId, "turn.ended");
    expect((ended!.data as EventDataMap["turn.ended"]).reason).toBe("stopped");
    expect(rt.state.messages.filter((m) => m.role === "assistant").length).toBe(2);
  });
});

// ---------- Provider ----------

describe("withRetry", () => {
  test("retries retryable errors and reports the inner provider", async () => {
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete() {
        if (++calls === 1) throw new ProviderError("overloaded", { retryable: true, status: 529 });
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const res = await withRetry(inner, { baseDelayMs: 1 }).complete(
      { system: [], messages: [], tools: [] },
      { signal: new AbortController().signal },
    );
    expect(calls).toBe(2);
    expect(res.provider).toBe("inner");
  });

  test("discards streamed deltas of a failed attempt before retrying", async () => {
    let calls = 0;
    const inner: Provider = {
      id: "inner",
      async complete(_req, { onDelta }) {
        onDelta?.({ kind: "text", text: calls === 0 ? "hal" : "whole" });
        if (++calls === 1) throw new ProviderError("dropped", { retryable: true });
        return { model: "m", content: [], stopReason: "end" };
      },
    };
    const deltas: Delta[] = [];
    await withRetry(inner, { baseDelayMs: 1 }).complete(
      { system: [], messages: [], tools: [] },
      { signal: new AbortController().signal, onDelta: (d) => deltas.push(d) },
    );
    expect(deltas).toEqual([{ kind: "text", text: "hal" }, { kind: "reset" }, { kind: "text", text: "whole" }]);
  });

  test("does not retry non-retryable errors", async () => {
    const inner: Provider = {
      id: "inner",
      async complete() {
        throw new ProviderError("bad request", { retryable: false, status: 400 });
      },
    };
    await expect(
      withRetry(inner, { baseDelayMs: 1 }).complete({ system: [], messages: [], tools: [] }, { signal: new AbortController().signal }),
    ).rejects.toThrow("bad request");
  });
});
