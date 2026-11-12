// jade/undo：/undo 恢复模型上一轮改过的文件。从旧 jade 的 test/experience.test.ts（turn-level undo）、
// test/jade.test.ts（writes save the previous content）移植；快照现在由 jade/undo 自己经 tool.before / tool.after 记下。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Message } from "uncarved";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "@uncarved/jade-api/services";
import { lastTurnChanges, turnToolNames, type Checkpoint } from "../plugins/undo/checkpoint.ts";
import { say, cleanup, scriptedHost, textOf, use } from "./scripted-ui.ts";

afterEach(cleanup);

const plain = (s: unknown) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

describe("turn-level undo", () => {
  const text = (t: string, by: "user" | "plugin" = "user"): Block =>
    ({ kind: "text", text: t, origin: by === "user" ? { by } : { by, id: "jade/continue" }, trust: "trusted" }) as Block;
  const useBlock = (id: string): Block => ({ kind: "tool_use", id, name: "edit_file", input: {}, origin: { by: "model" }, trust: "trusted" }) as Block;
  const result = (id: string): Block => ({ kind: "tool_result", toolUseId: id, content: [], isError: false, origin: { by: "tool", name: "edit_file" }, trust: "trusted" }) as Block;
  const cp = (toolUseId: string, file: string, at: number): Checkpoint => ({ toolUseId, tool: "edit_file", path: file, before: "", afterHash: "", at });

  const messages: Message[] = [
    { role: "user", content: [text("first")] },
    { role: "assistant", content: [useBlock("a")] },
    { role: "user", content: [result("a")] },
    { role: "assistant", content: [text("done")] },
    { role: "user", content: [text("second")] },
    { role: "assistant", content: [useBlock("b"), useBlock("c")] },
    { role: "user", content: [result("b"), result("c")] },
    // 输出被截断后插件让模型继续：仍是同一轮
    { role: "user", content: [text("[Note from jade] continue", "plugin")] },
    { role: "assistant", content: [useBlock("d")] },
    { role: "user", content: [result("d")] },
    { role: "assistant", content: [text("done")] },
    { role: "user", content: [text("just a question")] },
    { role: "assistant", content: [text("answer")] },
  ];
  // list() 的顺序：最新的在前
  const cps = [cp("d", "/x", 4), cp("c", "/y", 3), cp("b", "/x", 2), cp("a", "/z", 1)];

  test("undoes the most recent turn that changed files, then the one before", () => {
    expect(lastTurnChanges(messages, cps, new Set()).map((c) => c.toolUseId)).toEqual(["d", "c", "b"]);
    expect(lastTurnChanges(messages, cps, new Set(["d", "c", "b"])).map((c) => c.toolUseId)).toEqual(["a"]);
    expect(lastTurnChanges(messages, cps, new Set(["d", "c", "b", "a"]))).toEqual([]);
  });

  test("a partly undone turn finishes first", () => {
    expect(lastTurnChanges(messages, cps, new Set(["d"])).map((c) => c.toolUseId)).toEqual(["c", "b"]);
  });

  test("turnToolNames lists the tools of the turn holding a call, or of the last turn", () => {
    const msgs: Message[] = [
      { role: "user", content: [text("first")] },
      { role: "assistant", content: [{ ...useBlock("a"), name: "bash" } as Block, useBlock("b")] },
      { role: "user", content: [result("a"), result("b")] },
      { role: "user", content: [text("second")] },
      { role: "assistant", content: [useBlock("c")] },
    ];
    expect([...turnToolNames(msgs, "b")].sort()).toEqual(["bash", "edit_file"]);
    expect([...turnToolNames(msgs, "c")]).toEqual(["edit_file"]);
    expect([...turnToolNames(msgs)]).toEqual(["edit_file"]);
    expect([...turnToolNames(msgs, "missing")]).toEqual([]);
  });
});

describe("jade/undo in a session", () => {
  async function setup() {
    const w = await scriptedHost();
    const undo = w.host.service<Commands>("commands@1")!.get("undo")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: w.host.service<UI>("ui@1")!, sessions: w.host.sessions, print: () => {} };
    return { ...w, run: () => undo.run("", c) };
  }

  test("/undo restores the files of the last turn, then the turn before, and tells the model", async () => {
    const { cwd, host, shared, send, run } = await setup();
    const a = path.join(cwd, "a.txt");
    shared.script.push(
      // 第一轮：新建
      use("u1", "write_file", { path: "a.txt", content: "one\n" }),
      say("created"),
      // 第二轮：读了再改
      use("u2", "read_file", { path: "a.txt" }),
      use("u3", "edit_file", { path: "a.txt", old_string: "one", new_string: "two" }),
      say("edited"),
    );
    const s = await host.sessions.open();
    await send(s, "create a.txt");
    await send(s, "change it");
    expect(await readFile(a, "utf8")).toBe("two\n");

    expect(plain(await run())).toContain("Undid 1 change from the last turn:\n  restore a.txt");
    expect(await readFile(a, "utf8")).toBe("one\n");
    // 再撤销一轮：模型新建的文件删掉
    expect(plain(await run())).toContain("delete  a.txt");
    expect(existsSync(a)).toBe(false);
    expect(plain(await run())).toBe("Nothing to undo.");
    // 只改一个、没被别人改过的文件时不问
    expect(shared.asked).toEqual([]);

    shared.script.push(say("ok"));
    await send(s, "what now?");
    const notes = textOf(shared.requests.at(-1)!.messages.at(-1)!.content);
    expect(notes).toContain("[Note from jade] The user undid your changes from your last turn: restored a.txt to its content before your changes");
    expect(notes).toContain("deleted a.txt (you had created it)");
  });

  test("asks before discarding changes made after the agent wrote the file; no means nothing is restored", async () => {
    const { cwd, host, shared, send, run } = await setup();
    const a = path.join(cwd, "a.txt");
    shared.script.push(use("u1", "write_file", { path: "a.txt", content: "agent\n" }), say("done"));
    const s = await host.sessions.open();
    await send(s, "write it");
    await writeFile(a, "user edit\n");
    shared.answers.push("no");
    expect(await run()).toBeUndefined();
    expect(shared.asked).toEqual(["a.txt changed since the agent wrote it. Undo anyway and discard those changes too?"]);
    expect(await readFile(a, "utf8")).toBe("user edit\n");
    shared.answers.push("yes");
    expect(plain(await run())).toContain("Undid 1 change");
    expect(existsSync(a)).toBe(false);
  });

  test("says that shell commands of the undone turn are not undone", async () => {
    const { host, shared, send, run } = await setup();
    shared.script.push(use("u1", "bash", { command: "echo hi" }), use("u2", "write_file", { path: "a.txt", content: "x" }), say("done"));
    const s = await host.sessions.open();
    await send(s, "do it");
    expect(plain(await run())).toContain("This turn also ran shell commands; what they changed is not undone.");
  });

  test("in a git repository /undo also restores what the turn's shell commands changed, and leaves the project's own git alone", async () => {
    const { cwd, host, shared, send, run } = await setup();
    const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd }).stdout.toString();
    git("init", "-q");
    await writeFile(path.join(cwd, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(cwd, "kept.txt"), "original\r\nline\n");
    await writeFile(path.join(cwd, "removed.txt"), "will be removed\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const status = git("status", "--porcelain");
    shared.script.push(
      // 命令之前文件工具建的文件，命令之后又被命令改了
      use("u1", "write_file", { path: "made.txt", content: "by tool\n" }),
      use("u2", "bash", { command: "printf 'changed\\n' > kept.txt && rm removed.txt && printf 'new\\n' > added.txt && printf 'x\\n' >> made.txt && printf 'i\\n' > ignored.txt" }),
      say("done"),
    );
    const s = await host.sessions.open();
    await send(s, "do it");
    expect(await readFile(path.join(cwd, "kept.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(path.join(cwd, "removed.txt"))).toBe(false);

    shared.answers.push("yes");
    const out = plain(await run());
    expect(shared.asked.at(-1)).toContain("It ran shell commands");
    expect(out).toContain("Undid the last turn (4 files):");
    expect(out).not.toContain("is not undone");
    // 原样恢复，换行也不变
    expect(await readFile(path.join(cwd, "kept.txt"), "utf8")).toBe("original\r\nline\n");
    expect(await readFile(path.join(cwd, "removed.txt"), "utf8")).toBe("will be removed\n");
    expect(existsSync(path.join(cwd, "added.txt"))).toBe(false);
    // 文件工具在命令之前建的文件也撤销了
    expect(existsSync(path.join(cwd, "made.txt"))).toBe(false);
    // 被忽略的文件不在快照里
    expect(existsSync(path.join(cwd, "ignored.txt"))).toBe(true);
    // 项目自己的 git 没动过：暂存区和提交都是原样
    expect(git("status", "--porcelain")).toBe(status);
    expect(plain(await run())).toBe("Nothing to undo.");
  }, 30_000);

  test("failed and denied writes leave nothing to undo", async () => {
    const { host, shared, send, run } = await setup();
    // a.txt 不存在：edit_file 失败
    shared.script.push(use("u1", "edit_file", { path: "a.txt", old_string: "x", new_string: "y" }), say("failed"));
    const s = await host.sessions.open();
    await send(s, "edit it");
    expect(plain(await run())).toBe("Nothing to undo.");
  });
});

// 认工具靠注册时给的 meta，不认名字：换掉 jade/fs（比如换成别的写文件工具）/undo 照样能用
describe("tools are recognised by their meta, not their name", () => {
  /** 一个用户层插件，注册一个写文件的工具：名字是 put，路径在 file 字段里 */
  const PATCHER = (meta: string) => `import { writeFileSync } from "node:fs";
import path from "node:path";
export default { session(ctx) {
  ctx.kernel.tool({
    name: "put", description: "write text to a file", effect: "write", concurrency: "exclusive", idempotent: true,
    inputSchema: { type: "object", properties: { file: { type: "string" }, text: { type: "string" } }, required: ["file", "text"] },
    meta: ${meta},
    execute: async (input) => { writeFileSync(path.resolve(ctx.cwd, input.file), input.text); return { content: "written" }; },
  });
} };`;

  async function withPatcher(meta: string) {
    const w = await scriptedHost();
    const dir = path.join(w.home, "plugins", "patcher");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "test/patcher", version: "1.0.0", api: "^1", entry: "index.mjs" }));
    await writeFile(path.join(dir, "index.mjs"), PATCHER(meta));
    await w.host.close();
    const host = await w.restart();
    return { ...w, host };
  }

  test("/undo restores a file written by a tool with another name that declares meta.writes", async () => {
    const { cwd, host, shared, send } = await withPatcher(`{ writes: "file" }`);
    const b = path.join(cwd, "b.txt");
    await writeFile(b, "old");
    shared.script.push(use("u1", "put", { file: "b.txt", text: "new" }), say("done"));
    const s = await host.sessions.open();
    expect(s.tool("put")?.meta).toEqual({ writes: "file" });
    expect(s.tool("bash")?.meta).toEqual({ shell: "command" });
    expect(s.tool("write_file")?.meta).toEqual({ writes: "path" });
    expect(s.tool("missing")).toBeUndefined();
    await send(s, "change b");
    expect(await readFile(b, "utf8")).toBe("new");
    const undo = host.service<Commands>("commands@1")!.get("undo")!.command;
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    expect(plain(await undo.run("", c))).toContain("restore b.txt");
    expect(await readFile(b, "utf8")).toBe("old");
  });

  test("a tool with malformed meta keeps its plugin out of the session and says why", async () => {
    const { host, reports } = await withPatcher(`{ writes: 3 }`);
    const s = await host.sessions.open();
    expect(s.tool("put")).toBeUndefined();
    expect(reports.join(" ")).toContain("plugin test/patcher did not join session");
    expect(reports.join(" ")).toContain("tool put: meta.writes must be the name of an input field");
  });
});
