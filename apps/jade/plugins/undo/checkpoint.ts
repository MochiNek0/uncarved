// 文件快照：write_file / edit_file / multi_edit 执行前保存原内容，/undo 用它恢复。从旧 jade 的 tools/checkpoint.ts 移植。
//
// 快照放在 <dir>/<sessionId>/<toolUseId>.json，不进日志：文件可能很大，而撤销是用户的操作，不影响插件决策。
// 哪些修改已经撤销记在同一个目录的 undone.json 里（命令拿不到会话日志），恢复会话后仍然有效。

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "uncarved";

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
      if (!n.endsWith(".json") || n === UNDONE) continue;
      try {
        out.push(JSON.parse(await readFile(path.join(dir, n), "utf8")) as Checkpoint);
      } catch {
        // 写到一半的快照，忽略
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** 已经撤销的修改（toolUseId） */
  async undone(sessionId: string): Promise<Set<string>> {
    try {
      const ids = JSON.parse(await readFile(path.join(this.#dir, safe(sessionId), UNDONE), "utf8")) as unknown;
      return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  async markUndone(sessionId: string, ids: Iterable<string>): Promise<void> {
    const all = await this.undone(sessionId);
    for (const id of ids) all.add(id);
    const dir = path.join(this.#dir, safe(sessionId));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, UNDONE), JSON.stringify([...all]));
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

const UNDONE = "undone.json";

/**
 * 最近一轮还有没撤销的修改的快照（最新的在前）。一轮从一条用户自己写的消息开始；
 * 只有工具结果、或者只有插件、宿主加的说明（例如自动续写的提示）的消息不算新的一轮。没有可撤销的返回空数组
 */
export function lastTurnChanges(messages: readonly Message[], checkpoints: readonly Checkpoint[], undone: ReadonlySet<string>): Checkpoint[] {
  const pending = checkpoints.filter((c) => !undone.has(c.toolUseId));
  if (pending.length === 0) return [];
  let ids = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      for (const b of m.content) if (b.kind === "tool_use") ids.add(b.id);
      continue;
    }
    const startsTurn = m.content.some((b) => b.kind !== "tool_result" && b.origin.by === "user");
    if (!startsTurn) continue;
    const hits = pending.filter((c) => ids.has(c.toolUseId));
    if (hits.length > 0) return hits;
    ids = new Set();
  }
  // 找不到对应的消息（不应该发生）：退回到只撤销最近的一次写入
  return pending.slice(0, 1);
}

/** 会话和工具调用的 id 用作文件名 */
const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");
