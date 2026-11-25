import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Block, ModelResponse, State } from "uncarved";
import { NO_APPROVAL_REASON, NO_APPROVER_ERROR, ServiceUnavailable, StaleContext } from "../src/index.ts";
import { info, world } from "./helpers.ts";

type Step = Omit<ModelResponse, "model">;
const g = globalThis as { __script?: Step[]; __log?: string[]; __tools?: string[]; __late?: (t: unknown) => () => void; __ctx?: { session: { send(i: unknown): Promise<void>; abort(reason?: string): void } } };
const MODEL = { by: "model", provider: "scripted", model: "s1" } as const;
const use = (id: string, name: string, input: unknown = {}): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
const say = (text: string): Step => ({ content: [{ kind: "text", text, origin: MODEL, trust: "trusted" }], stopReason: "end" });
const call = (...blocks: Block[]): Step => ({ content: blocks, stopReason: "tool_use" });
const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });

beforeEach(() => {
  g.__script = [];
  g.__log = [];
});
afterEach(() => {
  delete g.__script;
  delete g.__log;
  delete g.__ctx;
  delete g.__tools;
  delete g.__late;
});

// 模型：按 globalThis.__script 依次回复
const PROVIDER = `export default { process(ctx) {
  ctx.provide("provider@1", {
    id: "scripted",
    async complete(req) {
      globalThis.__tools?.push(req.tools.map((t) => t.name).sort().join(","));
      const next = globalThis.__script.shift();
      if (!next) throw new Error("script exhausted");
      return { model: "s1", ...next };
    },
  });
} };`;

// 一个只读工具、一个写工具；会话作用域关闭时记一笔
const TOOLS = `export default { async session(ctx) {
  const tool = (name, effect) => ({
    name, effect, description: name, inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
    async execute() { globalThis.__log.push("ran " + name); return { content: name + " ok" }; },
  });
  ctx.kernel.tool(tool("peek", "read"));
  ctx.kernel.tool(tool("poke", "write"));
  await ctx.effect(() => () => globalThis.__log.push("tools closed " + ctx.session.id));
} };`;

// 审批插件：提供 approval@1，gate 全部放行
const ALLOW_ALL = `export default { process(ctx) { ctx.provide("approval@1", {}); }, session(ctx) {
  ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: () => ({ decision: "allow" }) });
} };`;

/** 工具结果：toolUseId → [是否出错, 文字] */
function results(state: State) {
  const out: Record<string, [boolean, string]> = {};
  for (const m of state.messages) {
    for (const b of m.content) {
      if (b.kind !== "tool_result") continue;
      const text = b.content.map((c) => (c.kind === "text" ? c.text : "")).join("");
      out[b.toolUseId] = [b.isError, text];
    }
  }
  return out;
}

async function setup(extra: (w: Awaited<ReturnType<typeof world>>) => Promise<unknown> = async () => {}) {
  const w = await world();
  await w.plugin("bundled", { id: "models", provides: ["provider@1"] }, PROVIDER);
  await w.plugin("bundled", { id: "tools" }, TOOLS);
  await extra(w);
  return { w, host: await w.start() };
}

describe("approval fallback", () => {
  test("without any gate plugin, only read-only tools run", async () => {
    const { host } = await setup();
    g.__script!.push(call(use("t1", "peek"), use("t2", "poke")), say("done"));
    const s = await host.sessions.open();
    await s.send(msg("go"));
    expect(results(s.state)).toEqual({ t1: [false, "peek ok"], t2: [true, NO_APPROVAL_REASON] });
    expect(g.__log).toEqual(["ran peek"]);
    await host.close();
  });

  test("with a gate plugin, the fallback steps aside", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "approval", provides: ["approval@1"] }, ALLOW_ALL));
    g.__script!.push(call(use("t1", "poke")), say("done"));
    const s = await host.sessions.open();
    await s.send(msg("go"));
    expect(results(s.state)).toEqual({ t1: [false, "poke ok"] });
    await host.close();
  });

  test("a gate from a plugin that is not the approval provider does not make the fallback step aside", async () => {
    // 其他插件的 gate 弃权时内核放行；兜底关卡只为 approval@1 的提供者让开
    const ABSTAIN = `export default { session(ctx) { ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: () => ({ decision: "abstain" }) }); } };`;
    const { host } = await setup((w) => w.plugin("bundled", { id: "repeats" }, ABSTAIN));
    g.__script!.push(call(use("t1", "poke")), say("done"));
    const s = await host.sessions.open();
    await s.send(msg("go"));
    expect(results(s.state).t1).toEqual([true, NO_APPROVAL_REASON]);
    await host.close();
  });

  test("a quarantined approval plugin falls back to denying writes, not allowing them", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "approval", provides: ["approval@1"] }, ALLOW_ALL));
    g.__script!.push(call(use("t1", "poke")), say("done"));
    const s = await host.sessions.open();
    await host.quarantine("approval", "test");
    await s.send(msg("go"));
    expect(results(s.state).t1).toEqual([true, NO_APPROVAL_REASON]);
    expect(info(host, "approval").state).toBe("quarantined");
    await host.close();
  });

  test("a quarantined plugin's tools return errors instead of running", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "approval", provides: ["approval@1"] }, ALLOW_ALL));
    g.__script!.push(call(use("t1", "peek")), say("done"));
    const s = await host.sessions.open();
    await host.quarantine("tools", "test");
    expect(g.__log).toEqual([`tools closed ${s.id}`]); // 它的会话作用域随隔离关闭
    await s.send(msg("go"));
    expect(results(s.state).t1![0]).toBe(true);
    expect(g.__log).toEqual([`tools closed ${s.id}`]); // 没有执行
    await host.close();
  });
});

test("a quarantined plugin's hooks stop running", async () => {
  const { host } = await setup((w) =>
    w.plugin("bundled", { id: "watcher" }, `export default { session(ctx) {
      ctx.kernel.hook({ kind: "observe", point: "event", fn: (e) => { globalThis.__log.push(e.type); } });
    } };`),
  );
  g.__script!.push(say("a"), say("b"));
  const s = await host.sessions.open();
  await s.send(msg("one"));
  expect(g.__log).toContain("turn.ended");
  await host.quarantine("watcher", "test");
  g.__log = [];
  await s.send(msg("two"));
  expect(g.__log).toEqual([]);
  await host.close();
});

describe("afterTurn and send", () => {
  test("a plugin continues once after the turn ends", async () => {
    const { host } = await setup((w) =>
      w.plugin("bundled", { id: "continue" }, `export default { session(ctx) {
        let done = false;
        ctx.kernel.hook({ kind: "observe", point: "event", fn: (e) => {
          if (e.type !== "turn.ended" || done) return;
          done = true;
          ctx.session.afterTurn(() => { globalThis.__log.push("after"); void ctx.session.send({ kind: "message", content: [{ kind: "text", text: "continue", origin: { by: "user" }, trust: "trusted" }] }); });
        } });
      } };`),
    );
    g.__script!.push(say("part 1"), say("part 2"));
    const s = await host.sessions.open();
    await s.send(msg("go"));
    await s.idle();
    const texts = s.state.messages.map((m) => m.content.map((b) => (b.kind === "text" ? b.text : "")).join(""));
    expect(texts).toEqual(["go", "part 1", "continue", "part 2"]);
    expect(g.__log).toEqual(["after"]);
    await host.close();
  });

  test("afterTurn registered in session() runs once the session is ready, with the resumed history in state()", async () => {
    const { host } = await setup((w) =>
      w.plugin("bundled", { id: "seed" }, `export default { session(ctx) {
        ctx.session.afterTurn(() => { globalThis.__log.push("messages " + ctx.session.state().messages.length); });
      } };`),
    );
    g.__script!.push(say("hi"));
    const s = await host.sessions.open();
    await s.idle();
    await s.send(msg("go"));
    await s.idle();
    const resumed = await host.sessions.open({ resume: s.id });
    await resumed.idle();
    expect(g.__log!.filter((x) => x.startsWith("messages "))).toEqual(["messages 0", "messages 2"]);
    await host.close();
  });

  test("a plugin stops the running turn", async () => {
    const { host } = await setup((w) =>
      w.plugin("bundled", { id: "stopper" }, `export default { session(ctx) {
        ctx.kernel.tool({ name: "stop", effect: "read", description: "stop", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
          async execute(_input, t) {
            ctx.session.abort("stop pressed in chat");
            await new Promise((r) => t.signal.aborted ? r() : t.signal.addEventListener("abort", r, { once: true }));
            return { content: "stopped" };
          } });
      } };`),
    );
    g.__script!.push(call(use("t1", "stop")), say("never reached"));
    const s = await host.sessions.open();
    await s.send(msg("go")).catch(() => {});
    const ended = (await s.history()).filter((e) => e.type === "turn.ended").map((e) => (e.data as { reason: string }).reason);
    expect(ended).toEqual(["aborted"]);
    expect(g.__script).toHaveLength(1);
    await host.close();
  });

  test("inputs sent while a turn runs are queued, not rejected as busy", async () => {
    const { host } = await setup();
    g.__script!.push(say("a"), say("b"));
    const s = await host.sessions.open();
    await Promise.all([s.send(msg("one")), s.send(msg("two"))]);
    expect(s.state.messages.length).toBe(4);
    await host.close();
  });

  test("an input sent right after the previous send resolves is still processed", async () => {
    // 前一条的处理循环已决定退出、还没清掉时排进来的输入，不能没人处理
    const { host } = await setup();
    g.__script!.push(say("a"), say("b"));
    const s = await host.sessions.open();
    await s.send(msg("one"));
    await s.send(msg("two"));
    expect(s.state.messages.length).toBe(4);
    await host.close();
  });

  test("recover takes its place in the queue instead of colliding with an input as busy", async () => {
    const { host } = await setup();
    g.__script!.push(say("one"), say("two"));
    const s = await host.sessions.open();
    const first = s.send(msg("first"));
    const recovered = s.recover();
    const second = s.send(msg("second"));
    await Promise.all([first, recovered, second]);
    expect(s.state.messages.length).toBe(4);
    await host.close();
  });
});

describe("waiting for approval", () => {
  // 审批插件：写操作要问（ask），自己不回答；测试经它的 ctx 交回答
  const ASK = `export default { process(ctx) { ctx.provide("approval@1", {}); }, session(ctx) {
    globalThis.__ctx = ctx;
    ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: (call) => ({ decision: call.tool.effect === "read" ? "allow" : "ask" }) });
    ctx.kernel.hook({ kind: "observe", point: "event", fn: (e) => { if (e.type === "turn.ended") ctx.session.afterTurn(() => { globalThis.__log.push("after"); }); } });
  } };`;
  const approval = (w: Awaited<ReturnType<typeof world>>) => w.plugin("bundled", { id: "approval", provides: ["approval@1"] }, ASK);
  const waiting = async (s: { state: State }) => {
    while (s.state.phase !== "awaiting") await Bun.sleep(1);
  };
  const ended = async (s: { history(): Promise<{ type: string; data: unknown }[]> }) =>
    (await s.history()).filter((e) => e.type === "turn.ended").map((e) => e.data as { reason: string; error?: string });

  test("the turn is not over while it waits: send resolves and afterTurn runs once the approval has let it finish", async () => {
    const { host } = await setup(approval);
    g.__script!.push(call(use("t1", "poke")), say("done"));
    const s = await host.sessions.open();
    let resolved = false;
    const turn = s.send(msg("go")).then(() => (resolved = true));
    await waiting(s);
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    expect(g.__log).toEqual([]);
    await g.__ctx!.session.send({ kind: "approval", toolUseId: "t1", approved: true });
    await turn;
    await s.idle();
    expect(results(s.state)).toEqual({ t1: [false, "poke ok"] });
    expect(g.__log).toEqual(["ran poke", "after"]);
    await host.close();
  });

  test("an approval for a call that is not waiting is rejected, and the turn keeps waiting", async () => {
    const { host } = await setup(approval);
    g.__script!.push(call(use("t1", "poke")), say("done"));
    const s = await host.sessions.open();
    const turn = s.send(msg("go"));
    await waiting(s);
    await expect(g.__ctx!.session.send({ kind: "approval", toolUseId: "nope", approved: true })).rejects.toThrow("no pending approval");
    expect(s.state.phase).toBe("awaiting");
    await g.__ctx!.session.send({ kind: "approval", toolUseId: "t1", approved: false, reason: "no" });
    await turn;
    expect(results(s.state)).toEqual({ t1: [true, "no"] });
    // 没有在跑的一轮时，审批的回答直接拒绝
    await expect(s.send({ kind: "approval", toolUseId: "t1", approved: true })).rejects.toThrow("no turn is waiting");
    await host.close();
  });

  test("aborting a turn that waits for approval ends it, and the next message runs", async () => {
    const { host } = await setup(approval);
    g.__script!.push(call(use("t1", "poke")), say("fine"));
    const s = await host.sessions.open();
    const turn = s.send(msg("go"));
    await waiting(s);
    s.abort(new Error("interrupted by user"));
    await expect(turn).rejects.toThrow("interrupted by user");
    expect(await ended(s)).toEqual([{ reason: "aborted", error: "interrupted by user" }]);
    expect(g.__log).not.toContain("ran poke");
    await s.send(msg("something else"));
    expect(s.state.phase).toBe("idle");
    expect(g.__script).toEqual([]);
    await host.close();
  });

  test("leaving a session that waits for approval ends the turn", async () => {
    const { host } = await setup(approval);
    g.__script!.push(call(use("t1", "poke")));
    const s = await host.sessions.open();
    const turn = s.send(msg("go")).catch((e: Error) => e.message);
    await waiting(s);
    await host.sessions.close();
    expect(await turn).toContain("was closed");
    expect((await ended(s)).map((e) => e.reason)).toEqual(["aborted"]);
    await host.close();
  });

  test("a session killed while it waited for approval waits again when resumed: plugins get the awaiting notice and can answer", async () => {
    // 订阅通知的审批插件：恢复后从 awaiting 通知和 ctx.session.state() 知道哪个调用在等
    const WATCH = `export default { process(ctx) { ctx.provide("approval@1", {}); }, session(ctx) {
      globalThis.__ctx = ctx;
      ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: (call) => ({ decision: call.tool.effect === "read" ? "allow" : "ask" }) });
      ctx.session.subscribe((n) => {
        if (n.type === "awaiting") globalThis.__log.push("awaiting " + n.toolUseIds.map((id) => ctx.session.state().batch.find((c) => c.toolUseId === id).name + ":" + id).join(","));
      });
    } };`;
    const { w, host } = await setup((x) => x.plugin("bundled", { id: "approval", provides: ["approval@1"] }, WATCH));
    g.__script!.push(call(use("t1", "poke")), say("done"));
    const s = await host.sessions.open();
    const first = s.send(msg("go")).catch(() => {});
    await waiting(s);
    // 进程被杀：日志停在等审批的地方。正常关闭会结束这一轮，所以先留一份日志，关掉之后放回去
    const logs = path.join(w.home, "sessions");
    await cp(logs, `${logs}.killed`, { recursive: true });
    await host.close();
    await first;
    await rm(logs, { recursive: true });
    await rename(`${logs}.killed`, logs);
    g.__log = [];

    const again = await w.start();
    const r = await again.sessions.open({ resume: s.id });
    expect(r.state.phase).toBe("awaiting");
    let done = false;
    const recovered = r.recover().then(() => (done = true));
    while (!g.__log!.includes("awaiting poke:t1")) await Bun.sleep(1);
    expect(done).toBe(false);
    await g.__ctx!.session.send({ kind: "approval", toolUseId: "t1", approved: true });
    await recovered;
    expect(results(r.state)).toEqual({ t1: [false, "poke ok"] });
    expect(g.__log).toEqual(["awaiting poke:t1", "ran poke"]);
    await again.close();
  });

  test("when a plugin asks but no approval plugin guards the session, the turn ends instead of waiting forever", async () => {
    const ASK_READS = `export default { session(ctx) { ctx.kernel.hook({ kind: "gate", point: "tool.gate", fn: () => ({ decision: "ask" }) }); } };`;
    const { host } = await setup((w) => w.plugin("bundled", { id: "careful" }, ASK_READS));
    g.__script!.push(call(use("t1", "peek")), say("never reached"));
    const s = await host.sessions.open();
    await expect(s.send(msg("go"))).rejects.toThrow(NO_APPROVER_ERROR);
    expect(await ended(s)).toEqual([{ reason: "aborted", error: NO_APPROVER_ERROR }]);
    expect(g.__log).toEqual([]);
    await host.close();
  });
});

describe("switching", () => {
  test("opening another session closes the old one's scopes, and the old one can be resumed", async () => {
    const { host } = await setup();
    g.__script!.push(say("hello"));
    const a = await host.sessions.open();
    await a.send(msg("first"));
    const b = await host.sessions.open();
    expect(host.sessions.current).toBe(b);
    expect(g.__log).toEqual([`tools closed ${a.id}`]);

    const again = await host.sessions.open({ resume: a.id });
    expect(again.id).toBe(a.id);
    expect(again.state.messages.length).toBe(2);
    expect(g.__log).toEqual([`tools closed ${a.id}`, `tools closed ${b.id}`]);
    await host.close();
  });

  test("switching away rejects inputs still queued on the old session instead of running them there", async () => {
    const { host } = await setup((w) =>
      w.plugin("bundled", { id: "waiter" }, `export default { session(ctx) {
        ctx.kernel.tool({ name: "wait", effect: "read", description: "wait", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
          async execute(_input, t) {
            globalThis.__log.push("waiting");
            await new Promise((r) => t.signal.aborted ? r() : t.signal.addEventListener("abort", r, { once: true }));
            return { content: "done" };
          } });
      } };`),
    );
    g.__script!.push(call(use("t1", "wait")), say("never reached"), say("never reached either"));
    const a = await host.sessions.open();
    const first = a.send(msg("one")).catch(() => "aborted");
    const queued = a.send(msg("two")).catch((e: Error) => e.message);
    while (!g.__log!.includes("waiting")) await new Promise((r) => setTimeout(r, 5));
    await host.sessions.open();
    expect(await first).toBe("aborted");
    expect(await queued).toContain("was closed");
    expect(g.__script).toHaveLength(2);
    expect(a.state.messages.some((m) => m.content.some((b) => b.kind === "text" && b.text === "two"))).toBe(false);
    await host.close();
  });

  test("a failed open rolls back the new session and keeps the old one", async () => {
    const { host } = await setup();
    const a = await host.sessions.open();
    await expect(host.sessions.open({ resume: "no-such-session" })).rejects.toThrow("not found");
    expect(host.sessions.current).toBe(a);
    // 新会话里 tools 插件的作用域已撤销；旧会话的还在
    expect(g.__log).toEqual(["tools closed no-such-session"]);
    await host.close();
  });

  test("without a model provider no session opens", async () => {
    const w = await world();
    const host = await w.start();
    await expect(host.sessions.open()).rejects.toThrow(ServiceUnavailable);
    await host.close();
  });

  test("a session ctx kept across a switch is stale", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "keeper" }, `export default { session(ctx) { globalThis.__ctx = ctx; } };`));
    await host.sessions.open();
    const old = g.__ctx!;
    await host.sessions.open();
    expect(() => old.session.send(msg("x"))).toThrow(StaleContext);
    await host.close();
  });
});

describe("sessions started side by side", () => {
  test("start does not replace the current session, and started sessions run turns at the same time", async () => {
    const { host } = await setup();
    const current = await host.sessions.open();
    const a = await host.sessions.start();
    const b = await host.sessions.start();
    expect(host.sessions.current).toBe(current);
    expect(new Set([current.id, a.id, b.id]).size).toBe(3);
    g.__script!.push(say("one"), say("two"));
    await Promise.all([a.send(msg("to a")), b.send(msg("to b"))]);
    expect(a.state.messages).toHaveLength(2);
    expect(b.state.messages).toHaveLength(2);
    expect(g.__log).toEqual([]);
    await host.close();
  });

  test("close leaves only that session, which can be resumed; host.close leaves the rest", async () => {
    const { host } = await setup();
    g.__script!.push(say("hello"));
    const a = await host.sessions.start();
    const b = await host.sessions.start();
    await a.send(msg("first"));
    await a.close();
    expect(g.__log).toEqual([`tools closed ${a.id}`]);
    await expect(a.send(msg("again"))).rejects.toThrow("was closed");

    const again = await host.sessions.start({ resume: a.id });
    expect(again.state.messages).toHaveLength(2);
    await host.close();
    expect(g.__log!.sort()).toEqual([`tools closed ${a.id}`, `tools closed ${a.id}`, `tools closed ${b.id}`].sort());
  });

  test("a session that is already open cannot be started again", async () => {
    const { host } = await setup();
    const current = await host.sessions.open();
    const a = await host.sessions.start();
    await expect(host.sessions.start({ resume: current.id })).rejects.toThrow("already open");
    await expect(host.sessions.start({ resume: a.id })).rejects.toThrow("already open");
    await host.close();
  });
});

describe("plugins that cannot join", () => {
  test("a throwing session() leaves that plugin out of the session only", async () => {
    const { w, host } = await setup((w) => w.plugin("bundled", { id: "grumpy" }, `export default { session() { throw new Error("nope"); } };`));
    g.__script!.push(call(use("t1", "peek")), say("done"));
    const s = await host.sessions.open();
    await s.send(msg("go"));
    expect(results(s.state).t1).toEqual([false, "peek ok"]);
    expect(w.reports.join("\n")).toContain(`plugin grumpy did not join session ${s.id}: nope`);
    expect(s.state.plugins.map((p) => p.id)).toEqual(["jade/core", "tools"]);
    await host.close();
  });

  test("a duplicate tool name leaves the later plugin out instead of failing the session", async () => {
    const { w, host } = await setup((w) =>
      w.plugin("user", { id: "copycat" }, `export default { session(ctx) {
        ctx.kernel.tool({ name: "peek", effect: "read", description: "x", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true, execute: async () => ({ content: "copy" }) });
      } };`),
    );
    const s = await host.sessions.open();
    expect(w.reports.join("\n")).toContain("plugin copycat did not join");
    expect(w.reports.join("\n")).toContain("tool peek is already registered by tools");
    expect(s.state.plugins.map((p) => p.id)).toEqual(["jade/core", "tools"]);
    await host.close();
  });

  test("hooks can only be registered while session() runs", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, `export default { session(ctx) { globalThis.__ctx = ctx; } };`));
    await host.sessions.open();
    const late = g.__ctx as unknown as { kernel: { hook(h: unknown): void } };
    expect(() => late.kernel.hook({})).toThrow("only be registered while session() runs");
    await host.close();
  });
});

describe("send called while session() runs", () => {
  // 插件在 session() 里就发一条消息（不 await），把 Promise 交出来
  const EAGER = `export default { session(ctx) {
    globalThis.__sent = ctx.session.send({ kind: "message", content: [{ kind: "text", text: "from the plugin", origin: { by: "user" }, trust: "trusted" }] });
    globalThis.__sent.catch(() => {});
  } };`;
  const sent = () => (globalThis as { __sent?: Promise<void> }).__sent!;

  test("waits until the session is built, then runs the turn", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "eager" }, EAGER));
    g.__script!.push(say("hello"));
    const s = await host.sessions.open();
    await sent();
    const texts = s.state.messages.map((m) => m.content.map((b) => (b.kind === "text" ? b.text : "")).join(""));
    expect(texts).toEqual(["from the plugin", "hello"]);
    await host.close();
  });

  test("is rejected when the session cannot be opened", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "eager" }, EAGER));
    await expect(host.sessions.open({ resume: "no-such-session" })).rejects.toThrow();
    await expect(sent()).rejects.toThrow("was closed before this input ran");
    expect(g.__script).toEqual([]);
    await host.close();
  });
});

describe("tools registered after session() returns", () => {
  // 插件把 ctx.kernel.tool 交出来，测试在会话开始之后调用
  const LATE = `export default { session(ctx) { globalThis.__late = (t) => ctx.kernel.tool(t); } };`;
  const tool = (name: string, effect = "read") => ({
    name, effect, description: name, inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
    execute: async () => ({ content: `${name} ok` }),
  });

  test("take effect from the next turn without opening a new session, and go away when unregistered", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, LATE));
    g.__tools = [];
    const s = await host.sessions.open();
    const seen: string[] = [];
    s.subscribe((n) => n.type === "event" && seen.push(n.event.type));
    g.__script!.push(say("one"));
    await s.send(msg("first"));
    const off = g.__late!(tool("fresh"));
    expect(s.tool("fresh")?.name).toBe("fresh");
    g.__script!.push(call(use("t1", "fresh")), say("two"));
    await s.send(msg("second"));
    expect(results(s.state).t1).toEqual([false, "fresh ok"]);
    off();
    off(); // 撤销两次无害
    g.__script!.push(say("three"));
    await s.send(msg("third"));
    expect(g.__tools).toEqual(["peek,poke", "fresh,peek,poke", "fresh,peek,poke", "peek,poke"]);
    // 同一个会话：对话都在，订阅没有因为重挂断掉，插件清单不算变化
    expect(s.state.messages.filter((m) => m.role === "user").length).toBe(4); // 三条消息 + 一条工具结果
    expect(seen).toContain("session.detached");
    expect(seen.filter((t) => t === "input.received").length).toBe(3);
    const types = (await s.history()).map((e) => e.type);
    expect(types).not.toContain("plugins.changed");
    expect(types.filter((t) => t === "session.detached").length).toBe(2);
    await host.close();
  });

  test("several changes between two turns remount once", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, LATE));
    const s = await host.sessions.open();
    g.__late!(tool("a"));
    g.__late!(tool("b"))();
    g.__late!(tool("c"));
    g.__tools = [];
    g.__script!.push(say("ok"));
    await s.send(msg("go"));
    expect(g.__tools).toEqual(["a,c,peek,poke"]);
    expect((await s.history()).filter((e) => e.type === "session.detached").length).toBe(1);
    await host.close();
  });

  test("a tool registered during a turn is offered from the next turn, not in the middle of this one", async () => {
    const LATE_IN_TOOL = `export default { session(ctx) {
      ctx.kernel.tool({ name: "grow", effect: "read", description: "grow", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
        async execute() { ctx.kernel.tool({ name: "grown", effect: "read", description: "grown", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true, execute: async () => ({ content: "grown ok" }) }); return { content: "grew" }; } });
    } };`;
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, LATE_IN_TOOL));
    g.__tools = [];
    const s = await host.sessions.open();
    g.__script!.push(call(use("t1", "grow")), call(use("t2", "grown")), say("done"));
    await s.send(msg("go"));
    // 这一轮里内核还不认识 grown
    expect(results(s.state).t2![0]).toBe(true);
    g.__script!.push(call(use("t3", "grown")), say("done"));
    await s.send(msg("again"));
    expect(results(s.state).t3).toEqual([false, "grown ok"]);
    expect(g.__tools).toEqual(["grow,peek,poke", "grow,peek,poke", "grow,peek,poke", "grow,grown,peek,poke", "grow,grown,peek,poke"]);
    await host.close();
  });

  test("a name that is already taken is refused when registered, so the session keeps working", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, LATE));
    const s = await host.sessions.open();
    expect(() => g.__late!(tool("peek"))).toThrow("tool peek is already registered by tools");
    g.__script!.push(say("ok"));
    await s.send(msg("go"));
    expect((await s.history()).some((e) => e.type === "session.detached")).toBe(false);
    await host.close();
  });

  test("a quarantined plugin's tools are no longer offered to the model", async () => {
    const { host } = await setup();
    g.__tools = [];
    const s = await host.sessions.open();
    await host.quarantine("tools", "test");
    g.__script!.push(say("ok"));
    await s.send(msg("go"));
    expect(g.__tools).toEqual([""]);
    expect(s.tool("peek")).toBeUndefined();
    await host.close();
  });

  test("when remounting fails, that input fails and the next one tries again", async () => {
    // 日志存储：globalThis.__failReads 大于 0 时读日志失败（resume 要读日志）
    const STORE = `export default { process(ctx) {
      const logs = new Map();
      ctx.provide("store@1", {
        async append(id, events) { logs.set(id, [...(logs.get(id) ?? []), ...structuredClone(events)]); },
        async *read(id, from = 1) {
          if (globalThis.__failReads > 0) { globalThis.__failReads--; throw new Error("disk on fire"); }
          for (const e of logs.get(id) ?? []) if (e.seq >= from) yield structuredClone(e);
        },
      });
    } };`;
    const { host } = await setup(async (w) => {
      await w.plugin("bundled", { id: "store", provides: ["store@1"] }, STORE);
      await w.plugin("bundled", { id: "late" }, LATE);
    });
    const s = await host.sessions.open();
    g.__late!(tool("fresh"));
    (globalThis as { __failReads?: number }).__failReads = 1;
    g.__tools = [];
    await expect(s.send(msg("lost"))).rejects.toThrow("could not update its tools: disk on fire");
    g.__script!.push(say("ok"));
    await s.send(msg("go"));
    expect(g.__tools).toEqual(["fresh,peek,poke"]);
    // 第一次 detach 已经写了，重试时不再写
    expect((await s.history()).filter((e) => e.type === "session.detached").length).toBe(1);
    delete (globalThis as { __failReads?: number }).__failReads;
    await host.close();
  });

  test("a session closed with changes pending still detaches and resumes normally", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, LATE));
    const s = await host.sessions.open();
    g.__late!(tool("fresh"));
    await host.sessions.close();
    expect(() => g.__late!(tool("other"))).toThrow(StaleContext);
    g.__tools = [];
    const again = await host.sessions.open({ resume: s.id });
    g.__script!.push(say("ok"));
    await again.send(msg("go"));
    expect(g.__tools).toEqual(["peek,poke"]); // fresh 是上个会话作用域里注册的，不带过来
    await host.close();
  });
});

describe("child sessions (ctx.session.spawn)", () => {
  type Ctx = {
    session: {
      id: string;
      parent?: { sessionId: string };
      depth: number;
      canSpawn: boolean;
      spawn(o: unknown): Promise<{ id: string; close(): Promise<{ sessionId: string; seq: number }>; state: State }>;
      tool(name: string): unknown;
      abort(reason?: string): void;
    };
    status?: unknown;
    service(name: string): { select(r: { title: string; options: { label: string; value: string }[] }): Promise<string | undefined> } | undefined;
  };
  type Kid = Awaited<ReturnType<Ctx["session"]["spawn"]>>;
  const k = globalThis as {
    __run?: (ctx: Ctx, t: { parent: { sessionId: string; eventId: string }; signal: AbortSignal }) => Promise<unknown>;
    __kids?: Ctx[];
    __select?: (r: { title: string }) => Promise<string | undefined>;
    __join?: () => Promise<void>;
  };
  afterEach(() => {
    delete k.__run;
    delete k.__kids;
    delete k.__select;
    delete k.__join;
  });
  // 主会话里的 run 工具交给测试的 __run 执行；子会话里记下插件的 ctx
  const SPAWNER = `export default { session(ctx) {
    if (ctx.session.parent) { (globalThis.__kids ??= []).push(ctx); return globalThis.__join?.(); }
    ctx.kernel.tool({ name: "run", effect: "read", description: "run", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
      async execute(input, t) { const r = await globalThis.__run(ctx, t); return r ?? { content: "ran" }; } });
  } };`;
  // 前端：select 交给测试的 __select
  const FRONT = `export default { process(ctx) {
    ctx.provide("ui@1", { interactive: true, notify() {}, select: (r) => globalThis.__select(r), input: async () => undefined,
      session: () => ({ status() {}, dispose() {} }) });
  } };`;
  const start = async (config?: object) => {
    const w = await world();
    await w.plugin("bundled", { id: "models", provides: ["provider@1"] }, PROVIDER);
    await w.plugin("bundled", { id: "tools" }, TOOLS);
    await w.plugin("bundled", { id: "front", provides: ["ui@1"] }, FRONT);
    await w.plugin("bundled", { id: "spawner", optional: ["ui@1"] }, SPAWNER);
    if (config) await Bun.write(path.join(w.home, "config.json"), JSON.stringify(config));
    return { w, host: await w.start() };
  };
  const run = async (host: Awaited<ReturnType<typeof start>>["host"]) => {
    g.__script!.push(call(use("t1", "run")), say("done"));
    const s = await host.sessions.open();
    await s.send(msg("go"));
    return s;
  };

  test("a child session is logged with its parent, gets every plugin but no session UI, and keeps only the tools asked for", async () => {
    const { host } = await start();
    let ref: { sessionId: string; seq: number } | undefined;
    k.__run = async (ctx, t) => {
      const kid = await ctx.session.spawn({ parent: t.parent, label: "look", tools: (tool: { effect: string }) => tool.effect === "read" });
      const c = k.__kids![0]!;
      expect(c.session.parent).toEqual(t.parent);
      expect(c.session.depth).toBe(1);
      // 默认上限 1 层：子会话不能再开
      expect(c.session.canSpawn).toBe(false);
      await expect(c.session.spawn({ parent: { sessionId: c.session.id, eventId: "x" } })).rejects.toThrow("nested at most 1 level");
      expect(c.status).toBeUndefined();
      expect(c.session.tool("peek")).toBeDefined();
      expect(c.session.tool("poke")).toBeUndefined();
      expect(kid.state.parent).toEqual(t.parent);
      ref = await kid.close();
      return { content: "ran", child: ref };
    };
    const s = await run(host);
    expect(results(s.state).t1).toEqual([false, "ran"]);
    const done = (await s.history()).find((e) => e.type === "tool.completed")!;
    expect((done.data as { child?: unknown }).child).toEqual(ref);
    expect(g.__log).toContain(`tools closed ${ref!.sessionId}`); // 子会话的插件作用域关了
    expect(host.sessions.current).toBe(s);
    await host.close();
  });

  test("spawn needs a tool call of this session as parent", async () => {
    const { host } = await start();
    k.__run = async (ctx) => {
      await expect(ctx.session.spawn({ parent: { sessionId: "elsewhere", eventId: "e" } })).rejects.toThrow("ToolContext.parent");
      await expect(ctx.session.spawn({})).rejects.toThrow("ToolContext.parent");
    };
    await run(host);
    await host.close();
  });

  test("sub-agents can be turned off, or allowed to nest deeper", async () => {
    const off = await start({ "jade/core": { maxDepth: 0 } });
    k.__run = async (ctx, t) => {
      expect(ctx.session.canSpawn).toBe(false);
      await expect(ctx.session.spawn({ parent: t.parent })).rejects.toThrow("turned off");
    };
    await run(off.host);
    await off.host.close();

    const deep = await start({ "jade/core": { maxDepth: 2 } });
    k.__run = async (ctx, t) => {
      const kid = await ctx.session.spawn({ parent: t.parent });
      expect(k.__kids![0]!.session.canSpawn).toBe(true);
      await kid.close();
    };
    await run(deep.host);
    await deep.host.close();
  });

  test("beyond maxActive, spawn waits for a running child to end", async () => {
    const { host } = await start({ "jade/core": { maxActive: 1 } });
    k.__run = async (ctx, t) => {
      const first = await ctx.session.spawn({ parent: t.parent });
      let second: Kid | undefined;
      const waiting = ctx.session.spawn({ parent: t.parent }).then((x) => (second = x));
      await new Promise((r) => setTimeout(r, 50));
      expect(second).toBeUndefined();
      await first.close();
      await waiting;
      expect(second).toBeDefined();
      await second!.close();
    };
    await run(host);
    await host.close();
  });

  test("a spawn waiting for a slot stops when its signal aborts; a sub-agent does not wait for one", async () => {
    const { host } = await start({ "jade/core": { maxActive: 1, maxDepth: 2 } });
    k.__run = async (ctx, t) => {
      const first = await ctx.session.spawn({ parent: t.parent });
      const stop = new AbortController();
      const waiting = ctx.session.spawn({ parent: t.parent, signal: stop.signal });
      stop.abort(new Error("esc pressed"));
      await expect(waiting).rejects.toThrow("esc pressed");
      // 子会话占着唯一的名额：它再开不等（等下去谁都等不到），直接报错
      const kid = k.__kids![0]!;
      await expect(kid.session.spawn({ parent: { sessionId: kid.session.id, eventId: "x" } })).rejects.toThrow("cannot wait for a slot");
      await first.close();
      // 不再等的那次没有占着名额
      const second = await ctx.session.spawn({ parent: t.parent });
      await second.close();
    };
    await run(host);
    await host.close();
  });

  test("a child still starting when its parent is left is ended, and its slot is freed", async () => {
    const { host } = await start({ "jade/core": { maxActive: 1 } });
    let joined!: () => void;
    k.__join = () => new Promise<void>((r) => (joined = r));
    let spawned: Promise<unknown> | undefined;
    k.__run = async (ctx, t) => {
      spawned = ctx.session.spawn({ parent: t.parent });
      spawned.catch(() => {});
      await new Promise((r) => t.signal.addEventListener("abort", r, { once: true }));
      throw t.signal.reason;
    };
    g.__script!.push(call(use("t1", "run")));
    const s = await host.sessions.open();
    const sent = s.send(msg("go")).catch(() => {});
    while (!k.__kids?.length) await new Promise((r) => setTimeout(r, 10));
    await host.sessions.close();
    await sent;
    delete k.__join;
    joined();
    await expect(spawned).rejects.toThrow("was closed");
    expect(g.__log).toContain(`tools closed ${k.__kids![0]!.session.id}`);
    k.__run = async (ctx, t) => {
      const kid = await ctx.session.spawn({ parent: t.parent });
      await kid.close();
    };
    await run(host);
    await host.close();
  });

  test("stopping a child session's turn on the user's behalf stops the top-level turn too", async () => {
    const { host } = await start();
    k.__run = async (ctx, t) => {
      const kid = await ctx.session.spawn({ parent: t.parent });
      k.__kids![0]!.session.abort("the user cancelled the approval request");
      expect(t.signal.aborted).toBe(true);
      await kid.close();
      throw t.signal.reason;
    };
    g.__script!.push(call(use("t1", "run")), say("never reached"));
    const s = await host.sessions.open();
    await s.send(msg("go")).catch(() => {});
    const ended = (await s.history()).filter((e) => e.type === "turn.ended").map((e) => (e.data as { reason: string }).reason);
    expect(ended).toEqual(["aborted"]);
    expect(g.__script).toHaveLength(1);
    await host.close();
  });

  test("dialogs from child sessions are asked one at a time, titled with the child's label", async () => {
    const { host } = await start();
    const shown: string[] = [];
    let open = 0;
    let most = 0;
    k.__select = async (r) => {
      shown.push(r.title);
      most = Math.max(most, ++open);
      await new Promise((x) => setTimeout(x, 20));
      open--;
      return "yes";
    };
    k.__run = async (ctx, t) => {
      const kids = await Promise.all(["one", "two"].map((label) => ctx.session.spawn({ parent: t.parent, label })));
      const ask = (c: Ctx) => c.service("ui@1")!.select({ title: "Allow it?", options: [{ label: "Yes", value: "yes" }] });
      expect(await Promise.all(k.__kids!.map(ask))).toEqual(["yes", "yes"]);
      for (const kid of kids) await kid.close();
    };
    await run(host);
    expect(shown.sort()).toEqual(["[one] Allow it?", "[two] Allow it?"]);
    expect(most).toBe(1);
    await host.close();
  });

  test("when the parent session is left, its child sessions are ended and the waiting tool call stops", async () => {
    const { w, host } = await start();
    let kid: Kid | undefined;
    k.__run = async (ctx, t) => {
      kid = await ctx.session.spawn({ parent: t.parent });
      await new Promise((r) => t.signal.addEventListener("abort", r, { once: true }));
      throw t.signal.reason;
    };
    g.__script!.push(call(use("t1", "run")));
    const s = await host.sessions.open();
    const sent = s.send(msg("go")).catch(() => {});
    while (!kid) await new Promise((r) => setTimeout(r, 10));
    await host.sessions.close();
    await sent;
    expect(kid.state.phase).toBe("ended");
    expect(g.__log).toContain(`tools closed ${kid.id}`);
    expect(w.reports.join("\n")).not.toContain("could not end it");
    await host.close();
  });
});
