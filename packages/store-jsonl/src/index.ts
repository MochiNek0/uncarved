// 文件日志存储：每个会话一个 .jsonl 文件，一行一个事件。对应宪法 4.2、4.3。
// 另有信任确认记录的文件存储，对应 7.1。
//
// - append 写入后 fsync，resolve 即代表已持久化
// - 崩溃可能在文件末尾留下不完整的一行。这次写入从未 resolve，所以读取时忽略它，
//   下次 append 之前截掉。中间某行损坏则直接报错，不做任何修复（I-3）
// - 只追加，不提供删除（3.4：被引用的日志不得删除）

import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { Event, LogStore, TrustRecord, TrustStore } from "uncarved";

export class CorruptLog extends Error {
  readonly sessionId: string;
  readonly line: number;
  constructor(sessionId: string, line: number, cause: unknown) {
    super(`session ${sessionId}: corrupt event at line ${line}`, { cause });
    this.name = "CorruptLog";
    this.sessionId = sessionId;
    this.line = line;
  }
}

export class JsonlLogStore implements LogStore {
  readonly dir: string;
  /** 本实例已检查过末尾的会话；每个会话只有一个写入者（4.3），检查一次即可 */
  #checked = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async append(sessionId: string, events: Event[]): Promise<void> {
    if (events.length === 0) return;
    const file = this.#file(sessionId);
    if (!this.#checked.has(sessionId)) {
      await mkdir(this.dir, { recursive: true });
      await dropTornTail(file);
      this.#checked.add(sessionId);
    }
    const fh = await open(file, "a");
    try {
      await fh.writeFile(events.map((e) => JSON.stringify(e) + "\n").join(""));
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async *read(sessionId: string, fromSeq = 1): AsyncIterable<Event> {
    let text: string;
    try {
      text = await readFile(this.#file(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const lines = text.split("\n");
    lines.pop(); // 最后一个换行之后的内容：空串，或未完成的一行
    for (const [i, line] of lines.entries()) {
      let e: Event;
      try {
        e = JSON.parse(line) as Event;
      } catch (cause) {
        throw new CorruptLog(sessionId, i + 1, cause);
      }
      if (e.seq >= fromSeq) yield e;
    }
  }

  #file(sessionId: string): string {
    // 会话 ID 直接作为文件名，禁止路径分隔符等字符，防止写到目录之外
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith(".")) {
      throw new Error(`invalid session id for file storage: ${JSON.stringify(sessionId)}`);
    }
    return path.join(this.dir, `${sessionId}.jsonl`);
  }
}

/** 信任确认记录（7.1）：一个 .jsonl 文件，一行一条记录，只追加 */
export class JsonlTrustStore implements TrustStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  async has(hash: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    const lines = text.split("\n");
    lines.pop(); // 未写完的一行从未确认成功，忽略
    return lines.some((line) => (JSON.parse(line) as TrustRecord).hash === hash);
  }

  async add(record: TrustRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await dropTornTail(this.file);
    const fh = await open(this.file, "a");
    try {
      await fh.writeFile(JSON.stringify(record) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}

/** 截掉最后一个换行之后的残留内容 */
async function dropTornTail(file: string): Promise<void> {
  let fh;
  try {
    fh = await open(file, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const buf = await fh.readFile();
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end < buf.length) {
      await fh.truncate(end);
      await fh.sync();
    }
  } finally {
    await fh.close();
  }
}
