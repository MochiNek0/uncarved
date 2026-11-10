import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Block, ModelResponse, State } from "uncarved";
import { NO_APPROVAL_REASON, ServiceUnavailable, StaleContext } from "../src/index.ts";
import { info, world } from "./helpers.ts";

type Step = Omit<ModelResponse, "model">;
const g = globalThis as { __script?: Step[]; __log?: string[]; __ctx?: { session: { send(i: unknown): Promise<void>; abort(reason?: string): void } } };
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
});

// 模型：按 globalThis.__script 依次回复
const PROVIDER = `export default { process(ctx) {
  ctx.provide("provider@1", {
    id: "scripted",
    async complete(req) {
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

  test("tools can only be registered while session() runs", async () => {
    const { host } = await setup((w) => w.plugin("bundled", { id: "late" }, `export default { session(ctx) { globalThis.__ctx = ctx; } };`));
    await host.sessions.open();
    const late = g.__ctx as unknown as { kernel: { tool(t: unknown): void } };
    expect(() => late.kernel.tool({})).toThrow("only be registered while session() runs");
    await host.close();
  });
});
