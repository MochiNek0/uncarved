// jade/sessions 的会话索引：按 id 合并、按目录分组、目录比较不受写法影响。

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cwdKey, listAllSessions, listSessions } from "../plugins/sessions/index.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function index(lines: (object | string)[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jade-sessions-"));
  dirs.push(dir);
  const file = path.join(dir, "sessions.jsonl");
  await writeFile(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

const a = path.resolve("/work/a");
const b = path.resolve("/work/b");

test("groups every session by directory, most recent first, merging lines of the same id", async () => {
  const file = await index([
    { id: "1", cwd: a, title: "first", at: "2026-01-01T00:00:00Z" },
    { id: "2", cwd: b, title: "other", at: "2026-01-02T00:00:00Z" },
    { id: "3", cwd: a, title: "second", at: "2026-01-03T00:00:00Z" },
    "{ half a line",
    { id: "1", cwd: a, title: "resumed later", at: "2026-01-04T00:00:00Z" },
  ]);
  const all = await listAllSessions(file);
  expect([...all.keys()].sort()).toEqual([cwdKey(a), cwdKey(b)].sort());
  expect(all.get(cwdKey(a))!.map((s) => [s.id, s.title, s.at])).toEqual([
    ["1", "first", "2026-01-04T00:00:00Z"],
    ["3", "second", "2026-01-03T00:00:00Z"],
  ]);
  expect(all.get(cwdKey(b))!.map((s) => s.id)).toEqual(["2"]);
});

test("a directory matches however its path is written", async () => {
  const file = await index([
    { id: "1", cwd: a, title: "plain", at: "2026-01-01T00:00:00Z" },
    { id: "2", cwd: a + path.sep, title: "trailing separator", at: "2026-01-02T00:00:00Z" },
    ...(process.platform === "win32" ? [{ id: "3", cwd: a.toUpperCase(), title: "other case", at: "2026-01-03T00:00:00Z" }] : []),
  ]);
  const ids = (await listSessions(file, a)).map((s) => s.id);
  expect(ids).toEqual(process.platform === "win32" ? ["3", "2", "1"] : ["2", "1"]);
  expect(await listSessions(file, b)).toEqual([]);
});

test("a missing index is empty", async () => {
  expect((await listAllSessions(path.join(os.tmpdir(), "jade-no-such-dir", "sessions.jsonl"))).size).toBe(0);
});
