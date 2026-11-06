// 仓库目录、确认记录、显示用的小工具。插件之间不共享代码（只能共享类型），jade/skills、jade/checks 各有一份。

import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** git 仓库的根目录（往上找 .git，目录或文件都算）；不在仓库里时是 cwd 本身 */
export function repoRoot(cwd: string): string {
  let d = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return d;
    const parent = path.dirname(d);
    if (parent === d) return path.resolve(cwd);
    d = parent;
  }
}

/** 从仓库根目录到工作目录的每一级目录，远的在前；工作目录不在仓库里时只有工作目录 */
export function projectDirs(root: string, cwd: string): string[] {
  const rel = path.relative(root, cwd);
  const inside = rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  if (!inside) return [cwd];
  const dirs = [root];
  if (rel) for (const seg of rel.split(path.sep)) dirs.push(path.join(dirs.at(-1)!, seg));
  return dirs;
}

/** 工作目录里的显示成相对路径，外面的显示绝对路径 */
export function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

/**
 * 用户确认过的东西（项目层的 MCP 服务），每行一条 { hash, path, at }。
 * 和旧 jade 的 $JADE_HOME/trust.jsonl 同一个文件、同一种格式，旧 jade 里确认过的不用再确认
 */
export class TrustFile {
  readonly file: string;
  #known = new Set<string>();

  constructor(file: string) {
    this.file = file;
  }

  async has(hash: string): Promise<boolean> {
    if (this.#known.has(hash)) return true;
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return false;
    }
    for (const line of text.split("\n")) {
      try {
        if ((JSON.parse(line) as { hash?: unknown }).hash === hash) {
          this.#known.add(hash);
          return true;
        }
      } catch {
        // 写到一半的行
      }
    }
    return false;
  }

  async add(hash: string, where: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify({ hash, path: where, at: new Date().toISOString() })}\n`);
    this.#known.add(hash);
  }
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// 设了 NO_COLOR（非空）或标准输出不是终端时不输出颜色，见 https://no-color.org
const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (open: string, close: string) => (s: string) =>
  colors ? `\x1b[${open}m${s.replaceAll(`\x1b[${close}m`, `\x1b[${close}m\x1b[${open}m`)}\x1b[${close}m` : s;
export const dim = paint("2", "22");
export const red = paint("31", "39");
export const green = paint("32", "39");
export const yellow = paint("33", "39");
export const bold = paint("1", "22");
