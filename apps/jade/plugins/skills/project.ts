// 仓库目录、显示用的小工具。插件之间不共享代码（只能共享类型），jade/mcp、jade/checks 各有一份。

import { existsSync, realpathSync } from "node:fs";
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

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

// 设了 NO_COLOR（非空）或标准输出不是终端时不输出颜色，见 https://no-color.org
const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (open: string, close: string) => (s: string) =>
  colors ? `\x1b[${open}m${s.replaceAll(`\x1b[${close}m`, `\x1b[${close}m\x1b[${open}m`)}\x1b[${close}m` : s;
export const dim = paint("2", "22");
export const bold = paint("1", "22");
