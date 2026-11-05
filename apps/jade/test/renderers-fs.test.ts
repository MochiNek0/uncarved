// 文件工具的显示（plugins/fs/renderers.ts、diff.ts）：从旧 jade 的 test/experience.test.ts、transcript.test.ts 移植。
// 审批插件把 path 换成绝对路径，所以每种情况都用绝对路径再测一遍。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffLines, diffStats, hunks, renderDiff } from "../plugins/fs/diff.ts";
import { fsRenderers } from "../plugins/fs/renderers.ts";
import type { ToolRenderer } from "../plugins/renderers/index.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jade-render-"));
  tmp.push(cwd);
  await writeFile(path.join(cwd, "a.ts"), "one\ntwo\nthree\n");
  const r = (tool: string): ToolRenderer => fsRenderers(cwd).find((x) => x.tool === tool)!;
  return { cwd, r, abs: path.join(cwd, "a.ts") };
}

describe("diff", () => {
  test("line numbers, context and stats", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
    const after = before.replace("e\n", "E\nE2\n");
    const lines = diffLines(before, after);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    const h = hunks(lines);
    expect(h).toHaveLength(1);
    // 三行上下文：b c d - e + E + E2 f g h
    expect(h[0]!.map((l) => `${l.kind}${l.text}`)).toEqual([" b", " c", " d", "-e", "+E", "+E2", " f", " g", " h"]);
    const shown = plain(renderDiff(before, after));
    expect(shown).toContain(" 5 - e");
    expect(shown).toContain(" 5 + E");
    expect(shown).toContain(" 6 + E2");
    expect(shown).toContain("+2 -1");
  });

  test("distant changes become separate hunks", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 2\n", "two\n").replace("line 28\n", "twenty-eight\n");
    expect(hunks(diffLines(before, after))).toHaveLength(2);
    expect(plain(renderDiff(before, after))).toContain("⋯");
  });

  test("identical and empty texts; CRLF compares equal to LF", () => {
    expect(diffStats(diffLines("x\n", "x\n"))).toEqual({ added: 0, removed: 0 });
    expect(plain(renderDiff("x", "x"))).toContain("no changes");
    expect(diffStats(diffLines("", "a\nb\n"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines("a\r\nb\r\n", "a\nb\n"))).toEqual({ added: 0, removed: 0 });
  });

  test("long diffs are cut at maxLines", () => {
    const after = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    const shown = plain(renderDiff("", after, 10));
    expect(shown).toContain("… 90 more lines");
    expect(shown).toContain("+100 -0");
  });
});

describe("summaries", () => {
  test("paths are shown relative to the working directory, also when given absolute", async () => {
    const { cwd, r, abs } = await workspace();
    for (const p of ["a.ts", abs]) {
      expect(r("read_file").summary!({ path: p })).toBe("a.ts");
      expect(r("edit_file").summary!({ path: p, old_string: "x", new_string: "y" })).toBe("a.ts");
      expect(r("write_file").summary!({ path: p, content: "" })).toBe("a.ts");
      expect(r("multi_edit").summary!({ path: p, edits: [{}, {}] })).toBe("a.ts, 2 edits");
    }
    expect(r("list_dir").summary!({ path: path.join(cwd, "src") })).toBe("src");
    // 工作目录外的保留绝对路径
    const outside = path.resolve(cwd, "..", "elsewhere.txt");
    expect(r("read_file").summary!({ path: outside })).toBe(outside.split(path.sep).join("/"));
  });

  test("grep and glob show the pattern and where, unless it is the working directory", async () => {
    const { cwd, r } = await workspace();
    expect(r("grep").summary!({ pattern: "port" })).toBe("port");
    expect(r("grep").summary!({ pattern: "port", path: cwd })).toBe("port");
    expect(r("grep").summary!({ pattern: "port", path: path.join(cwd, "src") })).toBe("port in src");
    expect(r("glob").summary!({ pattern: "**/*.ts", path: "lib" })).toBe("**/*.ts in lib");
  });

  test("odd input does not throw", async () => {
    const { r } = await workspace();
    expect(r("read_file").summary!(null)).toBe("");
    expect(r("multi_edit").summary!({ path: "a.ts" })).toBe("a.ts, 0 edits");
  });
});

describe("approval preview", () => {
  test("edit_file shows a numbered diff of the real file; a failing edit says so", async () => {
    const { r, abs } = await workspace();
    const preview = async (tool: string, input: unknown) => plain((await r(tool).preview!(input))!);
    for (const p of ["a.ts", abs]) {
      const ok = await preview("edit_file", { path: p, old_string: "two", new_string: "TWO" });
      expect(ok).toContain("2 - two");
      expect(ok).toContain("2 + TWO");
      expect(ok).toContain("1   one");
      const bad = await preview("edit_file", { path: p, old_string: "four", new_string: "4" });
      expect(bad).toContain("- four");
      expect(bad).toContain("+ 4");
      expect(bad).toContain("this edit will fail: old_string not found in a.ts");
      const overwrite = await preview("write_file", { path: p, content: "one\n" });
      expect(overwrite).toContain("overwrites");
      expect(overwrite).toContain("+0 -2");
    }
  });

  test("multi_edit applies the edits in order", async () => {
    const { r, abs } = await workspace();
    const edits = [
      { old_string: "one", new_string: "1" },
      { old_string: "1\ntwo", new_string: "1\n2" },
    ];
    const shown = plain((await r("multi_edit").preview!({ path: abs, edits }))!);
    expect(shown).toContain("1 + 1");
    expect(shown).toContain("2 + 2");
    expect(shown).toContain("+2 -2");
  });

  test("a new file shows its content; a missing file falls back to the edit's text", async () => {
    const { cwd, r } = await workspace();
    const created = plain((await r("write_file").preview!({ path: path.join(cwd, "new.txt"), content: "hello\nworld" }))!);
    expect(created).toBe("+ hello\n+ world");
    const missing = plain((await r("edit_file").preview!({ path: path.join(cwd, "gone.ts"), old_string: "a", new_string: "b" }))!);
    expect(missing).toBe("- a\n+ b");
  });
});

describe("result", () => {
  test("an edit shows the added and removed lines, the full diff when expanded", async () => {
    const { r, abs } = await workspace();
    const input = { path: abs, old_string: "two", new_string: "TWO\nmore" };
    const before = r("edit_file").before!(input);
    const res = r("edit_file").result!({ toolUseId: "e1", input, text: "Edited a.ts (1 replacement)", isError: false, before })!;
    expect(plain(res.line)).toBe("Edited a.ts (1 replacement) +2 -1");
    expect(plain(res.details!)).toContain("2 + TWO");
    expect(plain(res.details!)).toContain("3 + more");
  });

  test("write_file of a new file counts every line as added", async () => {
    const { cwd, r } = await workspace();
    const input = { path: path.join(cwd, "b.txt"), content: "x\ny\n" };
    const before = r("write_file").before!(input);
    const res = r("write_file").result!({ toolUseId: "w1", input, text: "Wrote 2 lines to b.txt", isError: false, before })!;
    expect(plain(res.line)).toBe("Wrote 2 lines to b.txt +2 -0");
  });

  test("errors and edits that will not apply use the default display", async () => {
    const { r, abs } = await workspace();
    const bad = { path: abs, old_string: "missing", new_string: "x" };
    const before = r("edit_file").before!(bad);
    expect(before).toBeUndefined();
    expect(r("edit_file").result!({ toolUseId: "e2", input: bad, text: "old_string not found", isError: true, before })).toBeUndefined();
    const ok = { path: abs, old_string: "two", new_string: "2" };
    expect(r("edit_file").result!({ toolUseId: "e3", input: ok, text: "refused", isError: true, before: r("edit_file").before!(ok) })).toBeUndefined();
  });
});
