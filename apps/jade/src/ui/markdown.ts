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
      return [`  ${line}`];
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
      return m[2] ? [dim(`  ${m[2]}`)] : [];
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
  return out.flatMap((l) => (typeof l === "string" ? [l] : l.render(width)));
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
  if (quote) return dim("│ ") + inline(quote[1]!);
  const item = line.match(/^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/);
  if (item) {
    const box = item[3] ? (item[3][1] === " " ? "☐ " : "☑ ") : "";
    return `${item[1]}${box ? "" : cyan("• ")}${box}${inline(item[4]!)}`;
  }
  const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
  if (ordered) return `${ordered[1]}${cyan(ordered[2]!)} ${inline(ordered[3]!)}`;
  return inline(line);
}

/** 行内格式：`代码`、**粗体**、*斜体*、~~删除线~~、[链接](url)、反斜杠转义。代码里的内容原样显示 */
export function inline(text: string): string {
  return text
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => {
      if (i % 2 === 1) return cyan(part.replace(/^`+ ?|`+$/g, "").replace(/ $/, ""));
      return part
        .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c: string) => `\0${c.charCodeAt(0)}\0`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
          label === url ? underline(url) : `${underline(label)}${dim(` (${url})`)}`,
        )
        .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => underline(url))
        .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/g, (_, a?: string, b?: string) => bold(a ?? b!))
        .replace(/(?<![*\w])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\w])|(?<![_\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![_\w])/g, (_, a?: string, b?: string) => italic(a ?? b!))
        .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, s: string) => strike(s))
        .replace(/\0(\d+)\0/g, (_, c: string) => String.fromCharCode(Number(c)));
    })
    .join("");
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
