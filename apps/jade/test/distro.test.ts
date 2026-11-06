// 最小发行版的端到端测试（设计第 11 节第 3 步）：真的运行 jade -p，模型换成按脚本回复的用户层插件。

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve(import.meta.dir, "../bin/jade.js");

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

const MODEL = { by: "model", provider: "scripted", model: "s1" };
const say = (text: string) => ({ content: [{ kind: "text", text, origin: MODEL, trust: "trusted" }], stopReason: "end" });
const use = (name: string, input: unknown) => ({ content: [{ kind: "tool_use", id: `t-${name}`, name, input, origin: MODEL, trust: "trusted" }], stopReason: "tool_use" });

// 按回复的轮数取脚本里的下一条；把每次请求的系统提示词和最后一条消息记下来
const FAKE_MODEL = `import { readFileSync, appendFileSync } from "node:fs";
const script = JSON.parse(readFileSync(new URL("./script.json", import.meta.url), "utf8"));
const log = new URL("./requests.jsonl", import.meta.url);
const provider = {
  id: "scripted",
  async complete(req) {
    const n = req.messages.filter((m) => m.role === "assistant").length;
    appendFileSync(log, JSON.stringify({ system: req.system.map((s) => s.text), tools: req.tools.map((t) => t.name), last: req.messages.at(-1) }) + "\\n");
    const next = script[n];
    if (!next) throw new Error("script exhausted");
    return { model: "s1", ...next };
  },
};
export default { process(ctx) {
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1", via: "a script" }), complete: provider.complete, list: async () => [] });
} };`;

async function setup(script: unknown[], config?: unknown) {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-home-")));
  const cwd = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-cwd-")));
  tmp.push(home, cwd);
  const dir = path.join(home, "plugins", "fake-model");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }),
  );
  await writeFile(path.join(dir, "index.mjs"), FAKE_MODEL);
  await writeFile(path.join(dir, "script.json"), JSON.stringify(script));
  if (config) await writeFile(path.join(home, "config.json"), JSON.stringify(config));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, JADE_HOME: home }, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const requests = async () =>
    (await readFile(path.join(dir, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { system: string[]; tools: string[]; last: { content: { kind: string; content?: { text: string }[] }[] } });
  return { home, cwd, run, requests };
}

describe("jade -p", () => {
  test("writes a file when the approval mode allows changes in the working directory", async () => {
    const w = await setup([use("write_file", { path: "hello.txt", content: "hi\n" }), say("Created hello.txt.")], { "jade/approval": { mode: "auto" } });
    const r = w.run("-p", "create hello.txt");
    expect(r.stderr).toContain("· write_file hello.txt");
    expect(r.stdout).toBe("Created hello.txt.\n");
    expect(r.code).toBe(0);
    expect(await readFile(path.join(w.cwd, "hello.txt"), "utf8")).toBe("hi\n");
  });

  test("reads a file and the result reaches the model", async () => {
    const w = await setup([use("read_file", { path: "notes.txt" }), say("It says hello.")]);
    await writeFile(path.join(w.cwd, "notes.txt"), "hello from notes\n");
    const r = w.run("-p", "what does notes.txt say?");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("It says hello.\n");
    const [first, second] = await w.requests();
    expect(first!.tools).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "glob", "grep"]));
    expect(first!.system[0]).toStartWith("You are Jade");
    expect(first!.system.join("\n")).toContain(`Working directory: ${w.cwd}`);
    expect(first!.system.join("\n")).toContain(`configured to use the model "s1" via a script`);
    // 工具插件经 prompts@1 加的段落
    expect(first!.system.join("\n")).toContain("Shell for the bash tool:");
    expect(JSON.stringify(second!.last)).toContain("1\\thello from notes");
  });

  test("runs a read-only shell command without asking, and its output reaches the model", async () => {
    const w = await setup([use("bash", { command: "echo from-bash" }), say("Done.")]);
    const r = w.run("-p", "say something");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("· bash echo from-bash");
    const [, second] = await w.requests();
    expect(JSON.stringify(second!.last)).toContain("from-bash");
  });

  test("in the default ask mode a change is denied because print cannot ask, and the user is told how to allow it", async () => {
    const w = await setup([use("write_file", { path: "hello.txt", content: "hi\n" }), say("I could not write it.")]);
    const r = w.run("-p", "create hello.txt");
    expect(r.code).toBe(0);
    expect(existsSync(path.join(w.cwd, "hello.txt"))).toBe(false);
    expect(r.stderr).toContain("denied: write_file needs the user's approval");
    expect(r.stderr).toContain(`"jade/approval": {"mode": "auto"}`);
  });

  test("with jade/approval disabled the core's fallback gate denies changes", async () => {
    const w = await setup([use("write_file", { path: "hello.txt", content: "hi\n" }), say("Denied.")], { "jade/approval": { mode: "yolo" } });
    expect(w.run("plugins", "disable", "jade/approval").code).toBe(0);
    const r = w.run("-p", "create hello.txt");
    expect(r.code).toBe(0);
    expect(existsSync(path.join(w.cwd, "hello.txt"))).toBe(false);
    expect(r.stderr).toContain("No permission plugin is active");
  });

  test("a project config cannot change the approval mode", async () => {
    const w = await setup([use("write_file", { path: "hello.txt", content: "hi\n" }), say("Done.")]);
    await mkdir(path.join(w.cwd, ".jade"));
    await writeFile(path.join(w.cwd, ".jade", "config.json"), JSON.stringify({ "jade/approval": { mode: "yolo" } }));
    const r = w.run("-p", "create hello.txt");
    expect(r.stderr).toContain("project config for jade/approval: mode can only be set in your own config.json");
    expect(existsSync(path.join(w.cwd, "hello.txt"))).toBe(false);
  });

  test("a model error ends the run with exit code 1 and the reason", async () => {
    const w = await setup([]);
    const r = w.run("-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: script exhausted");
  });

  test("without a prompt prints usage", async () => {
    const w = await setup([]);
    const r = w.run("-p", "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: jade -p");
  });
});
