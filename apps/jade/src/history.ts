// 输入历史：输入框里提交过的内容，跨会话保留，↑/↓ 和 Ctrl+R 用。
// 所有目录共用 $JADE_HOME/history.jsonl，每条记下目录；读的时候只取当前目录的。

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface HistoryEntry {
  text: string;
  cwd: string;
}

/** 每个目录最多留多少条 */
export const HISTORY_LIMIT = 500;
/** 文件超过这么多行时，下次读取顺便删掉旧的 */
const FILE_LIMIT = 5000;

export class InputHistory {
  readonly file: string;
  readonly cwd: string;

  constructor(file: string, cwd: string) {
    this.file = file;
    this.cwd = path.resolve(cwd);
  }

  /** 当前目录的历史，旧的在前，重复的只留最后一次 */
  async load(): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter(Boolean);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as HistoryEntry;
        if (typeof e.text === "string" && typeof e.cwd === "string") entries.push(e);
      } catch {}
    }
    if (lines.length > FILE_LIMIT) {
      await writeFile(this.file, entries.slice(-FILE_LIMIT / 2).map((e) => JSON.stringify(e) + "\n").join("")).catch(() => {});
    }
    const mine = entries.filter((e) => samePath(e.cwd, this.cwd)).map((e) => e.text);
    return mine.filter((t, i) => mine.lastIndexOf(t) === i).slice(-HISTORY_LIMIT);
  }

  async add(text: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify({ text, cwd: this.cwd } satisfies HistoryEntry) + "\n");
  }
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
