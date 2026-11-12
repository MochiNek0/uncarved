// 文件工具（plugins/fs）：从旧 jade 的 test/jade.test.ts "fs tools" 和 test/tools.test.ts 移植。
// 检查点（undo、跨进程记住读过的文件）已经去掉，相关测试没有移植。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block, Tool, ToolContext } from "uncarved";
import { applyEditsToText, fsTools, nearMiss, SeenFiles } from "../plugins/fs/fs.ts";
import { validate } from "../plugins/approval/schema.ts";

// ---------- 辅助 ----------

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jade-fs-"));
  tmp.push(cwd);
  return cwd;
}

const ctx = (): ToolContext => ({
  sessionId: "s",
  toolUseId: "t",
  signal: new AbortController().signal,
  parent: { sessionId: "s", eventId: "e" },
  progress: () => {},
});

async function exec(tools: Tool[], name: string, input: unknown) {
  const r = await tools.find((t) => t.name === name)!.execute(input, ctx());
  return { text: typeof r.content === "string" ? r.content : "", blocks: typeof r.content === "string" ? [] : (r.content as Block[]), isError: r.isError ?? false };
}
const run = async (tools: Tool[], name: string, input: unknown) => {
  const { text, isError } = await exec(tools, name, input);
  return { text, isError };
};

// ---------- 读写改 ----------

describe("fs tools", () => {
  test("read, edit, write, glob, grep", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    await run(tools, "write_file", { path: "src/a.ts", content: "const a = 1;\nconst b = 2;\n" });
    expect((await run(tools, "read_file", { path: "src/a.ts" })).text).toBe("1\tconst a = 1;\n2\tconst b = 2;");
    expect((await run(tools, "read_file", { path: "src/a.ts", offset: 2, limit: 1 })).text).toBe("2\tconst b = 2;");

    expect((await run(tools, "edit_file", { path: "src/a.ts", old_string: "const", new_string: "let" })).isError).toBe(true);
    await run(tools, "edit_file", { path: "src/a.ts", old_string: "const b", new_string: "let b" });
    expect(await readFile(path.join(cwd, "src/a.ts"), "utf8")).toBe("const a = 1;\nlet b = 2;\n");

    expect((await run(tools, "glob", { pattern: "**/*.ts" })).text).toBe("src/a.ts");
    // 不含 / 的模式只匹配第一层：没命中时提示 **/
    expect((await run(tools, "glob", { pattern: "*.ts" })).text).toBe(`No files matched. "*.ts" only matches directly under the working directory; use "**/*.ts" to search at any depth.`);
    expect((await run(tools, "glob", { pattern: "src/*.js" })).text).toBe("No files matched");
    expect((await run(tools, "grep", { pattern: "let \\w", include: "**/*.ts" })).text).toBe("src/a.ts:2:let b = 2;");
  });

  test("edit_file matches LF text in a CRLF file", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "w.txt"), "one\r\ntwo\r\n");
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "w.txt" });
    const r = await run(tools, "edit_file", { path: "w.txt", old_string: "one\ntwo", new_string: "1\n2" });
    expect(r.isError).toBe(false);
    expect(await readFile(path.join(cwd, "w.txt"), "utf8")).toBe("1\r\n2\r\n");
  });

  test("edit_file turning one line into several in a CRLF file adds CRLF lines", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "w.txt"), "one\r\ntwo\r\n");
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "w.txt" });
    expect((await run(tools, "edit_file", { path: "w.txt", old_string: "one", new_string: "one\nhalf" })).isError).toBe(false);
    expect(await readFile(path.join(cwd, "w.txt"), "utf8")).toBe("one\r\nhalf\r\ntwo\r\n");
  });

  test("edit_file matches LF text across mixed line endings", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "m.txt"), "a\r\nb\nc\r\nd\r\n");
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "m.txt" });
    const r = await run(tools, "multi_edit", { path: "m.txt", edits: [{ old_string: "a\nb\nc", new_string: "x\ny" }] });
    expect(r.isError).toBe(false);
    expect(await readFile(path.join(cwd, "m.txt"), "utf8")).toBe("x\r\ny\r\nd\r\n");
  });

  test("edit_file keeps LF in an LF file even when old_string has CRLF", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "l.txt"), "a\nb\n");
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "l.txt" });
    expect((await run(tools, "edit_file", { path: "l.txt", old_string: "a\r\nb", new_string: "x\ny" })).isError).toBe(false);
    expect(await readFile(path.join(cwd, "l.txt"), "utf8")).toBe("x\ny\n");
  });

  test("edit_file replace_all treats $ in new_string literally", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "d.txt"), "foo foo");
    const tools = fsTools(cwd);
    await run(tools, "read_file", { path: "d.txt" });
    await run(tools, "edit_file", { path: "d.txt", old_string: "foo", new_string: "$&$1", replace_all: true });
    expect(await readFile(path.join(cwd, "d.txt"), "utf8")).toBe("$&$1 $&$1");
  });

  test("read_file rejects a non-positive limit; write_file counts lines like read_file", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    await writeFile(path.join(cwd, "e.txt"), "1\n2\n");
    expect(await run(tools, "read_file", { path: "e.txt", limit: 0 })).toEqual({ text: "limit must be at least 1", isError: true });
    expect((await run(tools, "write_file", { path: "f.txt", content: "x\ny\n" })).text).toBe("Wrote 2 lines to f.txt");
    expect((await run(tools, "write_file", { path: "g.txt", content: "x\r\ny" })).text).toBe("Wrote 2 lines to g.txt");
    expect((await run(tools, "write_file", { path: "h.txt", content: "" })).text).toBe("Wrote 0 lines to h.txt");
  });

  test("changing an existing file requires reading it first, and refuses if it changed since", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    const file = path.join(cwd, "s.txt");
    await writeFile(file, "a\n");

    const unread = await run(tools, "edit_file", { path: "s.txt", old_string: "a", new_string: "b" });
    expect(unread).toMatchObject({ isError: true, text: expect.stringContaining("has not been read") });
    expect((await run(tools, "write_file", { path: "s.txt", content: "z" })).isError).toBe(true);

    await run(tools, "read_file", { path: "s.txt" });
    expect((await run(tools, "edit_file", { path: "s.txt", old_string: "a", new_string: "b" })).isError).toBe(false);
    // 自己的写入不算"被别人改过"
    expect((await run(tools, "edit_file", { path: "s.txt", old_string: "b", new_string: "c" })).isError).toBe(false);

    await writeFile(file, "someone else's change\n");
    const stale = await run(tools, "edit_file", { path: "s.txt", old_string: "c", new_string: "d" });
    expect(stale).toMatchObject({ isError: true, text: expect.stringContaining("modified since it was last read") });
    expect(await readFile(file, "utf8")).toBe("someone else's change\n");
  });

  // 旧版本靠检查点跨进程记住读过、写过的文件；现在只在本进程内有效，新的 fsTools（恢复的会话）要重新读
  test("files read or written by another fsTools instance must be read again", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "r.txt"), "read\n");
    const before = fsTools(cwd);
    await run(before, "write_file", { path: "w.txt", content: "mine\n" });
    await run(before, "read_file", { path: "r.txt" });

    const after = fsTools(cwd);
    expect(await run(after, "write_file", { path: "w.txt", content: "mine again\n" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("has not been read"),
    });
    expect(await run(after, "edit_file", { path: "r.txt", old_string: "read", new_string: "edited" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("has not been read"),
    });
    // 同样的内容重复写入不算覆盖
    expect((await run(after, "write_file", { path: "w.txt", content: "mine\n" })).isError).toBe(false);
  });

  test("a read in the same response as the change does not count", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "q.txt"), "a\n");
    const responses = { calls: 1 };
    const tools = fsTools(cwd, { responses });
    await run(tools, "read_file", { path: "q.txt" });
    expect(await run(tools, "write_file", { path: "q.txt", content: "b\n" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("same response"),
    });
    responses.calls++;
    // 下一次回复里又读了一遍：之前那次读取仍然有效
    await run(tools, "read_file", { path: "q.txt" });
    expect((await run(tools, "write_file", { path: "q.txt", content: "b\n" })).isError).toBe(false);
    // 自己写的内容模型知道，同一次回复里接着改没问题
    expect((await run(tools, "edit_file", { path: "q.txt", old_string: "b", new_string: "c" })).isError).toBe(false);
  });

  test("files whose read was compacted out of the projection must be read again", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "a.txt"), "a\n");
    await writeFile(path.join(cwd, "b.txt"), "b\n");
    const seen = new SeenFiles();
    const tools = fsTools(cwd, { seen });
    const call = (id: string, name: string, input: unknown) => tools.find((t) => t.name === name)!.execute(input, { ...ctx(), toolUseId: id });
    await call("r1", "read_file", { path: "a.txt" });
    await call("r2", "read_file", { path: "b.txt" });
    // edit_file 不算重新知道整个文件：仍然以 r1 那次读取为准
    expect((await call("e1", "edit_file", { path: "a.txt", old_string: "a", new_string: "A" })).isError).toBeFalsy();

    const use = (id: string): Block => ({ kind: "tool_use", id, name: "read_file", input: {}, origin: { by: "model", provider: "p", model: "m" }, trust: "trusted" });
    const result = (id: string, by: "tool" | "plugin"): Block => ({
      kind: "tool_result",
      toolUseId: id,
      isError: false,
      content: [{ kind: "text", text: "…", origin: by === "tool" ? { by: "tool", name: "read_file" } : { by: "plugin", id: "jade/compact" }, trust: "trusted" }],
      origin: { by: "tool", name: "read_file" },
      trust: "trusted",
    });
    // 两次读取都还在投影里：照常可以改
    seen.prune([
      { role: "assistant", content: [use("r1"), use("r2")] },
      { role: "user", content: [result("r1", "tool"), result("r2", "tool")] },
    ]);
    expect((await call("e2", "edit_file", { path: "b.txt", old_string: "b", new_string: "B" })).isError).toBeFalsy();
    // r1 被总结掉、r2 的输出被清理：都要重新读，并说明原因
    seen.prune([
      { role: "assistant", content: [use("r2")] },
      { role: "user", content: [result("r2", "plugin")] },
    ]);
    for (const p of ["a.txt", "b.txt"]) {
      const r = await call("w", "write_file", { path: p, content: "x\n" });
      expect(r).toMatchObject({ isError: true, content: expect.stringContaining("compacted out of the conversation") });
    }
    await call("r3", "read_file", { path: "a.txt" });
    expect((await call("w2", "write_file", { path: "a.txt", content: "x\n" })).isError).toBeFalsy();
  });

  test("read_file returns images as image blocks and refuses other binary files", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    await writeFile(path.join(cwd, "b.bin"), Buffer.from([1, 0, 2]));
    const tools = fsTools(cwd);
    const img = await tools.find((t) => t.name === "read_file")!.execute({ path: "p.png" }, ctx());
    expect(img.content).toEqual([
      expect.objectContaining({ kind: "image", source: { type: "base64", media_type: "image/png", data: "iVBORwAB" } }),
    ]);
    expect(await run(tools, "read_file", { path: "b.bin" })).toMatchObject({ isError: true, text: expect.stringContaining("binary file") });
  });

  test("read_file returns a PDF as a document block", async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "doc.pdf"), "%PDF-1.4\n\0binary");
    const r = await exec(fsTools(cwd), "read_file", { path: "doc.pdf" });
    expect(r.blocks[0]).toMatchObject({ kind: "document", source: { type: "base64", media_type: "application/pdf" }, trust: "untrusted" });
  });

  test("glob and grep skip files ignored by git", async () => {
    const cwd = await workspace();
    Bun.spawnSync(["git", "init", "-q"], { cwd });
    await mkdir(path.join(cwd, "dist"));
    await writeFile(path.join(cwd, ".gitignore"), "dist/\n");
    await writeFile(path.join(cwd, "a.ts"), "needle\n");
    await writeFile(path.join(cwd, "dist", "a.js"), "needle\n");
    const tools = fsTools(cwd);
    expect((await run(tools, "glob", { pattern: "**/*.*s" })).text).toBe("a.ts");
    expect((await run(tools, "grep", { pattern: "needle" })).text).toBe("a.ts:1:needle");
  });
});

// ---------- grep ----------

/** 有 ripgrep 时两条路径都测；JADE_TEST_RG 可以指定不在 PATH 上的 ripgrep */
const RG = process.env.JADE_TEST_RG ?? Bun.which("rg");
const variants: Array<[string, string | null]> = [["js", null], ...(RG ? ([["ripgrep", RG]] as Array<[string, string]>) : [])];

describe.each(variants)("grep (%s)", (_name, rg) => {
  async function repo() {
    const cwd = await workspace();
    await writeFile(path.join(cwd, "a.ts"), "one\nfoo two\nthree\nfour\nfive\nfoo six\n");
    await writeFile(path.join(cwd, "b.md"), "no match here\nfoo\n");
    return { cwd, tools: fsTools(cwd, { rg }) };
  }

  test("content, files and count modes", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "foo", include: "**/*.ts" })).text).toBe("a.ts:2:foo two\na.ts:6:foo six");
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "files" })).text).toBe("a.ts\nb.md");
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "files_with_matches" })).text).toBe("a.ts\nb.md");
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "count" })).text).toBe("a.ts:2\nb.md:1");
    expect((await exec(tools, "grep", { pattern: "nothing" })).text).toBe("No matches");
  });

  test("head_limit and glob, the names other tools use", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "foo", glob: "*.ts" })).text).toBe("a.ts:2:foo two\na.ts:6:foo six");
    expect((await exec(tools, "grep", { pattern: "foo", head_limit: 2 })).text).toBe("a.ts:2:foo two\na.ts:6:foo six\n(showing the first 2 of 3 lines)");
    expect((await exec(tools, "grep", { pattern: "foo", head_limit: "1", output_mode: "files" })).text).toBe("a.ts\n(showing the first 1 of 2 lines)");
    expect((await exec(tools, "grep", { pattern: "foo", head_limit: 3 })).text).toBe("a.ts:2:foo two\na.ts:6:foo six\nb.md:2:foo");
    const grep = tools.find((t) => t.name === "grep")!;
    expect(validate(grep.inputSchema, { pattern: "foo", head_limit: "30", glob: "*.ts" })).toBeUndefined();
  });

  test("context lines, with -- between groups", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "foo", path: "a.ts", context: 1 })).text).toBe(
      ["a.ts-1-one", "a.ts:2:foo two", "a.ts-3-three", "--", "a.ts-5-five", "a.ts:6:foo six"].join("\n"),
    );
  });

  test("include without a slash matches files at any depth", async () => {
    const { cwd, tools } = await repo();
    await mkdir(path.join(cwd, "src", "deep"), { recursive: true });
    await writeFile(path.join(cwd, "src", "deep", "c.ts"), "foo deep\n");
    expect((await exec(tools, "grep", { pattern: "foo", include: "*.ts", output_mode: "files" })).text).toBe(["a.ts", "src/deep/c.ts"].join("\n"));
  });

  test("files come out sorted by path, however many there are", async () => {
    const { cwd, tools } = await repo();
    const names = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`);
    await Promise.all(names.map((n) => writeFile(path.join(cwd, n), "foo\nbar foo\n")));
    const all = ["a.ts", "b.md", ...names];
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "files" })).text).toBe(all.join("\n"));
    expect((await exec(tools, "grep", { pattern: "foo", output_mode: "count" })).text).toBe(all.map((n) => `${n}:${n === "b.md" ? 1 : 2}`).join("\n"));
    expect((await exec(tools, "grep", { pattern: "bar" })).text).toBe(names.map((n) => `${n}:2:bar foo`).join("\n"));
  });

  test("JavaScript-only syntax such as lookbehind still works", async () => {
    const { tools } = await repo();
    expect((await exec(tools, "grep", { pattern: "(?<=foo )six" })).text).toBe("a.ts:6:foo six");
  });
});

// ---------- edit ----------

describe("edit hints and multi_edit", () => {
  test("nearMiss points at lines that match when whitespace is ignored", () => {
    const text = "function f() {\n\treturn 1;\n}\n";
    expect(nearMiss(text, "function f() {\n    return 1;\n}")).toContain("lines 1-3 if whitespace is ignored");
    expect(nearMiss(text, "function f() {\n  return 2;\n}")).toContain('first line "function f() {" appears at line 1');
    expect(nearMiss(text, "something else")).toBe("");
  });

  test("nearMiss recognizes read_file's line-number prefixes copied into old_string", () => {
    const text = "function f() {\n\treturn 1;\n}\n";
    expect(nearMiss(text, "1\tfunction f() {\n2\t\treturn 1;")).toContain("line-number prefixes");
    // 只有部分行像行号时不算
    expect(nearMiss(text, "1\tfunction f() {\nreturn 1;")).not.toContain("line-number prefixes");
  });

  test("a non-unique old_string reports where it occurs", () => {
    const text = "a\nx = 1\nb\nx = 1\nc\nx = 1\n";
    expect(applyEditsToText(text, [{ old_string: "x = 1", new_string: "x = 2" }], "f.ts")).toBe(
      "old_string occurs 3 times in f.ts (lines 2, 4, 6); add context to make it unique or set replace_all",
    );
    const many = "y\n".repeat(7);
    expect(applyEditsToText(many, [{ old_string: "y", new_string: "z" }], "f.ts")).toContain("(lines 1, 2, 3, 4, 5, …)");
  });

  test("edit_file explains a near miss", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    await writeFile(path.join(cwd, "a.ts"), "if (x) {\n\tgo();\n}\n");
    await exec(tools, "read_file", { path: "a.ts" });
    const r = await exec(tools, "edit_file", { path: "a.ts", old_string: "if (x) {\n  go();", new_string: "if (y) {\n  go();" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("lines 1-2 if whitespace is ignored");
  });

  test("multi_edit applies edits in order, and none of them if one fails", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    const file = path.join(cwd, "a.ts");
    await writeFile(file, "a = 1\nb = 2\n");
    await exec(tools, "read_file", { path: "a.ts" });
    const ok = await exec(tools, "multi_edit", {
      path: "a.ts",
      edits: [
        { old_string: "a = 1", new_string: "a = 10" },
        { old_string: "a = 10\nb", new_string: "a = 10\nc" },
      ],
    });
    expect(ok).toMatchObject({ isError: false, text: "Edited a.ts (2 replacements)" });
    expect(await readFile(file, "utf8")).toBe("a = 10\nc = 2\n");

    const bad = await exec(tools, "multi_edit", {
      path: "a.ts",
      edits: [
        { old_string: "a = 10", new_string: "a = 11" },
        { old_string: "missing", new_string: "x" },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toStartWith("edit 2 of 2: old_string not found");
    expect(await readFile(file, "utf8")).toBe("a = 10\nc = 2\n");
  });
});

describe("files that are not UTF-8", () => {
  // "中文" 加一个换行的 GBK 编码
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);

  test("read_file shows them decoded but edit_file and write_file leave the bytes alone", async () => {
    const cwd = await workspace();
    const file = path.join(cwd, "a.txt");
    await writeFile(file, gbk);
    const tools = fsTools(cwd);
    const read = await run(tools, "read_file", { path: "a.txt" });
    expect(read.isError).toBe(false);
    expect(read.text).toStartWith("1\t中文\n");
    expect(read.text).toContain("not valid UTF-8");
    const edit = await run(tools, "edit_file", { path: "a.txt", old_string: "中文", new_string: "x" });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain("not valid UTF-8");
    const write = await run(tools, "write_file", { path: "a.txt", content: "x\n" });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("not valid UTF-8");
    expect(await readFile(file)).toEqual(gbk);
  });
});

describe("line endings and large files", () => {
  test("write_file keeps CRLF and BOM of the file it overwrites", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    const file = path.join(cwd, "a.txt");
    await writeFile(file, "﻿one\r\ntwo\r\n");
    await exec(tools, "read_file", { path: "a.txt" });
    await exec(tools, "write_file", { path: "a.txt", content: "one\nthree\n" });
    expect(await readFile(file, "utf8")).toBe("﻿one\r\nthree\r\n");
  });

  test("edit_file matches LF text in a file with mixed line endings", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    const file = path.join(cwd, "a.txt");
    await writeFile(file, "a\r\nb\nc\n");
    await exec(tools, "read_file", { path: "a.txt" });
    const r = await exec(tools, "edit_file", { path: "a.txt", old_string: "b\nc", new_string: "b\nd" });
    expect(r.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("a\r\nb\nd\n");
  });

  test("read_file caps the total size and marks cut lines", async () => {
    const cwd = await workspace();
    const tools = fsTools(cwd);
    await writeFile(path.join(cwd, "big.txt"), `${"x".repeat(3000)}\n${Array.from({ length: 1500 }, () => "y".repeat(100)).join("\n")}\n`);
    const r = await exec(tools, "read_file", { path: "big.txt" });
    expect(r.text.split("\n")[0]).toEndWith("… [line truncated: 3000 characters]");
    expect(r.text.length).toBeLessThan(110_000);
    expect(r.text).toMatch(/output capped at about 100000 characters: showing lines 1-\d+ of 1501; continue with offset \d+\)$/);
  });
});
