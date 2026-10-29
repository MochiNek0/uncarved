import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAll, Runtime, type Block, type Event, type Provider, type Tool } from "uncarved";
import { CorruptLog, JsonlLogStore } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "uncarved-jsonl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ev = (seq: number): Event => ({
  v: 1,
  id: `e${seq}`,
  seq,
  at: "2026-01-01T00:00:00.000Z",
  type: "x/test",
  data: { seq },
  origin: { by: "runtime" },
});

test("按批追加，按 seq 读取；不存在的会话读出空", async () => {
  const store = new JsonlLogStore(dir);
  await store.append("s1", [ev(1), ev(2)]);
  await store.append("s1", [ev(3)]);

  expect((await readAll(store, "s1")).map((e) => e.seq)).toEqual([1, 2, 3]);
  const tail: number[] = [];
  for await (const e of store.read("s1", 2)) tail.push(e.seq);
  expect(tail).toEqual([2, 3]);
  expect(await readAll(store, "missing")).toEqual([]);
});

test("进程重启后，从文件恢复等待审批的会话并继续", async () => {
  const MODEL = { by: "model" as const, provider: "fake", model: "fake-1" };
  const script: Array<{ content: Block[]; stopReason: "tool_use" | "end" }> = [
    { content: [{ kind: "tool_use", id: "t1", name: "echo", input: {}, origin: MODEL, trust: "trusted" }], stopReason: "tool_use" },
    { content: [{ kind: "text", text: "done", origin: MODEL, trust: "trusted" }], stopReason: "end" },
  ];
  const provider: Provider = {
    id: "fake",
    async complete() {
      return { model: "fake-1", ...script.shift()! };
    },
  };
  const echo: Tool = {
    name: "echo",
    description: "echo",
    inputSchema: { type: "object" },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute() {
      return { content: "ok" };
    },
  };
  const plugins = [
    {
      id: "p",
      version: "1.0.0",
      kernel: "^1",
      tools: [echo],
      hooks: [{ kind: "gate" as const, point: "tool.gate" as const, fn: () => ({ decision: "ask" as const }) }],
    },
  ];

  const rt1 = await Runtime.create({ store: new JsonlLogStore(dir), provider, plugins });
  await rt1.send({ kind: "message", content: [{ kind: "text", text: "hi", origin: { by: "user" }, trust: "trusted" }] });
  expect(rt1.state.phase).toBe("awaiting");

  // 全新的存储实例 + 全新的 Runtime，只凭磁盘上的文件
  const rt2 = await Runtime.resume({ store: new JsonlLogStore(dir), provider, plugins, sessionId: rt1.state.sessionId });
  expect(rt2.state).toEqual(rt1.state);
  await rt2.send({ kind: "approval", toolUseId: "t1", approved: true });
  expect(rt2.state.phase).toBe("idle");
  expect(rt2.state.messages.at(-1)!.content[0]).toMatchObject({ text: "done" });
});

test("末尾未写完的一行：读取时忽略，下次追加前截掉", async () => {
  const store = new JsonlLogStore(dir);
  await store.append("s1", [ev(1)]);
  const file = path.join(dir, "s1.jsonl");
  await appendFile(file, JSON.stringify(ev(2)).slice(0, 20)); // 模拟写到一半时崩溃

  const restarted = new JsonlLogStore(dir);
  expect((await readAll(restarted, "s1")).map((e) => e.seq)).toEqual([1]);
  await restarted.append("s1", [ev(2)]);
  expect((await readAll(restarted, "s1")).map((e) => e.seq)).toEqual([1, 2]);
  expect((await readFile(file, "utf8")).split("\n")).toHaveLength(3);
});

test("中间某行损坏时报错，不跳过", async () => {
  await writeFile(path.join(dir, "s1.jsonl"), `${JSON.stringify(ev(1))}\n{broken\n${JSON.stringify(ev(3))}\n`);
  const err = await readAll(new JsonlLogStore(dir), "s1").catch((e) => e);
  expect(err).toBeInstanceOf(CorruptLog);
  expect(err.line).toBe(2);
});

test("拒绝会写到目录之外的会话 ID", async () => {
  const store = new JsonlLogStore(dir);
  for (const id of ["../evil", "a/b", "a\\b", "..", ""]) {
    await expect(store.append(id, [ev(1)])).rejects.toThrow("invalid session id");
  }
});
