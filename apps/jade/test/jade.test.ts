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
  Checkpoints,
  compactThreshold,
  contextWindowFromEnv,
  createJade,
  DERIVED_KEY,
  estimateTokens,
  fsTools,
  hasProvider,
  isSafeCommand,
  isPrivateHost,
  htmlToMarkdown,
  nearMiss,
  webTools,
  bashRule,
  loadEnvFile,
  parseEnv,
  POLICY_KEY,
  providerFromEnv,
  SessionIndex,
  policy,
  prompts,
  shellTool,
  shellTools,
  shellWords,
  todoTool,
  validate,
  withRetry,
  type JadeOptions,
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jade-cwd-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "jade-home-"));
  return { cwd, home };
}

async function setup(script: Step[], extra: Partial<JadeOptions> = {}) {
  const { cwd, home } = await workspace();
  const s = scripted(script);
  const store = extra.store ?? new MemoryLogStore();
  const jade = await createJade({ cwd, home, store, provider: s.provider, today: "2026-10-30", env: {}, ...extra });
  const rt = await Runtime.create({ store, provider: s.provider, plugins: jade.plugins });
  return { cwd, home, store, jade, rt, ...s };
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
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "w.txt" });
    const r = await run(tools, "edit_file", { path: "w.txt", old_string: "one\ntwo", new_string: "1\n2" });
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
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "d.txt" });
    await run(tools, "edit_file", { path: "d.txt", old_string: "foo", new_string: "$&$1", replace_all: true });
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

  test("changing an existing file requires reading it first, and refuses if it changed since", async () => {
    const { cwd } = await workspace();
    const tools = fsTools(cwd);
    const file = path.join(cwd, "s.txt");
    await writeFile(file, "a\n");

    const unread = await run(tools, "edit_file", { path: "s.txt", old_string: "a", new_string: "b" });
    expect(unread).toMatchObject({ isError: true, text: expect.stringContaining("has not been read") });
    expect((await run(tools, "write_file", { path: "s.txt", content: "z" })).isError).toBe(true);

    await run(tools, "read_file", { path: "s.txt" });
    expect((await run(tools, "edit_file", { path: "s.txt", old_string: "a", new_string: "b" })).isError).toBe(false);
    // 自己的写入不算"被别人改过"
    expect((await run(tools, "edit_file", { path: "s.txt", old_string: "b", new_string: "c" })).isError).toBe(false);

    await writeFile(file, "someone else's change\n");
    const stale = await run(tools, "edit_file", { path: "s.txt", old_string: "c", new_string: "d" });
    expect(stale).toMatchObject({ isError: true, text: expect.stringContaining("modified since it was last read") });
    expect(await readFile(file, "utf8")).toBe("someone else's change\n");
  });

  test("a resumed session can change files it read or wrote before, unless they changed since", async () => {
    const { cwd, home } = await workspace();
    const checkpoints = new Checkpoints(path.join(home, "checkpoints"));
    await writeFile(path.join(cwd, "r.txt"), "read\n");
    const before = fsTools(cwd, { checkpoints });
    await run(before, "write_file", { path: "w.txt", content: "mine\n" });
    await run(before, "read_file", { path: "r.txt" });
    await writeFile(path.join(cwd, "o.txt"), "other\n");

    // 新进程：内存里的记录没了
    const after = fsTools(cwd, { checkpoints });
    expect((await run(after, "write_file", { path: "w.txt", content: "mine again\n" })).isError).toBe(false);
    expect((await run(after, "edit_file", { path: "r.txt", old_string: "read", new_string: "edited" })).isError).toBe(false);
    expect(await run(after, "edit_file", { path: "o.txt", old_string: "other", new_string: "x" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("has not been read"),
    });
    await writeFile(path.join(cwd, "w.txt"), "the user's change\n");
    expect(await run(fsTools(cwd, { checkpoints }), "write_file", { path: "w.txt", content: "z" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("modified since"),
    });
  });

  test("a read in the same response as the change does not count", async () => {
    const { cwd } = await workspace();
    await writeFile(path.join(cwd, "q.txt"), "a\n");
    const responses = { calls: 1 };
    const tools = fsTools(cwd, { responses });
    await run(tools, "read_file", { path: "q.txt" });
    expect(await run(tools, "write_file", { path: "q.txt", content: "b\n" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("same response"),
    });
    responses.calls++;
    // 下一次回复里又读了一遍：之前那次读取仍然有效
    await run(tools, "read_file", { path: "q.txt" });
    expect((await run(tools, "write_file", { path: "q.txt", content: "b\n" })).isError).toBe(false);
    // 自己写的内容模型知道，同一次回复里接着改没问题
    expect((await run(tools, "edit_file", { path: "q.txt", old_string: "b", new_string: "c" })).isError).toBe(false);
  });

  test("bash is left out when the shell cannot be found", () => {
    const shell = shellTools({ cwd: os.tmpdir(), shell: "no-such-shell-for-jade" });
    expect(shell.tools).toEqual([]);
    expect(shell.unavailable).toContain("no-such-shell-for-jade was not found");
    expect(() => shellTool({ cwd: os.tmpdir(), shell: "no-such-shell-for-jade" })).toThrow("was not found");
  });

  test("read_file returns images as image blocks and refuses other binary files", async () => {
    const { cwd } = await workspace();
    await writeFile(path.join(cwd, "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    await writeFile(path.join(cwd, "b.bin"), Buffer.from([1, 0, 2]));
    const tools = fsTools(cwd);
    const img = await tools.find((t) => t.name === "read_file")!.execute({ path: "p.png" }, ctx());
    expect(img.content).toEqual([
      expect.objectContaining({ kind: "image", source: { type: "base64", media_type: "image/png", data: "iVBORwAB" } }),
    ]);
    expect(await run(tools, "read_file", { path: "b.bin" })).toMatchObject({ isError: true, text: expect.stringContaining("binary file") });
  });

  test("writes save the previous content so they can be undone", async () => {
    const { cwd, home } = await workspace();
    const checkpoints = new Checkpoints(path.join(home, "checkpoints"));
    const tools = fsTools(cwd, { checkpoints });
    const exec = (name: string, input: unknown, toolUseId: string) => tools.find((t) => t.name === name)!.execute(input, { ...ctx(), toolUseId });
    await exec("write_file", { path: "n.txt", content: "one\n" }, "w1");
    await exec("edit_file", { path: "n.txt", old_string: "one", new_string: "two" }, "e1");

    const [last, first] = await checkpoints.list("s");
    expect(last).toMatchObject({ toolUseId: "e1", before: "one\n" });
    expect(first).toMatchObject({ toolUseId: "w1", before: null });
    expect(await checkpoints.unchangedSince(last!)).toBe(true);
    await checkpoints.restore(last!);
    expect(await readFile(path.join(cwd, "n.txt"), "utf8")).toBe("one\n");
    await checkpoints.restore(first!);
    expect(await Bun.file(path.join(cwd, "n.txt")).exists()).toBe(false);
  });

  test("glob and grep skip files ignored by git", async () => {
    const { cwd } = await workspace();
    Bun.spawnSync(["git", "init", "-q"], { cwd });
    await mkdir(path.join(cwd, "dist"));
    await writeFile(path.join(cwd, ".gitignore"), "dist/\n");
    await writeFile(path.join(cwd, "a.ts"), "needle\n");
    await writeFile(path.join(cwd, "dist", "a.js"), "needle\n");
    const tools = fsTools(cwd);
    expect((await run(tools, "glob", { pattern: "**/*.*s" })).text).toBe("a.ts");
    expect((await run(tools, "grep", { pattern: "needle" })).text).toBe("a.ts:1:needle");
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

  test("background shells return at once; bash_output reads new output; kill_shell stops them", async () => {
    const { cwd } = await workspace();
    const shell = shellTools({ cwd });
    const exec = async (name: string, input: unknown) => {
      const r = await shell.tools.find((t) => t.name === name)!.execute(input, ctx());
      return { text: r.content as string, isError: r.isError ?? false };
    };
    const t0 = Date.now();
    const started = await exec("bash", { command: "echo first; sleep 30; echo never", run_in_background: true });
    expect(started.text).toStartWith("Started background shell bg1");
    expect(Date.now() - t0).toBeLessThan(2000);

    let out = "";
    for (let i = 0; i < 50 && !out.includes("<output>"); i++) {
      out = (await exec("bash_output", { id: "bg1" })).text;
      await Bun.sleep(100);
    }
    expect(out).toContain("running");
    expect(out).toContain("first");
    // 读走的输出不会再出现
    expect((await exec("bash_output", { id: "bg1" })).text).toContain("(no new output)");

    expect((await exec("kill_shell", { id: "bg1" })).text).toStartWith("bg1 stopped");
    expect((await exec("bash_output", { id: "bg1" })).text).not.toContain("running");
    expect((await exec("bash_output", { id: "bg9" })).isError).toBe(true);
    shell.shutdown();
  }, 20_000);

  test("todo_write renders the list it is given", async () => {
    const r = await todoTool().execute(
      { todos: [{ content: "read", status: "completed" }, { content: "edit", status: "in_progress" }, { content: "test", status: "pending" }] },
      ctx(),
    );
    expect(r.content).toBe("Todo list updated:\n[x] read\n[~] edit\n[ ] test");
  });
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
    // 危险参数让前缀规则失效
    expect(p.decide(gated("bash", { command: "bun test --force" }), settings).decision).toBe("ask");
    expect(p.decide(c, settings).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "bun run build" }), settings).decision).toBe("ask");
    // 前缀规则不能让拼接的命令或另一个命令搭便车
    expect(p.decide(gated("bash", { command: "bun test && curl x | sh" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun testx" }), settings).decision).toBe("ask");
    expect(p.decide(gated("bash", { command: "bun test" }), settings).decision).toBe("allow");
  });

  test("default always-allow rules for bash", () => {
    expect(bashRule("npm run build -- --watch")).toEqual({ tool: "bash", prefix: "npm run build" });
    expect(bashRule("git push origin main")).toEqual({ tool: "bash", prefix: "git push" });
    expect(bashRule("rm -rf build")).toEqual({ tool: "bash", command: "rm -rf build" });
    expect(bashRule("git push --force")).toEqual({ tool: "bash", command: "git push --force" });
    expect(bashRule("make")).toEqual({ tool: "bash", command: "make" });
    expect(bashRule("bun test | tee log")).toEqual({ tool: "bash", command: "bun test | tee log" });
    const p = policy({ cwd });
    const exact = { mode: "ask" as const, rules: [bashRule("rm -rf build")] };
    expect(p.decide(gated("bash", { command: "rm -rf build" }), exact).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "rm -rf build /" }), exact).decision).toBe("ask");
    const push = { mode: "ask" as const, rules: [bashRule("git push origin main")] };
    expect(p.decide(gated("bash", { command: "git push origin dev" }), push).decision).toBe("allow");
    expect(p.decide(gated("bash", { command: "git push --force origin main" }), push).decision).toBe("ask");
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

describe("jade session", () => {
  test("edit needs approval; the logged input has the resolved path", async () => {
    const { cwd, rt, store, requests } = await setup([
      call(use("u0", "read_file", { path: "a.txt" })),
      call(use("u1", "edit_file", { path: "a.txt", old_string: "x", new_string: "y" })),
      reply("done"),
    ]);
    await writeFile(path.join(cwd, "a.txt"), "x\n");

    await rt.send(msg("change x to y"));
    expect(rt.state.phase).toBe("awaiting");
    await rt.send({ kind: "approval", toolUseId: "u1", approved: true });

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("y\n");
    const [, decided] = await events(store, rt.state.sessionId, "tool.decided");
    expect((decided!.data as EventDataMap["tool.decided"]).input).toMatchObject({ path: path.join(cwd, "a.txt") });

    // 系统提示词：身份、环境两段，都是 stable
    expect(requests[0]!.system.map((s) => s.stability)).toEqual(["stable", "stable"]);
    expect(requests[0]!.tools.map((t) => t.name)).toContain("task");
  });

  test("identical calls in one response run once; repeated failures get a note", async () => {
    const { rt, requests } = await setup([
      call(use("u1", "read_file", { path: "missing.txt" }), use("u2", "read_file", { path: "missing.txt" })),
      call(use("u3", "read_file", { path: "missing.txt" })),
      reply("gave up"),
    ]);
    await rt.send(msg("read it"));
    const resultText = (b: Block) => (b.kind === "tool_result" ? b.content.map((c) => (c.kind === "text" ? c.text : "")).join("\n") : "");
    const [first, dup] = requests[1]!.messages.at(-1)!.content.map(resultText);
    expect(first).not.toContain("failed");
    expect(dup).toContain("identical to an earlier call");
    // 下一次回复里再发同一个调用会执行，第二次失败时提醒模型
    expect(resultText(requests[2]!.messages.at(-1)!.content[0]!)).toContain("This exact call has now failed 2 times");
  });

  test("the session list keeps the first message as the title and the last use as the time", async () => {
    const { home, cwd } = await workspace();
    const index = new SessionIndex(path.join(home, "index.jsonl"));
    await index.add({ id: "a", cwd, title: "draw a pelican", at: "1" });
    await index.add({ id: "b", cwd, title: "other", at: "2" });
    await index.add({ id: "a", cwd, title: "continue", at: "3" });
    expect(await index.list(cwd)).toEqual([
      { id: "a", cwd, title: "draw a pelican", at: "3" },
      { id: "b", cwd, title: "other", at: "2" },
    ]);
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

  test("the system prompt names the shell, or says there is none", async () => {
    const { cwd, home } = await workspace();
    const system = async (shell: string | null) => {
      const hook = (await prompts({ cwd, home, shell })).hooks![0]!;
      if (hook.kind !== "transform" || !("fn" in hook)) throw new Error("expected a local transform");
      const req = (await hook.fn({ system: [], messages: [], tools: [] } as never, {} as never)) as ModelRequest;
      return req.system.map((s) => s.text).join("\n");
    };
    const withShell = await system("/usr/bin/bash");
    expect(withShell).toContain("Shell for the bash tool: /usr/bin/bash");
    expect(withShell).toContain("with bash when that is feasible");
    const without = await system(null);
    expect(without).toContain("There is no shell in this session");
    expect(without).not.toContain("with bash");
  });

  test("project instructions are untrusted and carry their source", async () => {
    const { cwd, home } = await workspace();
    await writeFile(path.join(cwd, "AGENTS.md"), "Use tabs.");
    await writeFile(path.join(cwd, "CLAUDE.md"), "ignored: AGENTS.md wins");
    await writeFile(path.join(home, "CLAUDE.md"), "Be brief.");
    const s = scripted([reply("ok")]);
    const jade = await createJade({ cwd, home, store: new MemoryLogStore(), provider: s.provider });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("hi"));
    const [, , user, project, ...rest] = s.requests[0]!.system;
    expect(user).toMatchObject({ trust: "trusted", origin: { source: { layer: "user", path: "CLAUDE.md" } } });
    expect(project).toMatchObject({ trust: "untrusted", origin: { source: { layer: "project", path: "AGENTS.md" } } });
    expect(rest).toEqual([]);
  });

  test("instructions are collected from the repository root down to the working directory", async () => {
    const { cwd: repo, home } = await workspace();
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const sub = path.join(repo, "pkg", "app");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(repo, "CLAUDE.md"), "root rules");
    await writeFile(path.join(repo, "pkg", "AGENTS.md"), "pkg rules");
    const s = scripted([reply("ok")]);
    const jade = await createJade({ cwd: sub, home, store: new MemoryLogStore(), provider: s.provider });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: s.provider, plugins: jade.plugins });
    await rt.send(msg("hi"));
    const loaded = s.requests[0]!.system.slice(2);
    expect(loaded.map((x) => (x.origin as { source?: { path: string } }).source?.path)).toEqual(["CLAUDE.md", "pkg/AGENTS.md"]);
    expect(loaded[1]!.text).toContain("pkg rules");
  });

  test("the user's .env fills in only variables the shell has not set", async () => {
    expect(parseEnv('# c\nexport A=1\nB = "two words"\nC=x # note\nD=\'$raw\'\nnot a line')).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "$raw",
    });
    const { home } = await workspace();
    await writeFile(path.join(home, ".env"), "A=file\nB=file\n");
    const env: Record<string, string | undefined> = { A: "shell" };
    expect(await loadEnvFile(path.join(home, ".env"), env)).toBe(true);
    expect(env).toEqual({ A: "shell", B: "file" });
    expect(await loadEnvFile(path.join(home, "missing"), env)).toBe(false);
    expect(hasProvider({ OPENAI_COMPAT_BASE_URL: "http://x" })).toBe(true);
    expect(hasProvider({})).toBe(false);
  });

  test("OPENAI_COMPAT_EXTRA_BODY must be a JSON object", () => {
    const env = { OPENAI_COMPAT_BASE_URL: "http://x", OPENAI_COMPAT_MODEL: "m" };
    expect(providerFromEnv({ ...env, OPENAI_COMPAT_EXTRA_BODY: '{"enable_thinking":true}' }).id).toBe("openai-compat");
    expect(() => providerFromEnv({ ...env, OPENAI_COMPAT_EXTRA_BODY: "enable_thinking" })).toThrow("must be a JSON object");
    expect(() => providerFromEnv({ ...env, OPENAI_COMPAT_EXTRA_BODY: "[1]" })).toThrow("must be a JSON object");
  });

  test("old large tool output is cleared first, judged by the real usage of the previous request", async () => {
    const big = Array.from({ length: 800 }, () => "a".repeat(40)).join("\n");
    const { cwd, rt, store, requests } = await setup(
      [
        call(use("u1", "read_file", { path: "big.txt" })),
        // 估算只有约 9k，真实用量 15k 超过阈值
        { content: [text("read")], stopReason: "end", usage: { inputTokens: 15_000, outputTokens: 10 } },
        reply("ok"),
      ],
      { compactTokens: 12_000 },
    );
    await writeFile(path.join(cwd, "big.txt"), big);
    await rt.send(msg("read it"));
    expect(estimateTokens(requests[1]!.messages)).toBeLessThan(12_000);
    await rt.send(msg("next"));

    // 没有调用总结，只清理了旧的工具输出
    expect(requests.length).toBe(3);
    const result = requests[2]!.messages[2]!.content[0]!;
    expect(result.kind === "tool_result" && (result.content[0] as { text: string }).text).toContain("was cleared");
    expect((rt.state.derived[DERIVED_KEY] as CompactState)).toEqual({ upTo: 0, summary: "", trimUpTo: 3 });
    expect((await events(store, rt.state.sessionId, "jade/compact/trimmed")).length).toBe(1);
  });

  test("compaction is recorded once and reused after resume", async () => {
    const store = new MemoryLogStore();
    const { jade, rt, requests, script, cwd, home, provider } = await setup([reply("A"), reply("B")], { store });
    await rt.send(msg("first"));
    await rt.send(msg("second"));

    jade.compact.request();
    script.push(reply("SUMMARY"), reply("C"));
    await rt.send(msg("third"));

    const summarizer = requests[2]!;
    expect(summarizer.tools).toEqual([]);
    const main = requests[3]!;
    expect((main.messages[0]!.content[0] as { text: string }).text).toContain("SUMMARY");
    expect(main.messages.length).toBeLessThan(rt.state.messages.length);
    const compacted = rt.state.derived[DERIVED_KEY] as CompactState;
    expect(compacted.summary).toBe("SUMMARY");
    expect((await events(store, rt.state.sessionId, "jade/compact/compacted")).length).toBe(1);

    // 恢复后直接使用日志里的摘要，不再调用总结
    const again = await createJade({ cwd, home, store, provider, today: "2026-10-30" });
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
    expect(requests[1]!.tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "list_dir", "read_file", "web_fetch"]);
  });

  test("permission settings live in the log and survive resume", async () => {
    const store = new MemoryLogStore();
    const { rt, cwd, home, provider, script } = await setup([], { store });
    await rt.record(POLICY_KEY, { mode: "readonly", rules: [] });
    await rt.detach();

    const again = await createJade({ cwd, home, store, provider, today: "2026-10-30" });
    const resumed = await Runtime.resume({ store, provider, plugins: again.plugins, sessionId: rt.state.sessionId });
    script.push(call(use("u1", "write_file", { path: "a.txt", content: "x" })), reply("ok"));
    await resumed.send(msg("write it"));

    const [decided] = await events(store, rt.state.sessionId, "tool.decided");
    expect(decided!.data).toMatchObject({ decision: "deny", decidedBy: "jade/policy" });
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

describe("context window", () => {
  const env = { OPENAI_COMPAT_BASE_URL: "http://x/v1", OPENAI_COMPAT_MODEL: "m" };

  test("JADE_CONTEXT_WINDOW, 256000 by default", () => {
    expect(contextWindowFromEnv(env)).toBe(256_000);
    expect(contextWindowFromEnv({ ...env, JADE_CONTEXT_WINDOW: "1000000" })).toBe(1_000_000);
    expect(() => contextWindowFromEnv({ ...env, JADE_CONTEXT_WINDOW: "200k" })).toThrow("JADE_CONTEXT_WINDOW");
  });

  test("compaction threshold leaves room for the reply", () => {
    expect(compactThreshold(200_000, { ANTHROPIC_API_KEY: "k" })).toBe(136_000);
    expect(compactThreshold(200_000, { ...env, JADE_MAX_TOKENS: "8000" })).toBe(160_000);
    expect(compactThreshold(32_768, { ...env, JADE_MAX_TOKENS: "32000" })).toBe(16_384);
  });
});
