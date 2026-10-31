// 文件快照：write_file / edit_file 写入前保存原内容，宿主的 /undo 用它恢复。
//
// 快照放在 <dir>/<sessionId>/<toolUseId>.json，不进日志：文件可能很大，而撤销是宿主的操作，不影响插件决策。
// 哪些修改已经撤销由宿主用 Runtime.record 记在日志里（UNDO_KEY），恢复会话后仍然有效。

import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** derived 中保存已撤销的 toolUseId 的键 */
export const UNDO_KEY = "jade/undo";

export interface UndoState {
  undone: string[];
}

export interface Checkpoint {
  toolUseId: string;
  tool: string;
  /** 绝对路径 */
  path: string;
  /** 写入前的内容；null 表示文件原本不存在 */
  before: string | null;
  /** 写入后内容的 sha256，撤销前用来判断文件之后有没有被改过 */
  afterHash: string;
  /** 写入完成的时间（毫秒，带小数），决定撤销顺序 */
  at: number;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Checkpoints {
  readonly #dir: string;
  /** 会话 → 文件 → markSeen 记下的 sha256；第一次用到时从 seen.jsonl 读入 */
  readonly #seen = new Map<string, Promise<Map<string, string>>>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async save(sessionId: string, cp: Omit<Checkpoint, "at">): Promise<void> {
    const dir = path.join(this.#dir, safe(sessionId));
    await mkdir(dir, { recursive: true });
    const full: Checkpoint = { ...cp, at: performance.timeOrigin + performance.now() };
    await writeFile(path.join(dir, `${safe(cp.toolUseId)}.json`), JSON.stringify(full));
  }

  /** 本会话的所有快照，最新的在前 */
  async list(sessionId: string): Promise<Checkpoint[]> {
    const dir = path.join(this.#dir, safe(sessionId));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Checkpoint[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(path.join(dir, n), "utf8")) as Checkpoint);
      } catch {
        // 写到一半的快照，忽略
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * 记下本会话读过或写过的文件当时内容的 sha256。fs 工具在内存里也记一份，
   * 这里的是给恢复的会话用的：之前的进程里读过、写过的文件，内容没变就不用再读一遍。
   * 追加到每个会话一个的 seen.jsonl，后面的记录覆盖前面的；内容没变的重复读取不再写
   */
  async markSeen(sessionId: string, file: string, hash: string): Promise<void> {
    const seen = await this.#seenOf(sessionId);
    if (seen.get(file) === hash) return;
    seen.set(file, hash);
    const dir = path.join(this.#dir, safe(sessionId));
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "seen.jsonl"), JSON.stringify({ path: file, hash }) + "\n");
  }

  /** markSeen 记下的 sha256；没有记录返回 undefined */
  async seenHash(sessionId: string, file: string): Promise<string | undefined> {
    const hash = (await this.#seenOf(sessionId)).get(file);
    if (hash !== undefined) return hash;
    // 旧版本每个文件一个 seen/<sha256(path)>.json
    try {
      const rec = JSON.parse(await readFile(path.join(this.#dir, safe(sessionId), "seen", `${sha256(file)}.json`), "utf8")) as { path: string; hash: string };
      return rec.path === file ? rec.hash : undefined;
    } catch {
      return undefined;
    }
  }

  #seenOf(sessionId: string): Promise<Map<string, string>> {
    let seen = this.#seen.get(sessionId);
    if (!seen) {
      seen = readFile(path.join(this.#dir, safe(sessionId), "seen.jsonl"), "utf8").then(
        (text) => {
          const map = new Map<string, string>();
          for (const line of text.split("\n")) {
            try {
              const rec = JSON.parse(line) as { path: string; hash: string };
              map.set(rec.path, rec.hash);
            } catch {
              // 空行或写到一半的一行
            }
          }
          return map;
        },
        () => new Map<string, string>(),
      );
      this.#seen.set(sessionId, seen);
    }
    return seen;
  }

  /** 文件现在的内容是否还是这次写入的结果 */
  async unchangedSince(cp: Checkpoint): Promise<boolean> {
    try {
      return sha256(await readFile(cp.path, "utf8")) === cp.afterHash;
    } catch {
      return false;
    }
  }

  /** 把文件恢复成写入前的样子；原本不存在的文件删掉 */
  async restore(cp: Checkpoint): Promise<void> {
    if (cp.before === null) await rm(cp.path, { force: true });
    else {
      await mkdir(path.dirname(cp.path), { recursive: true });
      await writeFile(cp.path, cp.before);
    }
  }
}

/** 会话和工具调用的 id 用作文件名 */
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");
