import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, MemoryTrustStore, type Provider } from "uncarved";
import { createJade, loadPlugin, type Jade } from "../src/index.ts";
import { SessionScope, type ScopeHost } from "../src/session-scope.ts";

/** 记下作用域对界面做了什么 */
function fakeHost() {
  const shown: string[][] = [];
  const warnings: string[] = [];
  const typed: string[] = [];
  const sent: [string, string][] = [];
  let draft = "draft";
  const host: ScopeHost = {
    showStatus: (segments) => void shown.push(segments.map((s) => `${s.plugin}=${s.text}`)),
    input: {
      text: () => draft,
      insert: (t) => void typed.push(`insert ${t}`),
      set: (t) => void ((draft = t), typed.push(`set ${t}`)),
      hint: (t) => void typed.push(`hint ${t}`),
    },
    send: (plugin, text) => void sent.push([plugin, text]),
    warn: (w) => void warnings.push(w),
  };
  return { host, shown, warnings, typed, sent, last: () => shown.at(-1) };
}

/** 只有 dispose 的假 Jade */
function fakeJade(log: string[], name: string): Jade {
  return { dispose: async () => (log.push(`dispose ${name}`), [`${name} warned`]) } as unknown as Jade;
}

describe("session scope", () => {
  test("while preparing, status waits for activate and input/send are ignored with one warning", () => {
    const ui = fakeHost();
    const scope = new SessionScope(ui.host);
    const { onStatus, input, send } = scope.hooks;
    onStatus("me/clock", "12:00");
    onStatus("me/ci", "  CI   ok ");
    expect(ui.shown).toEqual([]);
    input!.insert("x", "me/voice");
    input!.set("y", "me/voice");
    input!.hint("z", "me/voice");
    send!("me/voice", "go");
    expect(input!.text("me/voice")).toBe("");
    expect(ui.typed).toEqual([]);
    expect(ui.sent).toEqual([]);
    expect(ui.warnings).toEqual(["plugin me/voice used ctx.input before its session started, so it was ignored"]);

    scope.activate();
    expect(scope.state).toBe("active");
    expect(ui.last()).toEqual(["me/clock=12:00", "me/ci=CI   ok"]);
    onStatus("me/clock", "12:01");
    onStatus("me/ci", undefined);
    expect(ui.last()).toEqual(["me/clock=12:01"]);
    input!.insert("x", "me/voice");
    input!.hint("next", "me/voice");
    input!.hint(undefined, "me/voice");
    send!("me/voice", "go");
    expect(input!.text("me/voice")).toBe("draft");
    expect(ui.typed).toEqual(["insert x", "hint next", "hint undefined"]);
    expect(ui.sent).toEqual([["me/voice", "go"]]);
    expect(() => scope.activate()).toThrow("cannot activate the session scope: it is active");
  });

  test("closing aborts the signal and ignores ctx calls; after dispose they are warned about once per plugin, but clearing status is fine", async () => {
    const ui = fakeHost();
    const log: string[] = [];
    const scope = new SessionScope(ui.host);
    scope.attach(fakeJade(log, "a"));
    scope.activate();
    const { onStatus, input, send } = scope.hooks;
    onStatus("me/clock", "12:00");
    const shownBefore = ui.shown.length;

    scope.close("the session ended");
    expect(scope.state).toBe("closing");
    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as Error).message).toBe("the session ended");
    // 还没轮到 dispose（会话收尾还在进行）：定时器再触发一次是正常的，不显示也不提示
    onStatus("me/clock", "12:01");
    input!.set("early", "me/voice");
    expect(ui.warnings).toEqual([]);

    // dispose 只执行一次
    const first = scope.dispose();
    expect(await first).toEqual(["a warned"]);
    expect(await scope.dispose()).toEqual(["a warned"]);
    expect(log).toEqual(["dispose a"]);
    expect(scope.state).toBe("closed");

    // dispose 之后还在调用：插件忘了停掉定时器，提示一次
    onStatus("me/clock", "12:02");
    onStatus("me/clock", "12:03");
    // 去掉自己的段落：不提示
    onStatus("me/tidy", undefined);
    input!.set("late", "me/voice");
    send!("me/voice", "late");
    expect(ui.shown.length).toBe(shownBefore);
    expect(ui.typed).toEqual([]);
    expect(ui.sent).toEqual([]);
    expect(ui.warnings).toEqual([
      "plugin me/clock used ctx.status after its session ended, so it was ignored; stop timers and listeners in dispose, or when ctx.signal aborts",
      "plugin me/voice used ctx.input after its session ended, so it was ignored; stop timers and listeners in dispose, or when ctx.signal aborts",
    ]);
  });

  test("a switch is a transaction: rolling back leaves the current scope alone; committing hands the status bar over", async () => {
    const ui = fakeHost();
    const log: string[] = [];
    const current = new SessionScope(ui.host);
    current.attach(fakeJade(log, "current"));
    current.activate();
    current.hooks.onStatus("me/clock", "old");

    // /resume 失败：新的一套在准备时设了状态，回滚时它从没显示过，当前的一套照常工作
    const failed = new SessionScope(ui.host);
    failed.hooks.onStatus("me/clock", "never shown");
    failed.attach(fakeJade(log, "failed"));
    await failed.dispose();
    expect(ui.last()).toEqual(["me/clock=old"]);
    current.hooks.onStatus("me/clock", "still old");
    expect(ui.last()).toEqual(["me/clock=still old"]);
    expect(current.signal.aborted).toBe(false);
    expect(ui.warnings).toEqual([]);

    // /clear 成功：关掉当前的，激活新的
    const next = new SessionScope(ui.host);
    next.hooks.onStatus("me/clock", "new");
    next.attach(fakeJade(log, "next"));
    current.close("the session ended");
    next.activate();
    expect(ui.last()).toEqual(["me/clock=new"]);
    current.hooks.onStatus("me/clock", "stale");
    expect(ui.last()).toEqual(["me/clock=new"]);
    await current.dispose();
    expect(ui.warnings).toEqual([]);
    expect(log).toEqual(["dispose failed", "dispose current"]);
  });

  test("real plugins: ctx.signal aborts when their scope closes, and their stale ctx calls name them", async () => {
    const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-scope-")));
    const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-scope-home-")));
    const dir = path.join(home, "plugins", "clock");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "me/clock", version: "1.0.0" }));
    await writeFile(
      path.join(dir, "index.js"),
      `export default (ctx) => {
  ctx.status("starting");
  globalThis.__jadeScopeCtx = ctx;
  ctx.signal.addEventListener("abort", () => (globalThis.__jadeScopeAborted = ctx.signal.reason.message));
  return ctx.definePlugin({});
};
`,
    );
    const loaded = await loadPlugin({ name: "clock", dir, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => false });
    const provider: Provider = { id: "none", complete: () => Promise.reject(new Error("unused")) };
    const ui = fakeHost();
    const scope = new SessionScope(ui.host);
    scope.attach(await createJade({ cwd, home, store: new MemoryLogStore(), provider, env: {}, extensions: [loaded], ...scope.hooks }));
    const g = globalThis as { __jadeScopeCtx?: { status(t: string): void; input?: { insert(t: string): void } }; __jadeScopeAborted?: string };
    try {
      expect(ui.shown).toEqual([]);
      scope.activate();
      expect(ui.last()).toEqual(["me/clock=starting"]);
      g.__jadeScopeCtx!.input!.insert("hi");
      expect(ui.typed).toEqual(["insert hi"]);

      scope.close("the session was reloaded");
      expect(g.__jadeScopeAborted).toBe("the session was reloaded");
      expect(await scope.dispose()).toEqual([]);
      g.__jadeScopeCtx!.status("tick");
      expect(ui.warnings).toEqual([expect.stringContaining("plugin me/clock used ctx.status after its session ended")]);
    } finally {
      scope.jade.shutdown();
      delete g.__jadeScopeCtx;
      delete g.__jadeScopeAborted;
    }
  });
});
