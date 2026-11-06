// 进程外插件（设计第 6 节、第 11 节第 5 步）：Python 写的插件提供服务、注册命令、注册工具和 gate。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, ModelResponse, State } from "uncarved";
import type { PluginHost } from "../src/index.ts";
import { info, world } from "./helpers.ts";

const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

type Step = Omit<ModelResponse, "model">;
const g = globalThis as { __script?: Step[]; __notes?: string[]; __registry?: Map<string, unknown>; __fromJs?: unknown[] };
const MODEL = { by: "model", provider: "scripted", model: "s1" } as const;
const use = (id: string, name: string, input: unknown = {}): Block => ({ kind: "tool_use", id, name, input, origin: MODEL, trust: "trusted" });
const say = (text: string): Step => ({ content: [{ kind: "text", text, origin: MODEL, trust: "trusted" }], stopReason: "end" });
const msg = (t: string) => ({ kind: "message" as const, content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }] });

beforeEach(() => {
  g.__script = [];
  g.__notes = [];
  g.__fromJs = [];
});
afterEach(() => {
  delete g.__script;
  delete g.__notes;
  delete g.__registry;
  delete g.__fromJs;
});

const PROVIDER = `export default { process(ctx) {
  ctx.provide("provider@1", { id: "scripted", async complete() {
    const next = globalThis.__script.shift();
    if (!next) throw new Error("script exhausted");
    return { model: "s1", ...next };
  } });
} };`;

// 按调用方创建实例的注册表：调用方关闭时撤销它注册的命令
const COMMANDS = `const registry = (globalThis.__registry = new Map());
export default { process(ctx) {
  ctx.provide("commands@1", (caller) => ({
    register(cmd) {
      registry.set(cmd.name, { ...cmd, owner: caller.plugin });
      caller.onDispose(() => registry.delete(cmd.name));
    },
    async run(name, args, signal) {
      const c = registry.get(name);
      if (!c) throw new Error("no command " + name);
      return signal ? c.run(args, signal) : c.run(args);
    },
    list: () => [...registry.values()].map((c) => c.name + " (" + c.owner + ")"),
  }));
} };`;

const UI = `export default { process(ctx) {
  ctx.provide("ui@1", { interactive: false, notify: (m) => globalThis.__notes.push(m), select: async () => undefined });
} };`;

// 进程内插件调用 Python 提供的服务，并把回调交给它
const JS_USER = `export default { async process(ctx) {
  const greeter = ctx.require("greeter@1");
  globalThis.__fromJs.push(await greeter.greet("js"));
  globalThis.__fromJs.push(await greeter.later((x) => "callback got " + x));
} };`;

const MAIN_PY = `import os
import time
from jade_plugin import Plugin, cancelled

plugin = Plugin("py/greeter")
open("pid.txt", "w").write(str(os.getpid()))

class Greeter:
    def __init__(self, ctx):
        self._ctx = ctx

    def greet(self, name):
        return f"{self._ctx.config.get('greeting', 'hello')}, {name}!"

    def later(self, callback):
        return callback("from python")

    def set_secret(self, key, value):
        self._ctx.secrets.set(key, value)

    def get_secret(self, key):
        return self._ctx.secrets.get(key)

    def crash(self):
        os._exit(3)

    def wait(self, signal):
        return wait_for_cancel("service", signal)

def wait_for_cancel(name, signal):
    while not cancelled():
        time.sleep(0.01)
    open(name + "-cancelled.txt", "w").write(repr(signal))
    return "cancelled"

@plugin.process
def process(ctx):
    greeter = Greeter(ctx)
    ctx.provide("greeter@1", greeter)

    def hello(args):
        ctx.service("ui@1").notify("hello ran with " + args)
        return greeter.greet(args)

    ctx.service("commands@1").register({"name": "hello", "description": "Greets", "run": hello})
    ctx.service("commands@1").register({"name": "wait", "description": "Waits", "run": lambda args, signal: wait_for_cancel("callback", signal)})

@plugin.session
def session(ctx):
    ctx.tool("shout", "Upper-cases text", {"type": "object"}, effect="read", execute=lambda input, c: input["text"].upper())

    def gate(call):
        if call["name"] == "shout" and call["input"].get("text") == "no":
            return {"decision": "deny", "reason": "python says no"}
        return {"decision": "abstain"}

    ctx.hook("gate", "tool.gate", gate, reads=["name", "input"], timeout_ms=5000)

plugin.run()
`;

async function setup(opts: { layer?: "user" | "project"; command?: string; jsUser?: boolean } = {}) {
  const w = await world();
  await w.plugin("bundled", { id: "models", provides: ["provider@1"] }, PROVIDER);
  await w.plugin("bundled", { id: "commands", provides: ["commands@1"] }, COMMANDS);
  await w.plugin("bundled", { id: "ui", provides: ["ui@1"] }, UI);
  const dir = await w.plugin(
    opts.layer ?? "user",
    { id: "py/greeter", entry: undefined, runtime: { command: opts.command ?? PYTHON!, args: ["main.py"] }, provides: ["greeter@1"], requires: ["commands@1"], optional: ["ui@1"] },
    "",
  );
  await writeFile(path.join(dir, "main.py"), MAIN_PY);
  if (opts.jsUser) await w.plugin("user", { id: "js/user", requires: ["greeter@1"] }, JS_USER);
  await writeFile(path.join(w.home, "config.json"), JSON.stringify({ "py/greeter": { greeting: "hi" } }));
  return { w, dir };
}

const commands = (host: PluginHost) => host.service<{ run(name: string, args: string, signal?: AbortSignal): Promise<string>; list(): Promise<string[]> }>("commands@1")!;

/** 工具结果：toolUseId → [是否出错, 文字] */
function results(state: State) {
  const out: Record<string, [boolean, string]> = {};
  for (const m of state.messages) {
    for (const b of m.content) {
      if (b.kind !== "tool_result") continue;
      out[b.toolUseId] = [b.isError, b.content.map((c) => (c.kind === "text" ? c.text : "")).join("")];
    }
  }
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!PYTHON)("out-of-process plugins", () => {
  test("a Python plugin provides a service and registers a command", async () => {
    const { w } = await setup({ jsUser: true });
    const host = await w.start();
    try {
      expect(info(host, "py/greeter").state).toBe("active");
      expect(await commands(host).list()).toEqual(["hello (py/greeter)", "wait (py/greeter)"]);
      // 命令在 Python 里执行，执行中又调用了宿主的 ui@1
      expect(await commands(host).run("hello", "jade")).toBe("hi, jade!");
      expect(g.__notes).toContain("hello ran with jade");
      // 进程内插件调用 Python 的服务；Python 调用进程内插件交给它的回调
      expect(info(host, "js/user").state).toBe("active");
      expect(g.__fromJs).toEqual(["hi, js!", "callback got from python"]);
    } finally {
      await host.close();
    }
  });

  test("secrets are available over the bridge, scoped to the plugin", async () => {
    const { w } = await setup({ jsUser: true });
    const host = await w.start();
    try {
      const greeter = host.service<{ set_secret(key: string, value: string | null): Promise<void>; get_secret(key: string): Promise<string | null> }>("greeter@1")!;
      await greeter.set_secret("TOKEN", "from-python");
      expect(await greeter.get_secret("TOKEN")).toBe("from-python");
      expect(await host.secrets("py/greeter").get("TOKEN")).toBe("from-python");
      expect(await host.secrets("js/user").get("TOKEN")).toBeUndefined();
      // null 删除
      await greeter.set_secret("TOKEN", null);
      expect(await greeter.get_secret("TOKEN")).toBeNull();
    } finally {
      await host.close();
    }
  });

  test("an AbortSignal passed to a Python service or callback arrives as a cancellation", async () => {
    const { w, dir } = await setup();
    const host = await w.start();
    try {
      const greeter = host.service<{ wait(signal: AbortSignal): Promise<string> }>("greeter@1")!;
      for (const [name, start] of [
        ["service", (s: AbortSignal) => greeter.wait(s)],
        ["callback", (s: AbortSignal) => commands(host).run("wait", "", s)],
      ] as const) {
        const ac = new AbortController();
        const pending = start(ac.signal);
        setTimeout(() => ac.abort(new Error("stop")), 100);
        await expect(pending).rejects.toThrow("stop");
        // 信号本身不过桥，插件收到 None，再经 $/cancel 知道被取消
        await until(() => existsSync(path.join(dir, `${name}-cancelled.txt`)));
        expect(readFileSync(path.join(dir, `${name}-cancelled.txt`), "utf8")).toBe("None");
      }
    } finally {
      await host.close();
    }
  });

  test("closing the host revokes its registrations and ends its process", async () => {
    const { w, dir } = await setup();
    const host = await w.start();
    const pid = Number(readFileSync(path.join(dir, "pid.txt"), "utf8"));
    expect(alive(pid)).toBe(true);
    expect(g.__registry!.size).toBe(2);
    await host.close();
    expect(g.__registry!.size).toBe(0);
    await until(() => !alive(pid));
  });

  test("its tool runs in a session and its gate takes part in approval", async () => {
    const { w } = await setup();
    const host = await w.start();
    try {
      g.__script!.push({ content: [use("t1", "shout", { text: "hey" }), use("t2", "shout", { text: "no" })], stopReason: "tool_use" }, say("done"));
      const s = await host.sessions.open();
      await s.send(msg("go"));
      await s.idle();
      const r = results(s.state);
      expect(r.t1).toEqual([false, "HEY"]);
      expect(r.t2![0]).toBe(true);
      expect(r.t2![1]).toContain("python says no");
    } finally {
      await host.close();
    }
  });

  test("when its process dies the plugin is quarantined and its command is revoked", async () => {
    const { w } = await setup({ jsUser: true });
    const host = await w.start();
    try {
      const greeter = host.service<{ crash(): Promise<void> }>("greeter@1")!;
      await expect(greeter.crash()).rejects.toThrow("exited");
      await until(() => info(host, "py/greeter").state === "quarantined");
      expect(info(host, "py/greeter").reason).toContain("code 3");
      expect(g.__registry!.size).toBe(0);
      expect(w.reports.join("\n")).toContain("plugin py/greeter was stopped");
    } finally {
      await host.close();
    }
  });

  test("a command that cannot start fails activation with the reason", async () => {
    const { w } = await setup({ command: "jade-no-such-command-xyz" });
    const host = await w.start();
    try {
      expect(info(host, "py/greeter").state).toBe("failed");
      expect(info(host, "py/greeter").reason).toContain("cannot start");
    } finally {
      await host.close();
    }
  });

  test("out-of-process plugins are not loaded from a project", async () => {
    const { w } = await setup({ layer: "project" });
    const host = await w.start();
    try {
      expect(info(host, "py/greeter").state).toBe("failed");
      expect(info(host, "py/greeter").reason).toContain("cannot be loaded from a project");
    } finally {
      await host.close();
    }
  });
});
