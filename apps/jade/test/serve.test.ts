// jade --serve 的端到端测试：真的启动 jade，经 stdin/stdout 一行一个 JSON 驱动，模型换成按脚本回复的用户层插件。

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const BIN = path.resolve(import.meta.dir, "../bin/jade.js");

let tmp: string[] = [];
afterEach(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
  tmp = [];
});

// 按这个会话里已有的回复数取脚本的下一条：每个会话各自从头走脚本。回复里带上收到的最后一句，看得出是哪个会话
const FAKE_MODEL = `import { readFileSync } from "node:fs";
const script = JSON.parse(readFileSync(new URL("./script.json", import.meta.url), "utf8"));
const provider = {
  id: "scripted",
  async complete(req) {
    const n = req.messages.filter((m) => m.role === "assistant").length;
    const next = script[n];
    if (!next) throw new Error("script exhausted");
    const heard = req.messages.at(-1).content.map((b) => b.text ?? "").join("");
    await new Promise((r) => setTimeout(r, next.delay ?? 0));
    return { model: "s1", stopReason: "end", content: [{ kind: "text", text: next.say + " <" + heard + ">", origin: { by: "model", provider: "scripted", model: "s1" }, trust: "trusted" }] };
  },
};
export default { process(ctx) {
  ctx.provide("provider@1", provider);
  ctx.provide("models@1", { current: () => ({ kind: "scripted", model: "s1", via: "a script" }), complete: provider.complete, list: async () => [] });
} };`;

type Event = Record<string, unknown> & { type: string; session?: string; id?: unknown };

async function serve(script: { say: string; delay?: number }[], dirs?: { home: string; cwd: string }) {
  const home = dirs?.home ?? realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-home-")));
  const cwd = dirs?.cwd ?? realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "jade-cwd-")));
  if (!dirs) tmp.push(home, cwd);
  const dir = path.join(home, "plugins", "fake-model");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "test/fake-model", version: "1.0.0", api: "^1", entry: "index.mjs", provides: ["provider@1", "models@1"], replaces: ["jade/models"] }),
  );
  await writeFile(path.join(dir, "index.mjs"), FAKE_MODEL);
  await writeFile(path.join(dir, "script.json"), JSON.stringify(script));

  const child = spawn(process.execPath, [BIN, "--serve"], { cwd, env: { ...process.env, JADE_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const events: Event[] = [];
  const waiters: { match: (e: Event) => boolean; resolve: (e: Event) => void }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const e = JSON.parse(line) as Event;
    events.push(e);
    for (const w of [...waiters]) {
      if (!w.match(e)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(e);
    }
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const send = (req: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(req)}\n`);
  /** 等第一个符合的事件（已经到了的也算） */
  const next = (match: (e: Event) => boolean) =>
    new Promise<Event>((resolve) => {
      const seen = events.find(match);
      if (seen) return resolve(seen);
      waiters.push({ match, resolve });
    });
  const reply = (id: string) => next((e) => e.id === id);
  return { home, cwd, send, next, reply, events, exited, end: () => child.stdin.end(), kill: () => child.kill("SIGKILL"), stderr: () => stderr };
}

describe("jade --serve", () => {
  test("runs several sessions at once, each keeping its own conversation across turns", async () => {
    const s = await serve([{ say: "one", delay: 300 }, { say: "two" }]);
    s.send({ type: "open", id: "a" });
    s.send({ type: "open", id: "b" });
    const a = (await s.reply("a")).session as string;
    const b = (await s.reply("b")).session as string;
    expect(a).not.toBe(b);

    // 两个会话同时跑：a 的第一轮慢，b 的不等它
    const t0 = Date.now();
    s.send({ type: "send", id: "a1", session: a, text: "hello a" });
    s.send({ type: "send", id: "b1", session: b, text: "hello b" });
    await Promise.all([s.reply("a1"), s.reply("b1")]);
    expect(Date.now() - t0).toBeLessThan(550);

    s.send({ type: "send", id: "a2", session: a, text: "again a" });
    expect(await s.reply("a2")).toEqual({ type: "done", id: "a2", session: a, reason: "end" });

    const ends = s.events.filter((e) => e.type === "turn_end");
    expect(ends.filter((e) => e.session === a).map((e) => e.result)).toEqual(["one <hello a>", "two <again a>"]);
    expect(ends.filter((e) => e.session === b).map((e) => e.result)).toEqual(["one <hello b>"]);
    expect(ends[0]).toMatchObject({ reason: "end", usage: { inputTokens: 0 } });
    expect(s.events.some((e) => e.type === "text" && e.session === b && e.text === "one <hello b>")).toBe(true);

    s.end();
    expect(await s.exited).toBe(0);
  }, 60_000);

  test("a closed session can be opened again with resume and remembers the conversation", async () => {
    const s = await serve([{ say: "one" }, { say: "two" }]);
    s.send({ type: "open", id: "o" });
    const a = (await s.reply("o")).session as string;
    s.send({ type: "send", id: "m1", session: a, text: "first" });
    await s.reply("m1");
    s.send({ type: "close", id: "c", session: a });
    expect(await s.reply("c")).toEqual({ type: "closed", id: "c", session: a });

    s.send({ type: "send", id: "gone", session: a, text: "x" });
    expect(await s.reply("gone")).toMatchObject({ type: "error", error: `no open session ${a}` });

    s.send({ type: "open", id: "r", resume: a });
    expect((await s.reply("r")).session).toBe(a);
    s.send({ type: "send", id: "m2", session: a, text: "second" });
    await s.reply("m2");
    expect(s.events.filter((e) => e.type === "turn_end").map((e) => e.result)).toEqual(["one <first>", "two <second>"]);
    s.end();
    expect(await s.exited).toBe(0);
  }, 60_000);

  test("bad requests get an error and the process keeps serving", async () => {
    const s = await serve([{ say: "one" }]);
    s.send({ type: "nope", id: 1 });
    expect(await s.reply(1 as unknown as string)).toMatchObject({ type: "error", error: 'unknown request type "nope"' });
    s.send({ type: "send", id: "x", session: "missing", text: "hi" });
    expect(await s.reply("x")).toMatchObject({ type: "error", session: "missing" });
    s.send({ type: "open", id: "bad-resume", resume: "no-such-session" });
    expect(await s.reply("bad-resume")).toMatchObject({ type: "error" });
    s.send({ type: "open", id: "ok" });
    expect(await s.reply("ok")).toMatchObject({ type: "opened" });
    s.end();
    expect(await s.exited).toBe(0);
  }, 60_000);

  test("a turn that is aborted or fails still answers send with done, carrying how it ended", async () => {
    // 第一个进程：这一轮慢，被中止。第二个进程：脚本是空的，模型出错
    const s = await serve([{ say: "slow", delay: 2000 }]);
    s.send({ type: "open", id: "o" });
    const a = (await s.reply("o")).session as string;
    s.send({ type: "send", id: "m1", session: a, text: "hi" });
    await new Promise((r) => setTimeout(r, 200));
    s.send({ type: "abort", session: a });
    expect(await s.reply("m1")).toEqual({ type: "done", id: "m1", session: a, reason: "aborted", error: "aborted by the client" });
    s.end();
    expect(await s.exited).toBe(0);

    const t = await serve([]);
    t.send({ type: "open", id: "o" });
    const b = (await t.reply("o")).session as string;
    t.send({ type: "send", id: "m", session: b, text: "hi" });
    expect(await t.reply("m")).toMatchObject({ type: "done", id: "m", session: b, reason: "error", error: expect.stringContaining("script exhausted") });
    // 出错之后会话照常能用
    t.send({ type: "send", id: "m2", session: b, text: "again" });
    expect(await t.reply("m2")).toMatchObject({ type: "done", reason: "error" });
    t.end();
    expect(await t.exited).toBe(0);
  }, 60_000);

  test("a resumed session whose unfinished turn fails reports it with turn_end, not a second reply to open", async () => {
    // 第一个进程在一轮中途被杀掉，日志停在等模型回复；第二个进程恢复它时脚本已经用完，补跑的这一轮出错
    const s = await serve([{ say: "slow", delay: 10_000 }]);
    s.send({ type: "open", id: "o" });
    const a = (await s.reply("o")).session as string;
    s.send({ type: "send", id: "m", session: a, text: "hi" });
    await new Promise((r) => setTimeout(r, 500));
    s.kill();
    await s.exited;

    const t = await serve([], { home: s.home, cwd: s.cwd });
    t.send({ type: "open", id: "o2", resume: a });
    expect(await t.reply("o2")).toEqual({ type: "opened", id: "o2", session: a });
    expect(await t.next((e) => e.type === "turn_end")).toMatchObject({ session: a, reason: "error" });
    t.send({ type: "open", id: "probe" });
    await t.reply("probe");
    expect(t.events.filter((e) => e.id === "o2")).toHaveLength(1);
    t.end();
    expect(await t.exited).toBe(0);
  }, 60_000);

  test("sessions are written to the session log like any other", async () => {
    const s = await serve([{ say: "one" }]);
    s.send({ type: "open", id: "o" });
    const a = (await s.reply("o")).session as string;
    s.send({ type: "send", id: "m", session: a, text: "hi" });
    await s.reply("m");
    s.end();
    expect(await s.exited).toBe(0);
    expect(await readFile(path.join(s.home, "sessions", `${a}.jsonl`), "utf8")).toContain("one <hi>");
  }, 60_000);
});
