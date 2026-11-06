// jade/undo：/undo 恢复模型上一轮改过的文件。从旧 jade 的 test/experience.test.ts（turn-level undo）、
// test/jade.test.ts（writes save the previous content）移植；快照现在由 jade/undo 自己经 tool.before / tool.after 记下。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Message } from "uncarved";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "../plugins/commands/index.ts";
import { lastTurnChanges, type Checkpoint } from "../plugins/undo/checkpoint.ts";
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

  test("failed and denied writes leave nothing to undo", async () => {
    const { host, shared, send, run } = await setup();
    // a.txt 不存在：edit_file 失败
    shared.script.push(use("u1", "edit_file", { path: "a.txt", old_string: "x", new_string: "y" }), say("failed"));
    const s = await host.sessions.open();
    await send(s, "edit it");
    expect(plain(await run())).toBe("Nothing to undo.");
  });
});
