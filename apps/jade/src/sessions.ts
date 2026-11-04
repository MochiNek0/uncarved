// 会话索引：LogStore 接口只有 append/read，没有"列出会话"，由发行版自己记一份。
// 只记顶层会话；子 Agent 的会话通过日志里的 child 引用找到。

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readAll, type LogStore } from "uncarved";

export interface SessionEntry {
  id: string;
  cwd: string;
  title: string;
  at: string;
}

export class SessionIndex {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async add(entry: SessionEntry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(entry) + "\n");
  }

  /** 最近使用的在前；同一个会话多次记录时取最后一次的时间、第一次的标题（之后的消息常常只是"继续"） */
  async list(cwd?: string): Promise<SessionEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const latest = new Map<string, SessionEntry>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SessionEntry;
        const first = latest.get(e.id);
        latest.delete(e.id);
        latest.set(e.id, first ? { ...e, title: first.title } : e);
      } catch {
        // 末尾未写完的一行
      }
    }
    return [...latest.values()].filter((e) => !cwd || path.resolve(e.cwd) === path.resolve(cwd)).reverse();
  }
}

/**
 * 会话从来没收到过输入（打开 jade 什么都没说就退出、/clear 后马上又 /clear）时删掉它的日志，
 * 否则每次启动都留下一个只有 session.started 和 session.detached 的文件。只认 JsonlLogStore 的布局：dir/<id>.jsonl。
 * 返回是否删掉了
 */
export async function discardIfEmpty(store: LogStore & { dir: string }, sessionId: string): Promise<boolean> {
  const events = await readAll(store, sessionId);
  if (events.some((e) => e.type === "input.received")) return false;
  await rm(path.join(store.dir, `${sessionId}.jsonl`), { force: true });
  return true;
}

/** id 等于 arg 或以它开头的唯一一个会话；都不是时原样返回，交给 Runtime.resume 去找 */
export function matchSession(entries: { id: string }[], arg: string): string {
  const hits = entries.filter((s) => s.id.startsWith(arg));
  return hits.find((s) => s.id === arg)?.id ?? (hits.length === 1 ? hits[0]!.id : arg);
}

/** 显示用的相对时间 */
export function ago(iso: string, now = Date.now()): string {
  const s = (now - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}
