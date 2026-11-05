// jade/task：只读的子 Agent。从旧 jade 的 test/jade.test.ts（task …）移植：
// 子 Agent 的工具来自 task@1 的登记（jade/fs 登记它的只读工具），模型经 models@1。

import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeNotice } from "uncarved";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";

afterEach(cleanup);
import { WRAP_UP } from "../plugins/task/subagent.ts";
import { SEARCH_PROVIDERS } from "../plugins/web/web.ts";

const SEARCH_KEYS = SEARCH_PROVIDERS.map((p) => p.env);

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
    const { home, host, shared, send } = await scriptedHost();
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
});
