// jade/task：子 Agent 是核心开的子会话（ctx.session.spawn）。从旧 jade 的 test/jade.test.ts（task …）移植：
// 子 Agent 的工具就是会话里的工具（默认只留只读的，加上只放行只读命令的 bash），审批经主会话同一套 jade/approval。

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonlLogStore } from "@uncarved/store-jsonl";
import { ProviderError, readAll, type Block, type ChildRef, type RuntimeNotice } from "uncarved";
import type { ChildSession } from "@uncarved/jade-api";
import { DELEGATION } from "../src/session.ts";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";

afterEach(cleanup);
// 每个子 Agent 都是一个完整的会话（所有插件都加入）：全量测试的负载下可能超过默认的 5 秒
setDefaultTimeout(30_000);
import { OMITTED, subagentPrompt, taskTool, WRAP_UP } from "../plugins/task/subagent.ts";
import { SEARCH_PROVIDERS } from "../plugins/web/web.ts";

const SEARCH_KEYS = SEARCH_PROVIDERS.map((p) => p.env);
/** scriptedHost 默认是 yolo，子 Agent 不会问；要看它问的测试用 ask */
const ASK = { "jade/approval": { mode: "ask" } };

describe("jade/task", () => {
  test("the sub-agent prompt mentions a step budget only when one is configured", () => {
    expect(subagentPrompt(40, false)).toContain("You have about 40 responses");
    expect(subagentPrompt(Infinity, false)).not.toContain("responses (each");
    expect(subagentPrompt(Infinity, false)).toContain("write your report as soon as you can answer");
  });

  test("runs a read-only sub-agent in a child session and returns its report; progress shows its tool calls", async () => {
    const { home, host, shared, send } = await scriptedHost();
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
    expect(sub.tools.map((t) => t.name).sort()).toEqual(expect.arrayContaining(["bash", "glob", "grep", "list_dir", "read_file"]));
    for (const name of ["write_file", "edit_file", "task", "ask_user"]) expect(sub.tools.map((t) => t.name)).not.toContain(name);
    // 核心的委派说明在最前，然后是 task 给的角色；主 Agent 的角色说明没有
    expect(sub.system[0]!.text).toBe(DELEGATION);
    expect(sub.system[1]!.text).toContain("read-only research sub-agent");
    expect(sub.system.some((seg) => seg.text === shared.requests[0]!.system[0]!.text)).toBe(false);
    expect(textOf(sub.messages[0]!.content)).toBe("list the root");
    // 子 Agent 看不到主会话
    expect(sub.messages).toHaveLength(1);
    expect(textOf(shared.requests[3]!.messages.at(-1)!.content)).toBe("report: empty");
    expect(progress).toEqual([
      { kind: "task-start", sessionId: expect.any(String), description: "look" },
      { kind: "task-model" },
      // 参数是审批插件换成绝对路径之后的
      { kind: "task-tool", name: "list_dir", input: { path: expect.any(String) }, decision: "allow" },
      { kind: "task-model" },
    ]);

    // 子会话的日志存盘，和父会话互相引用；子会话结束了，不进 /resume 的列表
    const completed = (await s.history()).find((e) => e.type === "tool.completed" && (e.data as { toolUseId: string }).toolUseId === "u1")!;
    const ref = (completed.data as { child?: ChildRef }).child!;
    expect(ref.sessionId).toBe((progress[0] as { sessionId: string }).sessionId);
    const log = await readAll(new JsonlLogStore(path.join(home, "sessions")), ref.sessionId);
    expect(log[0]).toMatchObject({ type: "session.started", data: { parent: { sessionId: s.id } } });
    expect(log.at(-1)!.type).toBe("session.ended");
    expect(log.at(-1)!.seq).toBe(ref.seq);
    const index = await readFile(path.join(home, "state", "sessions.jsonl"), "utf8");
    expect(index).not.toContain(ref.sessionId);
  });

  test("a running sub-agent is listed in the frontend's background jobs with what it does, and removed when it reports", async () => {
    const { shared, host, send, cwd } = await scriptedHost();
    await writeFile(path.join(cwd, "a.txt"), "a");
    await writeFile(path.join(cwd, "b.txt"), "b");
    shared.script.push(
      use("u1", "task", { description: "look", prompt: "list the root" }),
      use("c1", "list_dir", { path: "." }),
      use("c2", "list_dir", { path: "missing-dir-x" }),
      say("report: two files"),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.jobs).toHaveLength(1);
    const job = shared.jobs[0]!;
    expect(job).toMatchObject({ session: s.id, kind: "agent", title: "look", disposed: true });
    expect(job.output).toContain("● list_dir(");
    expect(job.output).toContain("report: two files");
    // 工具结果只显示第一行；多出来的完整输出挂在那一行上，后台列表里点开看。一行就放得下的不挂
    expect(job.output).toMatch(/⎿ .*\(\+1 lines\)/);
    expect(job.details).toHaveLength(1);
    expect(job.details[0]).toContain("a.txt");
    expect(job.details[0]).toContain("b.txt");
    expect(job.statuses).toContain("thinking");
    expect(job.statuses.some((t) => t.startsWith("list_dir("))).toBe(true);
  });

  test("stopping a sub-agent from the background jobs ends only it; the main agent gets what it had and continues", async () => {
    const { shared, host, send } = await scriptedHost();
    shared.stopJobs = true;
    shared.script.push(
      use("u1", "task", { description: "look", prompt: "list the root" }),
      // 子 Agent 说了一句、要调用工具：这时（它第一次有输出）用户停掉它，它不会再请求模型
      { content: [...(say("checking the root") as { content: Block[] }).content, ...(use("c1", "list_dir", { path: "." }) as { content: Block[] }).content], stopReason: "tool_use" },
      // 主会话
      say("ok, stopped"),
    );
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.requests).toHaveLength(3);
    const result = shared.requests[2]!.messages.at(-1)!.content.find((b) => b.kind === "tool_result") as Extract<Block, { kind: "tool_result" }>;
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toContain("The user stopped this sub-agent");
    expect(textOf(result.content)).toContain("checking the root");
    expect(shared.jobs[0]!.disposed).toBe(true);
  });

  test("a stop that comes after the sub-agent already reported does not throw its report away", async () => {
    const { shared, host, send } = await scriptedHost();
    shared.stopJobs = "at-end";
    shared.script.push(use("u1", "task", { description: "look", prompt: "list the root" }), say("report: empty"), say("done"));
    const s = await host.sessions.open();
    await send(s, "go");
    const result = shared.requests[2]!.messages.at(-1)!.content.find((b) => b.kind === "tool_result") as Extract<Block, { kind: "tool_result" }>;
    expect(result.isError).toBeFalsy();
    expect(textOf(result.content)).toContain("report: empty");
    expect(textOf(result.content)).not.toContain("The user stopped");
  });

  test("the sub-agent gets the session's instruction files, the repository's ones untrusted; instructions: false leaves them out", async () => {
    for (const off of [false, true]) {
      const { cwd, host, shared, send } = await scriptedHost(off ? { config: { "jade/task": { instructions: false } } } : {});
      await writeFile(path.join(cwd, "AGENTS.md"), "Always cite the design doc.");
      shared.script.push(use("u1", "task", { description: "look", prompt: "look around" }), say("report"), say("done"));
      const s = await host.sessions.open();
      await send(s, "go");
      const sub = shared.requests[1]!;
      const project = sub.system.filter((seg) => seg.text.includes("Always cite the design doc."));
      if (off) {
        expect(project).toEqual([]);
        // 主会话照常有
        expect(shared.requests[0]!.system.some((seg) => seg.text.includes("Always cite the design doc."))).toBe(true);
        continue;
      }
      expect(project).toHaveLength(1);
      expect(project[0]!.trust).toBe("untrusted");
      expect(project[0]!.origin).toMatchObject({ by: "plugin", id: "jade/prompts", source: { layer: "project", path: "AGENTS.md" } });
      // 委派说明和子 Agent 的角色排在前面
      expect(sub.system.indexOf(project[0]!)).toBeGreaterThan(1);
    }
  });

  test("the sub-agent reuses the environment and instruction files its session read at the start instead of reading them again", async () => {
    const { cwd, host, shared, send } = await scriptedHost();
    await writeFile(path.join(cwd, "AGENTS.md"), "Version one.");
    const s = await host.sessions.open();
    // 会话开始之后才改：子 Agent 看到的和主会话一样，是开始时读到的
    await writeFile(path.join(cwd, "AGENTS.md"), "Version two.");
    shared.script.push(use("u1", "task", { description: "look", prompt: "look around" }), say("report"), say("done"));
    await send(s, "go");
    const env = (i: number) => shared.requests[i]!.system.find((seg) => seg.text.startsWith("# Environment"))?.text;
    const text = (i: number) => shared.requests[i]!.system.map((seg) => seg.text).join("\n");
    expect(text(1)).toContain("Version one.");
    expect(text(1)).not.toContain("Version two.");
    expect(env(1)).toBe(env(0)!);
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
    let sends = 0;
    // 跨插件时宿主的膜把它包成 PluginError，原来的在 cause 里
    const overloaded = Object.assign(new Error("plugin m (models@1.complete): overloaded", { cause: new ProviderError("overloaded", { retryable: true, status: 529 }) }), { name: "PluginError" });
    const child: ChildSession = {
      id: "child",
      send: async () => {
        sends++;
        throw overloaded;
      },
      state: { sessionId: "child", lastSeq: 2, phase: "idle", messages: [], batch: [], plugins: [], derived: {} },
      subscribe: () => () => {},
      abort: () => {},
      close: async () => ({ sessionId: "child", seq: 3 }),
    };
    const tool = taskTool({ spawn: async () => child, maxSteps: 5, write: false, register: () => () => {} });
    const ctx = { sessionId: "s", toolUseId: "t", signal: new AbortController().signal, parent: { sessionId: "s", eventId: "e" }, progress() {} };
    const r = await tool.execute({ description: "x", prompt: "y" }, ctx);
    expect(sends).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.child).toEqual({ sessionId: "child", seq: 3 });
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
      expect(shared.requests[4]!.tools.map((t) => t.name)).toContain("read_file");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });

  test("reads outside the working directory are put to the user, labelled with the task; without an answer they are denied", async () => {
    const { home, host, shared, send } = await scriptedHost({ config: ASK });
    const outside = path.join(home, "secret.txt");
    await writeFile(outside, "the secret");
    const script = () =>
      shared.script.push(use("u1", "task", { description: "read", prompt: "read the file" }), use("c1", "read_file", { path: outside }), say("report"), say("done"));

    script();
    shared.answers.push("once");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual(["[read] Allow read_file?"]);
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("the secret");

    script();
    shared.answers.push("deny");
    await send(s, "again");
    expect(textOf(shared.requests[6]!.messages.at(-1)!.content)).toContain("The user denied this tool call");

    // 不能提问的前端
    script();
    shared.interactive = false;
    await send(s, "once more");
    expect(textOf(shared.requests[10]!.messages.at(-1)!.content)).toContain("nobody can approve it");
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
    expect(shared.requests[1]!.tools.map((t) => t.name)).toContain("bash");
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("hello");
    expect(textOf(shared.requests[3]!.messages.at(-1)!.content)).toContain("sub-agents can only run read-only commands");
    expect(existsSync(path.join(cwd, "a.txt"))).toBe(true);
  }, 30_000);

  test("with write: true the sub-agent gets every tool, and its changes go through approval", async () => {
    const { cwd, host, shared, send } = await scriptedHost({ config: { ...ASK, "jade/task": { write: true } } });
    shared.script.push(
      use("u1", "task", { description: "fix", prompt: "write the file" }),
      use("c1", "write_file", { path: "out.txt", content: "made by a sub-agent\n" }),
      say("report: wrote out.txt"),
      say("done"),
    );
    shared.answers.push("once");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.requests[1]!.tools.map((t) => t.name)).toContain("write_file");
    expect(shared.asked).toEqual(["[fix] Allow write_file?"]);
    expect(await readFile(path.join(cwd, "out.txt"), "utf8")).toBe("made by a sub-agent\n");
    expect(textOf(shared.requests[3]!.messages.at(-1)!.content)).toBe("report: wrote out.txt");
  });

  test("with sub-agents turned off the session has no task tool", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/core": { maxDepth: 0 } } });
    shared.script.push(say("ok"));
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.requests[0]!.tools.map((t) => t.name)).not.toContain("task");
  });

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
    shared.answers.push("deny");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual(["[read] Allow read_file?"]);
  });

  test("a glob whose pattern escapes the working directory is put to the user too", async () => {
    const { host, shared, send } = await scriptedHost({ config: ASK });
    shared.script.push(use("u1", "task", { description: "find", prompt: "find keys" }), use("c1", "glob", { pattern: "../**/.ssh/*" }), say("report"), say("done"));
    shared.answers.push("deny");
    const s = await host.sessions.open();
    await send(s, "go");
    expect(shared.asked).toEqual(["[find] Allow glob?"]);
    expect(textOf(shared.requests[2]!.messages.at(-1)!.content)).toContain("The user denied this tool call");
  });
});
