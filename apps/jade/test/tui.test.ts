import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { InputHistory } from "../src/history.ts";
import {
  parseEnv,
  providerFromEnv,
  providerInfo,
  providerKind,
  updateEnvFile,
} from "../src/index.ts";
import { edit, layout } from "../src/ui/editor.ts";
import type { Screen } from "../src/ui/screen.ts";
import { tuiScreen, type TuiHandlers } from "../src/ui/tui.tsx";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
      row: 1,
      col: 0,
    });
    expect(layout("ab\ncd", 5, 10)).toEqual({
      rows: ["ab", "cd"],
      row: 1,
      col: 2,
    });
    expect(layout("abcd", 4, 4)).toEqual({
      rows: ["abcd", ""],
      row: 1,
      col: 0,
    });
    expect(layout("", 0, 4)).toEqual({ rows: [""], row: 0, col: 0 });
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

describe("model configuration", () => {
  test("JADE_PROVIDER overrides the default order", async () => {
    const env = {
      OPENAI_API_KEY: "k",
      OPENAI_COMPAT_BASE_URL: "http://x",
      OPENAI_COMPAT_MODEL: "m",
    };
    expect(providerKind(env)).toBe("openai");
    expect(providerKind({ ...env, JADE_PROVIDER: "openai-compat" })).toBe(
      "openai-compat",
    );
    expect(providerInfo({ ...env, JADE_PROVIDER: "openai-compat" })).toEqual({
      kind: "openai-compat",
      model: "m",
      baseURL: "http://x",
    });
    expect(() => providerKind({ JADE_PROVIDER: "gemini" })).toThrow(
      "JADE_PROVIDER",
    );
    await expect(
      providerFromEnv({ ...env, JADE_MAX_TOKENS: "lots" }),
    ).rejects.toThrow("JADE_MAX_TOKENS");
  });

  test("updateEnvFile replaces, appends and removes keys and keeps everything else", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jade-env-"));
    const file = path.join(dir, ".env");
    await writeFile(file, "# comment\nA=1\nB=2\nA=3\nC=keep\n");
    const env: Record<string, string | undefined> = { B: "2" };
    await updateEnvFile(
      file,
      { A: "new", B: undefined, D: 'has space "and quotes"' },
      env,
    );
    const text = await readFile(file, "utf8");
    expect(text).toBe('# comment\nA=new\nC=keep\nD="has space "and quotes""\n');
    expect(parseEnv(text)).toEqual({
      A: "new",
      C: "keep",
      D: 'has space "and quotes"',
    });
    expect(env).toEqual({ A: "new", D: 'has space "and quotes"' });
  });
});

describe("terminal UI", () => {
  let screen: Screen | undefined;
  afterEach(async () => {
    await screen?.close();
    screen = undefined;
  });

  function setup(history?: string[]) {
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
    const calls = { submit: [] as string[], interrupt: 0, exit: 0 };
    const handlers: TuiHandlers = {
      submit: (t) => void calls.submit.push(t),
      interrupt: () => void calls.interrupt++,
      exit: () => void calls.exit++,
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
      commands: [
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

  test("streamed output and logs are printed above the input", async () => {
    const { screen, output } = setup();
    screen.stream("thinking", "pondering\n");
    screen.stream("text", "\n\nfirst line\nsecond");
    screen.endStream();
    screen.log("done");
    await sleep(80);
    const out = output();
    expect(out).toContain("✻ thinking");
    expect(out).toContain("pondering");
    expect(out.indexOf("first line")).toBeLessThan(out.indexOf("second"));
    expect(out).toContain("done");
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
    expect(output()).not.toContain("hidden-1");
    expect(output()).toContain("▸");
    clear();
    await type("\x1b[<0;5;6M");
    expect(output()).not.toContain("hidden-1");
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
});
