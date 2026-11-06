// jade/mentions：@ 引用的文件和目录随消息交给模型。从旧 jade 的 test/jade.test.ts、test/turns.test.ts（@ mentions）移植。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Renderers } from "../plugins/renderers/index.ts";
import { parseMentions } from "../plugins/mentions/attach.ts";
import { say, cleanup, scriptedHost, textOf } from "./scripted-ui.ts";

afterEach(cleanup);

const plain = (s: string | undefined) => s?.replace(/\x1b\[[0-9;]*m/g, "");

describe("jade/mentions", () => {
  test("parsing: quoted paths, trailing punctuation, duplicates, e-mail addresses", () => {
    expect(parseMentions('see @src/a.ts, @"my file.md" and @src/a.ts. mail a@b.c')).toEqual(["src/a.ts", "my file.md"]);
    expect(parseMentions("@first（中文）。")).toEqual(["first（中文"]);
  });

  test("referenced files and directories are attached to the message, read once and kept the same afterwards", async () => {
    const { cwd, host, shared, send } = await scriptedHost();
    await writeFile(path.join(cwd, "a.txt"), "hello from a\nsecond line\n");
    await mkdir(path.join(cwd, "sub"));
    await writeFile(path.join(cwd, "sub", "b.txt"), "b");
    shared.script.push(say("seen"), say("again"));
    const s = await host.sessions.open();
    await send(s, "look at @a.txt and @sub, not @nobody");

    const first = textOf(shared.requests[0]!.messages[0]!.content);
    expect(first).toStartWith("look at @a.txt and @sub, not @nobody");
    expect(first).toContain("The user referenced the file a.txt");
    expect(first).toContain("1\thello from a\n2\tsecond line");
    expect(first).toContain("The user referenced the directory sub. Its entries");
    expect(first).toContain("b.txt");
    const blocks = shared.requests[0]!.messages[0]!.content;
    expect(blocks.at(-1)!.origin).toEqual({ by: "plugin", id: "jade/mentions" });
    expect(blocks.at(-1)!.trust).toBe("untrusted");
    // 日志里的用户消息不变
    expect(s.state.messages[0]!.content).toHaveLength(1);

    const attached = (await s.history()).filter((e) => e.type === "jade/mentions/attached");
    expect(attached.map((e) => e.data)).toEqual([{ attached: ["a.txt", "sub"], failed: [] }]);
    const line = host.service<Renderers>("renderers@1")!.forEvent("jade/mentions/attached")!.renderer.render(attached[0]!.data)!.line;
    expect(plain(line)).toBe("[attached @a.txt, @sub]");

    // 文件之后变了：已经发出的消息里还是当时的内容（提示缓存不失效）
    await writeFile(path.join(cwd, "a.txt"), "changed\n");
    await send(s, "and now?");
    expect(textOf(shared.requests[1]!.messages[0]!.content)).toContain("1\thello from a");
    expect(textOf(shared.requests[1]!.messages[2]!.content)).toBe("and now?");

    // 恢复会话后也一样
    const id = s.id;
    await host.sessions.close();
    const resumed = await host.sessions.open({ resume: id });
    shared.script.push(say("resumed"));
    await send(resumed, "still there?");
    expect(textOf(shared.requests[2]!.messages[0]!.content)).toContain("1\thello from a");
  });

  test("a file that cannot be read is reported, not attached", async () => {
    const { cwd, host, shared, send } = await scriptedHost();
    await writeFile(path.join(cwd, "bin.dat"), Buffer.from([1, 0, 2, 0]));
    shared.script.push(say("ok"));
    const s = await host.sessions.open();
    await send(s, "what is @bin.dat?");
    expect(textOf(shared.requests[0]!.messages[0]!.content)).toBe("what is @bin.dat?");
    const [attached] = (await s.history()).filter((e) => e.type === "jade/mentions/attached");
    expect(attached!.data).toEqual({ attached: [], failed: [{ path: "bin.dat", reason: expect.stringContaining("binary file") }] });
  });
});
