// jade/approval 的审批渠道（approval@1 的 addApprover）：问题同时交给终端和渠道，先回答的算数，其余的被中止。
// 以及审批走内核的 ask：关卡不等用户，内核停下来等人工审批时才问，回答作为 approval 输入记进日志。

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { featureHost, msg, reply, results, textOf, use } from "./feature-host.ts";

interface ApproverState {
  /** 渠道的回答，按顺序用掉："hang" 等到被中止，"throw" 抛错 */
  answers: string[];
  seen: { title: string; detail?: string; options: string[] }[];
  aborted: number;
}
const g = globalThis as { __approver?: ApproverState };

const APPROVER = {
  manifest: { id: "test/approver", requires: ["approval@1"] },
  code: `export default { process(ctx) {
  const a = () => globalThis.__approver;
  ctx.require("approval@1").addApprover(async (req, signal) => {
    a().seen.push({ title: req.title, detail: req.detail, options: req.options.map((o) => o.value) });
    const next = a().answers.shift();
    if (next === "hang") return new Promise((r) => signal.addEventListener("abort", () => { a().aborted++; r(undefined); }, { once: true }));
    if (next === "throw") throw new Error("chat is down");
    return next;
  });
} };`,
};

async function run(answers: string[], interactive: boolean, uiAnswers: (string | undefined)[] = [], config?: object) {
  g.__approver = { answers, seen: [], aborted: 0 };
  const w = await featureHost({ plugins: [APPROVER], ...(config ? { config } : {}) });
  w.state.interactive = interactive;
  w.state.answers = uiAnswers;
  w.state.script.push({ content: [use("w", "write_file", { path: "hello.txt", content: "hi\n" })], stopReason: "tool_use" }, reply("done"));
  try {
    const s = await w.host.sessions.open();
    await s.send(msg("write it"));
    return { ...w, result: results(w.state.requests[1]!)[0]!, written: existsSync(path.join(w.cwd, "hello.txt")), approver: g.__approver };
  } finally {
    await w.host.close();
  }
}

describe("approvers", () => {
  test("a front end that cannot ask still asks the approver, and its answer counts", async () => {
    const r = await run(["once"], false);
    expect(r.written).toBe(true);
    expect(r.approver.seen).toEqual([{ title: "Allow write_file?", detail: expect.stringContaining("+ hi"), options: ["once", "always", "forever", "deny"] }]);
    expect(r.state.selects).toEqual([]);
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

describe("asking through the kernel", () => {
  const write = (id: string, file: string) => use(id, "write_file", { path: file, content: "hi\n" });
  /** 日志里和审批有关的事件 */
  const trail = (events: { type: string; data: unknown }[]) =>
    events.flatMap((e) => {
      const d = e.data as Record<string, unknown>;
      if (e.type === "tool.decided") return [`decided ${d.toolUseId} ${d.decision} by ${d.decidedBy}`];
      if (e.type === "input.received" && d.kind === "approval") return [`approval ${d.toolUseId} ${d.approved}`];
      if (e.type === "jade/approval/answered") return [`answered ${d.toolUseId} ${d.answer} by ${d.by}`];
      if (e.type === "derived.recorded" && d.key === "jade/approval/rules") return ["rules recorded"];
      if (e.type === "turn.ended") return [`ended ${d.reason}`];
      return [];
    });

  async function world(plugins: { manifest: { id: string } & Record<string, unknown>; code: string }[] = []) {
    g.__approver = { answers: [], seen: [], aborted: 0 };
    return featureHost({ plugins });
  }

  test("the log shows the gate asking, the answer as the user's input, and who gave it", async () => {
    const w = await world();
    w.state.answers = ["once"];
    w.state.script.push({ content: [write("w", "hello.txt")], stopReason: "tool_use" }, reply("done"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("write it"));
      expect(existsSync(path.join(w.cwd, "hello.txt"))).toBe(true);
      expect(trail(await s.history())).toEqual(["decided w ask by jade/approval", "approval w true", "answered w once by terminal", "ended end"]);
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("an approver's answer is recorded under its plugin", async () => {
    const w = await world([APPROVER]);
    g.__approver!.answers = ["deny"];
    w.state.interactive = false;
    w.state.script.push({ content: [write("w", "hello.txt")], stopReason: "tool_use" }, reply("done"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("write it"));
      expect(trail(await s.history())).toEqual(["decided w ask by jade/approval", "approval w false", "answered w deny by test/approver", "ended end"]);
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("when another plugin's gate denies the call, the user is not asked", async () => {
    const DENY = { manifest: { id: "test/deny" }, code: `export default { session(ctx) {
      ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: (call) => call.name === "write_file" ? { decision: "deny", reason: "not today" } : { decision: "abstain" } });
    } };` };
    const w = await world([DENY]);
    w.state.script.push({ content: [write("w", "hello.txt")], stopReason: "tool_use" }, reply("done"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("write it"));
      expect(w.state.selects).toEqual([]);
      expect(textOf(results(w.state.requests[1]!)[0]!.content)).toBe("not today");
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("always allow covers the rest of the batch and later turns, and is recorded in the log", async () => {
    const w = await world();
    w.state.answers = ["always"];
    w.state.script.push({ content: [write("a", "one.txt"), write("b", "two.txt")], stopReason: "tool_use" }, reply("done"));
    w.state.script.push({ content: [write("c", "three.txt")], stopReason: "tool_use" }, reply("done again"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("write them"));
      await s.send(msg("one more"));
      expect(w.state.selects).toHaveLength(1);
      for (const f of ["one.txt", "two.txt", "three.txt"]) expect(existsSync(path.join(w.cwd, f))).toBe(true);
      expect(trail(await s.history())).toEqual([
        "decided a ask by jade/approval",
        "decided b ask by jade/approval",
        "approval a true",
        "answered a always by terminal",
        "rules recorded",
        "approval b true",
        "answered b allow by rule",
        "ended end",
        "decided c allow by jade/approval",
        "ended end",
      ]);
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("always allow in this directory is saved under $JADE_HOME and covers new sessions and new processes", async () => {
    const w = await world();
    w.state.answers = ["forever"];
    w.state.script.push({ content: [write("a", "one.txt")], stopReason: "tool_use" }, reply("done"));
    w.state.script.push({ content: [write("b", "two.txt")], stopReason: "tool_use" }, reply("done again"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("write it"));
      expect(trail(await s.history())).toEqual(["decided a ask by jade/approval", "approval a true", "answered a forever by terminal", "ended end"]);
      const next = await w.host.sessions.open();
      await next.send(msg("one more"));
      expect(w.state.selects).toHaveLength(1);
      expect(existsSync(path.join(w.cwd, "two.txt"))).toBe(true);
    } finally {
      await w.host.close();
    }
    expect(JSON.parse(await Bun.file(path.join(w.home, "state", "approvals.json")).text())).toEqual({ [w.cwd]: [{ tool: "write_file" }] });
    // 另一个进程、同一个目录：不再问；别的目录照旧问
    for (const [cwd, asked] of [[w.cwd, 0], [undefined, 1]] as const) {
      const again = await featureHost({ home: w.home, ...(cwd ? { cwd } : {}) });
      again.state.answers = ["deny"];
      again.state.script.push({ content: [write("c", "three.txt")], stopReason: "tool_use" }, reply("done"));
      try {
        await (await again.host.sessions.open()).send(msg("write it"));
        expect(again.state.selects).toHaveLength(asked);
      } finally {
        await again.host.close();
      }
    }
  }, 30_000);

  test("deny with an explanation passes what the user typed to the model", async () => {
    const w = await world();
    w.state.answers = ["explain"];
    w.state.inputs = ["use two.txt instead"];
    w.state.script.push({ content: [write("a", "one.txt")], stopReason: "tool_use" }, reply("ok"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("write it"));
      expect(existsSync(path.join(w.cwd, "one.txt"))).toBe(false);
      expect(textOf(results(w.state.requests[1]!)[0]!.content)).toBe("The user denied this tool call and said: use two.txt instead");
      expect(trail(await s.history())).toEqual(["decided a ask by jade/approval", "approval a false", "answered a deny by terminal", "ended end"]);
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("a call another plugin's gate wants asked is asked here, without the always option", async () => {
    const CAREFUL = { manifest: { id: "test/careful" }, code: `export default { session(ctx) {
      ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: (call) => ({ decision: call.name === "read_file" ? "ask" : "abstain" }) });
    } };` };
    const w = await world([APPROVER, CAREFUL]);
    g.__approver!.answers = ["once"];
    w.state.interactive = false;
    await Bun.write(path.join(w.cwd, "notes.txt"), "hello\n");
    w.state.script.push({ content: [use("r", "read_file", { path: "notes.txt" })], stopReason: "tool_use" }, reply("done"));
    try {
      const s = await w.host.sessions.open();
      await s.send(msg("read it"));
      expect(g.__approver!.seen.map((q) => [q.title, q.options])).toEqual([["Allow read_file?", ["once", "deny"]]]);
      expect(results(w.state.requests[1]!)[0]!.isError).toBe(false);
      expect(trail(await s.history())).toEqual(["decided r ask by test/careful", "approval r true", "answered r once by test/approver", "ended end"]);
    } finally {
      await w.host.close();
    }
  }, 30_000);

  test("interrupting while the question is open closes it and ends the turn; the next message runs", async () => {
    const w = await world([APPROVER]);
    g.__approver!.answers = ["hang"];
    w.state.interactive = false;
    w.state.script.push({ content: [write("w", "hello.txt")], stopReason: "tool_use" }, reply("fine"));
    try {
      const s = await w.host.sessions.open();
      const turn = s.send(msg("write it")).catch((e: Error) => e.message);
      while (g.__approver!.seen.length === 0) await Bun.sleep(1);
      s.abort(new Error("interrupted by user"));
      expect(await turn).toBe("interrupted by user");
      await s.idle();
      expect(g.__approver!.aborted).toBe(1);
      expect(existsSync(path.join(w.cwd, "hello.txt"))).toBe(false);
      expect(trail(await s.history())).toEqual(["decided w ask by jade/approval", "ended aborted"]);
      await s.send(msg("never mind"));
      expect(s.state.phase).toBe("idle");
      expect(w.state.script).toEqual([]);
    } finally {
      await w.host.close();
    }
  }, 30_000);
});

describe("resuming", () => {
  test("a session killed while it waited for approval asks again when it is resumed", async () => {
    g.__approver = { answers: ["hang"], seen: [], aborted: 0 };
    const a = await featureHost({ plugins: [APPROVER] });
    a.state.interactive = false;
    a.state.script.push({ content: [use("w", "write_file", { path: "hello.txt", content: "hi\n" })], stopReason: "tool_use" });
    const s = await a.host.sessions.open();
    const first = s.send(msg("write it")).catch(() => {});
    while (s.state.phase !== "awaiting") await Bun.sleep(1);
    // 进程被杀：正常关闭会结束这一轮，所以先留一份停在等审批的日志，关掉之后放回去
    const logs = path.join(a.home, "sessions");
    await cp(logs, `${logs}.killed`, { recursive: true });
    await a.host.close();
    await first;
    await rm(logs, { recursive: true });
    await rename(`${logs}.killed`, logs);

    g.__approver = { answers: ["once"], seen: [], aborted: 0 };
    const b = await featureHost({ home: a.home, cwd: a.cwd, plugins: [APPROVER] });
    b.state.interactive = false;
    b.state.script.push(reply("done"));
    try {
      const r = await b.host.sessions.open({ resume: s.id });
      await r.recover();
      expect(existsSync(path.join(b.cwd, "hello.txt"))).toBe(true);
      // 这个进程里的关卡没见过这个调用：只能允许一次或拒绝
      expect(g.__approver.seen).toEqual([{ title: "Allow write_file?", detail: expect.stringContaining("+ hi"), options: ["once", "deny"] }]);
      const answered = (await r.history()).filter((e) => e.type === "jade/approval/answered").map((e) => e.data);
      expect(answered).toEqual([{ toolUseId: "w", answer: "once", by: "test/approver" }]);
      expect(r.state.phase).toBe("idle");
    } finally {
      await b.host.close();
    }
  }, 30_000);
});
