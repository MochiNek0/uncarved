// jade/schedule：定时任务。任务存在 $JADE_HOME/state/schedules.json，重启后还在；
// 到点时投到创建它的目录里正在运行的 jade 的当前会话（正在跑就排在本轮之后），没有 jade 开着就等着，
// 下次打开时错过的几次只补一次。不能提问的前端（jade -p）不投递。
// 管理入口：/schedule 命令和给模型的 schedule_create、schedule_list、schedule_edit 工具，共用同一份存储。

import path from "node:path";
import type { Tool, UserInput } from "uncarved";
import { definePlugin, type UI } from "@uncarved/jade-api";
import type { Commands } from "@uncarved/jade-api/services";
import { parseCron } from "./cron.ts";
import { claimDue, nextAt, sameDir, ScheduleStore, type Task } from "./store.ts";

const ID = "jade/schedule";
const TITLE_CHARS = 120;

function titleFrom(prompt: string): string {
  const one = prompt.replace(/\s+/g, " ").trim();
  return one.length > 50 ? `${one.slice(0, 50)}…` : one;
}

/** 检查 cron 并算出下一次；没有下一次时抛错 */
function firstRun(cron: string, now: Date): string {
  parseCron(cron);
  const next = nextAt(cron, now);
  if (!next) throw new Error(`cron "${cron}" never fires`);
  return next;
}

export async function createTask(
  store: ScheduleStore,
  opts: { prompt: string; cron: string; title?: string; recurring?: boolean; cwd: string },
  now = new Date(),
): Promise<Task> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("prompt is empty");
  const cron = opts.cron.trim().split(/\s+/).join(" ");
  const next = firstRun(cron, now);
  const title = (opts.title?.trim() || titleFrom(prompt)).slice(0, TITLE_CHARS);
  const at = now.toISOString();
  const task: Task = {
    id: crypto.randomUUID().slice(0, 8),
    title,
    prompt,
    cron,
    recurring: opts.recurring ?? true,
    cwd: path.resolve(opts.cwd),
    target: { kind: "cwd" },
    status: "active",
    next,
    createdAt: at,
    updatedAt: at,
  };
  await store.update((tasks) => void tasks.push(task));
  return task;
}

export type EditAction = "update" | "pause" | "resume" | "delete";

/** 改一个任务；删除时返回 undefined。恢复和改 cron 从现在起重新算下一次 */
export function editTask(
  store: ScheduleStore,
  id: string,
  action: EditAction,
  patch: { title?: string; prompt?: string; cron?: string; recurring?: boolean } = {},
  now = new Date(),
): Promise<Task | undefined> {
  return store.update((tasks) => {
    const i = tasks.findIndex((t) => t.id === id);
    if (i < 0) throw new Error(`no scheduled task ${id}`);
    if (action === "delete") {
      tasks.splice(i, 1);
      return undefined;
    }
    const t = tasks[i]!;
    if (action === "pause") {
      t.status = "paused";
      delete t.next;
    } else if (action === "resume") {
      t.status = "active";
      t.next = firstRun(t.cron, now);
    } else if (action === "update") {
      if (patch.prompt !== undefined) {
        if (!patch.prompt.trim()) throw new Error("prompt is empty");
        t.prompt = patch.prompt.trim();
      }
      if (patch.title !== undefined) t.title = (patch.title.trim() || titleFrom(t.prompt)).slice(0, TITLE_CHARS);
      if (patch.recurring !== undefined) t.recurring = patch.recurring;
      if (patch.cron !== undefined) {
        t.cron = patch.cron.trim().split(/\s+/).join(" ");
        const next = firstRun(t.cron, now);
        if (t.status === "active") t.next = next;
      }
    } else {
      throw new Error(`unknown action ${String(action)}`);
    }
    t.updatedAt = now.toISOString();
    return { ...t };
  });
}

/** 一行说明；任务不在 cwd 时写上它的目录 */
export function describe(t: Task, cwd: string): string {
  const when = t.status === "active" && t.next ? `next ${new Date(t.next).toLocaleString()}` : t.status;
  const once = t.recurring ? "" : " (once)";
  const where = sameDir(t.cwd, cwd) ? "" : `  [in ${t.cwd}]`;
  return `${t.id}  ${t.cron}${once}  ${when}  ${t.title}${where}`;
}

function listing(tasks: Task[], cwd: string): string {
  if (tasks.length === 0) return "No scheduled tasks.";
  // 本目录的在前
  const sorted = [...tasks].sort((a, b) => Number(sameDir(b.cwd, cwd)) - Number(sameDir(a.cwd, cwd)));
  return sorted.map((t) => describe(t, cwd)).join("\n");
}

const messageText = (t: Task) => `[Scheduled task "${t.title}" (${t.id})]\n${t.prompt}`;

/** 到点时发给模型的消息 */
export function delivery(t: Task): UserInput {
  return { kind: "message", content: [{ kind: "text", text: messageText(t), origin: { by: "plugin", id: ID }, trust: "trusted" }] };
}

const USAGE = `usage:
  /schedule                       list tasks
  /schedule add <cron> <prompt>   run a prompt on a 5-field cron (local time), e.g. /schedule add 0 9 * * 1-5 summarize yesterday's commits
  /schedule once <cron> <prompt>  same, but only the next time it matches
  /schedule pause|resume|rm <id>
  /schedule run <id>              send a task's prompt now (does not move its next run)
Tasks run in the current session of a jade that is open in the directory they were created in.`;

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function tools(store: ScheduleStore, cwd: string): Tool[] {
  const result = async (fn: () => Promise<string>) => {
    try {
      return { content: await fn() };
    } catch (e) {
      return { content: err(e), isError: true };
    }
  };
  const where =
    "A task runs only while jade is open in the directory it was created in: its prompt is sent as a message to that jade's current session (after the current turn if one is running). " +
    "Occurrences missed while jade was closed are run once when it opens again.";
  return [
    {
      name: "schedule_create",
      description:
        `Create a scheduled task that sends a prompt to the session at times given by a 5-field cron expression in the user's local time zone (minute hour day-of-month month day-of-week). ${where} ` +
        "Write the prompt as a self-contained instruction: it is read later, possibly in a different session. Use recurring: false for a one-time reminder.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "the instruction to send when the task fires" },
          cron: { type: "string", description: 'e.g. "0 9 * * 1-5" for weekdays at 09:00' },
          title: { type: "string", description: "short name; defaults to the start of the prompt" },
          recurring: { type: "boolean", description: "false: fire once, then end (default true)" },
        },
        required: ["prompt", "cron"],
        additionalProperties: false,
      },
      // 任务在本会话之后、以用户的身份发出指令，所以和改工作区之外的东西一样要问
      effect: "external",
      concurrency: "exclusive",
      idempotent: false,
      execute: (input) =>
        result(async () => {
          const i = input as { prompt: string; cron: string; title?: string; recurring?: boolean };
          const t = await createTask(store, { ...i, cwd });
          return `Created scheduled task:\n${describe(t, cwd)}`;
        }),
    },
    {
      name: "schedule_list",
      description: `List all scheduled tasks with their id, cron, next run time and title. ${where}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      concurrency: "safe",
      idempotent: true,
      execute: () => result(async () => listing(await store.list(), cwd)),
    },
    {
      name: "schedule_edit",
      description: "Change a scheduled task (update its prompt, cron, title or recurring), pause it, resume it, or delete it. Get ids from schedule_list.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["update", "pause", "resume", "delete"] },
          prompt: { type: "string" },
          cron: { type: "string" },
          title: { type: "string" },
          recurring: { type: "boolean" },
        },
        required: ["id", "action"],
        additionalProperties: false,
      },
      effect: "external",
      concurrency: "exclusive",
      idempotent: false,
      execute: (input) =>
        result(async () => {
          const { id, action, ...patch } = input as { id: string; action: EditAction; prompt?: string; cron?: string; title?: string; recurring?: boolean };
          const t = await editTask(store, id, action, patch);
          return t ? `Updated:\n${describe(t, cwd)}` : `Deleted scheduled task ${id}.`;
        }),
    },
  ];
}

export default definePlugin({
  process(ctx) {
    const store = new ScheduleStore(ctx.home);
    ctx.service<Commands>("commands@1")?.register({
      name: "schedule",
      args: "[add|once|pause|resume|rm|run] …",
      description: "scheduled tasks: prompts sent on a cron schedule while jade is open here",
      async run(args) {
        const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        try {
          switch (sub) {
            case "list":
              return listing(await store.list(), ctx.cwd);
            case "add":
            case "once": {
              if (rest.length < 6) return USAGE;
              const t = await createTask(store, { cron: rest.slice(0, 5).join(" "), prompt: rest.slice(5).join(" "), recurring: sub === "add", cwd: ctx.cwd });
              return `Scheduled:\n${describe(t, ctx.cwd)}`;
            }
            case "pause":
            case "resume":
            case "rm": {
              if (rest.length !== 1) return USAGE;
              const t = await editTask(store, rest[0]!, sub === "rm" ? "delete" : sub);
              return t ? describe(t, ctx.cwd) : `Deleted ${rest[0]}.`;
            }
            case "run": {
              const t = (await store.list()).find((x) => x.id === rest[0]);
              if (!t) return rest.length ? `No scheduled task ${rest[0]}.` : USAGE;
              return { prompt: messageText(t) };
            }
            default:
              return USAGE;
          }
        } catch (e) {
          return `schedule: ${err(e)}`;
        }
      },
    });
  },

  async session(ctx) {
    const store = new ScheduleStore(ctx.home);
    for (const t of tools(store, ctx.cwd)) ctx.kernel.tool(t);

    const ui = ctx.service<UI>("ui@1");
    // jade -p 这类不能提问的运行只做用户要它做的那一件事
    if (!ui?.interactive) return;
    const seconds = Number(ctx.config.checkSeconds);
    const every = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
    /** 已经发出、还没跑完的任务：跑完之前不再认领 */
    const running = new Set<string>();
    let warned = false;
    const check = async () => {
      if (ctx.signal.aborted) return;
      let due: Task[];
      try {
        due = await claimDue(store, ctx.cwd, ctx.session.id, new Date(), running);
      } catch (e) {
        if (ctx.signal.aborted) return;
        if (!warned) ui.notify(`schedule: ${err(e)}`, "warning");
        warned = true;
        return;
      }
      warned = false;
      for (const t of due) {
        if (ctx.signal.aborted) return;
        running.add(t.id);
        ui.notify(`[scheduled task "${t.title}" (${t.id})]`);
        ctx.session
          .send(delivery(t))
          // 会话已经离开（换会话、退出）时 ui 已经不能用了
          .catch((e: unknown) => ctx.signal.aborted || ui.notify(`scheduled task ${t.id} failed: ${err(e)}`, "error"))
          .finally(() => running.delete(t.id));
      }
    };
    // 不在这里立即检查：session() 执行时会话还没建好，这时 send 会失败，认领了的任务就丢了
    await ctx.effect(() => {
      const timer = setInterval(() => void check(), every);
      return () => clearInterval(timer);
    });
  },
});
