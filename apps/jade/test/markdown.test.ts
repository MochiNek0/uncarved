import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { expandTabs, markdownStream, renderMarkdown } from "../src/ui/markdown.ts";

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
