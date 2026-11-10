// jade/sessions：/clear、/resume、/retry，以及 /resume 用的会话索引。
// 索引是 $JADE_HOME/state/sessions.jsonl，每行 { id, cwd, title, at }：会话在本进程里第一次收到消息时追加一行。
// 读的时候按 id 合并：标题取最早的一行，时间取最晚的一行；目录按 cwdKey 比较。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UserInput } from "uncarved";
import { definePlugin } from "@uncarved/jade-api";
import type { Commands } from "../commands/index.ts";

export interface SessionSummary {
  id: string;
  cwd: string;
  /** 第一条消息的开头 */
  title: string;
  /** 最近一次使用的时间（ISO） */
  at: string;
}

const TITLE_CHARS = 80;

/** 比较目录用的键：绝对路径、去掉末尾的分隔符；Windows 上不分大小写 */
export function cwdKey(cwd: string): string {
  const p = path.resolve(cwd);
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 索引里的全部会话按目录分组，键是 cwdKey；每组最近用过的在前 */
export async function listAllSessions(file: string): Promise<Map<string, SessionSummary[]>> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return new Map();
  }
  const byId = new Map<string, SessionSummary>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: SessionSummary;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // 写到一半的行
    }
    if (typeof e?.id !== "string" || typeof e.cwd !== "string" || typeof e.at !== "string") continue;
    const seen = byId.get(e.id);
    byId.set(e.id, seen ? { ...seen, at: e.at > seen.at ? e.at : seen.at } : e);
  }
  const byCwd = new Map<string, SessionSummary[]>();
  for (const s of byId.values()) {
    const key = cwdKey(s.cwd);
    const group = byCwd.get(key);
    if (group) group.push(s);
    else byCwd.set(key, [s]);
  }
  for (const group of byCwd.values()) group.sort((a, b) => b.at.localeCompare(a.at));
  return byCwd;
}

/** 索引里 cwd 下的会话，最近用过的在前 */
export async function listSessions(file: string, cwd: string): Promise<SessionSummary[]> {
  return (await listAllSessions(file)).get(cwdKey(cwd)) ?? [];
}

/** 多久以前，例如 "5m ago" */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function titleOf(input: UserInput): string | undefined {
  if (input.kind !== "message") return undefined;
  const text = input.content.flatMap((b) => (b.kind === "text" && b.origin.by === "user" ? [b.text] : [])).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text;
}

/** sessions@1 */
export interface SessionIndex {
  /** cwd 里的会话，最近用过的在前（jade --continue 取第一个） */
  list(cwd: string): Promise<SessionSummary[]>;
}

export default definePlugin({
  process(ctx) {
    const file = path.join(ctx.home, "state", "sessions.jsonl");
    ctx.provide("sessions@1", { list: (cwd: string) => listSessions(file, cwd) } satisfies SessionIndex);
    const commands = ctx.require<Commands>("commands@1");

    commands.register({
      name: "clear",
      description: "start a new session (the current one stays resumable)",
      async run(_args, c) {
        const previous = c.sessions.current;
        await c.sessions.open();
        return previous && previous.state.messages.length > 0 ? `Started a new session. Resume the previous one with /resume or: jade --resume ${previous.id}` : "Started a new session.";
      },
    });

    commands.register({
      name: "resume",
      args: "[session id]",
      description: "continue an earlier session in this directory",
      async run(args, c) {
        let id: string | undefined = args.trim() || undefined;
        if (!id) {
          const all = (await listSessions(file, ctx.cwd)).filter((s) => s.id !== c.sessions.current?.id).slice(0, 50);
          if (all.length === 0) return "No other sessions in this directory.";
          id = await c.ui.select({ title: "Resume which session?", options: all.map((s) => ({ label: s.title || "(untitled)", value: s.id, hint: `${ago(s.at)} · ${s.id}` })) }, c.signal);
          if (!id) return;
        }
        // 前端在会话换掉之后重新显示它的对话
        await c.sessions.open({ resume: id });
      },
    });

    commands.register({
      name: "retry",
      description: "ask the model again after a failed request",
      async run(_args, c) {
        const s = c.sessions.current;
        if (!s || s.state.messages.at(-1)?.role !== "user") return "Nothing to retry: the last request did not fail before the model answered.";
        await s.send({ kind: "retry" });
      },
    });
  },

  session(ctx) {
    const file = path.join(ctx.home, "state", "sessions.jsonl");
    let indexed = false;
    ctx.kernel.hook({
      kind: "observe",
      point: "event",
      fn: async (e) => {
        if (indexed || e.type !== "input.received") return;
        const title = titleOf(e.data as UserInput);
        if (title === undefined) return;
        indexed = true;
        const entry: SessionSummary = { id: ctx.session.id, cwd: path.resolve(ctx.cwd), title, at: new Date().toISOString() };
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(entry)}\n`);
      },
    });
  },
});
