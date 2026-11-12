import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { tuiScreen } from "../plugins/tui/tui.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 极简终端：只跟踪光标行列和每行文字，够判断光标落在哪一行 */
class Vt {
  lines: string[];
  row = 0;
  col = 0;
  visible = true;
  cols: number;
  rows: number;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.lines = Array.from({ length: rows }, () => "");
  }
  resize(cols: number, rows: number) {
    // 像大多数终端：变矮时从顶部丢行（光标跟着上移），变高时在底部加空行
    while (this.lines.length > rows) {
      if (this.row > 0 && this.lines.length - 1 > this.row) this.lines.pop();
      else {
        this.lines.shift();
        this.row = Math.max(0, this.row - 1);
      }
    }
    while (this.lines.length < rows) this.lines.push("");
    this.cols = cols;
    this.rows = rows;
    this.row = Math.min(this.row, rows - 1);
    this.col = Math.min(this.col, cols - 1);
  }
  #put(ch: string) {
    let l = this.lines[this.row]!.padEnd(this.col, " ");
    l = l.slice(0, this.col) + ch + l.slice(this.col + 1);
    this.lines[this.row] = l;
    this.col = Math.min(this.col + 1, this.cols - 1);
  }
  #lf() {
    if (this.row === this.rows - 1) {
      this.lines.shift();
      this.lines.push("");
    } else this.row++;
  }
  write(s: string) {
    const re = /\x1b\[([?0-9;]*)([A-Za-z])|\x1b\][^\x07]*\x07|\x1b([78c])|([\s\S])/g;
    for (const m of s.matchAll(re)) {
      if (m[4] !== undefined) {
        const ch = m[4];
        if (ch === "\n") {
          this.#lf();
          this.col = 0;
        }
        else if (ch === "\r") this.col = 0;
        else if (ch >= " ") this.#put(ch);
        continue;
      }
      if (m[2] === undefined) continue;
      const p = m[1]!;
      const n = p === "" ? 1 : Number(p.split(";")[0]);
      switch (m[2]) {
        case "A":
          this.row = Math.max(0, this.row - n);
          break;
        case "B":
          this.row = Math.min(this.rows - 1, this.row + n);
          break;
        case "E":
          this.col = 0;
          this.row = Math.min(this.rows - 1, this.row + n);
          break;
        case "G":
          this.col = n - 1;
          break;
        case "H": {
          const [r, c] = p.split(";").map((x) => Number(x || 1));
          this.row = (r ?? 1) - 1;
          this.col = (c ?? 1) - 1;
          break;
        }
        case "J":
          if (p === "2" || p === "3") this.lines = this.lines.map(() => "");
          break;
        case "K":
          if (p === "2") this.lines[this.row] = "";
          else this.lines[this.row] = this.lines[this.row]!.slice(0, this.col);
          break;
        case "h":
        case "l":
          if (p === "?25") this.visible = m[2] === "h";
          break;
      }
    }
  }
}

// 窗口尺寸变化后（切到别的终端标签页再切回来常常会这样）有一帧整帧重画，上下各垫一行；
// 下一帧去掉垫行时光标曾经用的还是重画那一帧的布局，停在输入行下面一行
test("the terminal cursor stays on the input line after the window is resized", async () => {
  const vt = new Vt(100, 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _e, done) {
        vt.write(chunk.toString());
        done();
      },
    }),
    { isTTY: true, columns: 100, rows: 40 },
  );
  const screen = tuiScreen({
    status: { cwd: "~/p", model: "m", mode: "ask", session: "s" },
    version: "1",
    commands: [],
    handlers: { submit() {}, interrupt() {}, exit() {} },
    io: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
  });
  try {
    const at = () => ({ input: vt.lines.findIndex((l) => l.includes("› hello")), cursor: vt.row, col: vt.col, shown: vt.visible });
    stdin.write("hello");
    // 启动后 100ms 也有一帧整帧重画
    await sleep(400);
    expect(at()).toEqual({ input: 36, cursor: 36, col: 9, shown: true });
    for (const [c, r] of [
      [100, 30],
      [100, 40],
      [80, 40],
      [100, 40],
    ] as const) {
      vt.resize(c, r);
      Object.assign(stdout, { columns: c, rows: r });
      stdout.emit("resize");
      await sleep(30);
    }
    await sleep(400);
    expect(at()).toEqual({ input: 36, cursor: 36, col: 9, shown: true });
  } finally {
    await screen.close();
  }
});

/** 接上 Vt 的界面；writes 记下每次写进终端的内容 */
function mountVt(cols: number, rows: number) {
  const vt = new Vt(cols, rows);
  const writes: string[] = [];
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _e, done) {
        writes.push(chunk.toString());
        vt.write(chunk.toString());
        done();
      },
    }),
    { isTTY: true, columns: cols, rows },
  );
  const screen = tuiScreen({
    status: { cwd: "~/p", model: "m", mode: "ask", session: "s" },
    version: "1",
    commands: [],
    handlers: { submit() {}, interrupt() {}, exit() {} },
    io: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
  });
  const resize = (c: number, r: number) => {
    vt.resize(c, r);
    Object.assign(stdout, { columns: c, rows: r });
    stdout.emit("resize");
  };
  return { vt, writes, stdin, screen, resize };
}

// 拖动窗口时一连串的 resize 事件：Ink 每个事件都按旧布局画一帧，Windows 上每帧还清屏，画面一直闪
test("dragging the window draws nothing until it stops, then repaints once", async () => {
  const { vt, writes, stdin, screen, resize } = mountVt(100, 40);
  try {
    stdin.write("hello");
    // 运行中每 50ms 本来就要重画一帧
    screen.busy("Working");
    await sleep(300);
    writes.length = 0;
    for (let i = 0; i < 10; i++) {
      resize(100 - i * 2, 40 - i);
      await sleep(20);
    }
    // 窗口标题（OSC 0）不是界面的帧
    expect(writes.filter((w) => !w.startsWith("\x1b]0;"))).toEqual([]);
    await sleep(400);
    const clears = writes.join("").split("\x1b[2J").length - 1;
    expect(clears).toBeGreaterThan(0);
    expect(clears).toBeLessThanOrEqual(2);
    const input = vt.lines.findIndex((l) => l.includes("› hello"));
    expect(input).toBeGreaterThan(-1);
    expect({ cursor: vt.row, col: vt.col }).toEqual({ cursor: input, col: 9 });
  } finally {
    await screen.close();
  }
});

// 运行中每 50ms 一帧：重画那次提交要是被节流推迟，就会和下一次合并掉（没有重画），或者连画几帧比终端高的（每帧清屏）
test("ctrl+l repaints the whole screen once, also while busy", async () => {
  const { writes, stdin, screen } = mountVt(100, 40);
  try {
    screen.busy("Working");
    await sleep(300);
    for (let i = 0; i < 3; i++) {
      writes.length = 0;
      stdin.write("\x0c");
      await sleep(300);
      const clears = writes.join("").split("\x1b[2J").length - 1;
      expect(clears).toBeGreaterThan(0);
      expect(clears).toBeLessThanOrEqual(2);
    }
  } finally {
    await screen.close();
  }
});

// 宽度变了先折看得见的最后一段，前面的在后台补上：底部马上画出来，翻到最上面也还是完整的
test("after a width change the whole long transcript is still there", async () => {
  const { vt, stdin, screen, resize } = mountVt(100, 40);
  try {
    for (let i = 0; i < 3000; i++) screen.log(`row ${i} ${"x".repeat(i % 120)}`);
    await sleep(300);
    resize(70, 40);
    await sleep(300);
    expect(vt.lines.some((l) => l.includes("row 2999 "))).toBe(true);
    stdin.write("\x1b[1;5H"); // ctrl+home
    await sleep(300);
    expect(vt.lines.some((l) => /\brow 1\b/.test(l))).toBe(true);
    expect(vt.lines.some((l) => /\brow 2\b/.test(l))).toBe(true);
  } finally {
    await screen.close();
  }
});

// 运行中只有转圈的 Spinner 自己每 100ms 重画；输入框没有跟着提交时 Ink 认为没人要光标，把它藏起来
test("the terminal cursor stays visible while the spinner ticks", async () => {
  const vt = new Vt(100, 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _e, done) {
        vt.write(chunk.toString());
        done();
      },
    }),
    { isTTY: true, columns: 100, rows: 40 },
  );
  const screen = tuiScreen({
    status: { cwd: "~/p", model: "m", mode: "ask", session: "s" },
    version: "1",
    commands: [],
    handlers: { submit() {}, interrupt() {}, exit() {} },
    io: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
  });
  try {
    stdin.write("hello");
    screen.busy("Working");
    await sleep(400);
    const input = vt.lines.findIndex((l) => l.includes("› hello"));
    expect({ cursor: vt.row, col: vt.col, shown: vt.visible }).toEqual({ cursor: input, col: 9, shown: true });
  } finally {
    await screen.close();
  }
});

// 弹出输入框时下面的主输入框还在，也用着 useCursor；它没有焦点，每次提交都会把光标位置设成"不显示"，盖掉输入框设的位置
test("the terminal cursor sits in an input dialog while it is open", async () => {
  const vt = new Vt(100, 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _e, done) {
        vt.write(chunk.toString());
        done();
      },
    }),
    { isTTY: true, columns: 100, rows: 40 },
  );
  const screen = tuiScreen({
    status: { cwd: "~/p", model: "m", mode: "ask", session: "s" },
    version: "1",
    commands: [],
    handlers: { submit() {}, interrupt() {}, exit() {} },
    io: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
  });
  try {
    await sleep(200);
    const answer = screen.input("Model name", { initial: "abc" });
    await sleep(400);
    const line = vt.lines.findIndex((l) => l.includes("› abc"));
    expect(line).toBeGreaterThan(-1);
    expect({ cursor: vt.row, col: vt.col, shown: vt.visible }).toEqual({ cursor: line, col: vt.lines[line]!.indexOf("› abc") + 5, shown: true });
    // 打字之后（只有输入框重画）光标也跟着走
    stdin.write("d");
    await sleep(200);
    expect({ cursor: vt.row, col: vt.col, shown: vt.visible }).toEqual({ cursor: line, col: vt.lines[line]!.indexOf("› abcd") + 6, shown: true });
    stdin.write("\r");
    expect(await answer).toBe("abcd");
    // 关掉之后回到主输入框
    stdin.write("hi");
    await sleep(300);
    const input = vt.lines.findIndex((l) => l.includes("› hi"));
    expect({ cursor: vt.row, col: vt.col, shown: vt.visible }).toEqual({ cursor: input, col: vt.lines[input]!.indexOf("› hi") + 4, shown: true });
  } finally {
    await screen.close();
  }
});
