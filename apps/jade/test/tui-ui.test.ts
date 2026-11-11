import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { InputHistory } from "../plugins/tui/history.ts";
import { edit, layout, moveRow, offsetAt } from "../plugins/tui/editor.ts";
import type { Screen } from "../plugins/tui/screen.ts";
import { fitSegments, tail, tuiScreen, type TuiHandlers } from "../plugins/tui/tui.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 等到输出里出现 text（或匹配正则），最多 ms 毫秒：界面按定时器刷新，机器忙时固定等一小段时间不一定够 */
async function until(output: () => string, text: string | RegExp, ms = 2000) {
  const found = () => (typeof text === "string" ? output().includes(text) : text.test(output()));
  for (const end = Date.now() + ms; !found() && Date.now() < end; ) await sleep(10);
  if (typeof text === "string") expect(output()).toContain(text);
  else expect(output()).toMatch(text);
}
const strip = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[78]/g, "");

describe("editor", () => {
  test("edits by code point and keeps surrogate pairs intact", () => {
    let s = edit.insert({ value: "", cursor: 0 }, "a😀中");
    expect(s).toEqual({ value: "a😀中", cursor: 4 });
    s = edit.left(s);
    expect(s.cursor).toBe(3);
    s = edit.backspace(s);
    expect(s).toEqual({ value: "a中", cursor: 1 });
    expect(
      edit.deleteWord({ value: "git status --short", cursor: 18 }),
    ).toEqual({ value: "git status ", cursor: 11 });
    expect(edit.deleteWord({ value: "git status  ", cursor: 12 })).toEqual({
      value: "git ",
      cursor: 4,
    });
  });

  test("alt+f / alt+b move by words", () => {
    const value = "git  status --short";
    expect(edit.wordRight({ value, cursor: 0 }).cursor).toBe(3);
    expect(edit.wordRight({ value, cursor: 3 }).cursor).toBe(11);
    expect(edit.wordRight({ value, cursor: 19 }).cursor).toBe(19);
    expect(edit.wordLeft({ value, cursor: 19 }).cursor).toBe(12);
    expect(edit.wordLeft({ value, cursor: 12 }).cursor).toBe(5);
    expect(edit.wordLeft({ value, cursor: 0 }).cursor).toBe(0);
  });

  test("moves between lines and to line ends", () => {
    const s = { value: "first\nsecond line", cursor: 9 };
    expect(edit.home(s).cursor).toBe(6);
    expect(edit.end(s).cursor).toBe(17);
    expect(edit.up(s).cursor).toBe(3);
    expect(edit.down({ value: "first\nsecond line", cursor: 2 }).cursor).toBe(
      8,
    );
    expect(edit.onFirstLine(s)).toBe(false);
    expect(edit.onLastLine(s)).toBe(true);
    expect(edit.killBefore(s)).toEqual({ value: "first\nond line", cursor: 6 });
  });

  test("wraps by display width and locates the cursor", () => {
    // 中文占两列
    expect(layout("中文abc", 2, 4)).toEqual({
      rows: ["中文", "abc"],
      starts: [0, 2],
      row: 1,
      col: 0,
    });
    expect(layout("ab\ncd", 5, 10)).toEqual({
      rows: ["ab", "cd"],
      starts: [0, 3],
      row: 1,
      col: 2,
    });
    expect(layout("abcd", 4, 4)).toEqual({
      rows: ["abcd", ""],
      starts: [0, 4],
      row: 1,
      col: 0,
    });
    expect(layout("", 0, 4)).toEqual({ rows: [""], starts: [0], row: 0, col: 0 });
  });

  test("up and down move by wrapped screen rows and keep the display column", () => {
    // 中文占两列：从 abcd 末尾（第 4 列）往上是第二个字之后，不是第四个字之后
    expect(moveRow({ value: "中文中文\nabcd", cursor: 9 }, 20, -1)).toEqual({ value: "中文中文\nabcd", cursor: 2 });
    expect(moveRow({ value: "中文中文\nabcd", cursor: 2 }, 20, 1)?.cursor).toBe(9);
    // 没有换行的长文字折成几行，也能上下移动；到第一行、最后一行时交给调用方翻历史
    const long = { value: "abcdefghij", cursor: 7 };
    expect(moveRow(long, 4, -1)?.cursor).toBe(3);
    expect(moveRow({ ...long, cursor: 3 }, 4, -1)).toBeUndefined();
    expect(moveRow(long, 4, 1)?.cursor).toBe(10);
    expect(moveRow({ ...long, cursor: 10 }, 4, 1)).toBeUndefined();
    expect(offsetAt("ab\ncd", 10, 1, 1)).toBe(4);
    expect(offsetAt("ab\ncd", 10, 1, 9)).toBe(5);
    expect(offsetAt("ab\ncd", 10, 2, 0)).toBeUndefined();
  });
});

describe("input history", () => {
  test("keeps each directory's own inputs across sessions, latest copy of repeats", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jade-history-"));
    const file = path.join(dir, "history.jsonl");
    const a = new InputHistory(file, path.join(dir, "a"));
    const b = new InputHistory(file, path.join(dir, "b"));
    expect(await a.load()).toEqual([]);
    await a.add("one");
    await b.add("elsewhere");
    await a.add("two\nlines");
    await a.add("one");
    expect(await new InputHistory(file, path.join(dir, "a")).load()).toEqual([
      "two\nlines",
      "one",
    ]);
    expect(await b.load()).toEqual(["elsewhere"]);
  });
});

describe("terminal UI", () => {
  let screen: Screen | undefined;
  afterEach(async () => {
    await screen?.close();
    screen = undefined;
  });

  function setup(history?: string[], commands?: () => { name: string; args?: string; about: string }[]) {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => {},
      ref: () => {},
      unref: () => {},
    });
    let out = "";
    const stdout = Object.assign(
      new Writable({
        write(chunk, _enc, done) {
          out += chunk.toString();
          done();
        },
      }),
      { isTTY: true, columns: 100, rows: 40 },
    );
    const calls = { submit: [] as string[], interrupt: 0, exit: 0, cycle: 0, keys: [] as string[] };
    const handlers: TuiHandlers = {
      submit: (t) => void calls.submit.push(t),
      interrupt: () => void calls.interrupt++,
      exit: () => void calls.exit++,
      cycleMode: () => void calls.cycle++,
      // 只有 ctrl+t、alt+v 有插件处理
      key: (spec) => (spec === "ctrl+t" || spec === "alt+v") && calls.keys.push(spec) > 0,
      files: async () => [
        "src/",
        "src/main.ts",
        "src/ui/",
        "src/ui/tui.tsx",
        "docs/my notes.md",
      ],
    };
    screen = tuiScreen({
      status: {
        cwd: "~/proj",
        branch: "main",
        model: "test-model",
        mode: "ask",
        session: "s-123",
      },
      version: "9.9.9",
      commands: commands ?? [
        { name: "help", about: "list the commands" },
        { name: "mode", args: "[ask|yolo]", about: "change the mode" },
        { name: "model", about: "configure the model" },
      ],
      handlers,
      history,
      io: {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    });
    const type = async (s: string) => {
      stdin.write(s);
      await sleep(80);
    };
    return {
      screen,
      calls,
      type,
      output: () => strip(out),
      raw: () => out,
      clear: () => void (out = ""),
      resize: (columns: number, rows: number) => {
        Object.assign(stdout, { columns, rows });
        stdout.emit("resize");
      },
    };
  }

  test("shows the status bar and submits typed messages", async () => {
    const { calls, type, output } = setup();
    await sleep(80);
    expect(output()).toContain("~/proj");
    expect(output()).toContain("(main)");
    expect(output()).toContain("test-model");
    await type("你好 jade");
    await type("\r");
    expect(calls.submit).toEqual(["你好 jade"]);
  });

  test("plugin keys reach the handler, and plugins can read and change the input", async () => {
    const { screen, calls, type } = setup();
    await type("ab");
    await type("\x14"); // ctrl+t
    await type("\x1bv"); // alt+v
    await type("\x01"); // ctrl+a：jade 自己的键，不交给插件
    expect(calls.keys).toEqual(["ctrl+t", "alt+v"]);
    // 插件的键没有插入文字；ctrl+a 把光标移到了开头
    expect(screen.draft!.text()).toBe("ab");
    screen.draft!.insert("说 ");
    await sleep(80);
    expect(screen.draft!.text()).toBe("说 ab");
    screen.draft!.set("hello\r\nworld");
    await type("\r");
    expect(calls.submit).toEqual(["hello\nworld"]);
    expect(screen.draft!.text()).toBe("");
  });

  test("a plugin's hint shows in the empty input; tab or → takes it, typing hides it until the input is empty again, taking, sending or a new session drops it", async () => {
    const { screen, calls, type, output, clear } = setup();
    screen.draft!.hint("run the tests\nand fix what fails");
    await sleep(80);
    // 只显示第一行
    expect(output()).toContain("run the tests …");
    await type("\t");
    expect(screen.draft!.text()).toBe("run the tests\nand fix what fails");
    await type("\r");
    expect(calls.submit).toEqual(["run the tests\nand fix what fails"]);

    // 发出去之后提示没了，再按 Tab 什么也不做
    await type("\t");
    expect(screen.draft!.text()).toBe("");

    // → 也能接受；接受之后提示没了，再按 Tab 什么也不做
    screen.draft!.hint("next");
    await sleep(80);
    await type("\x1b[C");
    expect(screen.draft!.text()).toBe("next");
    screen.draft!.set("");
    await sleep(80);
    await type("\t");
    expect(screen.draft!.text()).toBe("");

    // 打字时不显示，删回空的又出现，还能接受
    screen.draft!.hint("later");
    await sleep(80);
    await type("x");
    clear();
    await sleep(80);
    expect(output()).not.toContain("later");
    await type("\x7f");
    await sleep(80);
    expect(output()).toContain("later");
    await type("\t");
    expect(screen.draft!.text()).toBe("later");
    screen.draft!.set("");
    await sleep(80);

    // Shift+Tab 仍然切换模式，不接受提示
    screen.draft!.hint("again");
    await sleep(80);
    await type("\x1b[Z");
    expect(calls.cycle).toBe(1);
    expect(screen.draft!.text()).toBe("");

    // 换会话时去掉
    screen.clear();
    await sleep(80);
    await type("\t");
    expect(screen.draft!.text()).toBe("");
  });

  test("applies every key that arrives in the same chunk", async () => {
    const { calls, type } = setup();
    await type("abcdef");
    // 按住退格、界面忙时终端会把多个按键合成一块送来，每个都要生效
    await type("\x7f\x7f\x7f");
    await type("\x1b[D\x1b[Dz");
    await type("\r");
    expect(calls.submit).toEqual(["azbc"]);
  });

  test("moves the terminal cursor in the same frame as the arrow key", async () => {
    const { type, raw } = setup();
    // Ink 用 ESC[nG 把光标放到第 n 列
    const column = () => Number([...raw().matchAll(/\x1b\[(\d+)G/g)].at(-1)?.[1]);
    await type("abc");
    const end = column();
    await type("\x1b[D");
    expect(column()).toBe(end - 1);
    await type("\x1b[D");
    expect(column()).toBe(end - 2);
    await type("\x1b[C");
    expect(column()).toBe(end - 1);
  });

  test("typing / lists matching commands; arrows select and enter runs the selection", async () => {
    const { calls, type, output } = setup();
    await type("/mo");
    expect(output()).toContain("/mode [ask|yolo]");
    expect(output()).toContain("/model");
    await type("\x1b[B");
    await type("\r");
    expect(calls.submit).toEqual(["/model"]);
    // Tab 补全，带参数的命令补上空格
    await type("/m");
    await type("\t");
    await type("yolo");
    await type("\r");
    expect(calls.submit).toEqual(["/model", "/mode yolo"]);
    // 文字和回车合在一块到达
    await type("fast typing\r");
    expect(calls.submit).toEqual(["/model", "/mode yolo", "fast typing"]);
  });

  test("commands given as a function are read again each time the menu is shown", async () => {
    let list = [{ name: "help", about: "list the commands" }];
    const { calls, type, output, clear } = setup(undefined, () => list);
    await type("/de");
    expect(output()).not.toContain("/deploy");
    // 插件在会话中途登记了命令
    list = [...list, { name: "deploy", about: "ship it" }];
    await type("\x7f\x7f\x7f");
    clear();
    await type("/de");
    expect(output()).toContain("/deploy");
    await type("\r");
    expect(calls.submit).toEqual(["/deploy"]);
  });

  test("typing @ lists matching paths; enter or tab inserts the selection", async () => {
    const { calls, type, output } = setup();
    await type("fix @tu");
    expect(output()).toContain("src/ui/tui.tsx");
    await type("\r");
    await type("now\r");
    expect(calls.submit).toEqual(["fix @src/ui/tui.tsx now"]);
    // 目录补全后接着补里面的文件；含空格的路径加引号
    await type("@src/u");
    await type("\t");
    await type("\x1b[B");
    await type("\t");
    await type("and @notes");
    await type("\t");
    await type("\r");
    expect(calls.submit.at(-1)).toBe('@src/ui/tui.tsx and @"docs/my notes.md"');
  });

  test("up recalls earlier input, including history from previous sessions", async () => {
    const { calls, type } = setup(["old one", "old two"]);
    await type("new");
    await type("\r");
    await type("\x1b[A");
    await type("\x1b[A");
    await type("\r");
    expect(calls.submit).toEqual(["new", "old two"]);
  });

  test("up and down move past /commands and @ mentions in the history instead of their menus", async () => {
    const { calls, type } = setup(["oldest", "/mo", "fix @src/u", "newest"]);
    for (let i = 0; i < 4; i++) await type("\x1b[A");
    await type("\r");
    expect(calls.submit).toEqual(["oldest"]);
    for (let i = 0; i < 4; i++) await type("\x1b[A");
    await type("\x1b[B");
    await type("\r");
    expect(calls.submit).toEqual(["oldest", "fix @src/u"]);
    // 改动翻出来的命令后，菜单照常出现
    for (let i = 0; i < 4; i++) await type("\x1b[A");
    await type("d");
    await type("\r");
    expect(calls.submit.at(-1)).toBe("/mode");
  });

  test("ctrl+r searches the history and puts the pick in the input to edit", async () => {
    const { calls, type, output } = setup([
      "fix the login bug",
      "run the tests",
      "fix the build",
    ]);
    await type("\x12");
    await type("fix");
    expect(output()).toContain("fix the build");
    expect(output()).toContain("fix the login bug");
    // 再按 Ctrl+R 换到更早的一条，回车放进输入框，接着改再发送
    await type("\x12");
    await type("\r");
    expect(calls.submit).toEqual([]);
    await type(" again\r");
    expect(calls.submit).toEqual(["fix the login bug again"]);
    // Esc 退出搜索，输入框里原来的内容不变
    await type("draft");
    await type("\x12");
    await type("zzz");
    expect(output()).toContain("no match");
    await type("\x1b");
    await sleep(50);
    await type("\r");
    expect(calls.submit.at(-1)).toBe("draft");
  });

  test("select and input dialogs take the keyboard and return the answer", async () => {
    const { screen, type, output } = setup();
    const picked = screen.select("Allow bash(ls)?", [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ]);
    await sleep(80);
    expect(output()).toContain("Allow bash(ls)?");
    await type("\x1b[B");
    await type("\r");
    expect(await picked).toBe("no");

    const key = screen.input("API key", { mask: true });
    await sleep(80);
    await type("sk-secret");
    await type("\r");
    expect(await key).toBe("sk-secret");
    expect(output()).not.toContain("sk-secret");
    expect(output()).toContain("•••••••••");
  });

  test("ctrl+j starts a new line; enter sends", async () => {
    const { calls, type } = setup();
    await type("one");
    await type("\n"); // ctrl+j（Windows Terminal 里 ctrl+enter 发的也是它）
    await type("two");
    expect(calls.submit).toEqual([]);
    // 终端单独报上来的 Shift+Enter（kitty 键盘协议的写法）
    await type("\x1b[13;2u");
    await type("three");
    await type("\r");
    expect(calls.submit).toEqual(["one\ntwo\nthree"]);
  });

  test("a dialog that pops up while the user is typing ignores the keys typed through it", async () => {
    const { screen, type, output } = setup();
    await type("fix 2 thin");
    let answer: string | undefined = "pending";
    void screen.select("Allow bash(rm x)?", [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ]).then((v) => (answer = v));
    await sleep(80);
    expect(output()).toContain("Allow bash(rm x)?");
    // 接着打出来的数字和回车不算回答
    await type("2");
    await type("\r");
    expect(answer).toBe("pending");
    // 停一下之后才算
    await sleep(700);
    await type("\r");
    expect(answer).toBe("yes");
  });

  test("aborting a dialog's signal closes it and returns undefined", async () => {
    const { screen, type, output } = setup();
    const ac = new AbortController();
    const picked = screen.select("Allow bash(rm x)?", [{ label: "Yes", value: "yes" }], { signal: ac.signal });
    await sleep(80);
    expect(output()).toContain("Allow bash(rm x)?");
    ac.abort();
    expect(await picked).toBeUndefined();
    // 对话框关掉之后键盘回到输入框
    const key = screen.input("Name", { signal: AbortSignal.abort() });
    expect(await key).toBeUndefined();
    await type("hi");
    await sleep(50);
    expect(output()).toContain("hi");
  });

  test("plugins' status bar segments are shown", async () => {
    const { screen, output } = setup();
    screen.status({ plugins: [{ plugin: "ci", text: "CI passing" }] });
    await until(output, "CI passing");
  });

  test("long choice lists scroll with the selection", async () => {
    const { screen, type, output, clear } = setup();
    const picked = screen.select(
      "Choose a model",
      Array.from({ length: 30 }, (_, i) => ({ label: `model-${i}`, value: i })),
    );
    await sleep(80);
    expect(output()).toContain("model-9");
    expect(output()).not.toContain("model-10");
    expect(output()).toContain("↓ 20 more");
    clear();
    await type("\x1b[6~");
    expect(output()).toContain("model-10");
    expect(output()).toContain("↑");
    await type("\r");
    expect(await picked).toBe(10);
  });

  test("esc interrupts while busy; ctrl+c twice exits while idle", async () => {
    const { screen, calls, type } = setup();
    screen.busy("Thinking");
    await sleep(50);
    await type("\x1b");
    await sleep(100);
    expect(calls.interrupt).toBe(1);
    screen.busy(undefined);
    await sleep(50);
    await type("\x03");
    expect(calls.exit).toBe(0);
    await type("\x03");
    expect(calls.exit).toBe(1);
  });

  test("shift+tab cycles the mode; the status bar shows context, compaction and session usage", async () => {
    const { screen, calls, type, output } = setup();
    await type("ab");
    await type("\x1b[Z");
    expect(calls.cycle).toBe(1);
    screen.status({
      mode: "plan",
      context: { used: 50_000, limit: 200_000, compactAt: 136_000 },
      spent: { input: 1_250_000, output: 40_000 },
    });
    await sleep(80);
    expect(output()).toContain("plan (shift+tab)");
    expect(output()).toContain("ctx 50k/200k (25%), compacts at 136k");
    expect(output()).toContain("session 1.3M in / 40k out");
    // shift+tab 不改输入框
    await type("\r");
    expect(calls.submit).toEqual(["ab"]);
  });

  test("streamed output and logs are printed above the input", async () => {
    const { screen, output } = setup();
    screen.stream("thinking", "pondering\n");
    screen.stream("text", "\n\nfirst line\nsecond");
    screen.endStream();
    screen.log("done");
    await sleep(80);
    const out = output();
    expect(out).toContain("✻ Thought for 0s ▸");
    expect(out.indexOf("first line")).toBeLessThan(out.indexOf("second"));
    expect(out).toContain("done");
  });

  test("thinking shows where the model is in one row and can be expanded while it is still thinking", async () => {
    const { screen, type, output, clear } = setup();
    screen.stream("thinking", "step one\nstep two\nstep th");
    await until(output, /✻ Thinking \ds · step th ▸/);
    expect(output()).not.toContain("step one");
    // 很长的一行只显示末尾，跟着模型往前走
    screen.stream("thinking", `ree ${"x".repeat(200)} latest words`);
    await until(output, "latest words ▸");
    // 思考中就能点开：对话区第 1 行在屏幕第 6 行
    clear();
    await type("\x1b[<0;5;6M");
    await type("\x1b[<0;5;6m");
    await until(output, /✻ Thinking \ds ▾/);
    expect(output()).toContain("step one");
    // 展开着的时候新内容接着出现
    clear();
    screen.stream("thinking", "\nstep four");
    await until(output, "step four");
    screen.endStream();
    await until(output, /✻ Thought for \ds ▾/);
    clear();
    await type("\x1b[<0;5;6M");
    await type("\x1b[<0;5;6m");
    await until(output, /✻ Thought for \ds ▸/);
    expect(output()).not.toContain("step one");
  });

  test("the status bar shows the output speed and drops the least useful parts in a narrow window", () => {
    const all = [
      { text: "ask (shift+tab)", short: "ask", shortAt: 6 },
      { text: "ctx 50k/200k (25%)", short: "ctx 25%", shortAt: 4 },
      { text: "42 tok/s", dropAt: 3 },
      { text: "PgUp/PgDn scroll", dropAt: 9 },
    ];
    expect(fitSegments(all, 200).map((s) => s.text)).toEqual(["ask (shift+tab)", "ctx 50k/200k (25%)", "42 tok/s", "PgUp/PgDn scroll"]);
    expect(fitSegments(all, 45).map((s) => s.text)).toEqual(["ask", "ctx 50k/200k (25%)", "42 tok/s"]);
    expect(fitSegments(all, 20).map((s) => s.text)).toEqual(["ask", "ctx 25%"]);
    expect(tail("abcdefghij", 5)).toBe("…ghij");
    expect(tail("中文中文", 5)).toBe("…中文");
  });

  test("a short terminal keeps the input box and status bar on screen while the command menu is open", async () => {
    const { type, output, resize } = setup();
    resize(60, 16);
    await sleep(250);
    await type("/");
    const out = output();
    const lastFrame = out.slice(out.lastIndexOf("jade ·"));
    expect(lastFrame).toContain("╰");
    expect(lastFrame).toContain("ask");
  });

  test("a tool call and its result share one row; progress shows only the latest line", async () => {
    const { screen, type, output, clear } = setup();
    screen.log("● bash(npm test)", { id: "t1" });
    screen.progress("t1", "  │ running 1");
    screen.progress("t1", "  │ running 2");
    await sleep(80);
    expect(output()).toContain("running 2");
    expect(output()).not.toContain("running 1");
    clear();
    screen.progress("t1", undefined);
    screen.amend("t1", "⎿ ok (+2 lines)", { details: "    out-1\n    out-2" });
    await sleep(80);
    expect(output()).toContain("● bash(npm test) ⎿ ok (+2 lines) ▸");
    expect(output()).not.toContain("running 2");
    expect(output()).not.toContain("out-1");
    clear();
    await type("\x1b[<0;5;6M");
    await type("\x1b[<0;5;6m");
    expect(output()).toContain("out-1");
    // 找不到那一项时另起一行
    screen.amend("missing", "⎿ orphan");
    await sleep(80);
    expect(output()).toContain("  ⎿ orphan");
  });

  test("runs fullscreen with a header showing the version, model and directory", async () => {
    const { output, raw } = setup();
    await sleep(80);
    // 第一帧之前先清屏并把光标移到左上角，否则从原来的光标位置画起，整个界面错位
    expect(raw().startsWith("\x1b[?1049h\x1b[2J\x1b[H")).toBe(true);
    const out = output();
    expect(out).toContain("jade v9.9.9");
    expect(out).toContain("session s-123");
    expect(out).toContain("test-model · ~/proj (main)");
  });

  test("the conversation scrolls by itself with PgUp/PgDn and the mouse wheel; typing is unaffected", async () => {
    const { screen, calls, type, output, clear } = setup();
    screen.log(Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n"));
    await sleep(80);
    expect(output()).toContain("line-99");
    expect(output()).not.toContain("line-50");
    clear();
    await type("\x1b[5~");
    await type("\x1b[5~");
    expect(output()).toContain("line-50");
    expect(output()).toContain("more lines");
    // 往上翻看时来了新输出，看的地方不动
    clear();
    screen.log("newest");
    await sleep(80);
    expect(output()).not.toContain("newest");
    // 滚轮向下，Ctrl+End 回到底部
    clear();
    await type("\x1b[<65;10;10M");
    expect(output()).not.toContain("<65");
    await type("\x1b[1;5F");
    expect(output()).toContain("newest");
    // 鼠标事件不会进输入框
    await type("\x1b[<64;10;10M");
    await type("hi\r");
    expect(calls.submit).toEqual(["hi"]);
  });

  test("clicking a folded line expands and collapses its details", async () => {
    const { screen, type, output, clear } = setup();
    screen.log("first");
    screen.log("  ⎿ summary (+2 lines)", {
      details: "    hidden-1\n    hidden-2",
    });
    screen.log("after");
    await sleep(80);
    expect(output()).toContain("summary (+2 lines) ▸");
    expect(output()).not.toContain("hidden-1");
    // 标题占 5 行（边框和三行：机器人与文字并排），对话区第 2 行在屏幕第 7 行
    clear();
    await type("\x1b[<0;5;7M");
    await type("\x1b[<0;5;7m");
    expect(output()).toContain("hidden-1");
    expect(output()).toContain("▾");
    // 点击展开的内容也能收起；点普通的行没有反应
    clear();
    await type("\x1b[<0;5;8M");
    await type("\x1b[<0;5;8m");
    expect(output()).not.toContain("hidden-1");
    expect(output()).toContain("▸");
    clear();
    await type("\x1b[<0;5;6M");
    await type("\x1b[<0;5;6m");
    expect(output()).not.toContain("hidden-1");
  });

  test("dragging selects text without shift and copies it; a click or ctrl+c clears it without side effects", async () => {
    const { screen, type, raw, calls, clear } = setup();
    screen.log("hello world");
    screen.log("second line", { details: "    hidden-1" });
    await sleep(80);
    const copied = () => [...raw().matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
    // 对话区第 1 行在屏幕第 6 行，左边空一列：从 "world" 拖到下一行的 "second" 末尾
    await type("\x1b[<0;8;6M");
    await type("\x1b[<32;10;7M");
    await type("\x1b[<32;7;7M");
    expect(raw()).toContain("\x1b[7m");
    await type("\x1b[<0;7;7m");
    expect(copied()).toEqual(["world\nsecond"]);
    expect(raw()).toContain("Copied 12 characters to the clipboard");
    // 拖动结束时不展开那一项
    expect(raw()).not.toContain("hidden-1");
    // 有选中的文字时 Ctrl+C 只取消选中：不中断、不提示退出
    await type("\x03");
    await type("\x03");
    expect(calls.interrupt).toBe(0);
    expect(calls.exit).toBe(0);
    // 再点一下（没有拖动）照常展开
    clear();
    await type("\x1b[<0;5;7M");
    await type("\x1b[<0;5;7m");
    expect(raw()).toContain("hidden-1");
    expect(copied()).toEqual([]);
  });

  test("clicks still land on the right line during the full repaint after startup", async () => {
    const { screen, type, output } = setup();
    screen.log("head", { details: "    hidden-1" });
    // 启动后 100ms 起有一帧整帧重画（上下各垫一行），这时候点击换算的行号曾经差一行
    await sleep(120);
    await type("\x1b[<0;5;6M");
    await type("\x1b[<0;5;6m");
    await sleep(100);
    expect(output()).toContain("hidden-1");
  });

  test("clear empties the conversation", async () => {
    const { screen, output, clear } = setup();
    screen.log("old stuff");
    await sleep(80);
    expect(output()).toContain("old stuff");
    clear();
    screen.clear();
    screen.log("fresh");
    await sleep(80);
    expect(output()).toContain("fresh");
    expect(output()).not.toContain("old stuff");
  });

  test("a long preview in an approval dialog is cut by screen rows, so the choices and key hints stay visible", async () => {
    const { screen, type, output, resize, clear } = setup();
    resize(80, 30);
    await sleep(250);
    clear();
    // 每行折成两行屏幕行：按逻辑行截断时底部的选项和提示被裁掉了
    const body = Array.from({ length: 14 }, (_, i) => `${i} ${"x".repeat(105)}`).join("\n");
    const picked = screen.select(
      "Allow edit_file(a.ts)?",
      [
        { label: "Yes", value: 1 },
        { label: "Yes, and always allow", value: 2 },
        { label: "No", value: 3 },
      ],
      { body },
    );
    await until(output, "enter confirm");
    expect(output()).toContain("3. No");
    expect(output()).toContain("more lines · PgDn/PgUp to scroll");
    // PgDn 翻到预览的末尾，批准之前能看完
    for (let i = 0; i < 20 && !output().includes("end of"); i++) await type("\x1b[6~");
    expect(output()).toContain("PgUp to scroll back");
    await type("\r");
    expect(await picked).toBe(1);
  });

  test("clicking in the input moves the cursor there", async () => {
    const { type, calls } = setup();
    await type("hello world");
    // 100×40：输入框的文字在第 37 行，"› " 之后从第 5 列开始；点第 7 列是第 3 个字符前
    await type("\x1b[<0;7;37M");
    await type("\x1b[<0;7;37m");
    await type("X");
    await type("\r");
    expect(calls.submit).toEqual(["heXllo world"]);
  });

  test("dragging in the input selects text without shift and copies it; the cursor stays where the drag ended", async () => {
    const { type, raw, calls } = setup();
    await type("hello world");
    const copied = () => [...raw().matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
    // 文字从第 5 列开始：从第 1 个字符前拖到第 6 个字符前
    await type("\x1b[<0;5;37M");
    await type("\x1b[<32;8;37M");
    await type("\x1b[<32;10;37M");
    expect(raw()).toContain("\x1b[7m");
    await type("\x1b[<0;10;37m");
    expect(copied()).toEqual(["hello"]);
    expect(raw()).toContain("Copied 5 characters to the clipboard");
    // 有选中时 Ctrl+C 只取消选中，不清空输入
    await type("\x03");
    await type("!");
    await type("\r");
    expect(calls.submit).toEqual(["hello! world"]);
  });

  test("the mouse wheel scrolls a long input instead of the conversation; typing goes back to the cursor", async () => {
    const { screen, type, output, clear } = setup();
    screen.log("conversation-line");
    await sleep(80);
    // 100×40 时输入框最多 10 行
    await type(`\x1b[200~${Array.from({ length: 20 }, (_, i) => `row-${i}`).join("\n")}\x1b[201~`);
    expect(output()).toContain("row-19");
    expect(output()).not.toContain("row-5\n");
    clear();
    // 输入框文字占第 28 到 37 行
    await type("\x1b[<64;10;30M");
    await type("\x1b[<64;10;30M");
    expect(output()).toContain("row-4");
    expect(output()).not.toContain("more lines");
    clear();
    await type("X");
    expect(output()).toContain("row-19X");
  });

  test("ctrl+o expands and collapses the latest foldable item", async () => {
    const { screen, type, output, clear } = setup();
    screen.log("● bash(ls)", { id: "t1", details: "    hidden-1" });
    screen.log("plain line");
    await sleep(80);
    expect(output()).not.toContain("hidden-1");
    await type("\x0f");
    expect(output()).toContain("hidden-1");
    clear();
    await type("\x0f");
    expect(output()).not.toContain("hidden-1");
  });

  test("esc clears the input only when pressed twice, and the cleared text can be recalled", async () => {
    const { type, output, calls } = setup();
    await type("a long draft");
    await type("\x1b");
    await sleep(50);
    await until(output, "Press Esc again to clear");
    await type("\x1b");
    await sleep(50);
    await type("\r");
    expect(calls.submit).toEqual([]);
    await type("\x1b[A");
    await type("\r");
    expect(calls.submit).toEqual(["a long draft"]);
  });
});
