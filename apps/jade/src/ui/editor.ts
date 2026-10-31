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
function charWidth(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x20 && c < 0x7f) return 1;
  let w = widths.get(ch);
  if (w === undefined) widths.set(ch, (w = stringWidth(ch)));
  return w;
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
