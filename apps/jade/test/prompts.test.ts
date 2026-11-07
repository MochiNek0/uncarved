// jade/prompts：指令文件进系统提示词，并告诉用户读了哪些。

import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, LogEvent, Message, Origin } from "uncarved";
import { explainEmptyResults, whyEmpty } from "../plugins/prompts/results.ts";
import { featureHost, msg, reply, results, tempDir, textOf, use } from "./feature-host.ts";

test("instruction files go into the system prompt and the user is told which were loaded", async () => {
  const home = await tempDir("jade-prompts-home-");
  const cwd = await tempDir("jade-prompts-cwd-");
  await writeFile(path.join(home, "AGENTS.md"), "user rule");
  await writeFile(path.join(cwd, "CLAUDE.md"), "project rule");
  const { host, state } = await featureHost({ home, cwd });
  try {
    state.script.push(reply("ok"));
    const s = await host.sessions.open();
    await s.send(msg("hi"));
    const system = state.requests[0]!.system.map((x) => x.text).join("\n");
    expect(system).toContain("user rule");
    expect(system).toContain("project rule");
    const shownHome = path.join(home, "AGENTS.md").split(path.sep).join("/");
    expect(state.notes).toContain(`loaded instructions: ${shownHome}, CLAUDE.md`);
  } finally {
    await host.close();
  }
});

test("no notice without instruction files", async () => {
  const { host, state } = await featureHost();
  try {
    await host.sessions.open();
    expect(state.notes.filter((n) => n.startsWith("loaded instructions"))).toEqual([]);
  } finally {
    await host.close();
  }
});

test("an empty error result says why: a tool that does not exist", async () => {
  const { host, state } = await featureHost();
  try {
    state.script.push({ content: [use("u1", "Read", { path: "a.txt" })], stopReason: "tool_use" }, reply("ok"));
    const s = await host.sessions.open();
    await s.send(msg("hi"));
    const [r] = results(state.requests[1]!);
    expect(r!.isError).toBe(true);
    expect(textOf(r!.content)).toContain('There is no tool named "Read"');
    expect(r!.content[0]!.origin).toEqual({ by: "plugin", id: "jade/prompts" });
    // 原因记进了日志：恢复的会话同样能说明
    expect(s.state.derived["jade/prompts/empty-results"]).toEqual({ u1: "unknown-tool" });
  } finally {
    await host.close();
  }
});

describe("explainEmptyResults", () => {
  const model = { by: "model", provider: "p", model: "m" } as const;
  const empty = (id: string, origin: Origin): Block => ({ kind: "tool_result", toolUseId: id, content: [], isError: true, origin, trust: "trusted" });
  const call = (id: string): Block => ({ kind: "tool_use", id, name: "bash", input: {}, origin: model, trust: "trusted" });
  const text = (m: Message[]) => m.at(-1)!.content.map((b) => (b.kind === "tool_result" ? textOf(b.content) : ""));

  test("each source gets its own explanation; the log is not touched", () => {
    const messages: Message[] = [
      { role: "assistant", content: [call("a"), call("b"), call("c"), call("d")] },
      { role: "user", content: [empty("a", { by: "runtime" }), empty("b", { by: "runtime" }), empty("c", { by: "user" }), empty("d", { by: "plugin", id: "x" })] },
    ];
    const before = structuredClone(messages);
    const [a, b, c, d] = text(explainEmptyResults(messages, { a: "interrupted" }, "jade/prompts"));
    expect(a).toContain("interrupted while it was running");
    expect(b).toContain("the turn ended before it finished");
    expect(c).toBe("The user declined this call.");
    expect(d).toContain("gave no reason");
    expect(messages).toEqual(before);
  });

  test("results with content, and successful ones, are left alone", () => {
    const messages: Message[] = [
      { role: "assistant", content: [call("a")] },
      {
        role: "user",
        content: [
          // 空的但不是错误
          { kind: "tool_result", toolUseId: "a", content: [], isError: false, origin: { by: "tool", name: "bash" }, trust: "untrusted" },
          // 错误但有内容
          { kind: "tool_result", toolUseId: "b", content: [{ kind: "text", text: "failed", origin: { by: "tool", name: "bash" }, trust: "untrusted" }], isError: true, origin: { by: "tool", name: "bash" }, trust: "untrusted" },
        ],
      },
    ];
    expect(explainEmptyResults(messages, {}, "jade/prompts")).toBe(messages);
  });

  test("whyEmpty only picks runtime denials without a reason and interruptions", () => {
    const ev = (type: string, data: unknown, origin: Origin) => ({ v: 1, id: "e", seq: 1, at: "", type, data, origin }) as LogEvent;
    expect(whyEmpty(ev("tool.decided", { toolUseId: "a", decision: "deny" }, { by: "runtime" }))).toEqual({ toolUseId: "a", why: "unknown-tool" });
    expect(whyEmpty(ev("tool.decided", { toolUseId: "a", decision: "deny" }, { by: "plugin", id: "x" }))).toBeUndefined();
    expect(whyEmpty(ev("tool.decided", { toolUseId: "a", decision: "allow" }, { by: "runtime" }))).toBeUndefined();
    expect(whyEmpty(ev("tool.interrupted", { toolUseId: "b" }, { by: "runtime" }))).toEqual({ toolUseId: "b", why: "interrupted" });
  });
});
