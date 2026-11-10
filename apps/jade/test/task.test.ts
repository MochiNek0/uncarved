// jade/task：只读的子 Agent。从旧 jade 的 test/jade.test.ts（task …）移植：
// 子 Agent 的工具来自 task@1 的登记（jade/fs 登记它的只读工具），模型经 models@1。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProviderError, type Block, type RuntimeNotice } from "uncarved";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";

afterEach(cleanup);
import { OMITTED, taskTool, WRAP_UP } from "../plugins/task/subagent.ts";
import { SEARCH_PROVIDERS } from "../plugins/web/web.ts";

const SEARCH_KEYS = SEARCH_PROVIDERS.map((p) => p.env);
/** scriptedHost 默认是 yolo，子 Agent 不会问；要看它问的测试用 ask */
const ASK = { "jade/approval": { mode: "ask" } };

describe("jade/task", () => {
  test("runs a read-only sub-agent and returns its report; progress shows its tool calls", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(
      use("u1", "task", { description: "look", prompt: "list the root" }),
      // 子 Agent
      use("c1", "list_dir", { path: "." }),
      say("report: empty"),
      // 主会话
      say("done"),
    );
    const s = await host.sessions.open();
    const progress: unknown[] = [];
    s.subscribe((n: RuntimeNotice) => void (n.type === "tool-progress" && progress.push(n.update)));
    await send(s, "go");

    expect(shared.requests).toHaveLength(4);
    const sub = shared.requests[1]!;
    expect(sub.tools.map((t) => t.name).sort()).toEqual(expect.arrayContaining(["glob", "grep", "list_dir", "read_file"]));
    expect(sub.tools.map((t) => t.name)).not.toContain("write_file");
    expect(sub.tools.map((t) => t.name)).not.toContain("task");
    expect(sub.system[0]!.text).toContain("read-only research sub-agent");
    expect(textOf(sub.messages[0]!.content)).toBe("list the root");
    // 子 Agent 看不到主会话
    expect(sub.messages).toHaveLength(1);
    expect(textOf(shared.requests[3]!.messages.at(-1)!.content)).toBe("report: empty");
    expect(progress).toEqual([
      { kind: "task-start", sessionId: expect.any(String), description: "look" },
      { kind: "task-model" },
      { kind: "task-tool", name: "list_dir", input: { path: "." }, decision: "allow" },
      { kind: "task-model" },
    ]);
  });

  test("the sub-agent's token usage is logged in the session, so the status bar can count it", async () => {
    const { host, shared, send } = await scriptedHost();
    shared.script.push(
      use("u1", "task", { description: "look", prompt: "list the root" }),
      { ...use("c1", "list_dir", { path: "." }), usage: { inputTokens: 100, outputTokens: 10 } },
      say("report", { inputTokens: 200, outputTokens: 20, cacheReadTokens: 50 }),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    const logged = (await s.history()).filter((e) => e.type === "jade/task/subagent").map((e) => e.data);
    expect(logged).toEqual([{ toolUseId: "u1", usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 50, cacheWriteTokens: 0 } }]);
  });

  test("a sub-agent that runs out of steps is asked for its report", async () => {
    const { cwd, host, shared, send } = await scriptedHost({ config: { "jade/task": { maxSteps: 3 } } });
    await writeFile(path.join(cwd, "a.txt"), "x");
    shared.script.push(
      use("u1", "task", { description: "survey", prompt: "survey the repo" }),
      ...[0, 1, 2].map((i) => use(`r${i}`, "glob", { pattern: `*.${i}` })),
      say("report: nothing found"),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "survey");
    expect(shared.requests).toHaveLength(6);
    expect(textOf(shared.requests[4]!.messages.at(-1)!.content)).toBe(WRAP_UP);
    const result = shared.requests[5]!.messages.at(-1)!.content[0]!;
    expect(result.kind === "tool_result" && result.isError).toBe(false);
    expect(textOf([result])).toBe("report: nothing found");
  });

  test("a sub-agent that hits an error (e.g. the context window) still reports, with older tool output left out", async () => {
    const { cwd, host, shared, send } = await scriptedHost();
    // 窗口很小：报告请求里工具输出最多约 2000 个字符
    shared.current = { ...shared.current!, contextWindow: 1000 };
    await writeFile(path.join(cwd, "big.txt"), "x".repeat(5000));
    shared.script.push(
      use("u1", "task", { description: "read", prompt: "read big.txt" }),
      use("c1", "read_file", { path: "big.txt" }),
      { error: "prompt is too long: 250000 tokens > 200000 maximum" } as never,
      say("report: big.txt is all x"),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.requests).toHaveLength(5);
    const wrap = shared.requests[3]!;
    expect(textOf(wrap.messages.at(-1)!.content)).toBe(WRAP_UP);
    const old = wrap.messages.flatMap((m) => m.content).find((b) => b.kind === "tool_result")!;
    expect(textOf((old as { content: Block[] }).content)).toBe(OMITTED);
    const result = shared.requests[4]!.messages.at(-1)!.content[0]!;
    expect(result.kind === "tool_result" && result.isError).toBe(false);
    expect(textOf([result])).toContain("The sub-agent stopped on an error: prompt is too long");
    expect(textOf([result])).toContain("report: big.txt is all x");
  });

  test("after an error whose retries are used up, the sub-agent is not asked for a report again", async () => {
    let calls = 0;
    const tool = taskTool({
      cwd: process.cwd(),
      provider: {
        id: "p",
        async complete() {
          calls++;
          // 跨插件时宿主的膜把它包成 PluginError，原来的在 cause 里
          throw Object.assign(new Error("plugin m (models@1.complete): overloaded", { cause: new ProviderError("overloaded", { retryable: true, status: 529 }) }), { name: "PluginError" });
        },
      },
      tools: () => [],
      maxSteps: 5,
      id: "jade/task",
    });
    const ctx = { sessionId: "s", toolUseId: "t", signal: new AbortController().signal, parent: { sessionId: "s", eventId: "e" }, progress() {} };
    const r = await tool.execute({ description: "x", prompt: "y" }, ctx);
    expect(calls).toBe(1);
    expect(r.isError).toBe(true);
  });

  test("a sub-agent whose history nears the context window stops and reports", async () => {
    const { cwd, host, shared, send } = await scriptedHost();
    shared.current = { ...shared.current!, contextWindow: 1000 };
    await writeFile(path.join(cwd, "a.txt"), "x");
    shared.script.push(
      use("u1", "task", { description: "read", prompt: "read a.txt" }),
      // 输入加输出 810 个 token，到了窗口的 70%
      { ...use("c1", "read_file", { path: "a.txt" }), usage: { inputTokens: 800, outputTokens: 10 } },
      say("report: a.txt is x"),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.requests).toHaveLength(4);
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toBe(WRAP_UP);
    expect(textOf([shared.requests[3]!.messages.at(-1)!.content[0]!])).toBe("report: a.txt is x");
  });

  test("the sub-agent gets web_fetch, and web_search only while a search service is configured", async () => {
    const saved = Object.fromEntries(SEARCH_KEYS.map((k) => [k, process.env[k]]));
    for (const k of SEARCH_KEYS) delete process.env[k];
    try {
      const { home, host, shared, send } = await scriptedHost();
      shared.script.push(use("u1", "task", { description: "web", prompt: "look it up" }), say("report"), say("done"));
      const s = await host.sessions.open();
      await send(s, "go");
      const names = shared.requests[1]!.tools.map((t) => t.name);
      expect(names).toContain("web_fetch");
      expect(names).not.toContain("web_search");

      // 配了搜索服务（/search 写的就是这个文件），新会话里子 Agent 也能搜
      await writeFile(path.join(home, ".env"), "TAVILY_API_KEY=t\n");
      const s2 = await host.sessions.open();
      shared.script.push(use("u2", "task", { description: "web", prompt: "search it" }), say("report"), say("done"));
      await send(s2, "again");
      expect(shared.requests[4]!.tools.map((t) => t.name)).toContain("web_search");
      // 换会话之后子 Agent 仍有文件工具（新会话的登记不被旧会话的撤销带走）
      expect(shared.requests[4]!.tools.map((t) => t.name)).toContain("read_file");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  test("reads outside the working directory are put to the user; without an answer they are denied", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: ASK });
    const outside = path.join(home, "secret.txt");
    await writeFile(outside, "the secret");
    const script = () =>
      shared.script.push(use("u1", "task", { description: "read", prompt: "read the file" }), use("c1", "read_file", { path: outside }), say("report"), say("done"));

    script();
    shared.answers.push("yes");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual([`A sub-agent wants to read ${outside}, outside the working directory. Allow it?`]);
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("the secret");

    script();
    shared.answers.push("no");
    await send(s, "again");
    expect(textOf(shared.requests[6]!.messages.at(-1)!.content)).toBe("The user denied this action.");

    // 不能提问的前端
    script();
    shared.interactive = false;
    await send(s, "once more");
    expect(textOf(shared.requests[10]!.messages.at(-1)!.content)).toContain("Nobody can approve");
    expect(shared.asked).toHaveLength(2);
  });

  test("an \"always allow\" answer in the main session covers the sub-agent too", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: ASK });
    const outside = path.join(home, "notes.txt");
    await writeFile(outside, "the notes");
    shared.script.push(
      use("r1", "read_file", { path: outside }),
      use("u1", "task", { description: "read", prompt: "read the notes" }),
      use("c1", "read_file", { path: outside }),
      say("report"),
      say("done"),
    );
    shared.answers.push("always");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual(["Allow read_file?"]);
    expect(textOf(shared.requests[3]!.messages.at(-1)!.content)).toContain("the notes");
  });

  test("in yolo mode the sub-agent does not ask either", async () => {
    const { home, host, shared, send } = await scriptedHost();
    const outside = path.join(home, "notes.txt");
    await writeFile(outside, "the notes");
    shared.script.push(use("u1", "task", { description: "read", prompt: "read the notes" }), use("c1", "read_file", { path: outside }), say("report"), say("done"));
    shared.interactive = false;
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual([]);
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("the notes");
  });

  test("the sub-agent can run read-only shell commands, and nothing else, even in yolo mode", async () => {
    const { cwd, host, shared, send } = await scriptedHost();
    await writeFile(path.join(cwd, "a.txt"), "hello\n");
    shared.script.push(
      use("u1", "task", { description: "look", prompt: "look around" }),
      use("c1", "bash", { command: "cat a.txt" }),
      use("c2", "bash", { command: "rm a.txt" }),
      say("report"),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    const sub = shared.requests[1]!;
    expect(sub.tools.map((t) => t.name)).toContain("bash");
    // 给子 Agent 的 bash 不能在后台跑
    expect(JSON.stringify(sub.tools.find((t) => t.name === "bash")!.inputSchema)).not.toContain("run_in_background");
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("hello");
    expect(textOf(shared.requests[3]!.messages.at(-1)!.content)).toContain("sub-agents can only run read-only commands");
    expect(existsSync(path.join(cwd, "a.txt"))).toBe(true);
  }, 30_000);

  test("the model configured for sub-agents is the one they call", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/task": { model: "cheap" } } });
    shared.script.push(use("u1", "task", { description: "look", prompt: "look" }), say("report"), say("done"));
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.modelOptions).toEqual(["cheap"]);
  });

  test("a symlink inside the working directory that points outside is put to the user", async () => {
    const { home, cwd, host, shared, send } = await scriptedHost({ config: ASK });
    await writeFile(path.join(home, "creds"), "secret");
    try {
      await symlink(path.join(home, "creds"), path.join(cwd, "link"), "file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return; // Windows 没有开发者模式时建不了符号链接
      throw e;
    }
    shared.script.push(use("u1", "task", { description: "read", prompt: "read link" }), use("c1", "read_file", { path: "link" }), say("report"), say("done"));
    shared.answers.push("no");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual(["A sub-agent wants to read link, outside the working directory. Allow it?"]);
  });

  test("a glob whose pattern escapes the working directory is put to the user too", async () => {
    const { host, shared, send } = await scriptedHost({ config: ASK });
    shared.script.push(use("u1", "task", { description: "find", prompt: "find keys" }), use("c1", "glob", { pattern: "../**/.ssh/*" }), say("report"), say("done"));
    shared.answers.push("no");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual(["A sub-agent wants to read ../**/.ssh/*, outside the working directory. Allow it?"]);
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toBe("The user denied this action.");
  });
});
