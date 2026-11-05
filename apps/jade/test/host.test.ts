import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FAULT_LIMIT, PluginError, PluginHost, pluginsCommand, ServiceUnavailable, StaleContext } from "../src/index.ts";
import { info, world } from "./helpers.ts";

// 一个注册表服务：别的插件往里注册回调，它负责调用；调用方关闭时撤销它注册的东西
const REGISTRY = `export default { process(ctx) {
  const items = new Map();
  ctx.provide("registry@1", (caller) => ({
    register(name, fn) { items.set(name, fn); caller.onDispose(() => items.delete(name)); },
    run(name, arg) { const fn = items.get(name); if (!fn) throw new Error("no " + name); return fn(arg); },
    names() { return [...items.keys()]; },
  }));
} };`;

describe("activation", () => {
  test("services work across plugins, and callbacks run as their owner", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "reg", provides: ["registry@1"] }, REGISTRY);
    await w.plugin("user", { id: "greet", requires: ["registry@1"] }, `export default { process(ctx) {
      const reg = ctx.require("registry@1");
      reg.register("hello", (who) => "hello " + who);
      reg.register("boom", () => { throw new Error("bad callback"); });
    } };`);
    const host = await PluginHost.start({ roots: w.roots, home: w.home });
    const reg = host.service<{ run(n: string, a?: unknown): unknown; names(): string[] }>("registry@1")!;
    expect(reg.run("hello", "jade")).toBe("hello jade");
    // 回调出错：归注册它的插件，交给调用方处理，不隔离谁
    let err: unknown;
    try {
      reg.run("boom");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginError);
    expect((err as PluginError).plugin).toBe("greet");
    expect(info(host, "greet").state).toBe("active");
    await host.close();
  });

  test("a failing activation is rolled back and its dependents are skipped with the reason", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "reg", provides: ["registry@1"] }, REGISTRY);
    await w.plugin("user", { id: "half", provides: ["half@1"], requires: ["registry@1"] }, `export default { process(ctx) {
      ctx.require("registry@1").register("left-behind", () => 1);
      ctx.provide("half@1", {});
      throw new Error("oops");
    } };`);
    await w.plugin("user", { id: "needs-half", requires: ["half@1"] }, `export default {};`);
    const host = await w.start();
    expect(info(host, "half")).toMatchObject({ state: "failed", reason: "oops" });
    expect(info(host, "needs-half")).toMatchObject({ state: "skipped", reason: "requires half@1: its provider half failed to activate" });
    // 注册的东西撤销了，服务也没留下
    expect(host.service<{ names(): string[] }>("registry@1")!.names()).toEqual([]);
    expect(host.service("half@1")).toBeUndefined();
    expect(w.reports.join("\n")).toContain("plugin half failed to activate: oops");
    await host.close();
  });

  test("a plugin must provide every service it declares", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "liar", provides: ["x@1"] }, `export default { process() {} };`);
    const host = await w.start();
    expect(info(host, "liar")).toMatchObject({ state: "failed", reason: "declares x@1 in provides but did not provide it" });
    await host.close();
  });

  test("undeclared services cannot be used", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "reg", provides: ["registry@1"] }, REGISTRY);
    await w.plugin("bundled", { id: "sneaky" }, `export default { process(ctx) { ctx.service("registry@1"); } };`);
    const host = await w.start();
    expect(info(host, "sneaky").reason).toContain("registry@1 is not declared in plugin.json");
    await host.close();
  });

  test("entries outside the plugin directory and bad modules fail without stopping the others", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "escape", entry: "../x.mjs" }, "");
    await w.plugin("bundled", { id: "throws-on-import" }, `throw new Error("top level");`);
    await w.plugin("bundled", { id: "ok" }, `export default {};`);
    const host = await w.start();
    expect(info(host, "escape").reason).toContain("outside the plugin directory");
    expect(info(host, "throws-on-import")).toMatchObject({ state: "failed", reason: "top level" });
    expect(info(host, "ok").state).toBe("active");
    await host.close();
  });

  test("effects are cleaned up in reverse order on close", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "fx" }, `export const log = []; export default { async process(ctx) {
      await ctx.effect(() => () => globalThis.__fx.push("first"));
      await ctx.effect(() => () => globalThis.__fx.push("second"));
    } };`);
    const g = globalThis as { __fx?: string[] };
    g.__fx = [];
    const host = await w.start();
    await host.close();
    expect(g.__fx).toEqual(["second", "first"]);
    delete g.__fx;
  });
});

describe("isolation", () => {
  test("an uncaught error from a plugin's code quarantines only that plugin", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "reg", provides: ["registry@1"] }, REGISTRY);
    await w.plugin("user", { id: "bad", requires: ["registry@1"] }, `
      async function later() { await null; throw new Error("thrown later in a timer"); }
      export default { process(ctx) {
        globalThis.__badCtx = ctx;
        ctx.require("registry@1").register("make", () => later().catch((err) => ({ err })));
      } };`);
    const host = await w.start();
    const reg = host.service<{ run(n: string): Promise<{ err: Error }>; names(): string[] }>("registry@1")!;
    // 拿到一个插件里没人接住的错误：靠错误栈归属（bun 下 Promise rejection 拿不到 AsyncLocalStorage，5.3）
    const { err } = await reg.run("make");
    host.handleUncaught(err);
    await Bun.sleep(10);
    expect(info(host, "bad")).toMatchObject({ state: "quarantined", reason: "thrown later in a timer" });
    expect(info(host, "reg").state).toBe("active");
    expect(reg.names()).toEqual([]); // 它的注册撤销了
    // 留着旧 ctx 的代码再用它：StaleContext
    const g = globalThis as { __badCtx?: { require(s: string): unknown } };
    expect(() => g.__badCtx!.require("registry@1")).toThrow(StaleContext);
    delete g.__badCtx;
    await host.close();
  });

  test("a quarantined provider's service becomes unavailable but its dependents keep running", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "reg", provides: ["registry@1"] }, REGISTRY);
    await w.plugin("user", { id: "user", requires: ["registry@1"] }, `export default { process(ctx) {
      const reg = ctx.require("registry@1");
      globalThis.__useReg = () => reg.names();
    } };`);
    const host = await w.start();
    await host.quarantine("reg", "test");
    const g = globalThis as { __useReg?: () => unknown };
    expect(() => g.__useReg!()).toThrow(ServiceUnavailable);
    expect(info(host, "user").state).toBe("active");
    delete g.__useReg;
    await host.close();
  });

  test("errors nobody can be blamed for are recorded, not fatal", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "ok" }, `export default {};`);
    const host = await w.start();
    host.handleUncaught(new Error("from nowhere"));
    await host.close();
    expect(info(host, "ok").state).toBe("active");
    const faults = JSON.parse(await readFile(path.join(w.home, "state", "faults.json"), "utf8"));
    expect(faults.unattributed[0].error).toContain("from nowhere");
  });
});

describe("crash loops", () => {
  test(`a plugin that faults in ${FAULT_LIMIT} launches in a row is disabled until enabled again`, async () => {
    const w = await world();
    await w.plugin("user", { id: "flaky" }, `export default { process() { throw new Error("always"); } };`);
    for (let i = 0; i < FAULT_LIMIT; i++) {
      const host = await w.start();
      expect(info(host, "flaky").state).toBe("failed");
      await host.close();
    }
    expect(w.reports.at(-1)).toContain("will be disabled from the next launch");

    const host = await w.start();
    expect(info(host, "flaky").state).toBe("disabled");
    expect(info(host, "flaky").reason).toContain("jade plugins enable flaky");
    await host.close();

    expect(await pluginsCommand(["enable", "flaky"], { roots: w.roots, home: w.home })).toBe("enabled flaky");
    const again = await w.start();
    expect(info(again, "flaky").state).toBe("failed"); // 又试了一次
    await again.close();
  });

  test("a clean launch resets the streak", async () => {
    const w = await world();
    await w.plugin("user", { id: "sometimes" }, `export default { process() { if (globalThis.__fail) throw new Error("x"); } };`);
    const g = globalThis as { __fail?: boolean };
    for (const fail of [true, true, false, true, true]) {
      g.__fail = fail;
      const host = await w.start();
      await host.close();
    }
    delete g.__fail;
    const host = await w.start();
    expect(info(host, "sometimes").state).not.toBe("disabled");
    await host.close();
  });
});

describe("rescue CLI", () => {
  test("list shows states and reasons without running plugin code; disable takes effect next launch", async () => {
    const w = await world();
    await w.plugin("bundled", { id: "tui", provides: ["ui@1"] }, `globalThis.__ran = true; export default {};`);
    await w.plugin("project", { id: "repo/ui", provides: ["ui@1"] }, `export default {};`);
    await mkdir(path.join(w.home, "roots", "user", "broken"), { recursive: true });
    const opts = { roots: w.roots, home: w.home };

    const out = await pluginsCommand(["list"], opts);
    expect((globalThis as { __ran?: boolean }).__ran).toBeUndefined();
    expect(out).toContain("tui@1.0.0  bundled  active");
    expect(out).toContain("repo/ui@1.0.0  project  conflict  a project plugin cannot override the bundled provider of ui@1 (tui)");
    expect(out).toContain("broken");
    expect(out).toContain("ui@1  tui");

    expect(await pluginsCommand(["disable", "tui"], opts)).toBe("disabled tui");
    const host = await w.start();
    expect(info(host, "tui")).toMatchObject({ state: "disabled", reason: "disabled in plugins.json" });
    await host.close();
    expect(() => pluginsCommand(["frobnicate"], opts)).toThrow("usage");
  });
});
