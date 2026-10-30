// 会话索引：LogStore 接口只有 append/read，没有"列出会话"，由发行版自己记一份。
// 只记顶层会话；子 Agent 的会话通过日志里的 child 引用找到。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

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

  /** 最近使用的在前；同一个会话多次记录时取最后一次 */
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
        latest.delete(e.id);
        latest.set(e.id, e);
      } catch {
        // 末尾未写完的一行
      }
    }
    return [...latest.values()].filter((e) => !cwd || path.resolve(e.cwd) === path.resolve(cwd)).reverse();
  }
}
