// bash 工具（plugins/shell）：从旧 jade 的 test/jade.test.ts "fs tools" 里的 bash 测试移植。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "uncarved";
import { shellTool, shellTools } from "../plugins/shell/shell.ts";

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
});
