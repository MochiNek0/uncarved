// 文件日志存储：每个会话一个 .jsonl 文件，一行一个事件。对应宪法 4.2、4.3。
// 另有信任确认记录的文件存储，对应 7.1。
//
// - append 写入后 fsync，resolve 即代表已持久化
// - 崩溃可能在文件末尾留下不完整的一行。这次写入从未 resolve，所以读取时忽略它，
//   下次 append 之前截掉。中间某行损坏则直接报错，不做任何修复（I-3）
// - 只追加，不提供删除（3.4：被引用的日志不得删除）
// - 每个会话只能有一个写入者（4.3）。每次 append 持有 <id>.jsonl.lock（独占创建），检查和写入之间不会插进别的写入；
//   另一个进程（或另一个实例）也在写同一个会话时，本实例的下一次 append 会发现文件和自己最后写入时不一致，
//   拒绝写入（ConcurrentWrite）。持锁进程已经不在时锁视为失效，可以接管

import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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

/** 同一个会话有另一个写入者（4.3） */
export class ConcurrentWrite extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, detail: string) {
    super(`session ${sessionId}: another writer is appending to this log (${detail})`);
    this.name = "ConcurrentWrite";
    this.sessionId = sessionId;
  }
}

export class JsonlLogStore implements LogStore {
  readonly dir: string;
  /** 本实例写过的会话，以及最后一次写入后文件应有的大小和最后一个 seq */
  #tails = new Map<string, { size: number; seq: number }>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async append(sessionId: string, events: Event[]): Promise<void> {
    if (events.length === 0) return;
    const file = this.#file(sessionId);
    if (!this.#tails.has(sessionId)) await mkdir(this.dir, { recursive: true });
    const lockFile = `${file}.lock`;
    const release = await acquire(lockFile, (holder) => new ConcurrentWrite(sessionId, `lock ${lockFile} is held by process ${holder}`));
    try {
      await this.#appendLocked(sessionId, file, events);
    } catch (err) {
      // 写到一半出错时文件状态不明（可能留下残行，也可能整行已经落盘）：下次从文件重新确认
      this.#tails.delete(sessionId);
      throw err;
    } finally {
      await release();
    }
  }

  async #appendLocked(sessionId: string, file: string, events: Event[]): Promise<void> {
    let tail = this.#tails.get(sessionId);
    if (tail === undefined) {
      // 第一次写（或上次出错）：截掉残行，从文件里取最后一个事件
      const kept = (await dropTornTail(file)) ?? Buffer.alloc(0);
      tail = { size: kept.length, seq: lastSeq(kept, sessionId) };
    }
    // 每次都确认要写的事件紧接着最后一个事件：调用方以为失败、其实已经落盘的写入不会被重复写入
    if (events[0]!.seq !== tail.seq + 1) {
      throw new ConcurrentWrite(sessionId, `log ends at seq ${tail.seq}, appending seq ${events[0]!.seq}`);
    }
    const fh = await open(file, "a");
    try {
      // 文件大小和本实例最后一次写入后不同，说明别人写过
      const { size } = await fh.stat();
      if (size !== tail.size) throw new ConcurrentWrite(sessionId, `log is ${size} bytes, expected ${tail.size}`);
      const data = Buffer.from(events.map((e) => JSON.stringify(e) + "\n").join(""));
      await fh.writeFile(data);
      await fh.sync();
      this.#tails.set(sessionId, { size: size + data.length, seq: events.at(-1)!.seq });
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
    // 持锁：截残行时不能截掉另一个进程正在写的那一行
    const lockFile = `${this.file}.lock`;
    const release = await acquire(lockFile, (holder) => new Error(`trust store lock ${lockFile} is held by process ${holder}`));
    try {
      await dropTornTail(this.file);
      const fh = await open(this.file, "a");
      try {
        await fh.writeFile(JSON.stringify(record) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }
    } finally {
      await release();
    }
  }
}

const LOCK_WAIT_MS = 10_000;
/** 空锁文件（进程在创建和写入 pid 之间退出）超过这个时间视为失效 */
const EMPTY_LOCK_STALE_MS = 5_000;

/**
 * 独占创建锁文件并写入本进程 pid；被占用时等待，持有者已退出时接管。返回释放函数。
 * 等待超时时抛出 timeout(持有者 pid) 给出的错误
 */
async function acquire(lockFile: string, timeout: (holder: string) => Error): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lockFile, "wx");
      try {
        await fh.writeFile(String(process.pid));
      } finally {
        await fh.close();
      }
      return () => rm(lockFile, { force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows 上锁文件正在被删除（待删除状态）时，创建同名文件报 EPERM：等它删完
      const deleting = code === "EPERM" && process.platform === "win32";
      if (code !== "EEXIST" && !deleting) throw err;
      if (deleting) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
    }
    const owner = await readFile(lockFile, "utf8").catch(() => undefined);
    if (owner !== undefined && (await stale(lockFile, owner))) {
      await takeOver(lockFile, owner);
      continue;
    }
    if (Date.now() > deadline) throw timeout(owner || "?");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function stale(lockFile: string, owner: string): Promise<boolean> {
  if (owner === "") {
    const info = await stat(lockFile).catch(() => undefined);
    return info !== undefined && Date.now() - info.mtimeMs > EMPTY_LOCK_STALE_MS;
  }
  const pid = Number(owner);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM：进程存在，只是没有权限发信号
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/**
 * 接管失效的锁：先把它改名挪开（只有一个接管者能成功），再确认挪走的确实是那把失效的锁。
 * 如果两个接管者赶在一起、挪走的是对方刚建好的新锁，就用 link（目标已存在时失败，不会覆盖）放回去
 */
async function takeOver(lockFile: string, owner: string): Promise<void> {
  const moved = `${lockFile}.${process.pid}.${Date.now()}`;
  try {
    await rename(lockFile, moved);
  } catch {
    return; // 别人先挪走了
  }
  const content = await readFile(moved, "utf8").catch(() => owner);
  // 空锁只能凭时间判断失效：挪走的也可能是别人刚建好、还没写入 pid 的新空锁，内容同样为空，要再看一次时间
  const same = content === owner && (owner !== "" || (await stale(moved, "")));
  if (!same) await link(moved, lockFile).catch(() => {});
  await rm(moved, { force: true });
}

/** 已截掉残行的文件内容里最后一个事件的 seq，没有事件为 0 */
function lastSeq(kept: Buffer, sessionId: string): number {
  const end = kept.length - 1;
  if (end < 0) return 0;
  const line = kept.subarray(kept.lastIndexOf(0x0a, end - 1) + 1, end).toString("utf8");
  try {
    return (JSON.parse(line) as Event).seq;
  } catch (cause) {
    let lines = 0;
    for (const b of kept) if (b === 0x0a) lines++;
    throw new CorruptLog(sessionId, lines, cause);
  }
}

/** 截掉最后一个换行之后的残留内容，返回保留的内容；文件不存在返回 undefined */
async function dropTornTail(file: string): Promise<Buffer | undefined> {
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
    return buf.subarray(0, end);
  } finally {
    await fh.close();
  }
}
