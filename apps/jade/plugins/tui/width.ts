// 显示宽度和折行的快路径。string-width / wrap-ansi 对每个非 ASCII 字符都要过 Intl.Segmenter 和 Unicode 属性正则，
// 中文一行要零点几毫秒（ASCII 的上百倍），长对话恢复、缩放、展开详情时会卡。
// 常用字符（ASCII、拉丁补充、标点符号、制表符、CJK、假名、谚文音节、全角）各自成一个字素簇，宽度可以逐个码点查表；
// 只含这些字符和 jade 自己的颜色码时走这里，结果和库逐字节一致（见 test/tui-width.test.ts），其余情况交回给库。

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

/**
 * 不会和前后字符组成一个字素簇、NFC 规范化不改变的码点：组合附加符号、零宽字符、变体选择符、谚文字母、代理项都不在里面。
 * 2329、232A 规范化后会变成 3008、3009，302A–302F、3099–309A 是组合附加符号。导出给测试用
 */
export function standalone(c: number): boolean {
  if (c < 0x7f) return c >= 0x20;
  if (c < 0x2010) return c >= 0xa0 && c <= 0xff && c !== 0xad;
  if (c <= 0x2027) return true;
  if (c >= 0x2030 && c <= 0x205e) return true;
  if (c >= 0x2190 && c <= 0x27bf) return c !== 0x2329 && c !== 0x232a;
  if (c >= 0x2e80 && c <= 0x2fdf) return true;
  if (c >= 0x3000 && c <= 0x30ff) return !(c >= 0x302a && c <= 0x302f) && c !== 0x3099 && c !== 0x309a;
  if (c >= 0x3100 && c <= 0x9fff) return true;
  if (c >= 0xac00 && c <= 0xd7a3) return true;
  return (c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
}

/** standalone 码点的宽度加一（0 表示还没算），按需用 string-width 算出来存着 */
const widths = new Uint8Array(0x10000);
function charWidth(c: number): number {
  let w = widths[c]!;
  if (w === 0) widths[c] = w = stringWidth(String.fromCharCode(c)) + 1;
  return w - 1;
}

/** 颜色码：jade 的样式只用单个参数的 SGR（screen.ts 的 paint） */
const SGR = /\x1b\[(\d{1,2})m/y;

/** 从 i 开始的颜色码，返回它的参数和长度；不是 jade 用的那几种时返回 undefined */
function sgrAt(s: string, i: number): { code: number; length: number } | undefined {
  SGR.lastIndex = i;
  const m = SGR.exec(s);
  if (!m) return undefined;
  const code = Number(m[1]);
  return CLOSE_OF.has(code) || RESETS.has(code) ? { code, length: m[0].length } : undefined;
}

/** 样式码 → 关闭码（wrap-ansi 经 ansi-styles 得到的同一张表） */
const CLOSE_OF = new Map<number, number>([
  [1, 22], [2, 22], [3, 23], [4, 24], [9, 29],
  ...[30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].map((c) => [c, 39] as [number, number]),
]);
const RESETS = new Set([22, 23, 24, 29, 39]);

/** 快路径能处理时的显示宽度（忽略颜色码），否则 undefined */
function fastWidth(s: string): number | undefined {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const m = sgrAt(s, i);
      if (!m) return undefined;
      i += m.length - 1;
      continue;
    }
    if (!standalone(c)) return undefined;
    w += c < 0x7f ? 1 : charWidth(c);
  }
  return w;
}

/** 显示宽度，和 string-width 一致 */
export function visibleWidth(s: string): number {
  return fastWidth(s) ?? stringWidth(s);
}

interface Token {
  value: string;
  width: number;
}

interface Word {
  tokens: Token[];
  value: string;
  width: number;
}

/** 按空格拆成词；颜色码跟着所在的词。有快路径处理不了的字符时返回 undefined */
function words(line: string): Word[] | undefined {
  let word: Word = { tokens: [], value: "", width: 0 };
  const out = [word];
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x20) {
      word = { tokens: [], value: "", width: 0 };
      out.push(word);
      continue;
    }
    let token: Token;
    if (c === 0x1b) {
      const m = sgrAt(line, i);
      if (!m) return undefined;
      token = { value: line.slice(i, i + m.length), width: 0 };
      i += m.length - 1;
    } else {
      if (!standalone(c)) return undefined;
      token = { value: line[i]!, width: c < 0x7f ? 1 : charWidth(c) };
    }
    word.tokens.push(token);
    word.value += token.value;
    word.width += token.width;
  }
  return out;
}

/** wrap-ansi 的 wrapWord：长词逐个字符往下排，返回最后一行的宽度 */
function wrapWord(rows: string[], tokens: Token[], columns: number, rowWidth: number): number {
  let visible = rowWidth;
  tokens.forEach((t, i) => {
    if (t.width > 0 && visible > 0 && visible + t.width > columns) {
      rows.push("");
      visible = 0;
    }
    rows[rows.length - 1] += t.value;
    visible += t.width;
    if (visible === columns && i < tokens.length - 1) {
      rows.push("");
      visible = 0;
    }
  });
  if (!visible && rows.at(-1)!.length > 0 && rows.length > 1) rows[rows.length - 2] += rows.pop()!;
  return fastWidth(rows.at(-1)!)!;
}

interface Style {
  family: string;
  open: number;
  close: number;
}

/** wrap-ansi 对一个样式码的处理：关闭码去掉对应的样式，打开码换掉同类的样式并排到最后 */
function applySgr(code: number, active: Style[], resetsOnly = false) {
  if (code === 39) {
    const i = active.findIndex((s) => s.family === "foreground");
    if (i !== -1) active.splice(i, 1);
    return;
  }
  if (RESETS.has(code)) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.family.startsWith("modifier-") && active[i]!.close === code) active.splice(i, 1);
    return;
  }
  if (resetsOnly) return;
  const close = CLOSE_OF.get(code)!;
  const family = close === 39 ? "foreground" : `modifier-${code}`;
  const i = active.findIndex((s) => s.family === family);
  if (i !== -1) active.splice(i, 1);
  active.push({ family, open: code, close });
}

/** wrap-ansi 的 restoreStylesAcrossRows：每个折行处先关掉还开着的样式，下一行开头再打开 */
function restoreStyles(s: string): string {
  let out = "";
  const active: Style[] = [];
  let copied = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x1b) {
      const m = sgrAt(s, i)!;
      applySgr(m.code, active);
      i += m.length;
      continue;
    }
    if (c !== 0x0a) {
      i++;
      continue;
    }
    out += s.slice(copied, i);
    if (i > copied) out += [...active].reverse().map((st) => `\x1b[${st.close}m`).join("");
    out += "\n";
    copied = ++i;
    if (i < s.length && s[i] !== "\n") {
      const opening = [...active];
      for (let j = i, m = sgrAt(s, j); m; j += m.length, m = sgrAt(s, j)) applySgr(m.code, opening, true);
      out += opening.map((st) => `\x1b[${st.open}m`).join("");
    }
  }
  return out + s.slice(copied);
}

/** wrap-ansi 对一行（不含换行和制表符）的 hard、trim: false 折法；快路径处理不了时返回 undefined */
function fastWrap(line: string, columns: number): string[] | undefined {
  const width = fastWidth(line);
  if (width === undefined) return undefined;
  if (width <= columns) return [line];
  const list = words(line)!;
  const rows = [""];
  let rowLength = 0;
  list.forEach((word, k) => {
    if (k > 0) {
      if (rowLength >= columns) {
        rows.push("");
        rowLength = 0;
      }
      rows[rows.length - 1] += " ";
      rowLength++;
    }
    if (word.width > columns) {
      const remaining = columns - rowLength;
      const thisLine = 1 + Math.floor((word.width - remaining - 1) / columns);
      const nextLine = Math.floor((word.width - 1) / columns);
      if (nextLine < thisLine) {
        rows.push("");
        rowLength = 0;
      }
      rowLength = wrapWord(rows, word.tokens, columns, rowLength);
      return;
    }
    if (rowLength + word.width > columns && rowLength > 0 && word.width > 0) {
      rows.push("");
      rowLength = 0;
    }
    rows[rows.length - 1] += word.value;
    rowLength += word.width;
  });
  return line.includes("\x1b") ? restoreStyles(rows.join("\n")).split("\n") : rows;
}

const WRAP = { hard: true, trim: false } as const;

/**
 * 按原来的行分组折行：每一项是一个原来的行折成的若干行，连起来和 wrapAnsi(text, width, { hard: true, trim: false }).split("\n") 一样。
 * text 里不能有制表符；有 \r 时（wrap-ansi 会把 \r\n 当成一个换行）返回 undefined
 */
export function wrapLines(text: string, width: number): string[][] | undefined {
  if (text.includes("\r")) return undefined;
  return text.split("\n").map((line) => fastWrap(line, width) ?? wrapAnsi(line, width, WRAP).split("\n"));
}

/** 和 wrapAnsi(text, width, { hard: true, trim: false }).split("\n") 一样，常用字符走快路径；text 里不能有制表符 */
export const wrapText = (text: string, width: number): string[] =>
  wrapLines(text, width)?.flat() ?? wrapAnsi(text, width, WRAP).split("\n");
