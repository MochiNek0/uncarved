// jade/tui 端到端：真实的 bundled 插件，假的终端和模型。用键盘输入一条消息，审批对话框里批准，看到回复；
// 再用 /mode、/help、/exit。

import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { PluginHost, type Frontend } from "../src/index.ts";
import { terminal } from "../plugins/tui/frontend.ts";

const BUNDLED = path.resolve(import.meta.dir, "../plugins");
const g = globalThis as { __script?: unknown[] };

let tmp: string[] = [];
afterEach(async () => {
  delete terminal.io;
  delete g.__script;
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

const MODEL = { by: "model", provider: "scripted", model: "s1" };
const FAKE_MODEL = `export default { process(ctx) {
  const provider = { id: "scripted", async complete() {
    const next = globalThis.__script.shift();
    if (!next) throw new Error("script exhausted");
    return { model: "s1", ...next };
  } };
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1-model", via: "a script", contextWindow: 1000 }), complete: provider.complete, list: async () => [] });
} };`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeTerminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let out = "";
  const stdout = Object.assign(
    new Writable({
      write(chunk, _enc, done) {
        out += chunk.toString();
        done();
      },
    }),
    { isTTY: true, columns: 120, rows: 40 },
  );
  terminal.io = { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream };
  return {
    type: async (s: string) => {
      stdin.write(s);
      await sleep(100);
    },
    output: () => stripVTControlCharacters(out),
  };
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(25);
  }
}

test("a message, an approval dialog, slash commands and /exit through the terminal interface", async () => {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-tui-")));
  tmp.push(home);
  const cwd = path.join(home, "work");
  await mkdir(cwd);
  const dir = path.join(home, "plugins", "fake-model");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }));
  await writeFile(path.join(dir, "index.mjs"), FAKE_MODEL);
  g.__script = [
    { content: [{ kind: "tool_use", id: "t1", name: "write_file", input: { path: "hello.txt", content: "hi\n" }, origin: MODEL, trust: "trusted" }], stopReason: "tool_use" },
    { content: [{ kind: "text", text: "Created hello.txt for you.", origin: MODEL, trust: "trusted" }], stopReason: "end" },
  ];

  const t = fakeTerminal();
  const reports: string[] = [];
  const host = await PluginHost.start({
    roots: [
      { layer: "bundled", root: BUNDLED },
      { layer: "user", root: path.join(home, "plugins") },
    ],
    home,
    cwd,
    report: (m) => reports.push(m),
  });
  try {
    expect(host.plan.frontend).toBe("jade/tui");
    const frontend = host.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: [], sessions: host.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("Type / for commands"));
    expect(t.output()).toContain("s1-model");

    await t.type("please create hello.txt");
    await t.type("\r");
    // 审批插件经 ui@1 弹出对话框，预览来自 jade/fs 的渲染器
    await until(() => t.output().includes("Allow once"));
    expect(t.output()).toContain("+ hi");
    await t.type("\r");
    await until(() => t.output().includes("Created hello.txt for you."));
    expect(await readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("hi\n");

    await t.type("/mode auto");
    await t.type("\r");
    await until(() => t.output().includes("mode: auto"));

    await t.type("/help");
    await t.type("\r");
    await until(() => t.output().includes("/resume"));

    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
    expect(t.output()).toContain("Resume with: jade --resume");
    expect(reports).toEqual([]);
  } finally {
    await host.close();
  }
});
