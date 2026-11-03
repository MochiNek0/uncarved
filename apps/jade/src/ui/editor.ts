// 输入框的编辑操作和折行。都是纯函数，便于测试。
// cursor 是 value 中的下标（UTF-16），操作按码点移动，不会把代理对拆开。

import stringWidth from "string-width";

export interface EditState {
  value: string;
  cursor: number;
}

export const empty: EditState = { value: "", cursor: 0 };

/** 光标前一个码点的起始下标 */
function prev(value: string, i: number): number {
  if (i <= 0) return 0;
  const c = value.charCodeAt(i - 1);
  return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

/** 光标后一个码点的结束下标 */
function next(value: string, i: number): number {
  if (i >= value.length) return value.length;
  const c = value.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < value.length ? i + 2 : i + 1;
}

const lineStart = (value: string, i: number) => value.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (value: string, i: number) => {
  const n = value.indexOf("\n", i);
  return n === -1 ? value.length : n;
};

export const edit = {
  insert: (s: EditState, text: string): EditState => ({
    value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
    cursor: s.cursor + text.length,
  }),
  backspace: (s: EditState): EditState => {
    const p = prev(s.value, s.cursor);
    return { value: s.value.slice(0, p) + s.value.slice(s.cursor), cursor: p };
  },
  del: (s: EditState): EditState => ({ value: s.value.slice(0, s.cursor) + s.value.slice(next(s.value, s.cursor)), cursor: s.cursor }),
  left: (s: EditState): EditState => ({ ...s, cursor: prev(s.value, s.cursor) }),
  right: (s: EditState): EditState => ({ ...s, cursor: next(s.value, s.cursor) }),
  home: (s: EditState): EditState => ({ ...s, cursor: lineStart(s.value, s.cursor) }),
  end: (s: EditState): EditState => ({ ...s, cursor: lineEnd(s.value, s.cursor) }),
  /** 删除光标前的一个词（连同它和光标之间的空白），同 shell 的 Ctrl+W */
  deleteWord: (s: EditState): EditState => {
    const before = s.value.slice(0, s.cursor);
    const kept = before.replace(/\S*\s*$/u, "");
    return { value: kept + s.value.slice(s.cursor), cursor: kept.length };
  },
  /** 删除光标到行首 */
  killBefore: (s: EditState): EditState => {
    const start = lineStart(s.value, s.cursor);
    return { value: s.value.slice(0, start) + s.value.slice(s.cursor), cursor: start };
  },
  /** 删除光标到行尾 */
  killAfter: (s: EditState): EditState => ({ value: s.value.slice(0, s.cursor) + s.value.slice(lineEnd(s.value, s.cursor)), cursor: s.cursor }),
  /** 光标所在行是第一行 / 最后一行（上下键在多行输入里移动光标，到边上才翻历史） */
  onFirstLine: (s: EditState) => !s.value.slice(0, s.cursor).includes("\n"),
  onLastLine: (s: EditState) => !s.value.slice(s.cursor).includes("\n"),
  up: (s: EditState): EditState => {
    const start = lineStart(s.value, s.cursor);
    if (start === 0) return s;
    const col = s.cursor - start;
    const prevStart = lineStart(s.value, start - 1);
    return { ...s, cursor: Math.min(prevStart + col, start - 1) };
  },
  down: (s: EditState): EditState => {
    const end = lineEnd(s.value, s.cursor);
    if (end === s.value.length) return s;
    const col = s.cursor - lineStart(s.value, s.cursor);
    return { ...s, cursor: Math.min(end + 1 + col, lineEnd(s.value, end + 1)) };
  },
};

export interface Layout {
  rows: string[];
  /** 光标所在的行和列（列按显示宽度，中文占两列） */
  row: number;
  col: number;
}

/** 单个字符的显示宽度；每次按键都要把整段输入过一遍，stringWidth 较慢，ASCII 直接算，其余缓存 */
const widths = new Map<string, number>();
export function charWidth(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x20 && c < 0x7f) return 1;
  let w = widths.get(ch);
  if (w === undefined) widths.set(ch, (w = stringWidth(ch)));
  return w;
}

/** 光标可以停的每个位置（码点边界）在折行后的行和列，和 layout 的折法一致 */
function stops(value: string, width: number): { i: number; row: number; col: number }[] {
  width = Math.max(2, width);
  const out: { i: number; row: number; col: number }[] = [];
  let row = 0;
  let w = 0;
  let i = 0;
  // 正好停在满行末尾时算下一行开头（同 layout）
  const stop = (at: number) => out.push(w >= width ? { i: at, row: row + 1, col: 0 } : { i: at, row, col: w });
  for (const ch of value) {
    if (ch === "\n") {
      stop(i);
      row++;
      w = 0;
    } else {
      const cw = charWidth(ch);
      if (w + cw > width) {
        row++;
        w = 0;
      }
      stop(i);
      w += cw;
    }
    i += ch.length;
  }
  stop(value.length);
  return out;
}

/** 折行后第 row 行里最接近第 col 列（不超过它）的光标位置；没有这一行时返回 undefined */
export function offsetAt(value: string, width: number, row: number, col: number): number | undefined {
  const inRow = stops(value, width).filter((s) => s.row === row);
  if (inRow.length === 0) return undefined;
  return (inRow.findLast((s) => s.col <= col) ?? inRow[0]!).i;
}

/**
 * 按折行后的屏幕行上下移动光标，保持显示列（中文占两列）。已经在第一行 / 最后一行时返回 undefined，
 * 由调用方去翻历史
 */
export function moveRow(s: EditState, width: number, by: -1 | 1): EditState | undefined {
  const all = stops(s.value, width);
  const here = all.find((x) => x.i === s.cursor) ?? all.at(-1)!;
  const target = here.row + by;
  if (target < 0 || target > all.at(-1)!.row) return undefined;
  const cursor = offsetAt(s.value, width, target, here.col);
  return cursor === undefined ? undefined : { ...s, cursor };
}

/** 按显示宽度折行（按字符折，不按词），并算出光标位置。width 至少为 2 */
export function layout(value: string, cursor: number, width: number): Layout {
  width = Math.max(2, width);
  const rows: string[] = [];
  let row = 0;
  let col = 0;
  let current = "";
  let currentWidth = 0;
  let i = 0;
  const place = () => {
    row = rows.length;
    col = currentWidth;
  };
  for (const ch of value) {
    if (i === cursor) place();
    if (ch === "\n") {
      rows.push(current);
      current = "";
      currentWidth = 0;
    } else {
      const w = charWidth(ch);
      if (currentWidth + w > width) {
        rows.push(current);
        current = "";
        currentWidth = 0;
        if (i === cursor) place();
      }
      current += ch;
      currentWidth += w;
    }
    i += ch.length;
  }
  if (cursor >= value.length) place();
  rows.push(current);
  // 光标正好停在满行末尾时放到下一行开头
  if (col >= width) {
    row++;
    col = 0;
    if (row >= rows.length) rows.push("");
  }
  return { rows, row, col };
}
