// 注册表插件（设计第 11 节第 6 步）：jade/commands、jade/keys、jade/renderers，以及用它们的 jade/modes、jade/sessions。
// 用真实的 bundled 插件目录，模型换成用户层的假插件。

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginHost, type SessionManager, type UI } from "../src/index.ts";
import type { Approval, CommandContext, Commands, Keys, Modes, Renderers, Tools } from "@uncarved/jade-api/services";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

const MODEL = { by: "model", provider: "scripted", model: "s1" };
const FAKE_MODEL = `export default { process(ctx) {
  const provider = { id: "scripted", async complete() {
    return { model: "s1", content: [{ kind: "text", text: "ok", origin: ${JSON.stringify(MODEL)}, trust: "trusted" }], stopReason: "end" };
  } };
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1", via: "a script", contextWindow: 1000 }), complete: provider.complete, list: async () => [] });
} };`;

// 一个注册命令、键、渲染器、给嵌套 Agent 的工具的用户层插件
const USER = `export default { process(ctx) {
  ctx.require("commands@1").register({ name: "hello", description: "says hello", run: (args) => "hello " + args });
  ctx.require("keys@1").register({ key: "ctrl+g", description: "go", run: () => {} });
  ctx.require("renderers@1").event({ event: "ping", render: (d) => ({ line: "ping " + d }) });
  ctx.require("tools@1").register({ name: "peek", description: "peeks", inputSchema: { type: "object" }, effect: "read", concurrency: "safe", idempotent: true, execute: async () => ({ content: "peeked" }) });
} };`;

async function start() {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-reg-")));
  tmp.push(home);
  const plugin = async (name: string, manifest: object, code: string) => {
    const dir = path.join(home, "plugins", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ version: "1.0.0", api: "^1", entry: "index.mjs", ...manifest }));
    await writeFile(path.join(dir, "index.mjs"), code);
  };
  await plugin("fake-model", { id: "test/fake-model", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }, FAKE_MODEL);
  await plugin("user", { id: "test/user", requires: ["commands@1", "keys@1", "renderers@1", "tools@1"] }, USER);
  const reports: string[] = [];
  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: BUNDLED },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    cwd: home,
    report: (m) => reports.push(m),
  });
  return { home, host, reports };
}

/** 选第一项的 UI */
const ui: UI = { interactive: true, notify: () => {}, select: async (r) => r.options[0]?.value, input: async () => undefined };
const ctxFor = (sessions: SessionManager): CommandContext => ({ signal: new AbortController().signal, ui, sessions, print: () => {} });

describe("registries", () => {
  test("the bundled distribution activates, with tui as the default frontend", async () => {
    const { host, reports } = await start();
    try {
      const bad = host.status().filter((p) => p.state !== "active" && p.state !== "replaced" && !(p.id === "jade/print" && p.state === "skipped"));
      expect(bad).toEqual([]);
      expect(host.plan.frontend).toBe("jade/tui");
      expect(reports).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("commands from plugins are listed, run with the caller's context, and revoked with their plugin", async () => {
    const { host } = await start();
    try {
      const commands = host.service<Commands>("commands@1")!;
      expect(commands.list().map((c) => c.name)).toEqual(expect.arrayContaining(["clear", "hello", "mode", "resume", "retry"]));
      expect(commands.list().find((c) => c.name === "hello")!.plugin).toBe("test/user");
      expect(await commands.get("HELLO")!.command.run("there", ctxFor(host.sessions))).toBe("hello there");
      expect(() => commands.register({ name: "hello", run: () => {} })).toThrow("already registered by test/user");
      await host.quarantine("test/user", "test");
      expect(commands.get("hello")).toBeUndefined();
      expect(host.service<Keys>("keys@1")!.get("ctrl+g")).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  test("keys reject reserved and malformed keys", async () => {
    const { host } = await start();
    try {
      const keys = host.service<Keys>("keys@1")!;
      expect(() => keys.register({ key: "ctrl+c", run: () => {} })).toThrow("reserved");
      expect(() => keys.register({ key: "f5", run: () => {} })).toThrow("invalid key");
      expect(keys.list().map((k) => k.key)).toEqual(["ctrl+g", "shift+tab"]);
    } finally {
      await host.close();
    }
  });

  test("event renderers are found by the full event type", async () => {
    const { host } = await start();
    try {
      const r = host.service<Renderers>("renderers@1")!;
      expect(r.forEvent("test/user/ping")!.renderer.render(1)).toEqual({ line: "ping 1" });
      expect(r.forEvent("ping")).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  test("tools for nested agents: any plugin registers them, any plugin lists them, and they are revoked with their plugin", async () => {
    const { host } = await start();
    try {
      // 取用的一方（这里是核心，换成任何插件都一样）不用登记的一方认识它
      const tools = host.service<Tools>("tools@1")!;
      await host.sessions.open();
      const names = () => tools.list().map((t) => t.name);
      expect(names()).toEqual(expect.arrayContaining(["read_file", "grep", "bash", "web_fetch", "peek"]));
      expect(names()).not.toContain("write_file");
      const signal = new AbortController().signal;
      const peek = tools.list().find((t) => t.name === "peek")!;
      expect(await peek.execute({}, { sessionId: "s", toolUseId: "t", signal, parent: { sessionId: "s", eventId: "e" }, progress() {} })).toEqual({ content: "peeked" });
      expect(() => tools.register({ ...peek, name: "read_file" })).toThrow("already registered by jade/fs");
      await host.quarantine("test/user", "test");
      expect(names()).not.toContain("peek");
      expect(names()).toContain("read_file");
    } finally {
      await host.close();
    }
  });

  test("shift+tab and /mode change the approval mode and tell subscribers", async () => {
    const { host } = await start();
    try {
      const approval = host.service<Approval>("approval@1")!;
      const modes = host.service<Modes>("modes@1")!;
      const seen: string[] = [];
      modes.subscribe((m) => seen.push(m));
      await host.service<Keys>("keys@1")!.get("shift+tab")!.key.run({ key: "shift+tab", signal: new AbortController().signal });
      expect(approval.mode()).toBe("auto");
      const mode = host.service<Commands>("commands@1")!.get("mode")!.command;
      expect(await mode.run("plan", ctxFor(host.sessions))).toBe("mode: plan");
      expect(await mode.run("nonsense", ctxFor(host.sessions))).toContain("unknown mode");
      expect(seen).toEqual(["auto", "plan"]);
    } finally {
      await host.close();
    }
  });

  test("/clear starts a new session, /resume lists this directory's sessions and goes back", async () => {
    const { home, host } = await start();
    try {
      const commands = host.service<Commands>("commands@1")!;
      const first = await host.sessions.open();
      await first.send({ kind: "message", content: [{ kind: "text", text: "remember the alamo", origin: { by: "user" }, trust: "trusted" }] });
      await first.idle();
      const index = (await readFile(path.join(home, "state", "sessions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(index).toEqual([expect.objectContaining({ id: first.id, cwd: home, title: "remember the alamo" })]);

      expect(await commands.get("clear")!.command.run("", ctxFor(host.sessions))).toContain(`jade --resume ${first.id}`);
      expect(host.sessions.current!.id).not.toBe(first.id);
      // 选第一项：唯一的另一个会话
      await commands.get("resume")!.command.run("", ctxFor(host.sessions));
      expect(host.sessions.current!.id).toBe(first.id);
      expect(host.sessions.current!.state.messages).toHaveLength(2);
      expect(await commands.get("retry")!.command.run("", ctxFor(host.sessions))).toContain("Nothing to retry");
    } finally {
      await host.close();
    }
  });
});
