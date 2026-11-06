// 定时任务的存储：$JADE_HOME/state/schedules.json。同一台机器上可能开着好几个 jade，
// 所有读写都在一把目录锁（schedules.lock，mkdir 是原子的）里进行，到点的任务由先拿到锁的进程认领，只投递一次。

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nextRun } from "./cron.ts";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  /** 五字段 cron，本机时区 */
  cron: string;
  /** false：触发一次后结束 */
  recurring: boolean;
  /** 创建时的工作目录：只有在这个目录里运行的 jade 投递它 */
  cwd: string;
  /** 投递到哪里。现在只有 cwd：投到这个目录里正在运行的 jade 的当前会话 */
  target: { kind: "cwd" };
  status: "active" | "paused" | "ended";
  /** 下一次触发的时间（ISO）；只有 active 的任务有 */
  next?: string;
  createdAt: string;
  updatedAt: string;
  /** 最近一次投递 */
  last?: { at: string; session: string };
}

interface File {
  version: 1;
  tasks: Task[];
}

/** 锁超过这么久没释放，当作持有它的进程已经不在了 */
const STALE_MS = 10_000;
const WAIT_MS = 5_000;

export class ScheduleStore {
  readonly file: string;
  readonly #lock: string;

  constructor(home: string) {
    this.file = path.join(home, "state", "schedules.json");
    this.#lock = path.join(home, "state", "schedules.lock");
  }

  /** 读全部任务 */
  list(): Promise<Task[]> {
    return this.#locked(() => this.#read());
  }

  /** 在锁里读出全部任务交给 fn，fn 改了就写回。fn 抛错时不写 */
  update<T>(fn: (tasks: Task[]) => T): Promise<T> {
    return this.#locked(async () => {
      const tasks = await this.#read();
      const before = JSON.stringify(tasks);
      const out = fn(tasks);
      if (JSON.stringify(tasks) !== before) {
        const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, `${JSON.stringify({ version: 1, tasks } satisfies File, null, 2)}\n`);
        await rename(tmp, this.file);
      }
      return out;
    });
  }

  async #read(): Promise<Task[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const data = JSON.parse(text) as Partial<File>;
    if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error(`${this.file}: unsupported format`);
    return data.tasks;
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.#lock), { recursive: true });
    const deadline = Date.now() + WAIT_MS;
    // 记下自己建的锁目录的文件号，释放时只删自己的锁：持有太久被别人当成过期删掉、重新上了锁时，不去删别人的
    let mine: bigint | undefined;
    for (;;) {
      try {
        await mkdir(this.#lock);
        mine = await lockId(this.#lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = await stat(this.#lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > STALE_MS) await rm(this.#lock, { recursive: true, force: true });
        else if (Date.now() > deadline) throw new Error(`${this.#lock} is held by another jade; remove it if no jade is running`);
        else await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      return await fn();
    } finally {
      if (mine !== undefined && (await lockId(this.#lock)) === mine) await rm(this.#lock, { recursive: true, force: true });
    }
  }
}

/** 锁目录的文件号；不在了时 undefined */
const lockId = (dir: string) => stat(dir, { bigint: true }).then((s) => s.ino, () => undefined);

/**
 * 两个目录是不是同一个：比较绝对路径（不看末尾的分隔符），Windows 上不分大小写。
 * 和 jade/sessions 的 cwdKey 相同，插件之间不共享代码（只能共享类型），所以这里留一份
 */
export function sameDir(a: string, b: string): boolean {
  const key = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return key(a) === key(b);
}

/** 下一次触发时间；没有了时 undefined */
export function nextAt(cron: string, from: Date): string | undefined {
  return nextRun(cron, from)?.toISOString();
}

/**
 * 认领 cwd 里到点的任务：记下这次投递，推进到 now 之后的下一次（错过的几次只算一次），
 * 一次性的任务结束。skip 里的任务（上一次还没跑完）不认领，留到下次检查
 */
export function claimDue(store: ScheduleStore, cwd: string, session: string, now: Date, skip: ReadonlySet<string> = new Set()): Promise<Task[]> {
  return store.update((tasks) => {
    const due: Task[] = [];
    for (const t of tasks) {
      if (t.status !== "active" || !sameDir(t.cwd, cwd) || !t.next || Date.parse(t.next) > now.getTime() || skip.has(t.id)) continue;
      t.last = { at: now.toISOString(), session };
      t.updatedAt = now.toISOString();
      const next = t.recurring ? nextAt(t.cron, now) : undefined;
      if (next) t.next = next;
      else {
        t.status = "ended";
        delete t.next;
      }
      due.push({ ...t });
    }
    return due;
  });
}
