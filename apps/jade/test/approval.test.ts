// jade/approval 的审批渠道（approval@1 的 addApprover）：问题同时交给终端和渠道，先回答的算数，其余的被中止。

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { featureHost, msg, reply, results, textOf, use } from "./feature-host.ts";

interface ApproverState {
  /** 渠道的回答，按顺序用掉："hang" 等到被中止，"throw" 抛错 */
  answers: string[];
  seen: { title: string; detail?: string; options: string[] }[];
  /** 渠道收到的结构化调用信息 */
  calls: Record<string, unknown>[];
  aborted: number;
}
const g = globalThis as { __approver?: ApproverState };

const APPROVER = {
  manifest: { id: "test/approver", requires: ["approval@1"] },
  code: `export default { process(ctx) {
  const a = () => globalThis.__approver;
  ctx.require("approval@1").addApprover(async (req, signal) => {
    a().seen.push({ title: req.title, detail: req.detail, options: req.options.map((o) => o.value) });
    a().calls.push(JSON.parse(JSON.stringify(req.call)));
    // 渠道改副本，不影响实际执行的参数
    req.call.input.content = "tampered";
    const next = a().answers.shift();
    if (typeof next === "string" && next.startsWith("{")) return JSON.parse(next);
    if (next === "hang") return new Promise((r) => signal.addEventListener("abort", () => { a().aborted++; r(undefined); }, { once: true }));
    if (next === "throw") throw new Error("chat is down");
    return next;
  });
} };`,
};

async function run(answers: string[], interactive: boolean, uiAnswers: (string | undefined)[] = [], config?: object) {
  g.__approver = { answers, seen: [], calls: [], aborted: 0 };
  const w = await featureHost({ plugins: [APPROVER], ...(config ? { config } : {}) });
  w.state.interactive = interactive;
  w.state.answers = uiAnswers;
  w.state.script.push({ content: [use("w", "write_file", { path: "hello.txt", content: "hi\n" })], stopReason: "tool_use" }, reply("done"));
  try {
    const s = await w.host.sessions.open();
    await s.send(msg("write it"));
    const file = path.join(w.cwd, "hello.txt");
    const written = existsSync(file);
    const content = written ? await readFile(file, "utf8") : undefined;
    const id = s.id;
    await w.host.sessions.close();
    const events = (await readFile(path.join(w.home, "sessions", `${id}.jsonl`), "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
    const answered = events.filter((e) => e.type === "jade/approval/answered").map((e) => e.data);
    return { ...w, id, result: results(w.state.requests[1]!)[0]!, written, content, answered, approver: g.__approver };
  } finally {
    await w.host.close();
  }
}

describe("approvers", () => {
  test("a front end that cannot ask still asks the approver, and its answer counts", async () => {
    const r = await run(["once"], false);
    expect(r.written).toBe(true);
    expect(r.approver.seen).toEqual([{ title: "Allow write_file?", detail: expect.stringContaining("+ hi"), options: ["once", "always", "deny"] }]);
    expect(r.state.selects).toEqual([]);
  }, 30_000);

  test("the approver gets the call itself, as a copy", async () => {
    const r = await run(["once"], false);
    expect(r.approver.calls).toEqual([
      {
        tool: "write_file",
        toolUseId: "w",
        effect: "write",
        input: { path: path.join(r.cwd, "hello.txt"), content: "hi\n" },
        session: r.id,
        cwd: r.cwd,
        mode: "ask",
      },
    ]);
    // 渠道改的是副本：写进文件的还是模型给的内容
    expect(r.content).toBe("hi\n");
  }, 30_000);

  test("who answered, and through which channel, is logged", async () => {
    const byApprover = await run(['{"answer":"once","by":"feishu:ou_42"}'], false);
    expect(byApprover.written).toBe(true);
    expect(byApprover.answered).toEqual([{ toolUseId: "w", tool: "write_file", answer: "once", channel: "test/approver", by: "feishu:ou_42" }]);

    const denied = await run(['{"answer":"deny"}'], false);
    expect(denied.written).toBe(false);
    expect(denied.answered).toEqual([{ toolUseId: "w", tool: "write_file", answer: "deny", channel: "test/approver" }]);

    const byTerminal = await run(["hang"], true, ["once"]);
    expect(byTerminal.answered).toEqual([{ toolUseId: "w", tool: "write_file", answer: "once", channel: "terminal" }]);
  }, 30_000);

  test("an answer object the approval plugin does not know counts as no answer, and nothing is logged", async () => {
    const r = await run(['{"answer":"sure","by":"x"}'], false);
    expect(r.written).toBe(false);
    expect(r.answered).toEqual([]);
  }, 30_000);

  test("the approver's deny denies", async () => {
    const r = await run(["deny"], false);
    expect(r.written).toBe(false);
    expect(textOf(r.result.content)).toContain("The user denied this tool call");
  }, 30_000);

  test("an approver that gives no answer or throws does not approve", async () => {
    for (const answer of ["maybe", "throw"]) {
      const r = await run([answer], false);
      expect(r.written).toBe(false);
      expect(r.result.isError).toBe(true);
    }
  }, 30_000);

  test("whoever answers first wins; the other one is stopped", async () => {
    // 终端先拒绝：渠道的问题被中止
    const denied = await run(["hang"], true, ["deny"]);
    expect(denied.written).toBe(false);
    expect(denied.approver.aborted).toBe(1);
    // 渠道不回答、终端允许：照常执行
    const allowed = await run(["maybe"], true, ["once"]);
    expect(allowed.written).toBe(true);
    expect(allowed.state.selects).toHaveLength(1);
  }, 30_000);

  test("askTimeoutMinutes bounds the wait for an answer; past it the call is denied", async () => {
    const r = await run(["hang"], false, [], { "jade/approval": { askTimeoutMinutes: 0.005 } });
    expect(r.written).toBe(false);
    expect(r.approver.aborted).toBe(1);
    expect(r.state.notes.join(" ")).not.toContain("askTimeoutMinutes");
  }, 30_000);

  test("a bad askTimeoutMinutes is reported and the default is used", async () => {
    const r = await run(["once"], false, [], { "jade/approval": { askTimeoutMinutes: "soon" } });
    expect(r.written).toBe(true);
    expect(r.state.notes.join(" ")).toContain('askTimeoutMinutes must be a number of minutes between 0 and 10080, got "soon"; using 24 hours');
  }, 30_000);
});
