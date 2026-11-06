// jade/schedule：cron 计算、跨进程认领、命令和工具，以及到点投到当前会话。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nextRun, parseCron } from "../plugins/schedule/cron.ts";
import { createTask, editTask } from "../plugins/schedule/index.ts";
import { claimDue, ScheduleStore, type Task } from "../plugins/schedule/store.ts";
import { msg, resultText, say, scripted, turn, use } from "./scripted-host.ts";

/** 本机时区的时间 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

async function tempStore() {
  const home = await mkdtemp(path.join(os.tmpdir(), "jade-schedule-"));
  return { home, store: new ScheduleStore(home), done: () => rm(home, { recursive: true, force: true }) };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("cron", () => {
  test("next run for common expressions", () => {
    const from = at(2026, 11, 6, 10, 30); // 周五
    expect(nextRun("*/15 * * * *", from)).toEqual(at(2026, 11, 6, 10, 45));
    expect(nextRun("0 9 * * *", from)).toEqual(at(2026, 11, 7, 9, 0));
    // 工作日：周五之后是下周一
    expect(nextRun("0 9 * * 1-5", at(2026, 11, 6, 9, 0))).toEqual(at(2026, 11, 9, 9, 0));
    expect(nextRun("30 10 1 1 *", from)).toEqual(at(2027, 1, 1, 10, 30));
    expect(nextRun("0 0 * * 7", from)).toEqual(at(2026, 11, 8, 0, 0)); // 7 也是周日
    expect(nextRun("0 0 30 2 *", from)).toBeUndefined();
  });

  test("day of month and day of week: either matches when both are restricted", () => {
    // 每月 13 日或者每周五
    expect(nextRun("0 12 13 * 5", at(2026, 11, 7))).toEqual(at(2026, 11, 13, 12, 0));
    expect(nextRun("0 12 13 * 5", at(2026, 11, 13, 13))).toEqual(at(2026, 11, 20, 12, 0));
    // 日是 * 时只看星期
    expect(nextRun("0 12 * * 5", at(2026, 11, 7))).toEqual(at(2026, 11, 13, 12, 0));
  });

  test("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow("5 fields");
    expect(() => parseCron("60 * * * *")).toThrow("out of range");
    expect(() => parseCron("a * * * *")).toThrow("invalid minute");
    expect(() => parseCron("*/0 * * * *")).toThrow("out of range");
  });
});

describe("store", () => {
  test("a due task is claimed once even when several jades check at the same time", async () => {
    const { home, store, done } = await tempStore();
    try {
      const now = at(2026, 11, 6, 9, 0);
      await createTask(store, { prompt: "check CI", cron: "0 9 * * *", cwd: "/w" }, at(2026, 11, 6, 8, 0));
      const others = [new ScheduleStore(home), new ScheduleStore(home), store];
      const claims = await Promise.all(others.map((s, i) => claimDue(s, "/w", `s${i}`, now)));
      expect(claims.flat()).toHaveLength(1);
      const [t] = await store.list();
      expect(t!.next).toBe(at(2026, 11, 7, 9, 0).toISOString());
      expect(t!.last?.at).toBe(now.toISOString());
    } finally {
      await done();
    }
  });

  test("missed runs collapse into one; other directories, paused and running tasks are left alone; one-time tasks end", async () => {
    const { store, done } = await tempStore();
    try {
      const made = at(2026, 11, 1);
      const hourly = await createTask(store, { prompt: "hourly", cron: "0 * * * *", cwd: "/w" }, made);
      const once = await createTask(store, { prompt: "once", cron: "0 * * * *", cwd: "/w", recurring: false }, made);
      const elsewhere = await createTask(store, { prompt: "elsewhere", cwd: "/other", cron: "0 * * * *" }, made);
      const paused = await createTask(store, { prompt: "paused", cwd: "/w", cron: "0 * * * *" }, made);
      const busy = await createTask(store, { prompt: "busy", cwd: "/w", cron: "0 * * * *" }, made);
      await editTask(store, paused.id, "pause", {}, made);

      const now = at(2026, 11, 6, 10, 20); // 五天没开
      const due = await claimDue(store, "/w", "s", now, new Set([busy.id]));
      expect(due.map((t) => t.prompt).sort()).toEqual(["hourly", "once"]);
      const byId = new Map((await store.list()).map((t) => [t.id, t]));
      expect(byId.get(hourly.id)!.next).toBe(at(2026, 11, 6, 11, 0).toISOString());
      expect(byId.get(once.id)!.status).toBe("ended");
      expect(byId.get(once.id)!.next).toBeUndefined();
      expect(byId.get(elsewhere.id)!.last).toBeUndefined();
      expect(byId.get(busy.id)!.next).toBe(at(2026, 11, 1, 1, 0).toISOString());
      // 第二次检查没有新的
      expect(await claimDue(store, "/w", "s", now)).toEqual([expect.objectContaining({ id: busy.id })]);
    } finally {
      await done();
    }
  });

  test("a jade whose lock was taken over as stale does not remove the new holder's lock when it finishes", async () => {
    const { home, store, done } = await tempStore();
    try {
      const lock = path.join(home, "state", "schedules.lock");
      await store.update(() => {
        // 别的 jade 把这把锁当成过期的删掉，自己重新上了锁
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(path.join(lock, "theirs"), "");
      });
      expect(existsSync(path.join(lock, "theirs"))).toBe(true);
    } finally {
      await done();
    }
  });

  test("the directory matches however it is spelled: trailing separator, and case on Windows", async () => {
    const { store, done } = await tempStore();
    try {
      const dir = path.resolve("/Work/Proj");
      await createTask(store, { prompt: "a", cron: "0 * * * *", cwd: dir }, at(2026, 11, 1));
      const other = (process.platform === "win32" ? dir.toLowerCase() : dir) + path.sep;
      expect(await claimDue(store, other, "s", at(2026, 11, 1, 2, 0))).toHaveLength(1);
    } finally {
      await done();
    }
  });

  test("edit: update, pause, resume, delete; bad input changes nothing", async () => {
    const { store, done } = await tempStore();
    try {
      const t0 = at(2026, 11, 6, 10, 0);
      const t = await createTask(store, { prompt: "  summarize   the day  ", cron: "0  18 * * *", cwd: "/w" }, t0);
      expect(t.title).toBe("summarize the day");
      expect(t.cron).toBe("0 18 * * *");
      await expect(createTask(store, { prompt: "x", cron: "0 0 30 2 *", cwd: "/w" })).rejects.toThrow("never fires");
      await expect(createTask(store, { prompt: " ", cron: "* * * * *", cwd: "/w" })).rejects.toThrow("empty");

      const u = await editTask(store, t.id, "update", { cron: "0 20 * * *", title: "evening" }, t0);
      expect(u).toMatchObject({ cron: "0 20 * * *", title: "evening", next: at(2026, 11, 6, 20, 0).toISOString() });
      await expect(editTask(store, t.id, "update", { cron: "nope" })).rejects.toThrow();
      expect((await store.list())[0]!.cron).toBe("0 20 * * *");

      expect(await editTask(store, t.id, "pause", {}, t0)).toMatchObject({ status: "paused" });
      const later = at(2026, 11, 9, 21, 0);
      expect(await editTask(store, t.id, "resume", {}, later)).toMatchObject({ status: "active", next: at(2026, 11, 10, 20, 0).toISOString() });
      expect(await editTask(store, t.id, "delete")).toBeUndefined();
      await expect(editTask(store, t.id, "pause")).rejects.toThrow("no scheduled task");
      expect(await store.list()).toEqual([]);
    } finally {
      await done();
    }
  });
});

describe("jade/schedule", () => {
  const fast = { "jade/schedule": { checkSeconds: 0.05 } };

  test("a due task is sent to the current session in its directory", async () => {
    const { home, cwd, host, requests } = await scripted([say("CI is green")], { config: fast });
    try {
      const store = new ScheduleStore(home);
      const t = await createTask(store, { prompt: "check CI", cron: "* * * * *", cwd, title: "CI" }, at(2020, 1, 1));
      const s = await host.sessions.open();
      await until(() => requests.length === 1);
      await s.idle();
      const sent = requests[0]!.messages.at(-1)!.content[0]!;
      expect(sent).toMatchObject({ kind: "text", text: `[Scheduled task "CI" (${t.id})]\ncheck CI`, origin: { by: "plugin", id: "jade/schedule" } });
      const [after] = await store.list();
      expect(after!.last?.session).toBe(s.id);
      expect(Date.parse(after!.next!)).toBeGreaterThan(Date.now());
    } finally {
      await host.close();
    }
  });

  test("jade -p does not run scheduled tasks", async () => {
    const { home, cwd, host, requests } = await scripted([], { config: fast, flags: ["-p"] });
    try {
      const store = new ScheduleStore(home);
      await createTask(store, { prompt: "check CI", cron: "* * * * *", cwd }, at(2020, 1, 1));
      await host.sessions.open();
      await new Promise((r) => setTimeout(r, 300));
      expect(requests).toHaveLength(0);
      expect((await store.list())[0]!.last).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  test("the model creates, lists and deletes tasks with the tools", async () => {
    let id = "";
    const { home, host, requests } = await scripted(
      [
        use(["1", "schedule_create", { prompt: "summarize commits", cron: "0 9 * * 1-5", title: "standup" }]),
        (req) => {
          id = /^(\w{8}) /m.exec(resultText(req.messages.at(-1)!.content[0]))![1]!;
          return use(["2", "schedule_list", {}]);
        },
        () => use(["3", "schedule_edit", { id, action: "delete" }]),
        say("done"),
      ],
      { config: { ...fast, "jade/approval": { mode: "yolo" } } },
    );
    try {
      const s = await host.sessions.open();
      await turn(s, msg("every weekday at 9 summarize commits"));
      expect(resultText(requests[1]!.messages.at(-1)!.content[0])).toContain("Created scheduled task");
      expect(resultText(requests[2]!.messages.at(-1)!.content[0])).toContain(`${id}  0 9 * * 1-5  next`);
      expect(resultText(requests[3]!.messages.at(-1)!.content[0])).toBe(`Deleted scheduled task ${id}.`);
      expect(JSON.parse(await readFile(path.join(home, "state", "schedules.json"), "utf8")).tasks).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("/schedule add, list, pause, run, rm", async () => {
    const { home, host } = await scripted([], { config: { "jade/schedule": { checkSeconds: 3600 } } });
    try {
      const commands = host.service<{ get(n: string): { command: { run(a: string, c: unknown): unknown } } | undefined }>("commands@1")!;
      const run = (a: string) => commands.get("schedule")!.command.run(a, {}) as Promise<unknown>;
      expect(await run("")).toBe("No scheduled tasks.");
      expect(await run("add 0 9 * *")).toContain("usage:");
      expect(await run("add 0 9 * * 1-5 summarize yesterday")).toContain("0 9 * * 1-5  next");
      const [t] = (await new ScheduleStore(home).list()) as Task[];
      expect(t).toMatchObject({ prompt: "summarize yesterday", recurring: true });
      expect(await run(`pause ${t!.id}`)).toContain("paused");
      expect(await run(`run ${t!.id}`)).toEqual({ prompt: `[Scheduled task "summarize yesterday" (${t!.id})]\nsummarize yesterday` });
      expect(await run(`rm ${t!.id}`)).toBe(`Deleted ${t!.id}.`);
      expect(await run(`rm ${t!.id}`)).toBe(`schedule: no scheduled task ${t!.id}`);
      expect(await run("once 61 * * * * x")).toContain("out of range");
    } finally {
      await host.close();
    }
  });
});
