// 工作区快照：shell 命令改了什么无从得知，所以每轮第一次跑命令之前给整个工作区拍一张快照，/undo 时把之后变了的文件恢复回去。
//
// 快照存在 $JADE_HOME 里的一个影子 git 仓库（<dir>/shadow/.git），工作区指向项目的仓库根目录：
// 项目自己的 .git（暂存区、提交、stash）一点不碰。只在 git 仓库里做：要靠 .gitignore 跳过 node_modules 这类目录，
// 对象库借用项目的（alternates），已经提交过的内容不再存一份。被忽略的文件不在快照里，撤销不了。
// 快照是 tree 对象，不建提交；哪一轮对应哪个 tree 记在 snapshots.json。
// 一轮结束时再拍一张（after）：撤销时只动这一轮之内变了的文件，之后别人（用户的 /sh、手改）动过的不会被一起冲掉，而是先问。
// 同一个影子仓库的操作在进程内排队：并行的子 Agent、/undo 都会用它，git 的 index.lock 不能并发。

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Snapshot {
  /** 这一轮第一次 bash 调用的 toolUseId：/undo 按它找到是哪一轮。用户自己执行的命令（label）是生成的 id */
  toolUseId: string;
  /** 影子仓库里的 tree：命令之前 */
  tree: string;
  /** 一轮（或用户的命令）结束时的 tree；没有时（旧记录、进程中途退出）撤销时和工作区现在的样子比 */
  after?: string;
  /** 子 Agent 拍的：根会话里打开它的那次调用（同 Checkpoint.via） */
  via?: string;
  /** 有它的是用户自己执行的命令（例如 /sh 的 "$ npm i"），单独算一步撤销，不属于哪一轮 */
  label?: string;
  /** 拍下的时间，和 Checkpoint.at 同一个钟 */
  at: number;
}

/** 快照之后变了的一个文件。added：之后新出现的（撤销时删掉）；其余的恢复成快照里的内容 */
export interface Change {
  /** 绝对路径 */
  path: string;
  added: boolean;
}

const FILE = "snapshots.json";
/** 一次 git 命令最多带这么多路径：Windows 的命令行长度有限 */
const CHUNK = 100;

/** 影子仓库目录 → 排在最后的操作 */
const queues = new Map<string, Promise<unknown>>();
/** 同一个目录的操作一个接一个执行（前一个失败不影响后一个） */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** 同一个目录共用一个实例：影子仓库只准备一次 */
const instances = new Map<string, Snapshots>();
/** dir：会话的快照目录；cwd：会话的工作目录 */
export function snapshotsAt(dir: string, cwd: string): Snapshots {
  const key = `${dir}|${cwd}`;
  let s = instances.get(key);
  if (!s) instances.set(key, (s = new Snapshots(dir, cwd)));
  return s;
}

export class Snapshots {
  readonly #dir: string;
  readonly #cwd: string;
  /** 影子仓库准备好之后的 git 环境；不在 git 仓库里（或没有 git）时 undefined */
  #ready: Promise<{ env: NodeJS.ProcessEnv; root: string } | undefined> | undefined;

  /** dir：这个会话的快照目录；cwd：会话的工作目录 */
  constructor(dir: string, cwd: string) {
    this.#dir = dir;
    this.#cwd = cwd;
  }

  #prepare(): Promise<{ env: NodeJS.ProcessEnv; root: string } | undefined> {
    return (this.#ready ??= (async () => {
      let root: string;
      let objects: string;
      try {
        root = path.resolve((await git(["rev-parse", "--show-toplevel"], { cwd: this.#cwd })).trim());
        objects = path.resolve(this.#cwd, (await git(["rev-parse", "--git-common-dir"], { cwd: this.#cwd })).trim(), "objects");
      } catch {
        return undefined;
      }
      const shadow = path.join(this.#dir, "shadow");
      const gitDir = path.join(shadow, ".git");
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root };
      delete env.GIT_INDEX_FILE;
      try {
        await readFile(path.join(gitDir, "HEAD"));
      } catch {
        await mkdir(shadow, { recursive: true });
        await git(["init", "--quiet", shadow], { cwd: shadow });
        // 原样存、原样取：不做换行转换，不跑 LFS 之类的 filter。info/attributes 比工作区里的 .gitattributes 优先
        await mkdir(path.join(gitDir, "info"), { recursive: true });
        await writeFile(path.join(gitDir, "info", "attributes"), "* -text -eol -filter -ident -working-tree-encoding\n");
        await writeFile(path.join(gitDir, "objects", "info", "alternates"), `${objects.split(path.sep).join("/")}\n`);
        for (const [k, v] of [["core.autocrlf", "false"], ["core.safecrlf", "false"], ["core.longpaths", "true"], ["gc.auto", "0"]]) {
          await git(["config", k!, v!], { cwd: root, env });
        }
      }
      return { env, root };
    })());
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    return serial(this.#dir, fn);
  }

  /** 给工作区拍一张快照，返回 tree；不在 git 仓库里时 undefined */
  take(): Promise<string | undefined> {
    return this.#serial(() => this.#take());
  }

  async #take(): Promise<string | undefined> {
    const r = await this.#prepare();
    if (!r) return undefined;
    await git(["add", "-A", "--ignore-errors", "."], { cwd: r.root, env: r.env }).catch(() => {
      // 有的文件加不进去（被别的程序锁着、嵌套的仓库）：其余的照样拍
    });
    return (await git(["write-tree"], { cwd: r.root, env: r.env })).trim();
  }

  /**
   * 撤销这张快照要动的文件，和其中之后又被改过的（conflicts，绝对路径）。
   * 有 after 时是 tree 到 after 之间变了的文件，工作区现在和 after 不一样的算之后改过；
   * 没有时（旧记录、进程中途退出）是 tree 到现在变了的文件，分不出哪些是之后改的
   */
  changes(snap: Pick<Snapshot, "tree" | "after">): Promise<{ changes: Change[]; conflicts: Set<string> }> {
    return this.#serial(async () => {
      const r = await this.#prepare();
      const now = await this.#take();
      if (!r || !now) return { changes: [], conflicts: new Set<string>() };
      const end = snap.after ?? now;
      const changes = await this.#diff(r, snap.tree, end);
      const later = new Set((await this.#diff(r, end, now)).map((c) => c.path));
      return { changes, conflicts: new Set(changes.map((c) => c.path).filter((p) => later.has(p))) };
    });
  }

  async #diff(r: { env: NodeJS.ProcessEnv; root: string }, from: string, to: string): Promise<Change[]> {
    if (from === to) return [];
    const out = await git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to], { cwd: r.root, env: r.env });
    const parts = out.split("\0");
    const changes: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ path: path.join(r.root, parts[i + 1]!), added: parts[i] === "A" });
    return changes;
  }

  /** 把这些文件恢复成快照 tree 里的样子：之后新出现的删掉，其余的取回 */
  restore(tree: string, changes: readonly Change[]): Promise<void> {
    return this.#serial(() => this.#restore(tree, changes));
  }

  async #restore(tree: string, changes: readonly Change[]): Promise<void> {
    const r = await this.#prepare();
    if (!r) return;
    for (const c of changes) if (c.added) await rm(c.path, { force: true });
    const back = changes.filter((c) => !c.added).map((c) => path.relative(r.root, c.path).split(path.sep).join("/"));
    for (let i = 0; i < back.length; i += CHUNK) {
      await git(["--literal-pathspecs", "checkout", tree, "--", ...back.slice(i, i + CHUNK)], { cwd: r.root, env: r.env });
    }
  }

  /** 本会话记下的快照，最新的在前 */
  list(): Promise<Snapshot[]> {
    return this.#serial(() => this.#list());
  }

  async #list(): Promise<Snapshot[]> {
    try {
      const all = JSON.parse(await readFile(path.join(this.#dir, FILE), "utf8")) as unknown;
      return Array.isArray(all) ? (all as Snapshot[]).sort((a, b) => b.at - a.at) : [];
    } catch {
      return [];
    }
  }

  save(snapshot: Snapshot): Promise<void> {
    return this.#serial(async () => this.#write([snapshot, ...(await this.#list())]));
  }

  /** 给这张快照补上结束时的 tree（现在工作区的样子） */
  close(toolUseId: string): Promise<void> {
    return this.#serial(async () => {
      const after = await this.#take();
      if (!after) return;
      await this.#write((await this.#list()).map((s) => (s.toolUseId === toolUseId ? { ...s, after } : s)));
    });
  }

  async #write(all: Snapshot[]): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(path.join(this.#dir, FILE), JSON.stringify(all));
  }
}

function git(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
