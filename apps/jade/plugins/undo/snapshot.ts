// 工作区快照：shell 命令改了什么无从得知，所以每轮第一次跑命令之前给整个工作区拍一张快照，/undo 时把之后变了的文件恢复回去。
//
// 快照存在 $JADE_HOME 里的一个影子 git 仓库（<dir>/shadow/.git），工作区指向项目的仓库根目录：
// 项目自己的 .git（暂存区、提交、stash）一点不碰。只在 git 仓库里做：要靠 .gitignore 跳过 node_modules 这类目录，
// 对象库借用项目的（alternates），已经提交过的内容不再存一份。被忽略的文件不在快照里，撤销不了。
// 快照是 tree 对象，不建提交；哪一轮对应哪个 tree 记在 snapshots.json。

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Snapshot {
  /** 这一轮第一次 bash 调用的 toolUseId：/undo 按它找到是哪一轮 */
  toolUseId: string;
  /** 影子仓库里的 tree */
  tree: string;
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

  /** 给工作区拍一张快照，返回 tree；不在 git 仓库里时 undefined */
  async take(): Promise<string | undefined> {
    const r = await this.#prepare();
    if (!r) return undefined;
    await git(["add", "-A", "--ignore-errors", "."], { cwd: r.root, env: r.env }).catch(() => {
      // 有的文件加不进去（被别的程序锁着、嵌套的仓库）：其余的照样拍
    });
    return (await git(["write-tree"], { cwd: r.root, env: r.env })).trim();
  }

  /** 工作区现在和快照 tree 相比变了的文件 */
  async changed(tree: string): Promise<Change[]> {
    const r = await this.#prepare();
    const now = await this.take();
    if (!r || !now || now === tree) return [];
    const out = await git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", tree, now], { cwd: r.root, env: r.env });
    const parts = out.split("\0");
    const changes: Change[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ path: path.join(r.root, parts[i + 1]!), added: parts[i] === "A" });
    return changes;
  }

  /** 把这些文件恢复成快照 tree 里的样子：之后新出现的删掉，其余的取回 */
  async restore(tree: string, changes: readonly Change[]): Promise<void> {
    const r = await this.#prepare();
    if (!r) return;
    for (const c of changes) if (c.added) await rm(c.path, { force: true });
    const back = changes.filter((c) => !c.added).map((c) => path.relative(r.root, c.path).split(path.sep).join("/"));
    for (let i = 0; i < back.length; i += CHUNK) {
      await git(["--literal-pathspecs", "checkout", tree, "--", ...back.slice(i, i + CHUNK)], { cwd: r.root, env: r.env });
    }
  }

  /** 本会话记下的快照，最新的在前 */
  async list(): Promise<Snapshot[]> {
    try {
      const all = JSON.parse(await readFile(path.join(this.#dir, FILE), "utf8")) as unknown;
      return Array.isArray(all) ? (all as Snapshot[]).sort((a, b) => b.at - a.at) : [];
    } catch {
      return [];
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    const all = await this.list();
    await mkdir(this.#dir, { recursive: true });
    await writeFile(path.join(this.#dir, FILE), JSON.stringify([snapshot, ...all]));
  }
}

function git(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
