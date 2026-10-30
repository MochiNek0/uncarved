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

import { randomUUID } from "node:crypto";
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
    let created = false;
    if (tail === undefined) {
      // 第一次写（或上次出错）：截掉残行，从文件里取最后一个事件
      const kept = await dropTornTail(file);
      created = kept === undefined;
      tail = { size: kept?.size ?? 0, seq: kept ? await this.#lastSeq(sessionId, kept.last) : 0 };
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
      // 新建的文件还要同步目录，否则断电后目录里可能没有这个文件
      if (created) await syncDir(this.dir);
      this.#tails.set(sessionId, { size: size + data.length, seq: events.at(-1)!.seq });
    } finally {
      await fh.close();
    }
  }

  /** 最后一行里事件的 seq，没有事件为 0 */
  async #lastSeq(sessionId: string, last: Buffer): Promise<number> {
    if (last.length === 0) return 0;
    try {
      return (JSON.parse(last.toString("utf8")) as Event).seq;
    } catch (cause) {
      // 完整读一遍，由 read 报出损坏的行号（也可能是更早的一行）
      for await (const _ of this.read(sessionId));
      throw new CorruptLog(sessionId, 0, cause);
    }
  }

  /** 分块读取，内存占用与日志长度无关 */
  async *read(sessionId: string, fromSeq = 1): AsyncIterable<Event> {
    let fh;
    try {
      fh = await open(this.#file(sessionId), "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    try {
      // 还没遇到换行的内容；读到文件末尾时仍留在这里的是未完成的一行，忽略
      const pending: Buffer[] = [];
      let line = 0;
      for (;;) {
        // 每次新分配：pending 里留着上一块的切片
        const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) return;
        const data = chunk.subarray(0, bytesRead);
        let start = 0;
        for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
          pending.push(data.subarray(start, nl));
          const text = Buffer.concat(pending).toString("utf8");
          pending.length = 0;
          start = nl + 1;
          line++;
          let e: Event;
          try {
            e = JSON.parse(text) as Event;
          } catch (cause) {
            throw new CorruptLog(sessionId, line, cause);
          }
          if (e.seq >= fromSeq) yield e;
        }
        if (start < data.length) pending.push(data.subarray(start));
      }
    } finally {
      await fh.close();
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
    return lines.some((line, i) => {
      try {
        return (JSON.parse(line) as TrustRecord).hash === hash;
      } catch (cause) {
        throw new Error(`trust store ${this.file}: corrupt record at line ${i + 1}`, { cause });
      }
    });
  }

  async add(record: TrustRecord): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // 持锁：截残行时不能截掉另一个进程正在写的那一行
    const lockFile = `${this.file}.lock`;
    const release = await acquire(lockFile, (holder) => new Error(`trust store lock ${lockFile} is held by process ${holder}`));
    try {
      const created = (await dropTornTail(this.file)) === undefined;
      const fh = await open(this.file, "a");
      try {
        await fh.writeFile(JSON.stringify(record) + "\n");
        await fh.sync();
        if (created) await syncDir(path.dirname(this.file));
      } finally {
        await fh.close();
      }
    } finally {
      await release();
    }
  }
}

const READ_CHUNK_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 10_000;
/** 空锁文件（进程在创建和写入 pid 之间退出）超过这个时间视为失效 */
const EMPTY_LOCK_STALE_MS = 5_000;

/**
 * 本进程当前持有的锁的内容。锁里写的是 "pid:随机串"：容器重启后进程号常常和崩溃前一样（例如都是 1），
 * 只比较 pid 会把上次留下的锁当成自己的，永远等下去
 */
const held = new Set<string>();

/**
 * 独占创建锁文件并写入本进程 pid；被占用时等待，持有者已退出时接管。返回释放函数。
 * 等待超时时抛出 timeout(持有者 pid) 给出的错误
 */
async function acquire(lockFile: string, timeout: (holder: string) => Error): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lockFile, "wx");
      const token = `${process.pid}:${randomUUID()}`;
      held.add(token);
      try {
        await fh.writeFile(token);
      } finally {
        await fh.close();
      }
      return async () => {
        await rm(lockFile, { force: true });
        held.delete(token);
      };
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
    if (Date.now() > deadline) throw timeout(owner?.split(":")[0] || "?");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function stale(lockFile: string, owner: string): Promise<boolean> {
  if (owner === "") {
    const info = await stat(lockFile).catch(() => undefined);
    return info !== undefined && Date.now() - info.mtimeMs > EMPTY_LOCK_STALE_MS;
  }
  const pid = Number(owner.split(":")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return !held.has(owner);
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

/** fsync 目录，让新建的文件名落盘。Windows 不支持打开目录做 fsync，也不需要 */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const fh = await open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * 截掉最后一个换行之后的残留内容，返回保留部分的大小和其中最后一行（不含换行）；文件不存在返回 undefined。
 * 从文件末尾往前分块找换行，内存占用与日志长度无关
 */
async function dropTornTail(file: string): Promise<{ size: number; last: Buffer } | undefined> {
  let fh;
  try {
    fh = await open(file, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    let keep: number | undefined; // 最后一个换行之后的位置
    let start = 0; // 最后一行的起点
    for (let pos = size; pos > 0; ) {
      const len = Math.min(READ_CHUNK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      await fh.read(chunk, 0, len, pos);
      let before = len;
      if (keep === undefined) {
        const nl = chunk.lastIndexOf(0x0a);
        if (nl < 0) continue;
        keep = pos + nl + 1;
        before = nl;
      }
      // lastIndexOf 的起点是负数时从末尾算起，要单独排除
      const prev = before > 0 ? chunk.lastIndexOf(0x0a, before - 1) : -1;
      if (prev >= 0) {
        start = pos + prev + 1;
        break;
      }
    }
    keep ??= 0;
    if (keep < size) {
      await fh.truncate(keep);
      await fh.sync();
    }
    const last = Buffer.alloc(Math.max(keep - 1 - start, 0));
    if (last.length > 0) await fh.read(last, 0, last.length, start);
    return { size: keep, last };
  } finally {
    await fh.close();
  }
}
