// 终端里显示模型回复的 Markdown：标题、粗体、斜体、行内代码、链接、列表、引用、分隔线、代码块和表格。
// 回复是流式到达的，按完整的行逐行处理：代码块要记住是否在块里，表格要攒齐所有行才能算列宽，
// 所以做成有状态的 markdownStream。表格和分隔线跟终端宽度有关，交出去的是按宽度现排的函数。

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { bold, cyan, dim, italic, strike, underline } from "./screen.ts";

/** 排好版的一行，或者按显示宽度现排的若干行（表格、分隔线） */
export type MdLine = string | { render(width: number): string[] };

export interface MarkdownStream {
  /** 送进一个完整的行，返回可以显示的行；表格的行先攒着，等表格结束 */
  push(line: string): MdLine[];
  /** 回复结束：交出攒着的内容，恢复初始状态 */
  flush(): MdLine[];
  /** 攒着还没交出的内容，流式输出时先显示在底部 */
  pending(): MdLine[];
}

type Align = "left" | "center" | "right";

const FENCE = /^\s*(`{3,}|~{3,})\s*([^`\s]*)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function markdownStream(): MarkdownStream {
  /** 所在代码块的开头标记（``` 或 ~~~），不在代码块里时为 undefined */
  let fence: string | undefined;
  /** 带 | 的一行：下一行是分隔行时它是表头，否则是普通的一行 */
  let candidate: string | undefined;
  let table: { align: Align[]; rows: string[][] } | undefined;

  const endTable = (): MdLine[] => {
    const out: MdLine[] = [];
    if (table) out.push(tableLine(table.rows, table.align));
    else if (candidate !== undefined) out.push(renderLine(candidate));
    table = undefined;
    candidate = undefined;
    return out;
  };

  function push(line: string): MdLine[] {
    if (fence) {
      const m = line.match(FENCE);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !m[2]) {
        fence = undefined;
        return [];
      }
      // 左边一条竖线和正文分开；长行折行后续行也带竖线
      return [hanging(dim("┃ "), line, dim("┃ "))];
    }
    if (table) {
      if (line.includes("|") && line.trim()) {
        table.rows.push(cells(line));
        return [];
      }
      return [...endTable(), ...push(line)];
    }
    if (candidate !== undefined) {
      if (DELIMITER.test(line) && line.includes("-")) {
        const header = cells(candidate);
        const align = cells(line).map((c): Align => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
        while (align.length < header.length) align.push("left");
        table = { align, rows: [header] };
        candidate = undefined;
        return [];
      }
      return [...endTable(), ...push(line)];
    }
    const m = line.match(FENCE);
    if (m) {
      fence = m[1]!;
      return m[2] ? [dim(`┃ ${m[2]}`)] : [];
    }
    if (splitCells(line).length > 1) {
      candidate = line;
      return [];
    }
    return [renderLine(line)];
  }

  return {
    push,
    flush() {
      const out = endTable();
      fence = undefined;
      return out;
    },
    pending: () => (table ? [tableLine(table.rows, table.align)] : candidate !== undefined ? [renderLine(candidate)] : []),
  };
}

/** 整段 Markdown 排好版（测试和一次性显示用） */
export function renderMarkdown(text: string, width: number): string[] {
  const md = markdownStream();
  const out = [...text.split("\n").flatMap((l) => md.push(l)), ...md.flush()];
  return out.flatMap((l) => (typeof l === "string" ? [l] : l.render(width))).map(visibleRow);
}

// ---------- 自动折行的记号 ----------
//
// 一行太长折成屏幕上的几行时，后面的几行（续行）开头带一个看不见的记号：用鼠标选中复制时，续行接回上一行，
// 而不是变成换行。记号只用几个控制字符（显示之前去掉；外面来的文字里的控制字符早被 safeScreen 去掉了，不会撞上）：
//   \x1f  \x1e × gap  \x1d × indent  \x1c
// gap：折行时上一行行尾去掉了几个空格，接回去时补上；indent：续行开头排版加的几列（列表的缩进、代码块的竖线），接回去时跳过

const SOFT_HEAD = /^\x1f(\x1e*)(\x1d*)\x1c/;

/** 把一行标成续行 */
export const softRow = (row: string, gap = 0, indent = 0): string => `\x1f${"\x1e".repeat(gap)}${"\x1d".repeat(indent)}\x1c${row}`;

/** 去掉记号，得到要显示的那一行 */
export const visibleRow = (row: string): string => (row.charCodeAt(0) === 0x1f ? row.replace(SOFT_HEAD, "") : row);

/** 一行是不是续行，以及接回上一行时要补的空格数、要跳过的列数；text 是去掉记号的那一行 */
export function softInfo(row: string): { text: string; soft: boolean; gap: number; indent: number } {
  const m = row.charCodeAt(0) === 0x1f ? SOFT_HEAD.exec(row) : null;
  if (!m) return { text: row, soft: false, gap: 0, indent: 0 };
  return { text: row.slice(m[0].length), soft: true, gap: m[1]!.length, indent: m[2]!.length };
}

const WRAP = { hard: true, trim: false } as const;

/**
 * 按显示宽度折行，保留颜色；每一项是屏幕上的一行，续行带记号。制表符先换成空格：按 0 列算宽度会对不齐、超宽。
 * 不去掉空格（trim: false），所以续行直接接在上一行后面就是原文
 */
export function wrapRows(text: string, width: number): string[] {
  const expanded = expandTabs(text);
  // 整段一起折：颜色可能跨行，分开折会丢掉后面几行的颜色
  const rows = wrapAnsi(expanded, width, WRAP).split("\n");
  const logical = expanded.split("\n");
  if (rows.length === logical.length) return rows;
  // 每个原来的行占了几行：放得下的占一行，放不下的单独折一次数出来（颜色不占宽度，不影响在哪里折）
  const counts = logical.map((l) => (stringWidth(l) <= width ? 1 : wrapAnsi(l, width, WRAP).split("\n").length));
  if (counts.reduce((a, b) => a + b, 0) !== rows.length) return rows;
  let at = 0;
  for (const n of counts) {
    for (let i = 1; i < n; i++) rows[at + i] = softRow(rows[at + i]!);
    at += n;
  }
  return rows;
}

/** 代码块和表格以外的一行 */
function renderLine(line: string): MdLine {
  if (RULE.test(line)) return { render: (width) => [dim("─".repeat(Math.max(1, Math.min(width, 80))))] };
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/);
  if (heading) {
    const text = inline(heading[2]!);
    return heading[1]!.length === 1 ? bold(underline(text)) : bold(text);
  }
  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) return hanging(dim("│ "), inline(quote[1]!), dim("│ "));
  const item = line.match(/^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/);
  // 列表项折行时续行和正文对齐
  if (item) {
    const box = item[3] ? (item[3][1] === " " ? "☐ " : "☑ ") : "";
    return hanging(`${item[1]}${box ? "" : cyan("• ")}${box}`, inline(item[4]!));
  }
  const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
  if (ordered) return hanging(`${ordered[1]}${cyan(ordered[2]!)} `, inline(ordered[3]!));
  return inline(line);
}

/**
 * 行内格式：`代码`、**粗体**、*斜体*、~~删除线~~、[链接](url)、反斜杠转义。代码里的内容原样显示。
 * 行内代码先换成占位符，粗体、斜体处理完再换回来，"**用 `foo()` 实现**" 这样跨过代码的粗体才认得出
 */
export function inline(text: string): string {
  const codes: string[] = [];
  return text
    .replace(/`+[^`]*?`+/g, (code) => `\x01${codes.push(cyan(code.replace(/^`+ ?|`+$/g, "").replace(/ $/, ""))) - 1}\x01`)
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c: string) => `\0${c.charCodeAt(0)}\0`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
      label === url ? underline(url) : `${underline(label)}${dim(` (${url})`)}`,
    )
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => underline(url))
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, (_, a?: string, b?: string) => bold(a ?? b!))
    .replace(/(?<![*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])|(?<![_\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![_\w])/g, (_, a?: string, b?: string) => italic(a ?? b!))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, s: string) => strike(s))
    .replace(/\0(\d+)\0/g, (_, c: string) => String.fromCharCode(Number(c)))
    .replace(/\x01(\d+)\x01/g, (_, i: string) => codes[Number(i)]!);
}

/** 制表符换成空格，按 stop 列一个制表位对齐（按显示宽度算，忽略颜色）。终端按 8 列显示 tab，按 0 列算宽度会对不齐、超宽 */
export function expandTabs(text: string, stop = 4): string {
  if (!text.includes("\t")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\t")) return line;
      let out = "";
      let col = 0;
      const parts = line.split("\t");
      parts.forEach((p, i) => {
        out += p;
        col += stringWidth(p);
        if (i < parts.length - 1) {
          const n = stop - (col % stop);
          out += " ".repeat(n);
          col += n;
        }
      });
      return out;
    })
    .join("\n");
}

/** 折行时续行缩进到 head 之后（列表项的正文、代码块的竖线）；rest 是续行开头显示的内容，宽度和 head 相同 */
function hanging(head: string, body: string, rest = " ".repeat(stringWidth(head))): MdLine {
  return {
    render: (width) => {
      const indent = stringWidth(head);
      const room = Math.max(1, width - indent);
      const rows = wrapAnsi(expandTabs(body), room, WRAP).split("\n");
      // 折行处留下的行尾空格看不见，去掉免得多占一列；去掉了几个记在续行的记号里，复制时补回去
      return rows.map((r, i) => (i === 0 ? head + r.trimEnd() : softRow(rest + r.trimEnd(), rows[i - 1]!.length - rows[i - 1]!.trimEnd().length, indent)));
    },
  };
}

/** 按没转义、不在行内代码里的 | 拆开一行 */
function splitCells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      cell += c;
    } else if (c === "|" && !code) {
      out.push(cell);
      cell = "";
    } else cell += c;
  }
  out.push(cell);
  return out;
}

/** 表格一行的各个单元格，去掉两端的 | */
function cells(line: string): string[] {
  const parts = splitCells(line.trim());
  if (parts.length > 1 && parts[0]!.trim() === "") parts.shift();
  if (parts.length > 1 && parts.at(-1)!.trim() === "") parts.pop();
  return parts.map((c) => c.trim());
}

function tableLine(rows: string[][], align: Align[]): MdLine {
  const shown = rows.map((r, i) => r.map((c) => (i === 0 ? bold(inline(c)) : inline(c))));
  return { render: (width) => renderTable(shown, align, width) };
}

/**
 * 画带边框的表格。放不下时按比例收窄较宽的列、单元格内折行；
 * 窄到每列连 3 列都分不到时，改成每行一段「表头: 值」
 */
function renderTable(rows: string[][], align: Align[], width: number): string[] {
  const n = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: n }, (_, i) => r[i] ?? ""));
  const natural = Array.from({ length: n }, (_, i) => Math.max(1, ...grid.map((r) => stringWidth(r[i]!))));
  const room = width - (3 * n + 1);
  if (room < 3 * n) {
    const [head, ...body] = grid;
    return body.flatMap((r, k) => [
      ...(k ? [""] : []),
      ...r.flatMap((c, i) => wrapAnsi(`${head![i]}${dim(":")} ${c}`, Math.max(1, width), { hard: true }).split("\n")),
    ]);
  }
  // 从最窄的列开始，能放下的列按原宽，放不下的平分剩下的宽度
  const widths = [...natural];
  if (natural.reduce((a, b) => a + b, 0) > room) {
    let left = room;
    let open = n;
    for (const i of [...natural.keys()].sort((a, b) => natural[a]! - natural[b]!)) {
      const share = Math.floor(left / open);
      widths[i] = Math.min(natural[i]!, share);
      left -= widths[i]!;
      open--;
    }
  }
  const pad = (s: string, w: number, a: Align) => {
    const gap = w - stringWidth(s);
    if (a === "right") return " ".repeat(gap) + s;
    if (a === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
    return s + " ".repeat(gap);
  };
  const border = (l: string, m: string, r: string) => dim(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const row = (r: string[]) => {
    const parts = r.map((c, i) => wrapAnsi(c, widths[i]!, { hard: true, trim: true }).split("\n"));
    const height = Math.max(...parts.map((p) => p.length));
    return Array.from({ length: height }, (_, k) =>
      dim("│ ") + parts.map((p, i) => pad(p[k] ?? "", widths[i]!, align[i] ?? "left")).join(dim(" │ ")) + dim(" │"),
    );
  };
  const [head, ...body] = grid;
  return [border("┌", "┬", "┐"), ...row(head!), border("├", "┼", "┤"), ...body.flatMap(row), border("└", "┴", "┘")];
}
