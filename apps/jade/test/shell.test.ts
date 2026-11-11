// bash 工具（plugins/shell）：从旧 jade 的 test/jade.test.ts "fs tools" 里的 bash 测试移植。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "uncarved";
import { shellService } from "../plugins/shell/service.ts";
import { shellTool, shellTools } from "../plugins/shell/shell.ts";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { cleanup, say, scriptedHost, textOf, use } from "./scripted-ui.ts";

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true }).catch(() => {});
  tmp = [];
});

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jade-shell-"));
  tmp.push(cwd);
  return cwd;
}

const ctx = (progress: unknown[] = []): ToolContext => ({
  sessionId: "s",
  toolUseId: "t",
  signal: new AbortController().signal,
  parent: { sessionId: "s", eventId: "e" },
  progress: (u) => progress.push(u),
});

describe("bash", () => {
  test("reports exit code and output, streaming it as progress", async () => {
    const cwd = await workspace();
    const progress: unknown[] = [];
    const r = await shellTool({ cwd }).execute({ command: "echo hi; exit 3" }, ctx(progress));
    expect(r.content).toBe("Exit code 3\n<stdout>\nhi\n</stdout>");
    expect(r.isError).toBe(true);
    expect(progress).toEqual([{ kind: "output", stream: "stdout", text: "hi\n" }]);
  });

  test("is left out when the shell cannot be found", () => {
    const shell = shellTools({ cwd: os.tmpdir(), shell: "no-such-shell-for-jade" });
    expect(shell.tools).toEqual([]);
    expect(shell.unavailable).toContain("no-such-shell-for-jade was not found");
    expect(() => shellTool({ cwd: os.tmpdir(), shell: "no-such-shell-for-jade" })).toThrow("was not found");
  });

  test("timeout and abort kill the shell's children instead of waiting for them", async () => {
    const cwd = await workspace();
    const tool = shellTool({ cwd });
    let t0 = Date.now();
    const r = await tool.execute({ command: "sleep 10; echo done", timeout_ms: 1000 }, ctx());
    expect(r.content).toStartWith("Timed out after 1000ms");
    expect(Date.now() - t0).toBeLessThan(5000);

    const ac = new AbortController();
    setTimeout(() => ac.abort("stop"), 500);
    t0 = Date.now();
    await tool.execute({ command: "sleep 10; echo done" }, { ...ctx(), signal: ac.signal }).catch(() => {});
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20_000);

  test("keeps the start and end of large output and drops the middle", async () => {
    const cwd = await workspace();
    const tool = shellTool({ cwd });
    // 约 2MB：开头一行 first，结尾一行 last
    const r = await tool.execute({ command: "echo first; head -c 2000000 /dev/zero | tr '\\0' x; echo; echo last" }, ctx());
    const text = r.content as string;
    expect(text).toContain("<stdout>\nfirst\n");
    expect(text).toEndWith("last\n</stdout>");
    expect(text).toMatch(/… \(\d+ characters omitted\) …/);
    expect(text.length).toBeLessThan(31_000);
  }, 20_000);

  test("coreutils are on PATH (Git Bash on Windows is started without its launcher)", async () => {
    const cwd = await workspace();
    const shell = shellTools({ cwd });
    // -maxdepth 是 Unix 的 find 才有的（GNU 和 macOS 的 BSD find 都有）：Windows 自带的 find.exe 会报参数格式错
    const r = await shell.run!("echo hi | cat | grep -c hi; find . -maxdepth 0", { timeoutMs: 20_000 });
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe("1\n.");
  }, 30_000);

  test("background shells return at once; bash_output reads new output; kill_shell stops them", async () => {
    const cwd = await workspace();
    const shell = shellTools({ cwd });
    const exec = async (name: string, input: unknown) => {
      const r = await shell.tools.find((t) => t.name === name)!.execute(input, ctx());
      return { text: r.content as string, isError: r.isError ?? false };
    };
    try {
      const t0 = Date.now();
      const started = await exec("bash", { command: "echo first; sleep 30; echo never", run_in_background: true });
      expect(started.text).toStartWith("Started background shell bg1");
      expect(Date.now() - t0).toBeLessThan(2000);

      let out = "";
      for (let i = 0; i < 50 && !out.includes("<output>"); i++) {
        out = (await exec("bash_output", { id: "bg1" })).text;
        await Bun.sleep(100);
      }
      expect(out).toContain("running");
      expect(out).toContain("first");
      // 读走的输出不会再出现
      expect((await exec("bash_output", { id: "bg1" })).text).toContain("(no new output)");

      expect((await exec("kill_shell", { id: "bg1" })).text).toStartWith("bg1 stopped");
      expect((await exec("bash_output", { id: "bg1" })).text).not.toContain("running");
      expect((await exec("bash_output", { id: "bg9" })).isError).toBe(true);
    } finally {
      shell.shutdown();
    }
  }, 20_000);

  test("a background shell that ends by itself is reported once; one stopped with kill is not", async () => {
    const cwd = await workspace();
    const exits: string[] = [];
    const shell = shellTools({ cwd, onExit: (bg) => void exits.push(`${bg.id} ${bg.command} -> ${bg.exitCode}`) });
    const bash = shell.tools.find((t) => t.name === "bash")!;
    try {
      await bash.execute({ command: "exit 3", run_in_background: true }, ctx());
      await bash.execute({ command: "sleep 30", run_in_background: true }, ctx());
      for (let i = 0; i < 50 && exits.length === 0; i++) await Bun.sleep(100);
      expect(shell.list()).toEqual([
        { id: "bg1", command: "exit 3", status: "exited with code 3" },
        { id: "bg2", command: "sleep 30", status: "running" },
      ]);
      expect(await shell.kill("bg2")).toBe(true);
      expect(await shell.kill("bg9")).toBe(false);
      await Bun.sleep(200);
      expect(exits).toEqual(["bg1 exit 3 -> 3"]);
    } finally {
      shell.shutdown();
    }
  }, 20_000);
});

// shell@1：其他插件执行命令的入口（jade/checks 用它跑项目的检查）
describe("shell@1", () => {
  test("runs a command and collects its output", async () => {
    const cwd = await workspace();
    const service = shellService();
    if (!service.executable) return; // 这台机器上没有 shell：下面只测"没有 shell"的情形
    const r = await service.run("echo one; echo two >&2; exit 4", { cwd, timeoutMs: 20_000 });
    expect(r.code).toBe(4);
    expect(r.timedOut).toBe(false);
    expect(r.output).toContain("one");
    expect(r.output).toContain("two");
  }, 20_000);

  test("kills the command on abort and on timeout", async () => {
    const cwd = await workspace();
    const service = shellService();
    if (!service.executable) return;
    const t0 = Date.now();
    const timed = await service.run("sleep 10; echo done", { cwd, timeoutMs: 500 });
    expect(timed.timedOut).toBe(true);
    expect(timed.code).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 300);
    await expect(service.run("sleep 10", { cwd, timeoutMs: 20_000, signal: ac.signal })).rejects.toThrow();
  }, 20_000);

  test("without a shell the service says so instead of failing at call time", async () => {
    const service = shellService({ shell: "no-such-shell-for-jade" });
    expect(service.executable).toBeUndefined();
    expect(service.unavailable).toContain("no-such-shell-for-jade");
    await expect(service.run("echo hi", { timeoutMs: 1000 })).rejects.toThrow("no-such-shell-for-jade");
    // which 不依赖 shell 在不在
    expect(typeof service.which("no-such-program-for-jade")).toBe("undefined");
  });
});

describe("jade/shell in a session", () => {
  afterEach(cleanup);

  test("a background command that ends is announced to the user and noted for the model; /shells lists it", async () => {
    const w = await scriptedHost();
    w.shared.script.push(use("u1", "bash", { command: "exit 3", run_in_background: true }), say("started"));
    const s = await w.host.sessions.open();
    await w.send(s, "start it");
    for (let i = 0; i < 50 && !w.shared.notes.some((n) => n.includes("bg1")); i++) await Bun.sleep(100);
    expect(w.shared.notes).toContain("Background shell bg1 (exit 3) exited with code 3");
    const shells = w.host.service<Commands>("commands@1")!.get("shells")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: w.host.service<UI>("ui@1")!, sessions: w.host.sessions, print: () => {} };
    expect(await shells.run("", c)).toBe("bg1  exited with code 3  exit 3");
    expect(await shells.run("kill bg7", c)).toBe("There is no background command bg7.");
    // 模型下一次请求时看到说明。命令可能在第一轮的第二次请求前就结束了（macOS 上常见），那时说明附在工具结果那条消息后面，
    // 所以在整段对话里找，而不只看最后一条
    w.shared.script.push(say("ok"));
    await w.send(s, "and now?");
    expect(w.shared.requests.at(-1)!.messages.map((m) => textOf(m.content)).join("\n")).toContain("[Note from jade] Background shell bg1 (exit 3) exited with code 3. Read its remaining output with bash_output.");
  }, 30_000);

  test("/sh runs the user's command without the model and notes the output for the next request", async () => {
    const w = await scriptedHost();
    const s = await w.host.sessions.open();
    const sh = w.host.service<Commands>("commands@1")!.get("sh")!.command;
    const printed: unknown[] = [];
    const live: (string | undefined)[] = [];
    const base = { ui: w.host.service<UI>("ui@1")!, sessions: w.host.sessions, print: (t: string, o?: { details?: string }) => void printed.push([t, o]), progress: (t: string | undefined) => void live.push(t) };
    const c: CommandContext = { ...base, signal: new AbortController().signal };
    await sh.run("echo hi", c);
    // 输出一到就交给前端显示
    expect(live).toEqual(["hi\n"]);
    await sh.run("echo no; echo more; exit 3", c);
    // 用户中途停掉（esc）：已经输出的留下来
    const ac = new AbortController();
    const stopping = sh.run("echo started; sleep 10", { ...base, signal: ac.signal });
    for (let i = 0; i < 50 && !live.some((t) => t?.includes("started")); i++) await Bun.sleep(100);
    ac.abort(new Error("interrupted by user"));
    await stopping;
    // 一行摘要；多行的输出折叠在 details 里
    expect(printed).toEqual([
      ["⎿ hi", undefined],
      ["⎿ exit code 3 · no (+1 lines)", { details: "    no\n    more" }],
      ["⎿ stopped by the user · started", undefined],
    ]);
    expect(await sh.run("  ", c)).toContain("Usage");
    expect(w.shared.requests).toEqual([]);
    w.shared.script.push(say("ok"));
    await w.send(s, "what did it print?");
    expect(w.shared.requests.at(-1)!.messages.map((m) => textOf(m.content)).join("\n")).toContain("[Note from jade] The user ran this shell command themselves (exit code 0):\n$ echo hi\nhi");
  }, 30_000);
});
