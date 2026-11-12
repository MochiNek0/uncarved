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
const g = globalThis as { __hold?: Promise<void>; __script?: unknown[]; __requests?: { messages: { content: { kind: string; text?: string }[] }[] }[] };

let tmp: string[] = [];
afterEach(async () => {
  delete terminal.io;
  delete g.__script;
  delete g.__hold;
  delete g.__requests;
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

const MODEL = { by: "model", provider: "scripted", model: "s1" };
const FAKE_MODEL = `export default { process(ctx) {
  const provider = { id: "scripted", async complete(req) {
    (globalThis.__requests ??= []).push(structuredClone(req));
    const next = globalThis.__script.shift();
    if (!next) throw new Error("script exhausted");
    // hold: 等测试放行才返回，模拟还在跑的一轮
    if (next.hold) await globalThis.__hold;
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
    raw: () => out,
  };
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(25);
  }
}

/** 一个 $JADE_HOME 和工作目录，带假模型插件 */
async function setup() {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-tui-")));
  tmp.push(home);
  const cwd = path.join(home, "work");
  await mkdir(cwd);
  const dir = path.join(home, "plugins", "fake-model");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }));
  await writeFile(path.join(dir, "index.mjs"), FAKE_MODEL);
  // 不读这台机器上的 ~/.claude/CLAUDE.md
  await writeFile(path.join(home, "config.json"), JSON.stringify({ "jade/prompts": { claudeInstructions: false } }));
  const start = () =>
    PluginHost.start({
      roots: [
        { layer: "bundled", root: BUNDLED },
        { layer: "user", root: path.join(home, "plugins") },
      ],
      home,
      cwd,
      report: () => {},
    });
  return { home, cwd, start };
}

test("--continue resumes the most recent session in this directory", async () => {
  const { home, start } = await setup();
  g.__script = [{ content: [{ kind: "text", text: "first answer", origin: MODEL, trust: "trusted" }], stopReason: "end" }];

  const t = fakeTerminal();
  const first = await start();
  try {
    const frontend = first.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: ["hello"], sessions: first.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("first answer"));
    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await first.close();
  }

  // jade/sessions 在收到第一条消息时写下了索引
  const index = (await readFile(path.join(home, "state", "sessions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { id: string; title: string });
  expect(index.map((e) => e.title)).toEqual(["hello"]);

  const t2 = fakeTerminal();
  const second = await start();
  try {
    const frontend = second.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: ["--continue"], sessions: second.sessions, signal: new AbortController().signal });
    // 界面顶部写着恢复的是哪个会话
    await until(() => t2.output().includes(`session ${index[0]!.id}`));
    await t2.type("/exit");
    await t2.type("\r");
    expect(await done).toBe(0);
  } finally {
    await second.close();
  }
});

test("the status bar shows where jade/compact will compact", async () => {
  const { start } = await setup();
  g.__script = [{ content: [{ kind: "text", text: "answer", origin: MODEL, trust: "trusted" }], stopReason: "end", usage: { inputTokens: 300, outputTokens: 20 } }];
  const t = fakeTerminal();
  const host = await start();
  try {
    const done = host.service<Frontend>("frontend@1")!.run({ argv: ["hello"], sessions: host.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("answer"));
    await until(() => t.output().includes("compacts at"));
    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await host.close();
  }
});

test("@ completes a file path, and sending it attaches the file's content", async () => {
  const { cwd, start } = await setup();
  await writeFile(path.join(cwd, "readme.md"), "readme says hi\n");
  g.__script = [{ content: [{ kind: "text", text: "got it", origin: MODEL, trust: "trusted" }], stopReason: "end" }];
  g.__requests = [];

  const t = fakeTerminal();
  const host = await start();
  try {
    const frontend = host.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: [], sessions: host.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("Type / for commands"));

    await t.type("look at @read");
    // 候选来自工作目录
    await until(() => t.output().includes("readme.md"));
    await t.type("\r");
    await until(() => t.output().includes("look at @readme.md"));
    await t.type("\r");
    await until(() => t.output().includes("got it"));

    // jade/mentions 把文件内容附在那条消息上
    expect(JSON.stringify(g.__requests![0])).toContain("readme says hi");

    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await host.close();
  }
});

test("↑ takes queued messages back into the input; esc twice interrupts and moves them back too", async () => {
  const { start } = await setup();
  let release!: () => void;
  g.__hold = new Promise((r) => (release = r));
  g.__script = [
    { hold: true, content: [{ kind: "text", text: "first answer", origin: MODEL, trust: "trusted" }], stopReason: "end" },
    { content: [{ kind: "text", text: "second answer", origin: MODEL, trust: "trusted" }], stopReason: "end" },
    { hold: true, content: [{ kind: "text", text: "never shown", origin: MODEL, trust: "trusted" }], stopReason: "end" },
  ];
  g.__requests = [];

  const t = fakeTerminal();
  const host = await start();
  const ac = new AbortController();
  try {
    const frontend = host.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: [], sessions: host.sessions, signal: ac.signal });
    await until(() => t.output().includes("Type / for commands"));

    await t.type("first\r");
    await until(() => g.__requests!.length === 1);
    await t.type("second\r");
    await until(() => t.output().includes("queued: second"));
    expect(t.output()).toContain("↑ to edit queued messages");

    // ↑ 取回来改，不打断正在跑的一轮
    await t.type("\x1b[A");
    await t.type(" edited");
    release();
    await until(() => t.output().includes("first answer"));
    expect(g.__requests!.length).toBe(1);
    await t.type("\r");
    await until(() => t.output().includes("second answer"));
    expect(JSON.stringify(g.__requests![1])).toContain("second edited");

    // 再排一条，连按两次 esc：打断这一轮，排队的消息回到输入框而不是被删掉
    g.__hold = new Promise(() => {});
    await t.type("third\r");
    await until(() => g.__requests!.length === 3);
    await t.type("fourth\r");
    await until(() => t.output().includes("queued: fourth"));
    await t.type("\x1b");
    await until(() => t.output().includes("press esc again to edit it"));
    await t.type("\x1b");
    await until(() => t.output().includes("moved 1 queued message back to the input"));
    await until(() => t.output().includes("› fourth"));
    await sleep(300);
    expect(g.__requests!.length).toBe(3);

    ac.abort();
    expect(await done).toBe(130);
  } finally {
    await host.close();
  }
});

test("a message typed while the agent works reaches the model with the next request instead of waiting for the turn to end", async () => {
  const { start } = await setup();
  let release!: () => void;
  g.__hold = new Promise((r) => (release = r));
  g.__script = [
    { hold: true, content: [{ kind: "tool_use", id: "t1", name: "list_dir", input: { path: "." }, origin: MODEL, trust: "trusted" }], stopReason: "tool_use" },
    { content: [{ kind: "text", text: "both done", origin: MODEL, trust: "trusted" }], stopReason: "end" },
  ];
  g.__requests = [];

  const t = fakeTerminal();
  const host = await start();
  const ac = new AbortController();
  try {
    const frontend = host.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: [], sessions: host.sessions, signal: ac.signal });
    await until(() => t.output().includes("Type / for commands"));

    await t.type("look around\r");
    await until(() => g.__requests!.length === 1);
    await t.type("and count the files\r");
    await until(() => t.output().includes("queued: and count the files"));
    release();
    await until(() => t.output().includes("both done"));
    // 同一轮的第二次请求里就有这句话，排在工具结果后面；没有另起一轮
    expect(g.__requests!.length).toBe(2);
    const last = g.__requests![1]!.messages.at(-1)!;
    expect(last.content[0]!.kind).toBe("tool_result");
    expect(last.content.at(-1)!.text).toBe("and count the files");
    expect(t.output()).toContain("› and count the files (sent while working)");
    await sleep(200);
    expect(g.__requests!.length).toBe(2);

    ac.abort();
    expect(await done).toBe(130);
  } finally {
    await host.close();
  }
});

test("ctrl+g hands the terminal to the editor and puts what it saved back into the input", async () => {
  const { home, start } = await setup();
  // 假的编辑器：在文件末尾加一句就退出
  const script = path.join(home, "editor.mjs");
  await writeFile(script, `import { readFileSync, writeFileSync } from "node:fs";\nconst f = process.argv[2];\nwriteFileSync(f, readFileSync(f, "utf8") + " edited in the editor\\n");\n`);
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ "jade/prompts": { claudeInstructions: false }, "jade/editor": { editor: `"${process.execPath}" "${script}"` } }),
  );
  g.__script = [{ content: [{ kind: "text", text: "got it", origin: MODEL, trust: "trusted" }], stopReason: "end" }];
  g.__requests = [];

  const t = fakeTerminal();
  const host = await start();
  const ac = new AbortController();
  try {
    const frontend = host.service<Frontend>("frontend@1")!;
    const done = frontend.run({ argv: [], sessions: host.sessions, signal: ac.signal });
    await until(() => t.output().includes("Type / for commands"));
    const entered = () => t.raw().split("\x1b[?1049h").length - 1;
    const before = entered();

    await t.type("my draft");
    await t.type("\x07");
    // 让出终端（退出备用屏幕），编辑器退出后重新接管
    await until(() => entered() > before, 15_000);
    expect(t.raw()).toContain("\x1b[?1049l");
    await until(() => t.output().includes("my draft edited in the editor"));

    // 重新接管之后界面照常工作
    await t.type("\r");
    await until(() => t.output().includes("got it"));
    expect(JSON.stringify(g.__requests![0])).toContain("my draft edited in the editor");

    ac.abort();
    expect(await done).toBe(130);
  } finally {
    await host.close();
  }
}, 30_000);

test("a message, an approval dialog, slash commands and /exit through the terminal interface", async () => {
  const home = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-tui-")));
  tmp.push(home);
  const cwd = path.join(home, "work");
  await mkdir(cwd);
  const dir = path.join(home, "plugins", "fake-model");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }));
  await writeFile(path.join(dir, "index.mjs"), FAKE_MODEL);
  // 不读这台机器上的 ~/.claude/CLAUDE.md
  await writeFile(path.join(home, "config.json"), JSON.stringify({ "jade/prompts": { claudeInstructions: false } }));
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
    // "总是允许"管到什么只在正文里写一次，选项里只有范围
    expect(t.output()).toContain('"Always allow" covers: write_file');
    expect(t.output()).toContain("Always allow in this session");
    expect(t.output()).toContain("Always allow in this directory, in every session");
    await t.type("\r");
    await until(() => t.output().includes("Created hello.txt for you."));
    expect(await readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("hi\n");

    // !<命令>：用户自己执行，不经过模型（脚本里没有多的回复）
    await t.type("!echo from-$((40+2)); echo second");
    // 输入框上边框的右边说明这一行是 shell 命令
    await until(() => t.output().includes(" shell command "));
    await t.type("\r");
    // 结果和工具的结果一样收成一行，其余的折叠起来
    await until(() => t.output().includes("from-42 (+1 lines)"));

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

// 没配模型时怎么配由模型插件自己说（jade/models 在会话打开时提示）；前端自己不提 /model、.env，
// 只要保证插件在会话打开时的提示在第一屏上（打开会话会清屏）
test("without a model, the models plugin's hint shows on the first screen and the frontend adds none of its own", async () => {
  const { home, start } = await setup();
  // 换成没有配置模型的模型插件，会话打开时自己提示
  await writeFile(
    path.join(home, "plugins", "fake-model", "plugin.json"),
    JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], optional: ["ui@1"], replaces: ["jade/models"] }),
  );
  await writeFile(
    path.join(home, "plugins", "fake-model", "index.mjs"),
    `export default {
      process(ctx) {
        const complete = async () => { throw new Error("no model"); };
        ctx.provide("provider@1", { id: "none", complete });
        ctx.provide("models@1", { current: () => undefined, complete, list: async () => [] });
      },
      session(ctx) { ctx.service("ui@1")?.notify("set up a model with the fake plugin", "warning"); },
    };`,
  );
  const t = fakeTerminal();
  const host = await start();
  try {
    const done = host.service<Frontend>("frontend@1")!.run({ argv: [], sessions: host.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("set up a model with the fake plugin"));
    expect(t.output()).not.toContain("No model is configured");
    expect(t.output()).not.toContain("ANTHROPIC_API_KEY");
    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await host.close();
  }
});

test("the notice about loaded instruction files survives the screen clear when the session opens", async () => {
  const { cwd, start } = await setup();
  await writeFile(path.join(cwd, "AGENTS.md"), "Be brief.");
  const t = fakeTerminal();
  const host = await start();
  try {
    const done = host.service<Frontend>("frontend@1")!.run({ argv: [], sessions: host.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("Type / for commands"));
    await sleep(100);
    expect(t.output()).toContain("loaded instructions: AGENTS.md");
    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await host.close();
  }
});

test("a message that starts with a path is sent to the model, not run as a command", async () => {
  const { start } = await setup();
  g.__script = [{ content: [{ kind: "text", text: "path answer", origin: MODEL, trust: "trusted" }], stopReason: "end" }];
  const t = fakeTerminal();
  const host = await start();
  try {
    const done = host.service<Frontend>("frontend@1")!.run({ argv: [], sessions: host.sessions, signal: new AbortController().signal });
    await sleep(300);
    await t.type("/c/Users/me/a.ts has a bug");
    await t.type("\r");
    await until(() => t.output().includes("path answer"));
    expect(t.output()).not.toContain("unknown command");
    expect(g.__requests!.at(-1)!.messages.at(-1)!.content.some((b) => b.text === "/c/Users/me/a.ts has a bug")).toBe(true);
    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await host.close();
  }
});

test("/copy puts the last reply, or its last code block, on the clipboard as written", async () => {
  const { start } = await setup();
  const text = "Use this:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.";
  g.__script = [{ content: [{ kind: "text", text, origin: MODEL, trust: "trusted" }], stopReason: "end" }];
  const t = fakeTerminal();
  const host = await start();
  // OSC 52 里的内容
  const copied = () => [...t.raw().matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
  try {
    const done = host.service<Frontend>("frontend@1")!.run({ argv: ["hello"], sessions: host.sessions, signal: new AbortController().signal });
    await until(() => t.output().includes("Done."));
    await t.type("/copy");
    await t.type("\r");
    await until(() => copied().length === 1);
    await t.type("/copy code");
    await t.type("\r");
    await until(() => copied().length === 2);
    expect(copied()).toEqual([text, "const a = 1;\nconst b = 2;"]);
    await t.type("/exit");
    await t.type("\r");
    expect(await done).toBe(0);
  } finally {
    await host.close();
  }
});
