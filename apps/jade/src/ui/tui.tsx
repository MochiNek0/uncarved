// 终端界面（Ink）：已完成的输出进 <Static> 往上滚，底部固定显示进行中的流式输出、运行状态、
// 排队的消息、输入框（或对话框）和状态栏。运行中也能输入：提交的内容由宿主决定立即执行还是排队。

import { Box, render, Static, Text, useBoxMetrics, useCursor, useInput, usePaste, useWindowSize, type DOMElement, type Key } from "ink";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import stringWidth from "string-width";
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
  entries: Array<{ id: number; text: string }>;
  /** entries 至少占了多少行（按字符折行估算，不会多估），用来让底部区域贴住终端底边 */
  staticLines: number;
  live?: { kind: "text" | "thinking"; text: string };
  busy?: { label: string; since: number };
  queued: string[];
  dialogs: Dialog[];
  status: StatusInfo;
}

/** 状态容器：频繁的流式更新合并到一帧再通知界面 */
class Store {
  state: UiState;
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextId = 0;

  readonly #columns: () => number;

  constructor(status: StatusInfo, columns: () => number) {
    this.state = { entries: [], staticLines: 0, queued: [], dialogs: [], status };
    this.#columns = columns;
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

  append(texts: string[]) {
    if (texts.length === 0) return;
    // 空行在 Ink 里没有高度，用一个空格占位
    const added = texts.map((text) => ({ id: this.#nextId++, text: text === "" ? " " : text }));
    // Ink 按词折行，行数只会比按字符折行多
    const width = Math.max(1, this.#columns());
    const lines = texts.reduce((n, t) => n + t.split("\n").reduce((m, l) => m + Math.max(1, Math.ceil(stringWidth(l) / width)), 0), 0);
    this.update({ entries: [...this.state.entries, ...added], staticLines: this.state.staticLines + lines });
  }
}

export interface TuiOptions {
  status: StatusInfo;
  commands: CommandInfo[];
  handlers: TuiHandlers;
  /** 测试时替换终端 */
  io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
}

export function tuiScreen(opts: TuiOptions): Screen {
  const stdout = opts.io?.stdout ?? process.stdout;
  const store = new Store(opts.status, () => stdout.columns ?? 80);
  // 先把光标移到终端最底下一行，输入框从底部开始，之后的输出从它上面往上滚；原来屏幕上的内容进入回滚区
  stdout.write("\n".repeat(Math.max(0, (stdout.rows ?? 24) - 1)));

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

  const instance = render(<App store={store} commands={opts.commands} handlers={opts.handlers} />, {
    exitOnCtrlC: false,
    ...(opts.io ? { ...opts.io, interactive: true, patchConsole: false } : {}),
  });

  return {
    interactive: true,
    log(text) {
      flushLive(true);
      store.update({ live: undefined });
      store.append(text.split("\n"));
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
    async close() {
      flushLive(true);
      store.update({ live: undefined, busy: undefined }, true);
      // 等最后一帧画完再卸载
      await new Promise((r) => setTimeout(r, 50));
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}

// ---------- 组件 ----------

function App({ store, commands, handlers }: { store: Store; commands: CommandInfo[]; handlers: TuiHandlers }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const dialog = state.dialogs[0];
  const { rows } = useWindowSize();

  // 让底部区域一直贴着终端底边：它变矮时（菜单、对话框关闭）上一帧的高度保留下来，空白垫在上面，
  // 否则 Ink 擦掉旧内容后输入框会往上浮。新输出写进上方时，垫的空白相应减少，被新内容顶替。
  // 高度不能达到终端行数，否则 Ink 每帧都清屏重画。
  const ref = useRef<DOMElement>(null);
  const { height } = useBoxMetrics(ref);
  const seen = useRef(state.staticLines);
  const reserve = Math.max(0, Math.min(height - (state.staticLines - seen.current), rows - 2));
  useEffect(() => {
    seen.current = state.staticLines;
  });

  return (
    <>
      <Static items={state.entries}>{(e) => <Text key={e.id}>{e.text}</Text>}</Static>
      <Box ref={ref} flexDirection="column" justifyContent="flex-end" minHeight={reserve}>
        {state.live?.text ? <Text dimColor={state.live.kind === "thinking"}>{state.live.text}</Text> : null}
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
        <Prompt commands={commands} handlers={handlers} busy={Boolean(state.busy)} active={!dialog} />
        <StatusBar status={state.status} />
      </Box>
    </>
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
        <Text dimColor>{status.cwd}</Text>
        {status.branch ? <Text color="magenta"> ({status.branch})</Text> : null}
        <Text dimColor> · </Text>
        <Text color="cyan">{status.model}</Text>
        <Text dimColor> · </Text>
        <Text color={modeColor}>{status.mode}</Text>
        <Text dimColor> · </Text>
        {ctx ? (
          <Text color={pct >= 80 ? "yellow" : undefined} dimColor={pct < 80}>
            ctx {tokens(ctx.used)}/{tokens(ctx.limit)} ({pct}%)
          </Text>
        ) : (
          <Text dimColor>ctx —</Text>
        )}
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

function Prompt({ commands, handlers, busy, active }: { commands: CommandInfo[]; handlers: TuiHandlers; busy: boolean; active: boolean }) {
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
  const room = Math.max(3, rows - Math.min(n, VISIBLE) - 12);
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
