import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Block, Message } from "uncarved";
import { expandCommand, lastTurnChanges, loadCommands, parseCommand, type Checkpoint } from "../src/index.ts";
import { diffLines, diffStats, hunks, renderDiff } from "../src/ui/diff.ts";
import { fsRenderers } from "../src/ui/renderers.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

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

  test("identical and empty texts", () => {
    expect(diffStats(diffLines("x\n", "x\n"))).toEqual({ added: 0, removed: 0 });
    expect(plain(renderDiff("x", "x"))).toContain("no changes");
    expect(diffStats(diffLines("", "a\nb\n"))).toEqual({ added: 2, removed: 0 });
  });
});

describe("approval preview", () => {
  test("edit_file shows a numbered diff of the real file; a failing edit says so", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jade-preview-"));
    await writeFile(path.join(dir, "a.ts"), "one\ntwo\nthree\n");
    const preview = async (tool: string, input: unknown) => (await fsRenderers(dir).find((r) => r.tool === tool)!.preview!(input))!;
    const ok = plain(await preview("edit_file", { path: "a.ts", old_string: "two", new_string: "TWO" }));
    expect(ok).toContain("2 - two");
    expect(ok).toContain("2 + TWO");
    expect(ok).toContain("1   one");
    const bad = plain(await preview("edit_file", { path: "a.ts", old_string: "four", new_string: "4" }));
    expect(bad).toContain("this edit will fail");
    const overwrite = plain(await preview("write_file", { path: "a.ts", content: "one\n" }));
    expect(overwrite).toContain("overwrites");
    expect(overwrite).toContain("+0 -2");
  });
});

describe("turn-level undo", () => {
  const text = (t: string, by: "user" | "host" = "user"): Block => ({ kind: "text", text: t, origin: { by }, trust: "trusted" }) as Block;
  const use = (id: string): Block => ({ kind: "tool_use", id, name: "edit_file", input: {}, origin: { by: "model" }, trust: "trusted" }) as Block;
  const result = (id: string): Block => ({ kind: "tool_result", toolUseId: id, content: [], isError: false, origin: { by: "tool", name: "edit_file" }, trust: "trusted" }) as Block;
  const cp = (toolUseId: string, file: string, at: number): Checkpoint => ({ toolUseId, tool: "edit_file", path: file, before: "", afterHash: "", at });

  const messages: Message[] = [
    { role: "user", content: [text("first")] },
    { role: "assistant", content: [use("a")] },
    { role: "user", content: [result("a")] },
    { role: "assistant", content: [text("done")] },
    { role: "user", content: [text("second")] },
    { role: "assistant", content: [use("b"), use("c")] },
    { role: "user", content: [result("b"), result("c")] },
    // 输出被截断后宿主让模型继续：仍是同一轮
    { role: "user", content: [text("[Note from jade] continue", "host")] },
    { role: "assistant", content: [use("d")] },
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

describe("custom commands", () => {
  test("front matter, description from the first line, and arguments", () => {
    const c = parseCommand("review", "---\ndescription: Review changes\nargument-hint: [path]\n---\nReview $ARGUMENTS carefully.\n", "/f", "user");
    expect(c.description).toBe("Review changes");
    expect(c.args).toBe("[path]");
    expect(expandCommand(c, "src/a.ts")).toBe("Review src/a.ts carefully.");
    const d = parseCommand("fix", "# Fix the failing tests\n\nRun them first.", "/f", "project");
    expect(d.description).toBe("Fix the failing tests");
    expect(expandCommand(d, "")).toBe("# Fix the failing tests\n\nRun them first.");
    expect(expandCommand(d, "only unit")).toBe("# Fix the failing tests\n\nRun them first.\n\nonly unit");
    expect(expandCommand({ body: "from $1 to $2, costs $100" }, "a b")).toBe("from a to b, costs $100");
  });

  test("user and project layers; nearer directories win", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "jade-commands-"));
    const home = path.join(tmp, "home");
    const root = path.join(tmp, "repo");
    const sub = path.join(root, "pkg");
    await mkdir(path.join(home, "commands"), { recursive: true });
    await mkdir(path.join(root, ".jade", "commands"), { recursive: true });
    await mkdir(path.join(sub, ".jade", "commands"), { recursive: true });
    await writeFile(path.join(home, "commands", "hello.md"), "user hello");
    await writeFile(path.join(home, "commands", "mine.md"), "only mine");
    await writeFile(path.join(root, ".jade", "commands", "hello.md"), "repo hello");
    await writeFile(path.join(sub, ".jade", "commands", "Hello.md"), "pkg hello");
    await writeFile(path.join(sub, ".jade", "commands", "bad name.md"), "skipped");
    await writeFile(path.join(sub, ".jade", "commands", "notes.txt"), "skipped");
    const all = await loadCommands({ home, root, cwd: sub });
    expect(all.map((c) => [c.name, c.body, c.layer])).toEqual([
      ["hello", "pkg hello", "project"],
      ["mine", "only mine", "user"],
    ]);
    // 只在仓库根目录启动时看不到子目录的命令
    expect((await loadCommands({ home, root, cwd: root })).find((c) => c.name === "hello")?.body).toBe("repo hello");
  });
});
