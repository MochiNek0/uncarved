// 宿主显示用的纯函数：工具调用的默认摘要和预览、折叠的工具结果。不依赖运行时和界面状态。
// 各个工具自己的显示由插件经 renderers@1 登记。

import os from "node:os";
import path from "node:path";
import { dim } from "./screen.ts";

/** 显示用的路径：工作目录里的用相对路径，其余用绝对路径；都用正斜杠。和 jade/fs 的 display 相同，插件之间不 import 值，所以这里留一份 */
function display(cwd: string, full: string): string {
  const rel = path.relative(cwd, full);
  const shown = rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : full;
  return shown.split(path.sep).join("/");
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * 带颜色（SGR 序列）的文字截到 n 个可见字符：序列不算长度、不会被切开；截断时在最后复位颜色，
 * 不让没关上的颜色渗到后面的行
 */
export function clipStyled(s: string, n: number): string {
  const sgr = /\x1b\[[0-9;:]*m/y;
  let out = "";
  let visible = 0;
  let styled = false;
  for (let i = 0; i < s.length; ) {
    sgr.lastIndex = i;
    const m = sgr.exec(s);
    if (m) {
      out += m[0];
      styled = true;
      i += m[0].length;
      continue;
    }
    if (visible === n) return out + "…" + (styled ? "\x1b[0m" : "");
    out += s[i];
    visible++;
    i++;
  }
  return out;
}

/** 家目录下的路径显示成 ~/… */
export function shortPath(p: string): string {
  const rel = path.relative(os.homedir(), p);
  const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel}` : rel === "" ? "~" : p;
  return shown.split(path.sep).join("/");
}

/** 工具调用默认的一行摘要，显示在工具名后面的括号里：path 参数，没有时是参数的 JSON */
export function summarize(cwd: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const where = typeof i.path === "string" ? display(cwd, i.path) : "";
  return where || clip(JSON.stringify(input), 120);
}

/** 审批时默认的预览：参数的 JSON */
export function preview(input: unknown): string {
  return dim(clip(JSON.stringify(input, null, 2), 2000));
}

/** 工具结果展开后的内容：缩进的全部行，超过 max 行时截断 */
export function detailsOf(lines: string[], color: (s: string) => string, max: number): string {
  const body = lines.slice(0, max).map((l) => color(`    ${l}`));
  if (lines.length > max) body.push(dim(`    … ${lines.length - max} more lines`));
  return body.join("\n");
}
