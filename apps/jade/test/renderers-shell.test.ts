// bash 等工具的显示（plugins/shell/renderers.ts）：从旧 jade 的 test/transcript.test.ts 移植。

import { describe, expect, test } from "bun:test";
import type { ToolRenderer } from "@uncarved/jade-api/services";
import { shellRenderers } from "../plugins/shell/renderers.ts";

// 插件给的是带样式的文字（Text）：只比文字
import { plain } from "../plugins/tui/screen.ts";
const r = (tool: string): ToolRenderer => shellRenderers.find((x) => x.tool === tool)!;

describe("bash", () => {
  test("a short command is the whole summary and has no details", () => {
    expect(r("bash").summary!({ command: "ls" })).toBe("ls");
    expect(r("bash").details!({ command: "ls" })).toBeUndefined();
  });

  test("a multi-line or long command shows its first line, the whole command when expanded", () => {
    const command = "cd src\nbun test";
    expect(r("bash").summary!({ command })).toBe("cd src");
    expect(plain(r("bash").details!({ command })!)).toBe("$ cd src\n  bun test");
    const long = "echo " + "x".repeat(200);
    expect(r("bash").summary!({ command: long })).toBe(`${long.slice(0, 120)}…`);
    expect(plain(r("bash").details!({ command: long })!)).toBe(`$ ${long}`);
  });

  test("the approval preview marks every line of the command", async () => {
    expect(plain((await r("bash").preview!({ command: "a\nb" }))!)).toBe("$ a\n$ b");
    const many = Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n");
    expect(plain((await r("bash").preview!({ command: many }))!)).toContain("… 10 more lines");
  });

  test("no progress renderer: the frontend shows { text } output line by line", () => {
    expect(r("bash").progress).toBeUndefined();
  });

  test("odd input does not throw", () => {
    expect(r("bash").summary!(null)).toBe("");
  });
});

test("bash_output and kill_shell show the shell id", () => {
  expect(r("bash_output").summary!({ id: "bg1" })).toBe("bg1");
  expect(r("kill_shell").summary!({ id: "bg1" })).toBe("bg1");
});
