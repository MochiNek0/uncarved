import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { expandTabs, markdownStream, renderMarkdown, visibleRow, wrapRows } from "../plugins/tui/markdown.ts";
import { selectedText } from "../plugins/tui/tui.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const md = (text: string, width = 80) => renderMarkdown(text, width).map(strip);

describe("markdown", () => {
  test("draws a table with aligned columns, counting CJK as two columns", () => {
    const out = md("| 名称 | n |\n|---|--:|\n| **a** | 1 |\n| 中文 | 22 |");
    expect(out).toEqual([
      "┌──────┬────┐",
      "│ 名称 │  n │",
      "├──────┼────┤",
      "│ a    │  1 │",
      "│ 中文 │ 22 │",
      "└──────┴────┘",
    ]);
  });

  test("wraps cells to fit a narrow terminal and falls back to key: value when too narrow", () => {
    const text = "| a | b |\n|---|---|\n| short | a much longer cell that has to wrap |";
    for (const row of md(text, 30)) expect(stringWidth(row)).toBeLessThanOrEqual(30);
    expect(md(text, 12)).toContain("a: short");
  });

  test("a line with | is a table only when a delimiter row follows", () => {
    expect(md("a | b\nplain")).toEqual(["a | b", "plain"]);
    expect(md("```\nx | y\n```")).toEqual(["┃ x | y"]);
  });

  test("code blocks have a gutter that continues on wrapped lines; list items wrap with a hanging indent", () => {
    expect(md("```ts\nconst abcdefgh = 1\n```", 12)).toEqual(["┃ ts", "┃ const", "┃ abcdefgh =", "┃  1"]);
    expect(md("- one two three four", 10)).toEqual(["• one two", "  three", "  four"]);
    expect(md("12. one two three", 10)).toEqual(["12. one", "    two", "    three"]);
  });

  test("bold and italic span inline code", () => {
    expect(md("**use `foo()` here** and *a `b` c*")).toEqual(["use foo() here and a b c"]);
    // 代码里的 * 仍然原样显示
    expect(md("`**not bold**`")).toEqual(["**not bold**"]);
  });

  test("tabs expand to tab stops by display width", () => {
    expect(expandTabs("a\tb\n中\tx\n\t\ty")).toBe("a   b\n中  x\n        y");
    expect(md("```\nif x {\n\treturn\n}\n```")).toEqual(["┃ if x {", "┃     return", "┃ }"]);
  });

  test("formats headings, lists, inline code and links but leaves identifiers alone", () => {
    expect(md("## Title\n- item `a*b*c`\n1. see [docs](https://x.dev)\nsnake_case_name **bold**")).toEqual([
      "Title",
      "• item a*b*c",
      "1. see docs (https://x.dev)",
      "snake_case_name bold",
    ]);
  });

  test("holds table rows while streaming and shows them as pending", () => {
    const s = markdownStream();
    expect(s.push("| a | b |")).toEqual([]);
    expect(s.push("|---|---|")).toEqual([]);
    expect(s.push("| 1 | 2 |")).toEqual([]);
    expect(s.pending()).toHaveLength(1);
    const out = s.push("after");
    expect(out).toHaveLength(2);
    expect(strip(out[1] as string)).toBe("after");
    expect(s.pending()).toEqual([]);
  });
});

describe("copying a selection across wrapped rows", () => {
  /** 排好的行（带续行记号）整个选中后复制出来的文字 */
  const copied = (rows: string[]) => selectedText({ anchor: { row: 0, col: 0 }, focus: { row: rows.length - 1, col: 1000 } }, (i) => rows[i]);
  const rendered = (text: string, width: number) => {
    const md = markdownStream();
    return [...text.split("\n").flatMap((l) => md.push(l)), ...md.flush()].flatMap((l) => (typeof l === "string" ? wrapRows(l, width) : l.render(width)));
  };

  test("rows that only exist because a line was too long are joined back; real line breaks stay", () => {
    const text = "npm install --save-dev typescript eslint prettier\nsecond line";
    const rows = wrapRows(text, 20);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.map(visibleRow).join("")).toBe(text.replace("\n", ""));
    expect(copied(rows)).toBe(text);
  });

  test("colour that spans lines does not confuse which rows are continuations", () => {
    const rows = wrapRows("\x1b[2mfirst line that is long enough to wrap\nsecond\x1b[22m", 16);
    expect(copied(rows)).toBe("first line that is long enough to wrap\nsecond");
  });

  test("a long line in a code block comes back as one line, without the gutter", () => {
    const code = "curl -fsSL https://example.com/install.sh | bash -s -- --prefix /usr/local";
    const rows = rendered("```\n" + code + "\necho done\n```", 24);
    expect(rows.length).toBeGreaterThan(4);
    expect(copied(rows)).toBe(`${code}\necho done`);
  });

  test("wrapped list items and paragraphs lose the hanging indent and keep their spaces", () => {
    const item = "- one two three four five six seven eight nine ten";
    expect(copied(rendered(item, 16))).toBe("• one two three four five six seven eight nine ten");
    const para = "中文段落没有空格也会在中间折行，复制出来不应该多出换行或者空格。";
    expect(copied(rendered(para, 12))).toBe(para);
  });

  test("a selection that starts on a continuation row starts a line of its own", () => {
    const rows = rendered("```\naaaa bbbb cccc dddd\n```", 8);
    expect(selectedText({ anchor: { row: 1, col: 0 }, focus: { row: rows.length - 1, col: 1000 } }, (i) => rows[i])).toBe(
      "aaaa bbbb cccc dddd".slice(strip(visibleRow(rows[0]!)).replace("┃ ", "").length).trimStart(),
    );
  });
});
