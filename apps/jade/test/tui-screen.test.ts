import { expect, test } from "bun:test";
import { safeScreen, terminalSafe, type Screen } from "../plugins/tui/screen.ts";

test("terminalSafe keeps colors, newlines and tabs, and drops everything else that drives the terminal", () => {
  expect(terminalSafe("\x1b[31mred\x1b[39m\tok\nnext")).toBe("\x1b[31mred\x1b[39m\tok\nnext");
  // 清屏、移动光标、隐藏光标
  expect(terminalSafe("a\x1b[2J\x1b[H\x1b[10;5Hb\x1b[?25lc")).toBe("abc");
  // OSC：改窗口标题（BEL 结束）、写剪贴板（ST 结束）、没有结束的
  expect(terminalSafe("x\x1b]0;pwned\x07y\x1b]52;c;aGk=\x1b\\z")).toBe("xyz");
  expect(terminalSafe("x\x1b]8;;http://e\x1b[31mlink")).toBe("x\x1b[31mlink");
  // DCS、其他 ESC 序列、单独的 ESC、C0 / C1 控制字符
  expect(terminalSafe("a\x1bPq#0\x1b\\b\x1bcc\x1b")).toBe("abc");
  expect(terminalSafe("a\x07\x08\x00b\x7f\x9bc")).toBe("abc");
  // \r：CRLF 是换行；进度条每行只留最后一段
  expect(terminalSafe("one\r\ntwo")).toBe("one\ntwo");
  expect(terminalSafe(" 10%\r 50%\r100%\r\ndone\r")).toBe("100%\ndone");
});

test("safeScreen filters every piece of text before it reaches the screen", async () => {
  const seen: unknown[] = [];
  const rec = (name: string) => (...args: unknown[]) => void seen.push([name, ...args]);
  const inner = {
    interactive: true,
    log: rec("log"),
    amend: rec("amend"),
    progress: rec("progress"),
    stream: rec("stream"),
    endStream: rec("endStream"),
    busy: rec("busy"),
    status: rec("status"),
    queued: rec("queued"),
    select: async (...a: unknown[]) => (rec("select")(...a), "picked"),
    input: async (...a: unknown[]) => (rec("input")(...a), "typed"),
    draft: { text: () => "draft", insert: rec("insert"), set: rec("set") },
    clear: rec("clear"),
    close: async () => {},
  } as unknown as Screen;
  const s = safeScreen(inner);
  const bad = "a\x1b[2Jb";
  s.log(bad, { id: "1", details: bad });
  s.amend("1", bad, { details: bad });
  s.progress("1", bad);
  s.progress("1", undefined);
  s.stream("text", bad);
  s.status({ plugins: [{ plugin: "p", text: bad }], branch: bad });
  s.queued([bad]);
  expect(await s.select<unknown>(bad, [{ label: bad, value: 1, hint: bad }], { body: bad })).toBe("picked");
  expect(await s.input(bad, { initial: bad })).toBe("typed");
  s.draft!.insert(bad);
  expect(s.draft!.text()).toBe("draft");
  expect(s.interactive).toBe(true);
  expect(JSON.stringify(seen)).not.toContain("\\u001b[2J");
  expect(seen).toContainEqual(["log", "ab", { id: "1", details: "ab" }]);
  expect(seen).toContainEqual(["progress", "1", undefined, undefined]);
  expect(seen).toContainEqual(["status", { plugins: [{ plugin: "p", text: "ab" }], branch: "ab" }]);
  expect(seen).toContainEqual(["select", "ab", [{ label: "ab", value: 1, hint: "ab" }], { body: "ab" }]);
});

test("safeScreen keeps escape sequences that are split across stream chunks, and a lone CR in the input box is a line break", () => {
  const seen: unknown[] = [];
  const rec = (name: string) => (...args: unknown[]) => void seen.push([name, ...args]);
  const inner = { interactive: true, stream: rec("stream"), endStream: rec("endStream"), draft: { text: () => "", insert: rec("insert"), set: rec("set") } } as unknown as Screen;
  const s = safeScreen(inner);
  s.stream("text", "a\x1b[3");
  s.stream("text", "1mred");
  // 拆开的清屏序列也整个去掉，不留下 [2J
  s.stream("text", "b\x1b");
  s.stream("text", "[2Jc");
  // 到结束都没写完的丢掉
  s.stream("text", "d\x1b]0;tit");
  s.endStream();
  s.stream("text", "e");
  expect(seen).toEqual([["stream", "text", "a"], ["stream", "text", "\x1b[31mred"], ["stream", "text", "b"], ["stream", "text", "c"], ["stream", "text", "d"], ["endStream"], ["stream", "text", "e"]]);
  seen.length = 0;
  s.draft!.set("line1\rline2");
  s.draft!.insert("x\r\ny");
  expect(seen).toEqual([["set", "line1\nline2"], ["insert", "x\ny"]]);
});

test("safeScreen puts plain text into the input box: colors are dropped too", () => {
  const seen: unknown[] = [];
  const rec = (name: string) => (...args: unknown[]) => void seen.push([name, ...args]);
  const s = safeScreen({ interactive: true, draft: { text: () => "", insert: rec("insert"), set: rec("set") } } as unknown as Screen);
  s.draft!.set("\x1b[31mfix\x1b[0m it");
  s.draft!.insert("a\x1b[2J\x1b[1mb\x1b[22m");
  expect(seen).toEqual([["set", "fix it"], ["insert", "ab"]]);
});
