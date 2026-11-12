// 仓库目录、显示用的小工具、斜杠命令参数的切分、token 估算。插件之间不共享代码（只能共享类型），jade/mcp、jade/checks 各有一份。

import type { Span, Text, TextStyle } from "@uncarved/jade-api";
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

// 带语义样式的文字（jade-api 的 Text）：插件只说这段是次要的、成功、警告……，怎么画由前端决定
const styled = (style: TextStyle) => (text: string): Span => ({ text, style });
export const dim = styled("dim");
export const bold = styled("bold");
export const ok = styled("ok");
export const warn = styled("warn");
export const error = styled("error");
/** 几行接成一段，行之间换行 */
export const lines = (rows: readonly Text[]): Text => rows.flatMap((r, i) => (i ? ["\n", r] : [r]));
/** 只取文字（输出到 stdout 的终端命令用） */
export const plain = (t: Text): string => (typeof t === "string" ? t : Array.isArray(t) ? (t as readonly Text[]).map(plain).join("") : (t as Span).text);

/** 斜杠命令的参数按空白切开；"…" 或 '…' 里的空白不切（不处理反斜杠，Windows 路径照写） */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | undefined;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote}`);
  if (started) out.push(cur);
  return out;
}

/** 中日韩文字和全角符号：大约一个字一个 token（和 jade/compact 的估算一致） */
const WIDE = /[　-鿿가-힯豈-﫿＀-￯]/g;

/** 粗略估算一段文字发给模型时占多少 token：英文和代码约 4 个字符 1 个，中日韩文字每字约 1 个 */
export function estimateTokens(text: string): number {
  const wide = text.match(WIDE)?.length ?? 0;
  return Math.ceil((text.length - wide) / 4 + wide);
}
