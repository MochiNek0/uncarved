// 生命周期矩阵：启动、/clear、/resume 失败、/resume 成功、reload、reload 改为新会话、退出、启动失败。
// 每条路径都用真的 createJade、真的 Runtime 和一个真的插件，断言：
//   工厂调用了几次、哪一套被中止（ctx.signal）、会话收尾和 dispose 的先后、dispose 在后台进行、
//   状态栏显示的是哪一套设置的、过期的 ctx 调用是否被拒绝并提示。
// 见 docs/design/jade-plugin-lifecycle.md 第 5、8 节。

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, MemoryTrustStore, Runtime, type Provider } from "uncarved";
import { createJade, loadPlugin } from "../src/index.ts";
import { SessionLifecycle, type LifecycleDeps } from "../src/session-lifecycle.ts";
import { SessionScope, type ScopeHost } from "../src/session-scope.ts";

/** 插件把发生的事记在这里：第几套实例被创建、中止、会话收尾、dispose */
interface Probe {
  n: number;
  log: string[];
  ctx: Record<number, { status(t: string | undefined): void; input?: { insert(t: string): void } }>;
  /** 设置后，dispose 等它 resolve 才完成：用来看 dispose 是不是在后台 */
  hold?: Promise<void>;
}
const g = globalThis as { __jadeLifecycle?: Probe };

const PLUGIN = `export default (ctx) => {
  const probe = globalThis.__jadeLifecycle;
  const n = ++probe.n;
  probe.log.push("create #" + n);
  probe.ctx[n] = ctx;
  ctx.status("#" + n);
  ctx.signal.addEventListener("abort", () => probe.log.push("abort #" + n + ": " + ctx.signal.reason.message));
  return ctx.definePlugin({
    hooks: [{ kind: "observe", point: "event", fn: (e) => void (e.type === "session.detached" && probe.log.push("detached #" + n)) }],
    dispose: async () => {
      await probe.hold;
      probe.log.push("dispose #" + n);
    },
  });
};
`;

async function setup() {
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-lifecycle-")));
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-lifecycle-home-")));
  const dir = path.join(home, "plugins", "probe");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "me/probe", version: "1.0.0" }));
  await writeFile(path.join(dir, "index.js"), PLUGIN);
  const loaded = await loadPlugin({ name: "probe", dir, layer: "user" }, { trust: new MemoryTrustStore(), confirm: async () => false });

  const probe: Probe = { n: 0, log: [], ctx: {} };
  g.__jadeLifecycle = probe;
  const store = new MemoryLogStore();
  const provider: Provider = { id: "none", complete: () => Promise.reject(new Error("unused")) };
  const ui = { status: [] as string[], typed: [] as string[], warnings: [] as string[], errors: [] as string[] };
  const host: ScopeHost = {
    showStatus: (segments) => void (ui.status = segments.map((s) => `${s.plugin}=${s.text}`)),
    input: { text: () => "", insert: (t) => void ui.typed.push(t), set: (t) => void ui.typed.push(t) },
    warn: (w) => void ui.warnings.push(w),
  };
  /** 让下一次恢复会话失败（只影响带 id 的 open） */
  const failing = { resume: false };
  const deps: LifecycleDeps<string> = {
    prepare: async () => {
      const scope = new SessionScope(host);
      scope.attach(await createJade({ cwd, home, store, provider, env: {}, extensions: [loaded], ...scope.hooks }));
      return scope;
    },
    open: async (plugins, id) => {
      if (id && failing.resume) throw new Error(`cannot resume ${id}`);
      return id ? Runtime.resume({ store, provider, plugins, sessionId: id }) : Runtime.create({ store, provider, plugins });
    },
    discard: async () => false,
    warn: (list) => void ui.warnings.push(...list),
    error: (err) => void ui.errors.push(String(err)),
  };
  /** 取走到现在为止的记录 */
  const take = () => probe.log.splice(0);
  return { probe, ui, deps, failing, take };
}

afterEach(() => {
  delete g.__jadeLifecycle;
});

const STALE = (what: string) => `plugin me/probe used ${what} after its session ended, so it was ignored; stop timers and listeners in dispose, or when ctx.signal aborts`;

describe("session lifecycle matrix", () => {
  test("start → /clear → /resume (fails) → /resume → reload → reload (new session) → exit", async () => {
    const { probe, ui, deps, failing, take } = await setup();

    // ---------- 启动：先创建（preparing，状态先存着），begin 之后才激活 ----------
    const sessions = await SessionLifecycle.prepare(deps);
    expect(take()).toEqual(["create #1"]);
    expect(ui.status).toEqual([]);
    const first = (await sessions.begin()).sessionId;
    expect(sessions.scope.state).toBe("active");
    expect(ui.status).toEqual(["me/probe=#1"]);
    probe.ctx[1]!.input!.insert("one");
    expect(ui.typed).toEqual(["one"]);

    // ---------- /clear：新的一套先创建；旧的先中止，再会话收尾，dispose 在后台 ----------
    let release!: () => void;
    probe.hold = new Promise((r) => (release = r));
    const cleared = await sessions.switchTo(undefined, undefined);
    expect(cleared).toEqual({ previous: first, kept: true });
    expect(take()).toEqual(["create #2", "abort #1: the session ended", "detached #1"]);
    // switchTo 返回时旧的一套还在 dispose：新会话不用等它
    expect(sessions.scope.state).toBe("active");
    const second = sessions.current.sessionId;
    expect(second).not.toBe(first);
    expect(ui.status).toEqual(["me/probe=#2"]);
    // 旧的一套 dispose 之前（closing）：它的调用不生效，也不提示（定时器在 dispose 里才停）
    probe.ctx[1]!.status("late");
    expect(ui.status).toEqual(["me/probe=#2"]);
    release();
    probe.hold = undefined;
    await sessions.settled();
    expect(take()).toEqual(["dispose #1"]);
    // dispose 之后还调用：插件漏了，提示一次
    probe.ctx[1]!.status("later");
    probe.ctx[1]!.input!.insert("ghost");
    expect(ui.status).toEqual(["me/probe=#2"]);
    expect(ui.typed).toEqual(["one"]);
    expect(ui.warnings).toEqual([STALE("ctx.status")]);
    ui.warnings.length = 0;

    // ---------- /resume 失败：只收掉新的一套，当前的一套照常（没被中止，状态栏不变，ctx 还生效） ----------
    await expect(sessions.switchTo("no-such-session", undefined)).rejects.toThrow();
    expect(take()).toEqual(["create #3", "abort #3: the session ended", "dispose #3"]);
    expect(sessions.current.sessionId).toBe(second);
    expect(sessions.scope.signal.aborted).toBe(false);
    expect(ui.status).toEqual(["me/probe=#2"]);
    probe.ctx[2]!.status("#2 again");
    expect(ui.status).toEqual(["me/probe=#2 again"]);
    // 回滚的一套从没激活：它在准备时设的状态从没显示过；回滚后它的调用照样提示
    probe.ctx[3]!.status("never");
    expect(ui.status).toEqual(["me/probe=#2 again"]);
    expect(ui.warnings).toEqual([STALE("ctx.status")]);
    ui.warnings.length = 0;

    // ---------- /resume 成功：回到第一个会话 ----------
    const resumed = await sessions.switchTo(first, undefined);
    expect(resumed).toEqual({ previous: second, kept: true });
    await sessions.settled();
    expect(take()).toEqual(["create #4", "abort #2: the session ended", "detached #2", "dispose #2"]);
    expect(sessions.current.sessionId).toBe(first);
    expect(ui.status).toEqual(["me/probe=#4"]);

    // ---------- reload：同一个会话，新的一套 ----------
    expect(await sessions.reload(undefined)).toEqual({});
    await sessions.settled();
    expect(take()).toEqual(["create #5", "abort #4: the session was reloaded", "detached #4", "dispose #4"]);
    expect(sessions.current.sessionId).toBe(first);
    expect(ui.status).toEqual(["me/probe=#5"]);

    // ---------- reload 时恢复不了：改为开始新会话，返回那个错误 ----------
    failing.resume = true;
    const { error } = await sessions.reload(undefined);
    failing.resume = false;
    expect(String(error)).toContain(`cannot resume ${first}`);
    await sessions.settled();
    expect(take()).toEqual(["create #6", "abort #5: the session was reloaded", "detached #5", "dispose #5"]);
    expect(sessions.current.sessionId).not.toBe(first);
    expect(ui.status).toEqual(["me/probe=#6"]);

    // ---------- 退出：离开会话，等 dispose 完成 ----------
    expect(await sessions.leave()).toBe(true);
    await sessions.settled();
    expect(take()).toEqual(["abort #6: the session ended", "detached #6", "dispose #6"]);

    // 整个过程：每套实例创建一次、dispose 一次；除了上面故意触发的，没有别的提示和错误
    expect(probe.n).toBe(6);
    expect(ui.warnings).toEqual([]);
    expect(ui.errors).toEqual([]);
  }, 30_000);

  test("start fails: the first set of plugins is disposed and the error is thrown", async () => {
    const { deps, take, failing } = await setup();
    failing.resume = true;
    const sessions = await SessionLifecycle.prepare(deps);
    await expect(sessions.begin("some-session")).rejects.toThrow("cannot resume some-session");
    expect(take()).toEqual(["create #1", "abort #1: the session ended", "dispose #1"]);
    expect(() => sessions.current).toThrow("the session has not begun");
  });

  test("switching to the current session is refused before any plugin is created", async () => {
    const { ui, deps, take } = await setup();
    const sessions = await SessionLifecycle.prepare(deps);
    const id = (await sessions.begin()).sessionId;
    take();
    // 插件经 session.resume 直接要当前会话：不创建新的一套，当前会话不受影响（没中止、没收尾）
    await expect(sessions.switchTo(id, undefined)).rejects.toThrow(`${id} is the current session`);
    expect(take()).toEqual([]);
    expect(sessions.current.sessionId).toBe(id);
    expect(sessions.scope.state).toBe("active");
    expect(ui.status).toEqual(["me/probe=#1"]);
    await sessions.leave();
    await sessions.settled();
    expect(ui.warnings).toEqual([]);
    expect(ui.errors).toEqual([]);
  });
});
