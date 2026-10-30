// 终端界面（Ink）：全屏（备用屏幕缓冲区）分三块——顶部标题（版本、模型、目录），中间是对话，
// 自己滚动（滚轮、PgUp/PgDn），底部固定显示运行状态、排队的消息、输入框（或对话框）和状态栏。
// 运行中也能输入：提交的内容由宿主决定立即执行还是排队。

import { writeSync } from "node:fs";
import { Box, render, Text, useBoxMetrics, useCursor, useInput, usePaste, useWindowSize, type DOMElement, type Key } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import wrapAnsi from "wrap-ansi";
import { edit, empty, layout, type EditState } from "./editor.ts";
import { dim, type Choice, type CommandInfo, type Screen, type StatusInfo } from "./screen.ts";

export interface TuiHandlers {
  /** 用户在输入框里提交了一行（消息或命令） */
  submit(text: string): void;
  /** 运行中按 Esc 或 Ctrl+C */
  interrupt(): void;
  /** 空闲时连按两次 Ctrl+C */
  exit(): void;
}

type Dialog =
  | { kind: "select"; title: string; body?: string; choices: Choice<unknown>[]; resolve(v: unknown): void }
  | { kind: "input"; title: string; initial?: string; mask?: boolean; placeholder?: string; resolve(v: string | undefined): void };

interface UiState {
  /** 对话内容变化时递增，让界面重画 */
  version: number;
  live?: { kind: "text" | "thinking"; text: string };
  /** 对话区离底部滚上去了多少行；0 表示跟着最新的输出 */
  scroll: number;
  busy?: { label: string; since: number };
  queued: string[];
  dialogs: Dialog[];
  status: StatusInfo;
}

/** 对话最多保留这么多行（折行前），超出时丢掉最早的一段 */
const MAX_LINES = 10_000;

/** 按显示宽度折行，保留颜色；每一项是屏幕上的一行 */
const wrap = (text: string, width: number) => wrapAnsi(text, width, { hard: true, trim: false }).split("\n");

/** 对话里的一项：普通的一行，或者带折叠内容的一段（点击展开、收起） */
interface Line {
  text: string;
  fold?: { details: string; open: boolean };
}

function wrapLine(l: Line, width: number): string[] {
  if (!l.fold) return wrap(l.text, width);
  const head = wrap(`${l.text}${dim(l.fold.open ? " ▾" : " ▸")}`, width);
  return l.fold.open ? [...head, ...wrap(l.fold.details, width)] : head;
}

/** 状态容器：频繁的流式更新合并到一帧再通知界面 */
class Store {
  state: UiState;
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** 已经完成的输出（折行前）；普通的一项一行 */
  #lines: Line[] = [];
  /** 按 #width 折好的行 */
  #wrapped: string[] = [];
  /** #wrapped 的每一行属于哪个可折叠项；普通行为 undefined */
  #owners: (Line | undefined)[] = [];
  #width = 0;

  constructor(status: StatusInfo) {
    this.state = { version: 0, scroll: 0, queued: [], dialogs: [], status };
  }

  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };
  get = () => this.state;

  update(patch: Partial<UiState>, now = false) {
    this.state = { ...this.state, ...patch };
    if (now) return this.#emit();
    this.#timer ??= setTimeout(() => this.#emit(), 16);
  }

  #emit() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const fn of this.#listeners) fn();
  }

  /** 追加普通的行；带 details 时追加一个可折叠项，texts 是收起时显示的部分 */
  append(texts: string[], details?: string) {
    if (texts.length === 0) return;
    const lines: Line[] =
      details === undefined
        ? texts.flatMap((t) => t.split("\n")).map((text) => ({ text }))
        : [{ text: texts.join("\n"), fold: { details, open: false } }];
    this.#lines.push(...lines);
    if (this.#lines.length > MAX_LINES) {
      this.#lines = this.#lines.slice(-MAX_LINES * 0.8);
      this.#width = 0;
    }
    const before = this.#wrapped.length;
    if (this.#width) for (const l of lines) this.#push(l);
    // 往上翻看时新内容不能把正在看的地方顶走
    const scroll = this.state.scroll > 0 ? this.state.scroll + this.#wrapped.length - before : 0;
    this.update({ version: this.state.version + 1, scroll });
  }

  #push(l: Line) {
    const rows = wrapLine(l, this.#width);
    this.#wrapped.push(...rows);
    for (const _ of rows) this.#owners.push(l.fold ? l : undefined);
  }

  /** 按给定宽度折好的全部输出；宽度变了（终端缩放）才重新折行 */
  lines(width: number): string[] {
    if (width !== this.#width) {
      this.#width = width;
      this.#wrapped = [];
      this.#owners = [];
      for (const l of this.#lines) this.#push(l);
    }
    return this.#wrapped;
  }

  /**
   * 展开或收起第 row 行（折好的行）所在的项；不是可折叠项时什么也不做。
   * start、view 是当前可见的第一行和可见行数：可见部分的开头保持不动；
   * 展开时标题如果在可见部分的底部，往下滚到能看见展开的内容，但标题不滚出去
   */
  toggle(row: number, start: number, view: number) {
    const line = this.#owners[row];
    if (!line?.fold) return;
    let first = row;
    while (first > 0 && this.#owners[first - 1] === line) first--;
    let count = 0;
    while (this.#owners[first + count] === line) count++;
    line.fold.open = !line.fold.open;
    const rows = wrapLine(line, this.#width);
    this.#wrapped.splice(first, count, ...rows);
    this.#owners.splice(first, count, ...rows.map(() => line));
    const end = Math.max(start + view, line.fold.open ? Math.min(first + rows.length, first + view) : 0);
    this.update({ version: this.state.version + 1, scroll: Math.max(0, this.#wrapped.length - end) }, true);
  }

  clear() {
    this.#lines = [];
    this.#wrapped = [];
    this.#owners = [];
    this.update({ version: this.state.version + 1, live: undefined, scroll: 0 }, true);
  }

  /** 往上（正数）或往下滚 n 行，不超过 max */
  scrollBy(n: number, max: number) {
    const scroll = Math.max(0, Math.min(max, this.state.scroll + n));
    if (scroll !== this.state.scroll) this.update({ scroll }, true);
  }
}

export interface TuiOptions {
  status: StatusInfo;
  /** 标题里显示的版本号 */
  version: string;
  commands: CommandInfo[];
  handlers: TuiHandlers;
  /** 测试时替换终端 */
  io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
}

/** 开关鼠标事件上报（SGR 格式），用来接收滚轮和点击；开着时终端里选中文字要按住 Shift */
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

export function tuiScreen(opts: TuiOptions): Screen {
  const stdout = opts.io?.stdout ?? process.stdout;
  const store = new Store(opts.status);

  const styled = (kind: "text" | "thinking", lines: string[]) => (kind === "thinking" ? lines.map((l) => (l ? dim(l) : l)) : lines);

  /** 把流式块里已经完整的行移进 Static，只把最后不完整的一行留在底部 */
  const flushLive = (all = false) => {
    const live = store.state.live;
    if (!live) return;
    const lines = live.text.split("\n");
    const rest = all ? "" : lines.pop()!;
    if (all && lines.at(-1) === "") lines.pop();
    store.append(styled(live.kind, lines));
    store.update({ live: rest || !all ? { kind: live.kind, text: rest } : undefined });
  };

  const ask = <T,>(dialog: Dialog) =>
    new Promise<T>((resolve) => {
      const d = { ...dialog, resolve: (v: unknown) => {
        store.update({ dialogs: store.state.dialogs.filter((x) => x !== d) }, true);
        resolve(v as T);
      } } as Dialog;
      store.update({ dialogs: [...store.state.dialogs, d] }, true);
    });

  // 切到备用屏幕后光标还停在原来的位置（不少终端不会自动归位），Ink 从那里往下画第一帧会让屏幕滚动，
  // 之后每帧只重写变化的行，整个界面就错位了。所以先自己切过去、清屏、把光标移到左上角
  stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  const instance = render(<App store={store} version={opts.version} commands={opts.commands} handlers={opts.handlers} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
    // 全屏每帧只重写变化的行
    incrementalRendering: true,
    ...(opts.io ? { ...opts.io, interactive: true, patchConsole: false } : {}),
  });
  stdout.write(MOUSE_ON);
  // 没走 close 就退出（process.exit）时也要把终端还原，否则会留在备用屏幕、鼠标上报也开着
  const restore = () => {
    try {
      writeSync(1, `${MOUSE_OFF}\x1b[?1049l\x1b[?25h`);
    } catch {}
  };
  if (!opts.io) process.on("exit", restore);

  return {
    interactive: true,
    log(text, o) {
      flushLive(true);
      store.update({ live: undefined });
      store.append(text.split("\n"), o?.details);
    },
    stream(kind, text) {
      const live = store.state.live;
      if (live && live.kind !== kind) {
        flushLive(true);
        store.update({ live: undefined });
      }
      if (!store.state.live) {
        if (kind === "thinking") store.append([dim("✻ thinking")]);
        else text = text.replace(/^\n+/, "");
        if (!text) return;
      }
      store.update({ live: { kind, text: (store.state.live?.text ?? "") + text } });
      if (text.includes("\n")) flushLive();
    },
    endStream() {
      flushLive(true);
      store.update({ live: undefined });
    },
    busy(label) {
      const current = store.state.busy;
      if (label === undefined) store.update({ busy: undefined });
      else store.update({ busy: { label, since: current?.since ?? Date.now() } });
    },
    status(info) {
      store.update({ status: { ...store.state.status, ...info } });
    },
    queued(items) {
      store.update({ queued: [...items] });
    },
    select: <T,>(title: string, choices: Choice<T>[], o?: { body?: string }) =>
      ask<T | undefined>({ kind: "select", title, body: o?.body, choices: choices as Choice<unknown>[], resolve: () => {} }),
    input: (title, o) => ask<string | undefined>({ kind: "input", title, ...o, resolve: () => {} }),
    clear() {
      store.clear();
    },
    async close() {
      flushLive(true);
      store.update({ live: undefined, busy: undefined }, true);
      // 等最后一帧画完再卸载；卸载时 Ink 退出备用屏幕
      await new Promise((r) => setTimeout(r, 50));
      stdout.write(MOUSE_OFF);
      instance.unmount();
      await instance.waitUntilExit();
      process.off("exit", restore);
    },
  };
}

// ---------- 组件 ----------

/**
 * SGR 鼠标事件（Ink 去掉了开头的 ESC）：按钮号、列、行（从 1 开始），M 是按下、m 是松开。
 * 按钮号去掉 Shift/Alt/Ctrl 位后 0 是左键，64 是滚轮向上，65 向下
 */
const MOUSE = /^\[<(\d+);\d+;(\d+)([Mm])$/;
const WHEEL_LINES = 3;

function App({ store, version, commands, handlers }: { store: Store; version: string; commands: CommandInfo[]; handlers: TuiHandlers }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const dialog = state.dialogs[0];
  const { columns, rows } = useWindowSize();

  // 对话区占掉标题和底部之外的全部高度，只画能看见的那几行
  const ref = useRef<DOMElement>(null);
  const { height, top } = useBoxMetrics(ref);
  const width = Math.max(10, columns - 2);
  const done = store.lines(width);
  const live = state.live?.text ? wrap(state.live.kind === "thinking" ? dim(state.live.text) : state.live.text, width) : [];
  const total = done.length + live.length;
  // 往上翻看时最后一行用来提示
  const scrolled = state.scroll > 0 && total > height;
  const view = Math.max(0, scrolled ? height - 1 : height);
  const max = Math.max(0, total - view);
  const scroll = Math.min(state.scroll, max);
  const end = total - scroll;
  const start = Math.max(0, end - view);
  const shown = [...done.slice(start, Math.min(end, done.length)), ...live.slice(Math.max(0, start - done.length), Math.max(0, end - done.length))];
  const page = Math.max(1, view - 2);

  useInput((input, key) => {
    const mouse = MOUSE.exec(input);
    if (mouse) {
      const button = Number(mouse[1]) & ~0b11100;
      if (button === 64) store.scrollBy(WHEEL_LINES, max);
      else if (button === 65) store.scrollBy(-WHEEL_LINES, max);
      else if (button === 0 && mouse[3] === "M") {
        // 点在对话区里已经完成的输出上：展开或收起那一项
        const i = Number(mouse[2]) - 1 - top;
        if (i >= 0 && i < shown.length && start + i < done.length) store.toggle(start + i, start, view);
      }
      return;
    }
    // 选择框自己用 PgUp/PgDn 翻选项
    if (dialog?.kind === "select") return;
    if (key.pageUp) store.scrollBy(page, max);
    else if (key.pageDown) store.scrollBy(-page, max);
    else if (key.ctrl && key.home) store.scrollBy(max, max);
    else if (key.ctrl && key.end) store.scrollBy(-max, max);
  });

  // 总高度要比终端少一行，否则 Ink 认为输出占满了屏幕，每帧清屏重画
  return (
    <Box flexDirection="column" width={columns} height={Math.max(1, rows - 1)} overflow="hidden">
      <Header status={state.status} version={version} />
      <Box ref={ref} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden" paddingX={1}>
        {shown.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l || " "}
          </Text>
        ))}
        {scrolled ? (
          <Text dimColor wrap="truncate-end">
            {`── ↓ ${scroll} more lines · wheel / PgDn to scroll · ctrl+end to jump to the bottom ──`}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {state.busy && !dialog ? <Spinner label={state.busy.label} since={state.busy.since} /> : null}
        {state.queued.map((q, i) => (
          <Text key={i} dimColor wrap="truncate-end">
            {"  ↳ queued: "}
            {q.replace(/\s+/g, " ")}
          </Text>
        ))}
        {dialog ? (
          dialog.kind === "select" ? (
            <SelectDialog key={dialogKey(dialog)} dialog={dialog} />
          ) : (
            <InputDialog key={dialogKey(dialog)} dialog={dialog} />
          )
        ) : null}
        <Prompt commands={commands} handlers={handlers} busy={Boolean(state.busy)} active={!dialog} onSubmit={() => store.scrollBy(-max, max)} />
        <StatusBar status={state.status} />
      </Box>
    </Box>
  );
}

function Header({ status, version }: { status: StatusInfo; version: string }) {
  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text wrap="truncate-end">
        <Text color="cyan" bold>
          ◆ jade
        </Text>
        <Text dimColor> v{version}</Text>
        {status.session ? <Text dimColor>{`  ·  session ${status.session}`}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        <Text color="cyan">{status.model}</Text>
        <Text dimColor> · </Text>
        <Text>{status.cwd}</Text>
        {status.branch ? <Text color="magenta"> ({status.branch})</Text> : null}
      </Text>
    </Box>
  );
}

const dialogIds = new WeakMap<Dialog, number>();
let dialogCounter = 0;
function dialogKey(d: Dialog): number {
  if (!dialogIds.has(d)) dialogIds.set(d, dialogCounter++);
  return dialogIds.get(d)!;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner({ label, since }: { label: string; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.floor((now - since) / 1000);
  return (
    <Box marginTop={1}>
      <Text color="cyan">{FRAMES[Math.floor(now / 100) % FRAMES.length]} </Text>
      <Text>{label}… </Text>
      <Text dimColor>
        ({seconds}s · esc to interrupt)
      </Text>
    </Box>
  );
}

function StatusBar({ status }: { status: StatusInfo }) {
  const ctx = status.context;
  const pct = ctx ? Math.round((ctx.used / ctx.limit) * 100) : 0;
  const modeColor = status.mode === "yolo" ? "red" : status.mode === "auto-edit" ? "yellow" : status.mode === "readonly" ? "blue" : "green";
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={modeColor}>{status.mode}</Text>
        <Text dimColor> · </Text>
        {ctx ? (
          <Text color={pct >= 80 ? "yellow" : undefined} dimColor={pct < 80}>
            ctx {tokens(ctx.used)}/{tokens(ctx.limit)} ({pct}%)
          </Text>
        ) : (
          <Text dimColor>ctx —</Text>
        )}
        {status.cache !== undefined && <Text dimColor> · cache {Math.round(status.cache * 100)}%</Text>}
        <Text dimColor> · PgUp/PgDn scroll · click ▸ to expand · shift+drag to select</Text>
      </Text>
    </Box>
  );
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** 编辑按键的通用处理；返回编辑后的状态，不是编辑键时返回 undefined */
function editKey(s: EditState, input: string, key: Key): EditState | undefined {
  if (key.leftArrow) return edit.left(s);
  if (key.rightArrow) return edit.right(s);
  if (key.home || (key.ctrl && input === "a")) return edit.home(s);
  if (key.end || (key.ctrl && input === "e")) return edit.end(s);
  if (key.backspace) return key.meta ? edit.deleteWord(s) : edit.backspace(s);
  if (key.delete || (key.ctrl && input === "d")) return edit.del(s);
  if (key.ctrl && input === "w") return edit.deleteWord(s);
  if (key.ctrl && input === "u") return edit.killBefore(s);
  if (key.ctrl && input === "k") return edit.killAfter(s);
  if (key.ctrl || key.meta || key.escape || key.return || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return undefined;
  // 鼠标事件由 App 处理
  if (MOUSE.test(input)) return undefined;
  // 其余是普通输入；快速输入时一次可能有多个字符
  const text = input.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  return text ? edit.insert(s, text) : undefined;
}

/** 渲染可编辑文本并把终端光标放到输入位置（输入法的候选框跟着它） */
function EditableText({ state, width, prefix, mask, placeholder, active }: {
  state: EditState;
  width: number;
  prefix: string;
  mask?: boolean;
  placeholder?: string;
  active: boolean;
}) {
  const ref = useRef<DOMElement>(null);
  // 只用来在布局变化后重新计算光标位置；它给的是相对父元素的坐标，光标要的是相对整个输出
  const metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const shown = mask ? "•".repeat([...state.value].length) : state.value;
  const cursor = mask ? [...state.value.slice(0, state.cursor)].length : state.cursor;
  const { rows, row, col } = layout(shown, cursor, width - prefix.length);

  useEffect(() => {
    if (!active || !metrics.hasMeasured || !ref.current) return setCursorPosition(undefined);
    const at = origin(ref.current);
    setCursorPosition({ x: at.x + prefix.length + col, y: at.y + row });
  });
  useEffect(() => () => setCursorPosition(undefined), []);

  return (
    <Box ref={ref} flexDirection="column">
      {state.value === "" && placeholder ? (
        <Text>
          <Text color="cyan">{prefix}</Text>
          <Text dimColor>{placeholder}</Text>
        </Text>
      ) : (
        rows.map((r, i) => (
          <Text key={i} wrap="truncate-end">
            <Text color="cyan">{i === 0 ? prefix : " ".repeat(prefix.length)}</Text>
            {r}
          </Text>
        ))
      )}
    </Box>
  );
}

/** 元素相对整个动态输出（Static 之外的部分）左上角的位置 */
function origin(node: DOMElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let n: DOMElement | undefined = node; n?.yogaNode; n = n.parentNode) {
    x += n.yogaNode.getComputedLeft();
    y += n.yogaNode.getComputedTop();
  }
  return { x, y };
}

function Prompt({ commands, handlers, busy, active, onSubmit }: {
  commands: CommandInfo[];
  handlers: TuiHandlers;
  busy: boolean;
  active: boolean;
  /** 提交后对话区回到底部 */
  onSubmit(): void;
}) {
  const [state, setState] = useState<EditState>(empty);
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string>();
  const history = useRef<string[]>([]);
  /** 正在看的历史条目；-1 表示当前输入 */
  const browsing = useRef(-1);
  const draft = useRef("");
  const lastCtrlC = useRef(0);
  const { columns } = useWindowSize();

  const usageOf = (c: CommandInfo) => `/${c.name}${c.args ? ` ${c.args}` : ""}`;
  const column = Math.max(...commands.map((c) => usageOf(c).length)) + 2;
  const naming = state.value.startsWith("/") && !/\s/.test(state.value);
  const matches = naming ? commands.filter((c) => `/${c.name}`.startsWith(state.value)) : [];
  const pick = matches[Math.min(selected, matches.length - 1)];

  const set = (s: EditState) => {
    setState(s);
    setSelected(0);
    setNotice(undefined);
  };
  const submit = (text: string) => {
    if (!text.trim()) return;
    history.current = [...history.current.filter((h) => h !== text), text].slice(-100);
    browsing.current = -1;
    set(empty);
    onSubmit();
    handlers.submit(text);
  };
  const recall = (i: number) => {
    browsing.current = i;
    const value = i === -1 ? draft.current : history.current[history.current.length - 1 - i]!;
    set({ value, cursor: value.length });
  };

  usePaste((text) => set(edit.insert(state, text.replace(/\r\n?/g, "\n"))), { isActive: active });

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busy) return handlers.interrupt();
      if (state.value) return set(empty);
      if (Date.now() - lastCtrlC.current < 2000) return handlers.exit();
      lastCtrlC.current = Date.now();
      return setNotice("Press Ctrl+C again to exit");
    }
    if (key.escape) {
      if (busy) return handlers.interrupt();
      return set(empty);
    }
    // 文字和回车在同一块里到达（输入很快时终端可能合并）：插入文字后发送
    if (!key.ctrl && !key.meta && input.length > 1 && input.indexOf("\r") === input.length - 1) {
      return submit(edit.insert(state, input.slice(0, -1)).value.trim());
    }
    if (key.return) {
      // 行尾的 \ 加回车换行；Alt+Enter 也换行
      if (key.meta) return set(edit.insert(state, "\n"));
      if (state.value.slice(0, state.cursor).endsWith("\\")) return set(edit.insert(edit.backspace(state), "\n"));
      if (pick && state.value !== `/${pick.name}`) return submit(`/${pick.name}`);
      return submit(state.value.trim());
    }
    if (key.tab) {
      if (pick) set({ value: `/${pick.name}${pick.args ? " " : ""}`, cursor: pick.name.length + 1 + (pick.args ? 1 : 0) });
      return;
    }
    if (key.upArrow) {
      if (matches.length) return setSelected((selected - 1 + matches.length) % matches.length);
      if (!edit.onFirstLine(state)) return setState(edit.up(state));
      if (browsing.current + 1 < history.current.length) {
        if (browsing.current === -1) draft.current = state.value;
        recall(browsing.current + 1);
      }
      return;
    }
    if (key.downArrow) {
      if (matches.length) return setSelected((selected + 1) % matches.length);
      if (!edit.onLastLine(state)) return setState(edit.down(state));
      if (browsing.current >= 0) recall(browsing.current - 1);
      return;
    }
    const next = editKey(state, input, key);
    if (next) set(next);
  }, { isActive: active });

  // 对话框打开时隐藏但不卸载，输入到一半的内容和历史都保留
  return (
    <Box flexDirection="column" marginTop={1} display={active ? "flex" : "none"}>
      <Box borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1}>
        <EditableText
          state={state}
          width={Math.max(10, columns - 5)}
          prefix="› "
          placeholder={busy ? "Type to queue a message · esc to interrupt" : "Message jade · / for commands"}
          active={active}
        />
      </Box>
      {matches.length ? (
        <Box flexDirection="column" paddingX={2}>
          {matches.map((c) => {
            const on = c === pick;
            return (
              <Text key={c.name} wrap="truncate-end">
                <Text color={on ? "cyan" : undefined} bold={on}>
                  {on ? "❯ " : "  "}
                  {usageOf(c).padEnd(column)}
                </Text>
                <Text dimColor>{c.about}</Text>
              </Text>
            );
          })}
          <Text dimColor>  ↑↓ select · enter run · tab complete</Text>
        </Box>
      ) : notice ? (
        <Text color="yellow">  {notice}</Text>
      ) : null}
    </Box>
  );
}

/** 选择框一次最多显示几项 */
const VISIBLE = 10;

function SelectDialog({ dialog }: { dialog: Extract<Dialog, { kind: "select" }> }) {
  const [selected, setSelected] = useState(0);
  const n = dialog.choices.length;
  const { rows } = useWindowSize();
  // 预览（例如要写入的文件）过长时截断：整个界面高过终端时 Ink 会每帧清屏重画
  const lines = dialog.body?.split("\n") ?? [];
  const room = Math.max(3, rows - Math.min(n, VISIBLE) - 16);
  const body = lines.length > room ? [...lines.slice(0, room), dim(`… ${lines.length - room} more lines`)].join("\n") : dialog.body;
  useInput((input, key) => {
    if (key.upArrow || input === "k") return setSelected((selected - 1 + n) % n);
    if (key.downArrow || input === "j") return setSelected((selected + 1) % n);
    if (key.return) return dialog.resolve(dialog.choices[selected]!.value);
    if (key.escape || (key.ctrl && input === "c")) return dialog.resolve(undefined);
    if (key.pageDown) return setSelected(Math.min(n - 1, selected + VISIBLE));
    if (key.pageUp) return setSelected(Math.max(0, selected - VISIBLE));
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(n, 9)) dialog.resolve(dialog.choices[digit - 1]!.value);
  });
  // 选项多时只显示选中项附近的一段
  const start = Math.max(0, Math.min(selected - Math.floor(VISIBLE / 2), n - VISIBLE));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold>{dialog.title}</Text>
      {body ? <Text>{body}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {start > 0 ? <Text dimColor>  ↑ {start} more</Text> : null}
        {dialog.choices.slice(start, start + VISIBLE).map((c, j) => {
          const i = start + j;
          return (
            <Text key={i} wrap="truncate-end">
              <Text color={i === selected ? "cyan" : undefined} bold={i === selected}>
                {i === selected ? "❯ " : "  "}
                {i + 1}. {c.label}
              </Text>
              {c.hint ? <Text dimColor>  {c.hint}</Text> : null}
            </Text>
          );
        })}
        {start + VISIBLE < n ? <Text dimColor>  ↓ {n - start - VISIBLE} more</Text> : null}
      </Box>
      <Text dimColor>↑↓ select · enter confirm · esc cancel</Text>
    </Box>
  );
}

function InputDialog({ dialog }: { dialog: Extract<Dialog, { kind: "input" }> }) {
  const initial = dialog.initial ?? "";
  const [state, setState] = useState<EditState>({ value: initial, cursor: initial.length });
  const { columns } = useWindowSize();
  usePaste((text) => setState(edit.insert(state, text.replace(/\r?\n/g, ""))));
  useInput((input, key) => {
    if (key.return) return dialog.resolve(state.value.trim());
    if (key.escape || (key.ctrl && input === "c")) return dialog.resolve(undefined);
    const next = editKey(state, input, key);
    if (next) setState(next);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text bold>{dialog.title}</Text>
      <EditableText state={state} width={Math.max(10, columns - 6)} prefix="› " mask={dialog.mask} placeholder={dialog.placeholder} active />
      <Text dimColor>enter confirm · esc cancel</Text>
    </Box>
  );
}
