// 终端界面（Ink）：全屏（备用屏幕缓冲区）分三块——顶部标题（版本、模型、目录），中间是对话，
// 自己滚动（滚轮、PgUp/PgDn），底部固定显示运行状态、排队的消息、输入框（或对话框）和状态栏。
// 运行中也能输入：提交的内容由宿主决定立即执行还是排队。
//
// 不用 JSX：插件以 .ts 源码加载，Node 的类型剥离不处理 .tsx，所以组件用 createElement（h）写。

import { writeSync } from "node:fs";
import type { DOMElement, Key } from "ink";
import type { StatusSegment } from "@uncarved/jade-api";
import {
  Box,
  render,
  Text,
  useBoxMetrics,
  useCursor,
  useInput,
  usePaste,
  createContext,
  createElement as h,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "./vendor.ts";
import stringWidth from "string-width";
import { mentionAt, mentionText, rankPaths } from "./mentions.ts";
import { charWidth, edit, empty, layout, moveRow, offsetAt, type EditState } from "./editor.ts";
import { expandTabs, markdownStream, softInfo, visibleRow, wrapRows, type MdLine } from "./markdown.ts";
import { cells, FRAME_MS, Mascot, moodOf, nextChange, title } from "./mascot.ts";
import {
  dim,
  type Choice,
  type CommandInfo,
  type CompletionInfo,
  type Screen,
  type StatusInfo,
} from "./screen.ts";

/**
 * 界面可用的尺寸：宽度比终端少一列。
 * Ink 增量重画时每行写成「内容 + ESC[K」；一行正好占满终端宽度时光标停在最后一列（等待换行），
 * 紧跟的 ESC[K 会把最后一个字符擦掉，输入框之类的右边框就缺了一块。留出最后一列就不会这样
 */
function useScreenSize(): { columns: number; rows: number } {
  const { columns, rows } = useContext(SizeContext);
  return { columns: Math.max(1, columns - 1), rows };
}

/** 终端尺寸：由 store 在窗口停止缩放之后才更新（见 tuiScreen 里的 onResize），不用 Ink 的 useWindowSize */
const SizeContext = createContext<Size>({ columns: 80, rows: 24 });
type Size = { columns: number; rows: number };

/** 最后一个 resize 事件之后等这么久才按新尺寸重画；拖动窗口时一连串的事件只画一次 */
const RESIZE_SETTLE_MS = 100;
/** 拖动窗口时最多隔这么久按新尺寸整帧重画一次：每次都画会一直闪（Windows 上每帧清屏），一直不画就只剩终端折乱的旧画面 */
const RESIZE_FRAME_MS = 200;
/**
 * 整帧重画之前先停这么久不画：要比 Ink 的帧间隔（30fps，约 33ms）长，
 * 重画那次提交才会马上画出来（节流的第一下），而不是被推迟、和下一次提交合并掉
 */
const REPAINT_GAP_MS = 40;
/** 宽度变了之后在后台重新折行，每批折这么多项 */
const REWRAP_BATCH = 1000;

export interface TuiHandlers {
  /** 用户在输入框里提交了一行（消息或命令） */
  submit(text: string): void;
  /** 运行中按 Esc 或 Ctrl+C */
  interrupt(): void;
  /** 输入框第一行按 ↑：把排队的消息放回输入框；没有排队的消息时返回 false，↑ 照常翻历史 */
  unqueue?(): boolean;
  /** 空闲时连按两次 Ctrl+C */
  exit(): void;
  /** 登记了的补全（completions@1）：触发字符、占位提示里的说明、候选菜单下的说明；每次渲染时取 */
  completions?(): CompletionInfo[];
  /** 打了触发字符时的候选（像路径一样用 / 分层，目录以 / 结尾）；每次开始输入一段新的补全时取一次 */
  complete?(trigger: string): Promise<string[]>;
  /** 输入框有焦点时按下 jade 自己不用的 ctrl+<字母>、alt+<字母或数字>、shift+tab（见 keySpec）；返回 true 表示有插件处理了 */
  key?(spec: string): boolean;
}

/** 输入框交给 tuiScreen 的读写入口（Prompt 每次渲染时更新） */
type DraftBridge = { current?: { get(): string; apply(f: (s: EditState) => EditState): void } };

/** 按键写成 "ctrl+g"、"alt+v"（小写）；别的键返回 undefined */
function keySpec(input: string, key: Key): string | undefined {
  if (input.length !== 1) return undefined;
  const c = input.toLowerCase();
  if (key.ctrl && !key.meta && /^[a-z]$/.test(c)) return `ctrl+${c}`;
  if (key.meta && !key.ctrl && /^[a-z0-9]$/.test(c)) return `alt+${c}`;
  return undefined;
}

type Dialog =
  | {
      kind: "select";
      title: string;
      body?: string;
      choices: Choice<unknown>[];
      resolve(v: unknown): void;
    }
  | {
      kind: "input";
      title: string;
      initial?: string;
      mask?: boolean;
      placeholder?: string;
      resolve(v: string | undefined): void;
    };

interface UiState {
  /** 对话内容变化时递增，让界面重画 */
  version: number;
  /** 还没结束的正文：完整的行已经移进对话，这里只有最后不完整的一行（思考是对话里的一项，见 Thinking） */
  live?: { text: string; /** Markdown 里攒着的部分（还没结束的表格），显示在 text 前面 */ pending?: MdLine[] };
  /** 对话区离底部滚上去了多少行；0 表示跟着最新的输出 */
  scroll: number;
  busy?: { label: string; since: number };
  /** 上一次正常做完（不是中断）的时间，吉祥物据此笑一会儿 */
  doneAt?: number;
  /** 正在运行的工具最新的一行进度，显示在对话的最后，工具结束时去掉 */
  progress: { id: string; line: string }[];
  queued: string[];
  dialogs: Dialog[];
  status: StatusInfo;
  /** 插件设置的灰色提示（ctx.input.hint）：输入框为空时显示，Tab 或 → 接受 */
  hint?: string;
  size: Size;
  /** 这一帧比终端高，让 Ink 清屏从左上角整帧重画（见 Store.repaint） */
  repaint?: boolean;
}

/** 对话最多保留这么多行（折行前），超出时丢掉最早的一段 */
const MAX_LINES = 10_000;

/** 按显示宽度折行，保留颜色；每一项是屏幕上的一行，自动折出来的续行开头带记号（markdown.ts），显示之前用 visibleRow 去掉 */
const wrap = wrapRows;

/**
 * 对话里的一项：普通的一行，或者可以点击展开、收起的一段。
 * - details：折叠起来的完整内容
 * - oneRow：收起时只占一行，放不下的部分截掉，展开时完整显示
 * - title：展开时代替 text 显示的标题
 * - think：思考；收起时按宽度现排一行（思考中显示最新的进展，结束后显示用了多久），展开时显示全文
 */
interface Line {
  text: string;
  think?: Thinking;
  details?: string;
  oneRow?: boolean;
  title?: string;
  open?: boolean;
  /** 之后用 amend 补充内容时用的名字 */
  id?: string;
  /** 按宽度现排的内容（Markdown 表格、分隔线），代替 text */
  render?(width: number): string[];
}

/** Markdown 排好的一行折成屏幕上的行 */
const mdRows = (l: MdLine, width: number) =>
  typeof l === "string" ? wrap(l, width) : l.render(width);

/** 按宽度截成一行，截掉了内容时以 … 结尾；留出两列给 … 和展开标记 */
function oneRow(text: string, width: number): { row: string; cut: boolean } {
  const rows = wrap(text, Math.max(1, width - 3));
  const cut = rows.length > 1;
  return { row: cut ? `${rows[0]}${dim("…")}` : rows[0]!, cut };
}

/** 这一项能不能展开：有折叠的内容，或者收起时被截掉了一部分 */
function foldable(l: Line, width: number): boolean {
  if (l.think) return l.think.text.trim() !== "";
  return l.details !== undefined || (Boolean(l.oneRow) && oneRow(l.text, width).cut);
}

/** 一段思考：start、end 是开始和结束的时间（毫秒），没有 end 表示还在思考 */
interface Thinking {
  text: string;
  start: number;
  end?: number;
}

const elapsed = (t: Thinking) =>
  `${Math.max(0, Math.round(((t.end ?? Date.now()) - t.start) / 1000))}s`;

/** 按显示宽度取 text 末尾最多 cols 列；截掉了开头时以 … 开头 */
export function tail(text: string, cols: number): string {
  if (stringWidth(text) <= cols) return text;
  const chars = [...text];
  let out = "";
  let w = 1;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = stringWidth(chars[i]!);
    if (w + cw > cols) break;
    out = chars[i] + out;
    w += cw;
  }
  return `…${out}`;
}

/**
 * 思考收起时的一行（不含展开标记）：思考中显示"✻ Thinking 12s · "加上最新一行的末尾，跟着模型实时往前走；
 * 结束后显示"✻ Thought for 12s"
 */
function thinkingRow(t: Thinking, width: number): string {
  if (t.end !== undefined) return dim(`✻ Thought for ${elapsed(t)}`);
  const label = `✻ Thinking ${elapsed(t)}`;
  const latest = t.text
    .split("\n")
    .findLast((l) => l.trim())
    ?.trim()
    .replace(/\s+/g, " ");
  // 留出 " · "、" ▸" 和一列余量
  const room = width - stringWidth(label) - 6;
  return dim(latest && room >= 8 ? `${label} · ${tail(latest, room)}` : `${label}…`);
}

function wrapLine(l: Line, width: number): string[] {
  if (l.render) return l.render(width);
  if (l.think) {
    if (!foldable(l, width)) return [thinkingRow(l.think, width)];
    if (!l.open) return [`${thinkingRow(l.think, width)}${dim(" ▸")}`];
    const t = l.think;
    const title = dim(t.end === undefined ? `✻ Thinking ${elapsed(t)}` : `✻ Thought for ${elapsed(t)}`);
    const body = t.text
      .replace(/\s+$/, "")
      .split("\n")
      .map((r) => (r ? dim(`  ${r}`) : r))
      .join("\n");
    return [...wrap(`${title}${dim(" ▾")}`, width), ...wrap(body, width)];
  }
  if (!foldable(l, width)) return wrap(l.text, width);
  if (!l.open) {
    const head = l.oneRow ? oneRow(l.text, width).row : l.text;
    return wrap(`${head}${dim(" ▸")}`, width);
  }
  const head = wrap(`${l.title ?? l.text}${dim(" ▾")}`, width);
  return l.details === undefined ? head : [...head, ...wrap(l.details, width)];
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
  /** #wrapped 的每一行属于哪一项 */
  #owners: Line[] = [];
  /** 带名字的项，amend 用 */
  #named = new Map<string, Line>();
  #width = 0;
  /** #lines 里前这么多项还没按 #width 折行：宽度变了先折看得见的最后一段，前面的在后台分批补上 */
  #unwrapped = 0;
  #rewrap: ReturnType<typeof setTimeout> | undefined;
  #repaintTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 先不通知界面重画：窗口正在缩放（等停下来按新尺寸画一次；按旧尺寸画的帧在终端里会错位，
   * Windows 上还会每帧清屏，拖动窗口时就是一直在闪），或者整帧重画之前的空档（见 REPAINT_GAP_MS）
   */
  paused = false;

  constructor(status: StatusInfo, size: Size) {
    this.state = { version: 0, scroll: 0, progress: [], queued: [], dialogs: [], status, size };
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
    if (this.paused) return;
    for (const fn of this.#listeners) fn();
  }

  /** 窗口正在缩放：停下来之前不画 */
  resizing() {
    clearTimeout(this.#repaintTimer);
    this.paused = true;
  }

  /** 窗口停止缩放，或者拖动中隔一段的那次：按新尺寸整帧重画。之前已经停了一阵没画，不用再等 */
  resized(size: Size) {
    this.#repaintNow({ size });
  }

  /**
   * 让一次提交比终端高，Ink 会清屏、从左上角整帧重画（包在同步输出里），下一次提交恢复（见 App）。
   * Ink 增量渲染只用相对光标移动，起点一旦偏了（窗口缩放、别的输出插进来），之后每帧都会画错行，这样能把它拉回来。
   * 只能有一次提交是这样：比终端高的帧不管内容变没变，Ink 每画一次就清一次屏
   */
  repaint() {
    clearTimeout(this.#repaintTimer);
    this.paused = true;
    this.#repaintTimer = setTimeout(() => this.#repaintNow(), REPAINT_GAP_MS);
  }

  #repaintNow(patch: Partial<UiState> = {}) {
    clearTimeout(this.#repaintTimer);
    this.paused = false;
    this.update({ ...patch, repaint: true }, true);
  }

  /** 追加普通的行；带 item 时 texts 合成一项（可折叠、可以之后补充），texts 是收起时显示的部分 */
  append(texts: string[], item?: Omit<Line, "text">) {
    if (texts.length === 0) return;
    const lines: Line[] =
      item === undefined
        ? texts.flatMap((t) => t.split("\n")).map((text) => ({ text }))
        : [{ ...item, text: texts.join("\n") }];
    this.#lines.push(...lines);
    for (const l of lines) if (l.id !== undefined) this.#named.set(l.id, l);
    if (this.#lines.length > MAX_LINES) {
      this.#lines = this.#lines.slice(-MAX_LINES * 0.8);
      this.#named = new Map(this.#lines.flatMap((l) => (l.id === undefined ? [] : [[l.id, l] as const])));
      this.#width = 0;
    }
    const before = this.#wrapped.length;
    if (this.#width) for (const l of lines) this.#push(l);
    // 往上翻看时新内容不能把正在看的地方顶走
    const scroll =
      this.state.scroll > 0
        ? this.state.scroll + this.#wrapped.length - before
        : 0;
    this.update({ version: this.state.version + 1, scroll });
  }

  /** 改写带名字的那一项；找不到时返回 false */
  amend(id: string, change: (l: Line) => void): boolean {
    const line = this.#named.get(id);
    if (!line) return false;
    change(line);
    if (!this.#width) {
      this.update({ version: this.state.version + 1 });
      return true;
    }
    const first = this.#owners.indexOf(line);
    let count = 0;
    while (first >= 0 && this.#owners[first + count] === line) count++;
    const rows = wrapLine(line, this.#width);
    let scroll = this.state.scroll;
    if (first >= 0) {
      this.#wrapped.splice(first, count, ...rows);
      this.#owners.splice(first, count, ...rows.map(() => line));
      // 这一项在往上翻看时的可见部分下面，行数变了要跟着调，看的地方才不动
      if (scroll > 0 && first >= this.#wrapped.length - scroll) scroll += rows.length - count;
    }
    this.update({ version: this.state.version + 1, scroll });
    return true;
  }

  #push(l: Line) {
    const rows = wrapLine(l, this.#width);
    this.#wrapped.push(...rows);
    for (const _ of rows) this.#owners.push(l);
  }

  /**
   * 按给定宽度折好的输出，至少有末尾的 need 行（或者全部）。
   * 宽度变了（终端缩放）才重新折行：同步只折到够 need 行，前面的分批在后台补上，长对话缩放后不用等全部折完才画出来
   */
  lines(width: number, need = Infinity): string[] {
    if (width !== this.#width) {
      this.#width = width;
      this.#wrapped = [];
      this.#owners = [];
      this.#unwrapped = this.#lines.length;
      clearTimeout(this.#rewrap);
      this.#rewrap = undefined;
    }
    this.#wrapEarlier((n) => this.#wrapped.length + n >= need, Infinity);
    if (this.#unwrapped > 0) this.#rewrap ??= setTimeout(this.#rewrapBatch, 0);
    return this.#wrapped;
  }

  #rewrapBatch = () => {
    this.#rewrap = undefined;
    if (!this.#width || this.#unwrapped === 0) return;
    const before = this.#wrapped.length;
    this.#wrapEarlier(() => false, REWRAP_BATCH);
    if (this.#unwrapped > 0) this.#rewrap = setTimeout(this.#rewrapBatch, 0);
    // 补上的行在前面，离底部的距离（scroll）不变，看的地方也就不动；只是行号变了，所以要重画
    if (this.#wrapped.length !== before) this.update({ version: this.state.version + 1 });
  };

  /** 从后往前折还没折的项，直到 enough(新折出的行数) 或者折了 max 项 */
  #wrapEarlier(enough: (rows: number) => boolean, max: number) {
    const rows: string[][] = [];
    const owners: Line[] = [];
    let count = 0;
    while (this.#unwrapped > 0 && rows.length < max && !enough(count)) {
      const l = this.#lines[--this.#unwrapped]!;
      const r = wrapLine(l, this.#width);
      rows.push(r);
      owners.push(l);
      count += r.length;
    }
    if (rows.length === 0) return;
    rows.reverse();
    owners.reverse();
    this.#wrapped = [...rows.flat(), ...this.#wrapped];
    this.#owners = [...owners.flatMap((l, i) => rows[i]!.map(() => l)), ...this.#owners];
  }

  /**
   * 展开或收起第 row 行（折好的行）所在的项；不是可折叠项时什么也不做。
   * start、view 是当前可见的第一行和可见行数：可见部分的开头保持不动；
   * 展开时标题如果在可见部分的底部，往下滚到能看见展开的内容，但标题不滚出去
   */
  toggle(row: number, start: number, view: number) {
    const line = this.#owners[row];
    if (!line || !foldable(line, this.#width)) return;
    let first = row;
    while (first > 0 && this.#owners[first - 1] === line) first--;
    let count = 0;
    while (this.#owners[first + count] === line) count++;
    line.open = !line.open;
    const rows = wrapLine(line, this.#width);
    this.#wrapped.splice(first, count, ...rows);
    this.#owners.splice(first, count, ...rows.map(() => line));
    const end = Math.max(
      start + view,
      line.open ? Math.min(first + rows.length, first + view) : 0,
    );
    this.update(
      {
        version: this.state.version + 1,
        scroll: Math.max(0, this.#wrapped.length - end),
      },
      true,
    );
  }

  clear() {
    this.#lines = [];
    this.#wrapped = [];
    this.#owners = [];
    this.#unwrapped = 0;
    this.#named.clear();
    this.update(
      { version: this.state.version + 1, live: undefined, progress: [], scroll: 0, hint: undefined },
      true,
    );
  }

  /** 展开或收起最后一个可折叠的项（Ctrl+O）；start、view 同 toggle */
  toggleLatest(start: number, view: number) {
    for (let r = this.#owners.length - 1; r >= 0; r--) {
      if (foldable(this.#owners[r]!, this.#width)) return this.toggle(r, start, view);
    }
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
  /** 斜杠命令菜单的内容；命令随会话的插件增减时传函数，每次显示菜单时取最新的 */
  commands: CommandInfo[] | (() => CommandInfo[]);
  handlers: TuiHandlers;
  /** 之前提交过的输入（旧的在前），↑/↓ 和 Ctrl+R 用 */
  history?: string[];
  /** 测试时替换终端 */
  io?: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream };
}

/**
 * 开关鼠标事件上报（SGR 格式），用来接收滚轮、点击和按住左键拖动（1002）。
 * 开着时终端自己不再处理点击，所以对话区的文字由 jade 自己选中和复制（见 Selection）
 */
const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
/**
 * 光标样式：闪烁的竖线（DECSCUSR 5，再加上 ATT610 的"开始闪烁"给只认它的终端），一眼能看出输入框有焦点；
 * 退出时还原成终端自己的默认样式。光标什么时候显示仍由 Ink 管（只有输入框或输入对话框有焦点时才显示）
 */
const CURSOR_BLINK = "\x1b[5 q\x1b[?12h";
const CURSOR_RESET = "\x1b[0 q";

/** 工作超过这么久后结束，或者这时弹出要用户选择的对话框，用户多半去做别的了：提醒一下 */
const NOTIFY_AFTER = 10_000;
/** 支持 OSC 9 桌面通知的终端；其他终端什么都不发（不认识的 OSC 9 在有的终端里会弹别的东西） */
const OSC9_TERMINALS = new Set(["iTerm.app", "WezTerm", "ghostty"]);

/**
 * 支持的终端发一条桌面通知。不响铃：铃声在很多终端里（例如 Windows Terminal）是系统的错误提示音，听起来像出错了。
 * JADE_NOTIFY=off 关闭
 */
function notifier(stdout: NodeJS.WriteStream, env = process.env): (message: string) => void {
  if (env.JADE_NOTIFY === "off" || !OSC9_TERMINALS.has(env.TERM_PROGRAM ?? "")) return () => {};
  return (message) => stdout.write(`\x1b]9;jade: ${message.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`);
}

/** 终端标题里的控制字符换成空格，免得提前结束转义序列 */
const osc0 = (text: string) => `\x1b]0;${text.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`;
/** 先把终端原来的标题存进标题栈（xterm 的 CSI 22 t），退出时取回；不支持的终端（如 Windows Terminal）退出时清空标题，回到默认 */
const TITLE_PUSH = "\x1b[22;0t";
const TITLE_POP = `${osc0("")}\x1b[23;0t`;

/**
 * 让终端标签页标题跟着 jade 的状态走（见 mascot.ts 的 title）：空闲时显示标志，运行中转圈，等用户时加感叹号。
 * JADE_TITLE=off 关闭。返回关闭函数，会把标题还原
 */
function titleBar(stdout: NodeJS.WriteStream, store: Store, env = process.env): () => void {
  if (env.JADE_TITLE === "off") return () => {};
  let shown = "";
  const update = () => {
    const s = store.state;
    const now = Date.now();
    const mood = moodOf({ busy: s.busy?.label, asking: s.dialogs.length > 0, doneAt: s.doneAt }, now);
    const dir = s.status.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? s.status.cwd;
    const text = title(mood, dir, now);
    if (text === shown) return;
    shown = text;
    stdout.write(osc0(text));
  };
  stdout.write(TITLE_PUSH);
  update();
  const off = store.subscribe(update);
  // 运行中转圈：状态不变时也要按时间换一帧
  const timer = setInterval(() => store.state.busy && update(), 250);
  timer.unref?.();
  return () => {
    off();
    clearInterval(timer);
    stdout.write(TITLE_POP);
  };
}

export function tuiScreen(opts: TuiOptions): Screen {
  const stdout = opts.io?.stdout ?? process.stdout;
  const size = (): Size => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const store = new Store(opts.status, size());
  let settle: ReturnType<typeof setTimeout> | undefined;
  let lastResizeFrame = 0;
  const onResize = () => {
    clearTimeout(settle);
    // 终端已经按新宽度把画着的那一帧重新折过行（边框断成两截、两行拼成一行）：拖动时每隔一段按新尺寸整帧重画一次，
    // 中间不画（Ink 增量画的帧在折乱的屏幕上会错位）；停下后再画最后一次
    const now = Date.now();
    if (now - lastResizeFrame >= RESIZE_FRAME_MS) {
      lastResizeFrame = now;
      store.resized(size());
    } else store.resizing();
    settle = setTimeout(() => {
      lastResizeFrame = Date.now();
      store.resized(size());
    }, RESIZE_SETTLE_MS);
  };
  stdout.on("resize", onResize);
  const draft: DraftBridge = {};
  const notify = notifier(stdout);
  /** 已经工作了很久（见 NOTIFY_AFTER） */
  const longBusy = () => {
    const since = store.state.busy?.since;
    return since !== undefined && Date.now() - since >= NOTIFY_AFTER;
  };
  let doneTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 正在进行的思考：一开始就作为一项放进对话（可以点击展开），之后的增量攒起来，每隔一小段时间改写一次那一项。
   * 收起时只占一行，显示模型最新想到了哪里；结束时换成用了多久
   */
  let thinking:
    | { id: string; think: Thinking; timer?: ReturnType<typeof setTimeout> }
    | undefined;
  let thinkingCount = 0;
  const redrawThinking = () => {
    if (!thinking) return;
    clearTimeout(thinking.timer);
    thinking.timer = undefined;
    store.amend(thinking.id, () => {});
  };
  const endThinking = () => {
    if (!thinking) return;
    thinking.think.end = Date.now();
    redrawThinking();
    thinking = undefined;
  };

  /** 正文按 Markdown 排版；一段正文结束时换一个新的，清掉代码块、表格的状态 */
  let md = markdownStream();
  const appendMd = (lines: MdLine[]) => {
    for (const l of lines) {
      if (typeof l === "string") store.append([l]);
      else store.append([""], { render: l.render });
    }
  };

  /** 推进正文：已经完整的行排版后移进对话，只把最后不完整的一行留在底部；all 时全部移进去，连同思考一起结束 */
  const flushLive = (all = false) => {
    if (all) endThinking();
    const live = store.state.live;
    if (!live) return;
    const lines = live.text.split("\n");
    const rest = all ? "" : lines.pop()!;
    if (all && lines.at(-1) === "") lines.pop();
    appendMd(lines.flatMap((l) => md.push(expandTabs(l))));
    if (all) {
      appendMd(md.flush());
      md = markdownStream();
    }
    store.update({ live: rest || !all ? { text: rest, pending: md.pending() } : undefined });
  };

  /** signal 中止时关掉对话框，返回 undefined */
  const ask = <T>(dialog: Dialog, signal?: AbortSignal) =>
    new Promise<T>((resolve) => {
      if (signal?.aborted) return resolve(undefined as T);
      const close = () => d.resolve(undefined);
      const d = {
        ...dialog,
        resolve: (v: unknown) => {
          signal?.removeEventListener("abort", close);
          store.update(
            { dialogs: store.state.dialogs.filter((x) => x !== d) },
            true,
          );
          resolve(v as T);
        },
      } as Dialog;
      signal?.addEventListener("abort", close, { once: true });
      store.update({ dialogs: [...store.state.dialogs, d] }, true);
    });

  // 切到备用屏幕后光标还停在原来的位置（不少终端不会自动归位），Ink 从那里往下画第一帧会让屏幕滚动，
  // 之后每帧只重写变化的行，整个界面就错位了。所以先自己切过去、清屏、把光标移到左上角
  const commands = opts.commands;
  /** 接管终端、画界面。界面的内容都在 store 里，所以让出终端（suspend）之后可以再画一个新的 */
  const mount = () => {
    stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
    const ours = new Set(stdout.listeners("resize"));
    const mounted = render(
      h(App, {
        store,
        copy: (text: string) => void stdout.write(osc52(text)),
        version: opts.version,
        commands: typeof commands === "function" ? commands : () => commands,
        handlers: opts.handlers,
        history: opts.history ?? [],
        draft,
      }),
      {
        exitOnCtrlC: false,
        alternateScreen: true,
        // 全屏每帧只重写变化的行
        incrementalRendering: true,
        ...(opts.io
          ? { ...opts.io, interactive: true, patchConsole: false }
          : {}),
      },
    );
    // Ink 自己也听 resize：每个事件都马上按旧的布局画一帧（变窄时还先逐行擦掉上一帧），
    // 拖动窗口时就是一连串错位的帧，Windows 上每帧还清屏。尺寸改由上面的 onResize 在停下之后统一处理，
    // Ink 每次提交都会按终端当前的宽度重新排版，不需要它自己的监听
    for (const l of stdout.listeners("resize")) if (!ours.has(l)) stdout.off("resize", l as () => void);
    stdout.write(MOUSE_ON + CURSOR_BLINK);
    return mounted;
  };
  let instance = mount();
  /** 让出终端一次只做一回，后来的排在后面 */
  let yielding: Promise<unknown> = Promise.resolve();
  const closeTitle = titleBar(stdout, store);
  // 没走 close 就退出（process.exit）时也要把终端还原，否则会留在备用屏幕、鼠标上报也开着
  const restore = () => {
    try {
      writeSync(1, `${MOUSE_OFF}${CURSOR_RESET}${TITLE_POP}\x1b[?1049l\x1b[?25h`);
    } catch {}
  };
  if (!opts.io) process.on("exit", restore);

  return {
    interactive: true,
    log(text, o) {
      flushLive(true);
      store.update({ live: undefined });
      // 带名字的项（工具调用）收起时只占一行，结果用 amend 接在后面
      store.append(
        text.split("\n"),
        o?.details !== undefined || o?.id !== undefined
          ? { details: o.details, id: o.id, oneRow: o.id !== undefined }
          : undefined,
      );
    },
    amend(id, text, o) {
      flushLive(true);
      const found = store.amend(id, (l) => {
        l.text = `${l.text} ${text}`;
        if (o?.details !== undefined) l.details = o.details;
      });
      if (!found)
        store.append(
          [`  ${text}`],
          o?.details !== undefined ? { details: o.details } : undefined,
        );
    },
    progress(id, line) {
      const rest = store.state.progress.filter((p) => p.id !== id);
      store.update({
        progress: line === undefined ? rest : [...rest, { id, line }],
      });
    },
    stream(kind, text) {
      if (kind === "thinking") {
        if (store.state.live) {
          flushLive(true);
          store.update({ live: undefined });
        }
        if (!thinking) {
          if (!text.trim()) return;
          const think: Thinking = { text: "", start: Date.now() };
          thinking = { id: `\0thinking-${thinkingCount++}`, think };
          store.append([""], { id: thinking.id, think });
        }
        thinking.think.text += text;
        thinking.timer ??= setTimeout(redrawThinking, 50);
        return;
      }
      endThinking();
      if (!store.state.live) {
        text = text.replace(/^\n+/, "");
        if (!text) return;
      }
      store.update({ live: { text: (store.state.live?.text ?? "") + text } });
      if (text.includes("\n")) flushLive();
    },
    endStream() {
      flushLive(true);
      store.update({ live: undefined });
    },
    busy(label) {
      const current = store.state.busy;
      if (label === undefined) {
        // 稍等一下再提醒：排队的消息接着开始时（马上又 busy）不算结束
        if (longBusy()) doneTimer ??= setTimeout(() => notify("done"), 300);
        store.update({
          busy: undefined,
          ...(current && current.label !== "Interrupting" ? { doneAt: Date.now() } : {}),
        });
        return;
      }
      clearTimeout(doneTimer);
      doneTimer = undefined;
      store.update({ busy: { label, since: current?.since ?? Date.now() } });
    },
    status(info) {
      store.update({ status: { ...store.state.status, ...info } });
    },
    queued(items) {
      store.update({ queued: [...items] });
    },
    draft: {
      text: () => draft.current?.get() ?? "",
      insert: (text) => draft.current?.apply((s) => edit.insert(s, text.replace(/\r\n?/g, "\n"))),
      set: (text) => {
        const value = text.replace(/\r\n?/g, "\n");
        draft.current?.apply(() => ({ value, cursor: value.length }));
      },
      hint: (text) => store.update({ hint: text ? text.replace(/\r\n?/g, "\n") : undefined }),
    },
    copy: (text) => void stdout.write(osc52(text)),
    suspend<T>(fn: () => T | Promise<T>): Promise<T> {
      const run = yielding.then(async () => {
        // 输入框里打了一半的字在组件里，卸载就没了：先记下
        const typed = draft.current?.get();
        stdout.write(MOUSE_OFF + CURSOR_RESET);
        // 卸载时 Ink 退出备用屏幕、关掉 raw mode、不再读 stdin：终端回到普通状态，别的程序可以用
        instance.unmount();
        await instance.waitUntilExit();
        delete draft.current;
        try {
          return await fn();
        } finally {
          instance = mount();
          // 等输入框画出来再返回：调用方接着就可能改输入框（编辑器里写好的内容）
          const input = (): DraftBridge["current"] => draft.current;
          for (let i = 0; i < 100 && !input(); i++) await new Promise((r) => setTimeout(r, 10));
          if (typed) input()?.apply(() => ({ value: typed, cursor: typed.length }));
        }
      });
      yielding = run.catch(() => {});
      return run;
    },
    select: <T>(title: string, choices: Choice<T>[], o?: { body?: string; signal?: AbortSignal }) => {
      if (longBusy()) notify(title);
      return ask<T | undefined>(
        {
          kind: "select",
          title,
          body: o?.body,
          choices: choices as Choice<unknown>[],
          resolve: () => {},
        },
        o?.signal,
      );
    },
    input: (title, { signal, ...o } = {}) =>
      ask<string | undefined>(
        {
          kind: "input",
          title,
          ...o,
          resolve: () => {},
        },
        signal,
      ),
    clear() {
      clearTimeout(thinking?.timer);
      thinking = undefined;
      md = markdownStream();
      store.clear();
    },
    async close() {
      clearTimeout(doneTimer);
      flushLive(true);
      store.update({ live: undefined, busy: undefined, progress: [] }, true);
      // 等最后一帧画完再卸载；卸载时 Ink 退出备用屏幕
      await new Promise((r) => setTimeout(r, 50));
      closeTitle();
      clearTimeout(settle);
      stdout.off("resize", onResize);
      stdout.write(MOUSE_OFF + CURSOR_RESET);
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
const MOUSE = /^\[<(\d+);(\d+);(\d+)([Mm])$/;
/** 解析鼠标事件：button 是去掉 Shift/Alt/Ctrl 位的按钮号，press 表示按下；x、y 是屏幕上的列和行（从 0 开始） */
function mouseEvent(input: string): { button: number; press: boolean; x: number; y: number } | undefined {
  const m = MOUSE.exec(input);
  if (!m) return undefined;
  return { button: Number(m[1]) & ~0b11100, press: m[4] === "M", x: Number(m[2]) - 1, y: Number(m[3]) - 1 };
}
const WHEEL_LINES = 3;

/** 按住左键拖动时的按钮号（左键 0 加上移动位 32） */
const DRAG = 32;
/** "已复制"的提示显示多久 */
const COPIED_MS = 2000;

// ---------- 选中文字 ----------

/** 对话区里的位置：row 是整个对话（已完成的加上正在输出的）的第几行，col 按显示宽度（中文占两列） */
type Point = { row: number; col: number };
/** anchor 是按下左键的位置，focus 是拖到的位置；两端都包含在内 */
type Selection = { anchor: Point; focus: Point };

const same = (a: Point, b: Point) => a.row === b.row && a.col === b.col;

/** 第 row 行选中的列 [from, to)；这一行不在选区里时 undefined */
function selectedCols(s: Selection, row: number): [number, number] | undefined {
  const { anchor: a, focus: f } = s;
  const [first, last] = a.row < f.row || (a.row === f.row && a.col <= f.col) ? [a, f] : [f, a];
  if (row < first.row || row > last.row) return undefined;
  return [row === first.row ? first.col : 0, row === last.row ? last.col + 1 : Infinity];
}

/** ANSI 转义序列（CSI，和以 BEL 或 ST 结束的 OSC，例如超链接） */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const INVERSE = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

/**
 * 逐个走过一行里的字符：visit 收到每个字符和它是否落在列 [from, to) 里（宽字符跨进去一半也算）。
 * 转义序列原样交给 escape
 */
function walk(line: string, from: number, to: number, visit: (ch: string, inside: boolean) => void, escape?: (seq: string) => void) {
  let col = 0;
  for (let i = 0; i < line.length; ) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(line);
    if (m) {
      escape?.(m[0]);
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = charWidth(ch);
    visit(ch, col < to && col + Math.max(w, 1) > from);
    col += w;
    i += ch.length;
  }
}

/** 给一行里选中的部分加上反色；中间的转义序列可能关掉反色，之后重新打开 */
function highlight(line: string, from: number, to: number): string {
  let out = "";
  let on = false;
  walk(
    line,
    from,
    to,
    (ch, inside) => {
      if (inside !== on) out += inside ? INVERSE : INVERSE_OFF;
      on = inside;
      out += ch;
    },
    (seq) => (out += seq + (on ? INVERSE : "")),
  );
  return out + (on ? INVERSE_OFF : "");
}

/**
 * 选中的纯文字：每行去掉行尾空白，用换行连起来。自动折行出来的续行接回上一行（补上折行时去掉的空格、
 * 跳过排版加的缩进），所以一行很长的命令复制出来还是一行。row 给的是带续行记号的行
 */
export function selectedText(s: Selection, row: (i: number) => string | undefined): string {
  const lines: string[] = [];
  const { anchor: a, focus: f } = s;
  const first = Math.min(a.row, f.row);
  for (let r = first; r <= Math.max(a.row, f.row); r++) {
    const [from, to] = selectedCols(s, r)!;
    const { text: line, soft, gap, indent } = softInfo(row(r) ?? "");
    let text = "";
    // 续行开头的缩进、竖线是排版加的
    walk(line, Math.max(from, soft ? indent : 0), to, (ch, inside) => void (inside && (text += ch)));
    if (soft && r > first) lines[lines.length - 1] += " ".repeat(gap) + text;
    // 代码块左边的竖线是排版加的，不是代码的一部分
    else lines.push(text.replace(/^┃ ?/, ""));
  }
  return lines.map((l) => l.trimEnd()).join("\n");
}

/** OSC 52：让终端把文字放进系统剪贴板（Windows Terminal、iTerm2、kitty、WezTerm 等支持） */
const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/**
 * 输入框和对话框用：有选中的文字时 Ctrl+C 只取消选中（很多人选完习惯按 Ctrl+C 复制），
 * 不中断模型、不清空输入、不取消对话框
 */
const SelectionContext = createContext<{ active(): boolean; clear(): void }>({ active: () => false, clear: () => {} });
/** 终端矮于这么多行时标题只占一行 */
const COMPACT_ROWS = 24;

/**
 * 底部的菜单、选择框、多行输入最多占多少行：终端很矮时整个界面会高过终端，
 * 超出的部分被裁掉，输入框的边框和状态栏就显示不全了
 */
const roomFor = (rows: number, max: number) =>
  Math.max(3, Math.min(max, Math.floor((rows - 10) / 2)));

function App({
  store,
  copy,
  version,
  commands,
  handlers,
  history,
  draft,
}: {
  store: Store;
  /** 把选中的文字放进剪贴板 */
  copy(text: string): void;
  version: string;
  commands: () => CommandInfo[];
  handlers: TuiHandlers;
  history: string[];
  draft: DraftBridge;
}) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const dialog = state.dialogs[0];
  const columns = Math.max(1, state.size.columns - 1);
  const rows = state.size.rows;
  const compact = rows < COMPACT_ROWS;
  // 运行中每一帧（FRAME_MS）整体重画一次，推动转圈和吉祥物的动画。不能让 Spinner、吉祥物自己重画：
  // Ink 只在输入框也跟着提交的那一帧保留光标，否则把光标藏起来，运行中光标就不见了。
  // 窗口缩放时和整帧重画之前不画（见 Store.paused）
  const [ticks, tickNow] = useReducer((n: number) => n + 1, 0);
  const tick = () => store.paused || tickNow();
  const busy = state.busy !== undefined;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(tick, FRAME_MS);
    return () => clearInterval(t);
  }, [busy]);
  const now = Date.now();
  const mood = moodOf({ busy: state.busy?.label, asking: dialog !== undefined, doneAt: state.doneAt }, now);
  const mascot = useRef<Mascot>(undefined);
  mascot.current ??= new Mascot();
  const showBot = !compact && columns >= 50;
  const bot = showBot ? mascot.current.frame(mood, now) : undefined;
  // 不在运行时吉祥物也会眨眼、瞟一眼、从上一个表情缓过来：只在它要动的时候按帧重画，其余时间不画
  const moving = showBot && mascot.current.moving(mood, now);
  useEffect(() => {
    if (busy || !showBot) return;
    const t = setTimeout(tick, nextChange(mood, Date.now(), state.doneAt, moving));
    return () => clearTimeout(t);
    // 缩放时跳过的那一下靠 state.size 变了再排上
  }, [busy, showBot, ticks, mood, moving, state.doneAt, state.size]);

  // 对话区占掉标题和底部之外的全部高度，只画能看见的那几行
  const ref = useRef<DOMElement>(null);
  const { height, top } = useBoxMetrics(ref);
  const width = Math.max(10, columns - 2);
  // 往上翻看时要折到能看见的地方；多要一屏给翻页
  const done = store.lines(width, state.scroll + 2 * rows);
  // 还没结束的流式块和正在运行的工具的进度：思考只显示最新的一行，进度每个工具一行
  const live = [
    ...(state.live?.pending ?? []).flatMap((l) => mdRows(l, width)),
    ...(state.live?.text ? wrap(state.live.text, width) : []),
    ...state.progress.map((p) => oneRow(p.line, width).row),
  ];
  const total = done.length + live.length;
  // 往上翻看时最后一行用来提示
  const scrolled = state.scroll > 0 && total > height;
  const view = Math.max(0, scrolled ? height - 1 : height);
  // 最多能翻多远按翻上去之后的可见行数算：还在底部时按 height 算，翻到顶会少一行，第一行看不见
  const max = total > height ? total - Math.max(0, height - 1) : 0;
  const scroll = Math.min(state.scroll, max);
  const end = total - scroll;
  const start = Math.max(0, end - view);
  const shown = [
    ...done.slice(start, Math.min(end, done.length)),
    ...live.slice(
      Math.max(0, start - done.length),
      Math.max(0, end - done.length),
    ),
  ];
  const page = Math.max(1, view - 2);

  // 选中文字：按下左键记下位置，拖动时更新，松开时复制；点一下（没拖动）还是展开或收起那一项。
  // 几个事件可能在同一块输入里连着到达，来不及重画，所以另外用 ref 记着最新的值
  const [selection, setSelectionState] = useState<Selection>();
  const selected = useRef<Selection>(undefined);
  const pressed = useRef<Point>(undefined);
  const setSelection = (s: Selection | undefined) => {
    selected.current = s;
    setSelectionState(s);
  };
  const [selectionApi] = useState(() => ({ active: () => selected.current !== undefined, clear: () => setSelection(undefined) }));
  // 宽度变了，行重新折过，原来的位置对不上了
  useEffect(() => setSelection(undefined), [width]);
  const rowAt = (i: number) => (i < done.length ? done[i] : live[i - done.length]);
  // 复制之后在输入框下面提示一会儿
  const [copied, setCopied] = useState<string>();
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  /** 输入框文字在屏幕上的位置（Prompt 里的 EditableText 每次渲染时写入） */
  const inputPlace = useRef<Placement>(undefined);
  const copySelection = (s: Selection) => copyText(selectedText(s, rowAt));
  const copyText = (text: string) => {
    copy(text);
    clearTimeout(copiedTimer.current);
    setCopied(`Copied ${[...text].length} characters to the clipboard`);
    copiedTimer.current = setTimeout(() => setCopied(undefined), COPIED_MS);
  };

  // 窗口停止缩放后和按 Ctrl+L 时整帧重画一次（见 Store.repaint）。
  // 启动时不重画：第一帧之前已经清屏、光标在左上角；整帧重画在不支持同步输出的终端上（Windows 上常见）看得出闪一下
  const repaint = state.repaint === true;
  // 整帧重画那次提交已经马上画出来了（见 Store.repaint），下一次提交就恢复；
  // 这一轮里别的组件跟着改的状态（量出来的高度）和恢复合在同一次提交里，不会再画一帧比终端高的
  useEffect(() => {
    if (repaint) store.update({ repaint: false });
  }, [repaint]);

  useInput((input, key) => {
    if (key.ctrl && input === "l") return store.repaint();
    // 展开或收起最近的一项（工具结果、思考、检查报告），鼠标点不了时也能看完整内容
    if (key.ctrl && input === "o") return store.toggleLatest(start, view);
    const mouse = mouseEvent(input);
    if (mouse) {
      // 对话区里的位置；clamp 时拖出对话区停在第一行或最后一行，否则在对话区外返回 undefined
      const at = (clamp: boolean): Point | undefined => {
        const i = mouse.y - top;
        if (!clamp && (i < 0 || i >= shown.length)) return undefined;
        return { row: start + Math.min(Math.max(i, 0), shown.length - 1), col: Math.max(0, mouse.x - 1) };
      };
      // 滚轮在放不下全部文字的输入框上（含上下边框）时由输入框自己翻
      const input = inputPlace.current;
      const overInput = input && input.total > input.rows && mouse.y >= input.y - 1 && mouse.y <= input.y + input.rows;
      if ((mouse.button === 64 || mouse.button === 65) && overInput) return;
      if (mouse.button === 64) store.scrollBy(WHEEL_LINES, max);
      else if (mouse.button === 65) store.scrollBy(-WHEEL_LINES, max);
      else if (mouse.button === 0 && mouse.press) {
        if (selected.current) setSelection(undefined);
        pressed.current = at(false);
      } else if (mouse.button === DRAG && pressed.current) {
        setSelection({ anchor: pressed.current, focus: at(true)! });
      } else if (mouse.button === 0 && !mouse.press && pressed.current) {
        const p = pressed.current;
        pressed.current = undefined;
        const s = selected.current;
        if (s && !same(s.anchor, s.focus)) copySelection(s);
        else {
          if (s) setSelection(undefined);
          // 点在对话区里已经完成的输出上：展开或收起那一项
          if (p.row < done.length) store.toggle(p.row, start, view);
        }
      }
      return;
    }
    // 按别的键取消选中；Ctrl+C 由输入框和对话框处理（见 SelectionContext）
    if (selected.current && !(key.ctrl && input === "c")) setSelection(undefined);
    // 选择框自己用 PgUp/PgDn 翻选项
    if (dialog?.kind === "select") return;
    if (key.pageUp) store.scrollBy(page, max);
    else if (key.pageDown) store.scrollBy(-page, max);
    else if (key.ctrl && key.home) store.scrollBy(max, max);
    else if (key.ctrl && key.end) store.scrollBy(-max, max);
  });

  // 总高度要比终端少一行，否则 Ink 认为输出占满了屏幕，每帧清屏重画。
  // 重画那一帧上下各垫一行空白：终端把顶上那行滚出去后，看到的和平时逐行一样，所以不会闪。
  // 只做纵向裁剪：每行都已按宽度折好或截断，横向裁剪会让 Ink 每帧对每一行再切一遍 ANSI 字符串
  return h(SizeContext.Provider, { value: state.size }, h(
    SelectionContext.Provider,
    { value: selectionApi },
    h(
      Box,
      {
        flexDirection: "column",
        width: columns,
        height: repaint ? rows + 1 : Math.max(1, rows - 1),
        paddingY: repaint ? 1 : 0,
        overflowY: "hidden",
      },
      // 垫的空白放在外层：里面这层在重画那一帧和平时一样高，对话区的 top（相对父节点）不变，点击换算的行号不会差一行
      h(
        Box,
        { flexDirection: "column", flexGrow: 1, overflowY: "hidden" },
        h(Header, { status: state.status, version, compact, bot, completions: handlers.completions?.() ?? [] }),
        h(
          Box,
          {
            ref,
            flexDirection: "column",
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
            overflowY: "hidden",
            paddingX: 1,
          },
          shown.map((raw, i) => {
            // 续行的记号不显示
            const l = visibleRow(raw);
            const cols = selection && selectedCols(selection, start + i);
            return h(Text, { key: i, wrap: "truncate-end" }, cols ? highlight(l || " ", ...cols) : l || " ");
          }),
          scrolled
            ? h(
                Text,
                { dimColor: true, wrap: "truncate-end" },
                `── ↓ ${scroll} more lines · wheel / PgDn to scroll · ctrl+end to jump to the bottom ──`,
              )
            : null,
        ),
        h(
          Box,
          { flexDirection: "column", flexShrink: 0 },
          state.busy && !dialog ? h(Spinner, { label: state.busy.label, since: state.busy.since }) : null,
          // 插件的块（例如任务清单）：对话框占着地方时先不显示
          dialog
            ? null
            : (state.status.panels ?? []).flatMap((p) =>
                p.text.split("\n").map((l, i) => h(Text, { key: `${p.plugin}:${i}`, wrap: "truncate-end" }, " ", l || " ")),
              ),
          state.queued.map((q, i) =>
            h(Text, { key: i, dimColor: true, wrap: "truncate-end" }, "  ↳ queued: ", q.replace(/\s+/g, " ")),
          ),
          dialog
            ? dialog.kind === "select"
              ? h(SelectDialog, { key: dialogKey(dialog), dialog })
              : h(InputDialog, { key: dialogKey(dialog), dialog })
            : null,
          h(Prompt, {
            commands,
            handlers,
            history,
            bridge: draft,
            hint: state.hint,
            onHintDone: () => store.update({ hint: undefined }),
            busy: Boolean(state.busy),
            queued: state.queued.length > 0,
            active: !dialog,
            onSubmit: () => store.scrollBy(-max, max),
            flash: copied,
            place: inputPlace,
            onCopy: copyText,
          }),
          h(StatusBar, { status: state.status, width: Math.max(10, columns - 2) }),
        ),
      ),
    ),
  ));
}

/**
 * 标题左边的吉祥物（见 mascot.ts）：玉做的团子，按 mood 换表情和动画，三行高，正好和右边三行文字并排
 */
function Bot({ pixels }: { pixels: (string | undefined)[][] }) {
  return h(
    Box,
    { flexDirection: "column", flexShrink: 0, marginRight: 1 },
    ...cells(pixels).map((row, i) =>
      h(
        Text,
        { key: i },
        ...row.map((r, j) => h(Text, { key: j, color: r.fg, backgroundColor: r.bg }, r.text)),
      ),
    ),
  );
}

function Header({
  completions,
  status,
  version,
  compact,
  bot,
}: {
  status: StatusInfo;
  version: string;
  /** 吉祥物这一帧的像素（见 mascot.ts）；放不下时 undefined */
  bot?: (string | undefined)[][];
  /** 终端很矮时只占一行，把高度留给对话和输入框 */
  compact: boolean;
  completions: CompletionInfo[];
}) {
  // 模型 · 目录 (分支)
  const where = [
    h(Text, { key: "model", color: "cyan" }, status.model),
    h(Text, { key: "sep", dimColor: true }, " · "),
    h(Text, { key: "cwd" }, status.cwd),
    status.branch ? h(Text, { key: "branch", color: "magenta" }, ` (${status.branch})`) : null,
  ];
  const name = h(Text, { key: "name", color: "cyan", bold: true }, "jade");
  if (compact)
    return h(
      Box,
      { flexShrink: 0, paddingX: 1 },
      h(Text, { wrap: "truncate-end" }, name, h(Text, { key: "dot", dimColor: true }, " · "), ...where),
    );
  return h(
    Box,
    { flexShrink: 0, borderStyle: "round", borderColor: "cyan", paddingX: 1 },
    bot ? h(Bot, { pixels: bot }) : null,
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
      h(
        Text,
        { wrap: "truncate-end" },
        name,
        h(Text, { dimColor: true }, ` v${version}`),
        status.session ? h(Text, { dimColor: true }, `  ·  session ${status.session}`) : null,
      ),
      h(Text, { wrap: "truncate-end" }, ...where),
      h(Text, { dimColor: true, wrap: "truncate-end" }, ["/help for commands", ...completions.map((c) => `${c.trigger} ${c.label}`)].join(" · ")),
    ),
  );
}

const dialogIds = new WeakMap<Dialog, number>();
let dialogCounter = 0;
function dialogKey(d: Dialog): number {
  if (!dialogIds.has(d)) dialogIds.set(d, dialogCounter++);
  return dialogIds.get(d)!;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 转圈动画由 App 每 100ms 整体重画一次推动（见 App 里的 tick），这里只按当前时间画 */
function Spinner({ label, since }: { label: string; since: number }) {
  const now = Date.now();
  const seconds = Math.floor((now - since) / 1000);
  return h(
    Box,
    { marginTop: 1 },
    h(
      Text,
      { wrap: "truncate-end" },
      h(Text, { color: "cyan" }, `${FRAMES[Math.floor(now / 100) % FRAMES.length]} `),
      h(Text, null, `${label}… `),
      h(Text, { dimColor: true }, `(${seconds}s · esc to interrupt)`),
    ),
  );
}

/**
 * 状态栏的一段，段之间用 " · " 隔开。放不下时按步骤缩短：shortAt 是换成短写法 short 的那一步，
 * dropAt 是去掉整段的那一步；数字大的先做，没有 dropAt 的段一直保留
 */
interface Segment {
  text: string;
  short?: string;
  shortAt?: number;
  dropAt?: number;
  color?: string;
  dim?: boolean;
}

/** 插件段落的语义颜色怎么画 */
const TONE: Record<NonNullable<StatusSegment["tone"]>, string> = { ok: "green", warn: "yellow", error: "red", accent: "magenta" };

/** 在 width 列里放下尽量多的内容（保持原来的顺序） */
export function fitSegments(segments: Segment[], width: number): Segment[] {
  const kept = segments.map((s) => ({ ...s }));
  const total = () =>
    kept.reduce((n, s, i) => n + stringWidth(s.text) + (i ? 3 : 0), 0);
  const steps = kept
    .flatMap((s) => [
      ...(s.short !== undefined && s.shortAt !== undefined
        ? [{ s, at: s.shortAt, drop: false }]
        : []),
      ...(s.dropAt !== undefined ? [{ s, at: s.dropAt, drop: true }] : []),
    ])
    .sort((a, b) => b.at - a.at);
  for (const { s, drop } of steps) {
    if (total() <= width) break;
    if (drop) kept.splice(kept.indexOf(s), 1);
    else s.text = s.short!;
  }
  return kept;
}

function StatusBar({ status, width }: { status: StatusInfo; width: number }) {
  const ctx = status.context;
  const pct = ctx ? Math.round((ctx.used / ctx.limit) * 100) : 0;
  const nearFull = pct >= 80;
  const speed = status.speed;
  // 插件的段落：要一直留着的（keep，例如 jade/modes 的当前模式）放在最前，窄的时候换成短写法；其余的比提示晚、比缓存早去掉
  const plugin = (p: { text: string | StatusSegment }, keep: boolean): Segment => {
    const seg = typeof p.text === "string" ? { text: p.text } : p.text;
    return {
      text: seg.text,
      ...(seg.short !== undefined ? { short: seg.short, shortAt: keep ? 6 : 7.6 } : {}),
      ...(keep ? {} : { dropAt: 7.5 }),
      ...(seg.tone ? { color: TONE[seg.tone] } : { dim: true }),
    };
  };
  const kept = (status.plugins ?? []).filter((p) => typeof p.text !== "string" && p.text.keep);
  const others = (status.plugins ?? []).filter((p) => !kept.includes(p));
  // 窄的时候依次：提示变短、去掉提示、用量变短、去掉缓存、模式变短、去掉用量、上下文变短、去掉速度
  const segments: Segment[] = [
    ...kept.map((p) => plugin(p, true)),
    ctx
      ? {
          text: `ctx ${tokens(ctx.used)}/${tokens(ctx.limit)} (${pct}%)`,
          short: `ctx ${pct}%`,
          shortAt: 4,
          color: nearFull ? "yellow" : undefined,
          dim: !nearFull,
        }
      : { text: "ctx —", dim: true },
    ...(speed
      ? [
          {
            text: `${speed.live ? "~" : ""}${speed.tps >= 100 ? Math.round(speed.tps) : speed.tps.toFixed(1)} tok/s`,
            dropAt: 3,
            dim: true,
          },
        ]
      : []),
    ...(status.cache !== undefined
      ? [{ text: `cache ${Math.round(status.cache * 100)}%`, dropAt: 7, dim: true }]
      : []),
    ...(status.spent
      ? [
          {
            text: `session ${tokens(status.spent.input)} in / ${tokens(status.spent.output)} out`,
            short: `${tokens(status.spent.input)} in / ${tokens(status.spent.output)} out`,
            shortAt: 8,
            dropAt: 5,
            dim: true,
          },
        ]
      : []),
    ...others.map((p) => plugin(p, false)),
    {
      text: "PgUp/PgDn scroll · click ▸ or ctrl+o to expand · drag to select and copy",
      short: "ctrl+o to expand",
      shortAt: 10,
      dropAt: 9,
      dim: true,
    },
  ];
  const shown = fitSegments(segments, width);
  return h(
    Box,
    { paddingX: 1 },
    h(
      Text,
      { wrap: "truncate-end" },
      shown.map((s, i) =>
        h(Text, { key: i }, i ? h(Text, { dimColor: true }, " · ") : null, h(Text, { color: s.color, dimColor: s.dim }, s.text)),
      ),
    ),
  );
}

/** 一行提示：按宽度选第一个放得下的写法，都放不下时用最后一个并截断 */
function Hint({ variants, width }: { variants: string[]; width: number }) {
  const text =
    variants.find((v) => stringWidth(v) <= width) ?? variants.at(-1)!;
  return h(Text, { dimColor: true, wrap: "truncate-end" }, text);
}

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);

/**
 * 同一块输入里的多个按键（按住退格、输入很快时终端会合并）由 Ink 连续交给处理函数，中间不重新渲染，
 * 处理函数里读 useState 的值会是旧的，后面的按键就丢了。这里的值放在 ref 里同步更新：
 * get() 总是最新的，set() 之后安排一次重画（同一块里的多次 set 合并成一次）
 */
function useLive<T>(initial: T): [get: () => T, set: (v: T) => void] {
  const ref = useRef(initial);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  return [
    () => ref.current,
    (v: T) => {
      ref.current = v;
      rerender();
    },
  ];
}

/** 编辑按键的通用处理；返回编辑后的状态，不是编辑键时返回 undefined */
function editKey(s: EditState, input: string, key: Key): EditState | undefined {
  // Ctrl+←/→ 按词移动（Windows 上的习惯），同 Alt+B / Alt+F
  if (key.leftArrow) return key.ctrl ? edit.wordLeft(s) : edit.left(s);
  if (key.rightArrow) return key.ctrl ? edit.wordRight(s) : edit.right(s);
  if (key.home || (key.ctrl && input === "a")) return edit.home(s);
  if (key.end || (key.ctrl && input === "e")) return edit.end(s);
  if (key.backspace) return key.meta ? edit.deleteWord(s) : edit.backspace(s);
  if (key.delete || (key.ctrl && input === "d")) return edit.del(s);
  if (key.ctrl && input === "w") return edit.deleteWord(s);
  if (key.meta && !key.ctrl && input === "f") return edit.wordRight(s);
  if (key.meta && !key.ctrl && input === "b") return edit.wordLeft(s);
  if (key.ctrl && input === "u") return edit.killBefore(s);
  if (key.ctrl && input === "k") return edit.killAfter(s);
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.return ||
    key.tab ||
    key.upArrow ||
    key.downArrow ||
    key.pageUp ||
    key.pageDown
  )
    return undefined;
  // 鼠标事件由 App 处理
  if (MOUSE.test(input)) return undefined;
  // 其余是普通输入；快速输入时一次可能有多个字符
  const text = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  return text ? edit.insert(s, text) : undefined;
}

/**
 * 可编辑文本在屏幕上的位置：第一个字符的列 x、第一行可见行的行 y、可见的是折行后的第 first 行起的 rows 行，
 * 折行后一共 total 行
 */
type Placement = { x: number; y: number; first: number; rows: number; total: number } | undefined;

/** 一行文字里下标 [from, to)（相对这一行）反色显示，和对话区的选中一样 */
function inverseRange(row: string, from: number, to: number): string {
  from = Math.max(0, Math.min(row.length, from));
  to = Math.max(from, Math.min(row.length, to));
  if (from === to) return row;
  return `${row.slice(0, from)}${INVERSE}${row.slice(from, to)}${INVERSE_OFF}${row.slice(to)}`;
}

/** 渲染可编辑文本并把终端光标放到输入位置（输入法的候选框跟着它） */
function EditableText({
  state,
  width,
  prefix,
  mask,
  placeholder,
  active,
  maxRows = Infinity,
  place,
  top,
  selected,
}: {
  /** 每次渲染时写入文字的位置，点击换算光标用 */
  place?: { current: Placement };
  /** 用滚轮翻到的第一行可见行；undefined 时跟着光标 */
  top?: number;
  /** 选中的文字：value 里的下标 [from, to) */
  selected?: [number, number];
  state: EditState;
  width: number;
  prefix: string;
  mask?: boolean;
  placeholder?: string;
  active: boolean;
  /** 最多显示几行；输入更长时只显示光标附近的几行 */
  maxRows?: number;
}) {
  const ref = useRef<DOMElement>(null);
  // 只用来在布局变化后重画一次、重新计算光标位置；它给的是相对父元素的坐标，光标要的是相对整个输出
  const metrics = useBoxMetrics(ref);
  const shown = mask ? "•".repeat([...state.value].length) : state.value;
  const cursor = mask
    ? [...state.value.slice(0, state.cursor)].length
    : state.cursor;
  const all = layout(shown, cursor, width - prefix.length);
  const { col } = all;
  // 行数超过 maxRows 时滚动：平时光标所在的行总在可见范围里，用滚轮翻过时停在翻到的地方（光标可能不在里面）
  const last = Math.max(0, all.rows.length - maxRows);
  const first =
    top === undefined
      ? Math.max(0, Math.min(all.row - maxRows + 1, last))
      : Math.max(0, Math.min(top, last));
  const rows = all.rows.slice(first, first + maxRows);
  const row = all.row - first;
  const cursorShown = row >= 0 && row < rows.length;

  // 光标位置要在渲染时设：useCursor 在这次提交时交给 Ink，跟这一帧一起画出来。
  // 放在 useEffect 里会晚一帧，光标总是停在上一次按键的位置（只移动光标时最明显）。
  // 这里用的是上一次的布局，提交后要核对一遍：
  // - 输入框相对父元素挪了位置时 useBoxMetrics 会再触发一次渲染
  // - 只有祖先挪了位置时（窗口尺寸变化后整帧重画那一帧上下各垫一行，下一帧再去掉）它看不出来，
  //   光标会停在比输入行低一行的地方，要自己比一下整体位置
  const at =
    active && metrics.hasMeasured && ref.current
      ? origin(ref.current)
      : undefined;
  const position = at && cursorShown ? { x: at.x + prefix.length + col, y: at.y + row } : undefined;
  if (place) place.current = at && { x: at.x + prefix.length, y: at.y, first, rows: rows.length, total: all.rows.length };
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!at || !ref.current) return;
    const now = origin(ref.current);
    if (now.x !== at.x || now.y !== at.y) recheck();
  });

  return h(
    Box,
    { ref, flexDirection: "column" },
    active ? h(CursorAt, { position }) : null,
    state.value === "" && placeholder
      ? h(Text, { wrap: "truncate-end" }, h(Text, { color: "cyan" }, prefix), h(Text, { dimColor: true }, placeholder))
      : rows.map((r, i) =>
          h(
            Text,
            { key: first + i, wrap: "truncate-end" },
            h(
              Text,
              { color: "cyan" },
              first + i === 0
                ? prefix
                : i === 0
                  ? "↑".padEnd(prefix.length)
                  : i === rows.length - 1 && first + rows.length < all.rows.length
                    ? "↓".padEnd(prefix.length)
                    : " ".repeat(prefix.length),
            ),
            selected && !mask ? inverseRange(r, selected[0] - all.starts[first + i]!, selected[1] - all.starts[first + i]!) : r,
          ),
        ),
  );
}

/**
 * 终端光标只有一个，每个 useCursor 每次提交都会设一遍。没有焦点的输入框（弹出输入框时下面的主输入框）
 * 不能用它，否则它设的"不显示"会盖掉有焦点的那个，所以只在有焦点时挂上
 */
function CursorAt({ position }: { position: { x: number; y: number } | undefined }) {
  const { setCursorPosition } = useCursor();
  setCursorPosition(position);
  return null;
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

function Prompt({
  commands,
  handlers,
  history: initial,
  bridge,
  hint,
  onHintDone,
  busy,
  queued,
  active,
  onSubmit,
  flash,
  place,
  onCopy,
}: {
  /** 输入框文字在屏幕上的位置（见 EditableText 的 place）；App 用它判断滚轮是不是在输入框上 */
  place: { current: Placement };
  /** 在输入框里拖动选中了文字：复制它 */
  onCopy(text: string): void;
  /** 当前的命令（随会话的插件增减），每次算菜单时取 */
  commands: () => CommandInfo[];
  handlers: TuiHandlers;
  history: string[];
  /** 让 tuiScreen 的 draft 读写输入框 */
  bridge: DraftBridge;
  /** 插件设置的灰色提示 */
  hint?: string;
  /** 提示随消息发出去了：去掉它 */
  onHintDone(): void;
  busy: boolean;
  /** 有排队等待发送的消息 */
  queued: boolean;
  active: boolean;
  /** 提交后对话区回到底部 */
  onSubmit(): void;
  /** 临时显示在输入框右上角的提示（例如"已复制"） */
  flash?: string;
}) {
  const selection = useContext(SelectionContext);
  const [current, setState] = useLive<EditState>(empty);
  const [getSelected, setSelected] = useLive(0);
  const [getNotice, setNotice] = useLive<string | undefined>(undefined);
  const history = useRef<string[]>(initial);
  /** 正在看的历史条目；-1 表示当前输入 */
  const browsing = useRef(-1);
  const draft = useRef("");
  const lastCtrlC = useRef(0);
  const lastEsc = useRef(0);
  /**
   * 用滚轮翻过输入框时翻到的第一行可见行。只对翻的时候的那份文字和光标有效：打字、移动光标后又跟着光标
   */
  const scrolled = useRef<{ top: number; value: string; cursor: number }>(undefined);
  /** 在输入框里按住左键拖动选中的文字：anchor 是按下的位置，focus 是拖到的位置（value 里的下标）；文字改了就作废 */
  const [getDrag, setDrag] = useLive<{ anchor: number; focus: number; value: string } | undefined>(undefined);
  const { columns, rows } = useScreenSize();
  /** 输入框里文字的宽度：边框、内边距和前面的 "› " 之外 */
  const textWidth = Math.max(10, columns - 5) - 2;
  /** 补全菜单、搜索结果最多显示几项；输入框最多几行 */
  const menuRows = roomFor(rows, MENTION_ROWS);
  const inputRows = roomFor(rows, 10);
  const hintWidth = Math.max(10, columns - 3);
  // @ 引用补全用的路径；排好的结果按（路径表，查询）缓存，按键处理和渲染都要用时不重复排
  const [getPaths, setPaths] = useLive<string[]>([]);
  const ranked = useRef<{ paths: string[]; query: string; result: string[] }>(
    undefined,
  );
  // Ctrl+R 搜索历史：结果新的在前，index 是选中的那条
  const [getSearch, setSearch] = useLive<
    { query: string; index: number } | undefined
  >(undefined);

  const usageOf = (c: CommandInfo) => `/${c.name}${c.args ? ` ${c.args}` : ""}`;
  const completions = handlers.completions?.() ?? [];
  const triggers = completions.map((c) => c.trigger);
  const column = Math.max(...commands().map((c) => usageOf(c).length)) + 2;

  /** 由最新的输入算出补全菜单和搜索结果；渲染和按键处理都用它 */
  const derive = () => {
    const state = current();
    const selected = getSelected();
    const search = getSearch();
    // 翻到的历史条目原样未改时不弹补全菜单，否则菜单会占住 ↑/↓，翻不过 /命令 这样的条目
    const recalled =
      browsing.current >= 0 &&
      state.value ===
        history.current[history.current.length - 1 - browsing.current];
    const naming =
      !recalled && state.value.startsWith("/") && !/\s/.test(state.value);
    const matches = naming
      ? commands().filter((c) => `/${c.name}`.startsWith(state.value))
      : [];
    const pick = matches[Math.min(selected, matches.length - 1)];
    // @ 引用：光标处正在输入的路径和补全候选
    const mention =
      naming || recalled ? undefined : mentionAt(state.value, state.cursor, triggers);
    let found: string[] = [];
    if (mention) {
      const paths = getPaths();
      const r = ranked.current;
      found =
        r && r.paths === paths && r.query === mention.query
          ? r.result
          : rankPaths(paths, mention.query, MENTION_ROWS);
      ranked.current = { paths, query: mention.query, result: found };
    }
    const file = found[Math.min(selected, found.length - 1)];
    const menu = matches.length || found.length;
    const results = search
      ? history.current
          .toReversed()
          .filter((h) => h.toLowerCase().includes(search.query.toLowerCase()))
      : [];
    const hit = search
      ? Math.max(0, Math.min(search.index, results.length - 1))
      : 0;
    return {
      state,
      selected,
      search,
      matches,
      pick,
      mention,
      found,
      file,
      menu,
      results,
      hit,
    };
  };
  const { state, search, matches, pick, mention, found, file, results, hit } =
    derive();
  const notice = getNotice();

  const mentioning = mention?.trigger;
  // 每次开始输入一段新的补全时重新取一次：候选可能已经变了（例如文件）
  useEffect(() => {
    if (mentioning === undefined || !handlers.complete) return;
    let live = true;
    setPaths([]);
    handlers.complete(mentioning).then(
      (p) => void (live && setPaths(p)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [mentioning]);
  const completion = completions.find((c) => c.trigger === mentioning);
  // 结果多时只显示选中项附近的几条
  const first = around(hit, results.length, menuRows);
  const firstMatch = around(Math.max(0, matches.indexOf(pick!)), matches.length, menuRows);
  const firstFound = around(Math.max(0, found.indexOf(file!)), found.length, menuRows);

  /** 提示只在空闲、输入框为空、没有在搜索历史时显示，也只有这时能接受 */
  const hinting = () => hint !== undefined && !busy && current().value === "" && !getSearch();
  const set = (s: EditState) => {
    // 打字时提示只是不显示（hinting() 要求输入框为空），删回空的又出现；发出去才作废
    setState(s);
    setSelected(0);
    setNotice(undefined);
    lastEsc.current = 0;
  };
  const remember = (text: string) => {
    history.current = [
      ...history.current.filter((h) => h !== text),
      text,
    ].slice(-100);
    browsing.current = -1;
  };
  /**
   * 大段粘贴在输入框里只占一个占位符，发送（和放进历史、给插件读）时换回原文。
   * 占位符被删掉一部分时认不出来，按打出来的样子发送。发送、清空之后原文已经换回去了（历史里存的也是原文），不再留着
   */
  const pastes = useRef(new Map<string, string>());
  const unfold = (text: string) => (pastes.current.size ? text.replace(PASTED, (m) => pastes.current.get(m) ?? m) : text);
  const submit = (folded: string) => {
    if (!folded.trim()) return;
    const text = unfold(folded);
    pastes.current.clear();
    if (hint !== undefined) onHintDone();
    remember(text);
    set(empty);
    // 发出去之后弹出的对话框是用户自己要的（/mode、/model），马上就能回答
    typedAt = 0;
    onSubmit();
    handlers.submit(text);
  };
  /** 清空输入；清掉的内容放进（本次运行的）历史，按 ↑ 能找回来 */
  const discard = () => {
    const text = unfold(current().value);
    pastes.current.clear();
    if (text.trim()) remember(text);
    set(empty);
  };
  /** 用选中的路径替换正在输入的 @ 引用；目录不加空格，接着补全里面的文件 */
  const complete = (p: string) => {
    const { state, mention } = derive();
    const text = mentionText(mention!.trigger, p) + (p.endsWith("/") ? "" : " ");
    set({
      value:
        state.value.slice(0, mention!.start) +
        text +
        state.value.slice(state.cursor),
      cursor: mention!.start + text.length,
    });
  };
  bridge.current = { get: () => unfold(current().value), apply: (f) => set(f(current())) };
  const recall = (i: number) => {
    browsing.current = i;
    const value =
      i === -1
        ? draft.current
        : history.current[history.current.length - 1 - i]!;
    set({ value, cursor: value.length });
  };

  usePaste(
    (text) => {
      const search = getSearch();
      if (search)
        setSearch({
          query: search.query + text.replace(/\s+/g, " "),
          index: 0,
        });
      else {
        const pasted = text.replace(/\r\n?/g, "\n");
        const lines = pasted.replace(/\n$/, "").split("\n").length;
        if (lines <= FOLD_PASTE_LINES && pasted.length <= FOLD_PASTE_CHARS) return set(edit.insert(current(), pasted));
        const tag = `[Pasted text #${pastes.current.size + 1} ${lines > 1 ? `+${lines} lines` : `${pasted.length} chars`}]`;
        pastes.current.set(tag, pasted);
        set(edit.insert(current(), tag));
      }
    },
    { isActive: active },
  );

  /** 搜索时的按键：上下（或再按 Ctrl+R）换一条，回车/Tab 放进输入框接着改，Esc 退出 */
  const searchKey = (
    s: { query: string; index: number },
    input: string,
    key: Key,
  ) => {
    const { results, hit } = derive();
    if (key.escape || (key.ctrl && (input === "c" || input === "g")))
      return setSearch(undefined);
    if (key.return || key.tab) {
      setSearch(undefined);
      const picked = results[hit];
      if (picked !== undefined) {
        browsing.current = -1;
        set({ value: picked, cursor: picked.length });
      }
      return;
    }
    if (key.upArrow || (key.ctrl && input === "r"))
      return setSearch({
        ...s,
        index: Math.min(hit + 1, Math.max(0, results.length - 1)),
      });
    if (key.downArrow) return setSearch({ ...s, index: Math.max(0, hit - 1) });
    if (key.backspace || key.delete)
      return setSearch({ query: [...s.query].slice(0, -1).join(""), index: 0 });
    if (key.ctrl && input === "u") return setSearch({ query: "", index: 0 });
    if (key.ctrl || key.meta || MOUSE.test(input)) return;
    const text = input.replace(/[\x00-\x1f\x7f]/g, "");
    if (text) setSearch({ query: s.query + text, index: 0 });
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c" && selection.active()) return selection.clear();
      const search = getSearch();
      if (search) return searchKey(search, input, key);
      const state = current();
      // 输入框里的鼠标：点击移动光标，按住拖动选中、松开时复制，滚轮翻看放不下的文字
      const mouse = mouseEvent(input);
      if (mouse) {
        const at = place.current;
        if (!at) return;
        const row = mouse.y - at.y;
        // 拖出输入框时停在第一行或最后一行
        const offset = (r: number) => offsetAt(state.value, textWidth, at.first + Math.max(0, Math.min(at.rows - 1, r)), mouse.x - at.x);
        // 滚轮：上下边框也算在输入框上
        if ((mouse.button === 64 || mouse.button === 65) && row >= -1 && row <= at.rows && at.total > at.rows) {
          const top = Math.max(0, Math.min(at.total - at.rows, at.first + (mouse.button === 64 ? -WHEEL_LINES : WHEEL_LINES)));
          scrolled.current = { top, value: state.value, cursor: state.cursor };
          return setState({ ...state });
        }
        if (mouse.button === 0 && mouse.press) {
          if (row < 0 || row >= at.rows) return setDrag(undefined);
          const cursor = offset(row);
          if (cursor === undefined) return;
          setDrag({ anchor: cursor, focus: cursor, value: state.value });
          // 点在翻过的地方时保持翻到的位置
          if (scrolled.current) scrolled.current = { ...scrolled.current, cursor };
          return setState({ ...state, cursor });
        }
        const drag = getDrag();
        if (!drag || drag.value !== state.value) return;
        if (mouse.button === DRAG) {
          const focus = offset(row);
          if (focus === undefined) return;
          setDrag({ ...drag, focus });
          if (scrolled.current) scrolled.current = { ...scrolled.current, cursor: focus };
          return setState({ ...state, cursor: focus });
        }
        if (mouse.button === 0 && !mouse.press && drag.anchor !== drag.focus) {
          onCopy(state.value.slice(Math.min(drag.anchor, drag.focus), Math.max(drag.anchor, drag.focus)));
        }
        return;
      }
      // 别的键取消输入框里的选中；Ctrl+C 只取消选中（已经在松开时复制过了）
      const drag = getDrag();
      if (drag) {
        setDrag(undefined);
        if (key.ctrl && input === "c" && drag.anchor !== drag.focus && drag.value === state.value) return;
      }
      if (key.ctrl && input === "r")
        return history.current.length
          ? setSearch({ query: "", index: 0 })
          : undefined;
      if (key.ctrl && input === "c") {
        if (busy) {
          // 第一下中断；停不下来时（卡在 Interrupting）再按一下也能退出
          if (Date.now() - lastCtrlC.current < 2000) return handlers.exit();
          lastCtrlC.current = Date.now();
          return handlers.interrupt();
        }
        if (state.value) return discard();
        if (Date.now() - lastCtrlC.current < 2000) return handlers.exit();
        lastCtrlC.current = Date.now();
        return setNotice("Press Ctrl+C again to exit");
      }
      if (key.escape) {
        if (busy) return handlers.interrupt();
        if (!state.value) return;
        // 误按一下 Esc 不清掉写了半天的内容：连按两次才清空
        if (Date.now() - lastEsc.current < 1500) return discard();
        setNotice("Press Esc again to clear the input");
        lastEsc.current = Date.now();
        return;
      }
      // 文字和回车在同一块里到达（输入很快时终端可能合并）：插入文字后发送
      if (
        !key.ctrl &&
        !key.meta &&
        input.length > 1 &&
        input.indexOf("\r") === input.length - 1
      ) {
        return submit(edit.insert(state, input.slice(0, -1)).value.trim());
      }
      if (key.return) {
        // 行尾的 \ 加回车换行；Alt+Enter 也换行；终端把 Shift+Enter 单独报上来时（kitty 键盘协议、modifyOtherKeys）也换行。
        // Ctrl+J（Windows Terminal 里 Ctrl+Enter 也是它）发的是 LF，不算回车，在 editKey 里当普通换行插入
        if (key.meta || key.shift) return set(edit.insert(state, "\n"));
        if (state.value.slice(0, state.cursor).endsWith("\\"))
          return set(edit.insert(edit.backspace(state), "\n"));
        const { pick, file } = derive();
        if (pick && state.value !== `/${pick.name}`)
          return submit(`/${pick.name}`);
        if (file) return complete(file);
        return submit(state.value.trim());
      }
      // Tab 或 →：把提示变成输入框里的文字，接着可以改
      if (((key.tab && !key.shift) || key.rightArrow) && hinting()) {
        browsing.current = -1;
        return set({ value: hint!, cursor: hint!.length });
      }
      // shift+tab 交给插件的快捷键（例如 jade/modes 切换模式）
      if (key.tab && key.shift) return void handlers.key?.("shift+tab");
      if (key.tab) {
        const { pick, file } = derive();
        if (pick)
          set({
            value: `/${pick.name}${pick.args ? " " : ""}`,
            cursor: pick.name.length + 1 + (pick.args ? 1 : 0),
          });
        else if (file) complete(file);
        return;
      }
      if (key.upArrow) {
        const { menu, selected } = derive();
        if (menu) return setSelected((selected - 1 + menu) % menu);
        // 按折行后的屏幕行移动：一大段没有换行的文字也能上下走，到了第一行才翻历史
        const up = moveRow(state, textWidth, -1);
        if (up) return setState(up);
        // 先取回排队的消息，取完了再翻历史
        if (handlers.unqueue?.()) {
          browsing.current = -1;
          return;
        }
        if (browsing.current + 1 < history.current.length) {
          if (browsing.current === -1) draft.current = state.value;
          recall(browsing.current + 1);
        }
        return;
      }
      if (key.downArrow) {
        const { menu, selected } = derive();
        if (menu) return setSelected((selected + 1) % menu);
        const down = moveRow(state, textWidth, 1);
        if (down) return setState(down);
        if (browsing.current >= 0) recall(browsing.current - 1);
        return;
      }
      const spec = keySpec(input, key);
      if (spec && handlers.key?.(spec)) return;
      const next = editKey(state, input, key);
      if (next) {
        if (next.value !== state.value) typedAt = Date.now();
        set(next);
      }
    },
    { isActive: active },
  );

  const view = scrolled.current;
  const viewTop = view && view.value === state.value && view.cursor === state.cursor ? view.top : undefined;
  const drag = getDrag();
  const dragged: [number, number] | undefined =
    drag && drag.value === state.value && drag.anchor !== drag.focus
      ? [Math.min(drag.anchor, drag.focus), Math.max(drag.anchor, drag.focus)]
      : undefined;

  // 以命令的简写开头（例如 jade/shell 的 !）：这一行是那条命令，边框换个颜色、上边框的右边写一行说明
  const prefixed = search ? undefined : commands().find((c) => c.prefix !== undefined && state.value.startsWith(c.prefix));
  const bang = prefixed !== undefined;
  const prefixLabel = (() => {
    if (!prefixed) return "";
    const hint = prefixed.prefixHint ?? `/${prefixed.name}`;
    const head = hint.split(" · ")[0]!;
    // 窄的时候只留第一句；运行中排队，说明这一点
    return columns >= 70 ? (busy ? `${head} · runs after this turn · esc stops it` : `${hint} · esc stops it`) : head;
  })();
  const placeholder = ["Message jade", "/ commands", ...completions.map((c) => `${c.trigger} ${c.label}`)].join(" · ");

  // 对话框打开时隐藏但不卸载，输入到一半的内容和历史都保留
  return h(
    Box,
    { flexDirection: "column", marginTop: 1, display: active ? "flex" : "none" },
    h(
      Box,
      { borderStyle: "round", borderColor: bang ? "magenta" : busy ? "gray" : "cyan", paddingX: 1 },
      search
        ? h(EditableText, {
            state: { value: search.query, cursor: search.query.length },
            width: Math.max(10, columns - 5),
            prefix: "search history› ",
            placeholder: "type to filter",
            active,
            maxRows: inputRows,
          })
        : h(EditableText, {
            state,
            width: Math.max(10, columns - 5),
            prefix: "› ",
            placeholder: hinting()
              ? hintLine(hint!)
              : queued
                ? "↑ to edit queued messages · esc to interrupt"
                : busy
                  ? "Type to queue a message · esc to interrupt"
                  : columns >= 70
                    ? `${placeholder} · ↑ or ctrl+r for history`
                    : placeholder,
            active,
            maxRows: inputRows,
            place,
            top: viewTop,
            selected: dragged,
          }),
    ),
    search
      ? h(
          Box,
          { flexDirection: "column", paddingX: 2 },
          results.length
            ? results.slice(first, first + menuRows).map((item, i) => {
                const on = first + i === hit;
                return h(
                  Text,
                  { key: first + i, wrap: "truncate-end", color: on ? "cyan" : undefined, bold: on },
                  on ? "❯ " : "  ",
                  item.replace(/\s*\n\s*/g, " ⏎ "),
                );
              })
            : h(Text, { dimColor: true }, " no match"),
          h(Hint, {
            width: hintWidth,
            variants: [" ↑↓ or ctrl+r select · enter/tab put in the input · esc cancel", " ↑↓ select · enter use · esc cancel"],
          }),
        )
      : matches.length
        ? h(
            Box,
            { flexDirection: "column", paddingX: 2 },
            matches.slice(firstMatch, firstMatch + menuRows).map((c) => {
              const on = c === pick;
              return h(
                Text,
                { key: c.name, wrap: "truncate-end" },
                h(Text, { color: on ? "cyan" : undefined, bold: on }, on ? "❯ " : "  ", usageOf(c).padEnd(column)),
                h(Text, { dimColor: true }, c.about),
              );
            }),
            h(Hint, {
              width: hintWidth,
              variants: [
                ` ↑↓ select · enter run · tab complete${matches.length > menuRows ? ` · ${matches.length} commands` : ""}`,
                " ↑↓ · enter run · tab complete",
              ],
            }),
          )
        : found.length
          ? h(
              Box,
              { flexDirection: "column", paddingX: 2 },
              found.slice(firstFound, firstFound + menuRows).map((p) => {
                const on = p === file;
                return h(
                  Text,
                  { key: p, wrap: "truncate-middle", color: on ? "cyan" : p.endsWith("/") ? "blue" : undefined, bold: on },
                  on ? "❯ " : "  ",
                  p,
                );
              }),
              h(Hint, {
                width: hintWidth,
                variants: [
                  ...(completion?.hint ? [` ↑↓ select · enter/tab insert · ${completion.hint}`] : []),
                  " ↑↓ select · enter/tab insert",
                  " ↑↓ · enter insert",
                ],
              }),
            )
          : notice
            ? h(Text, { color: "yellow" }, ` ${notice}`)
            : null,
    // 压在输入框上边框的右边，不占行，出现和消失时下面的内容不跳
    // 以命令的简写开头时同一个位置写这一行是什么（刚复制的提示优先）
    flash
      ? h(Box, { position: "absolute", top: 0, right: 2 }, h(Text, { color: "green" }, ` ${flash} `))
      : bang
        ? h(
            Box,
            { position: "absolute", top: 0, right: 2 },
            h(Text, { color: "magenta" }, ` ${prefixLabel} `),
          )
        : null,
  );
}

/** 提示在输入框里只显示第一行，后面还有时加 … */
const hintLine = (hint: string) => {
  const [first, ...rest] = hint.split("\n");
  return `${first}${rest.length ? " …" : ""}`;
};

/** @ 补全最多显示几项 */
const MENTION_ROWS = 8;
/** 粘贴超过这么多行或这么多字符时，输入框里只放一个占位符 */
const FOLD_PASTE_LINES = 10;
const FOLD_PASTE_CHARS = 2000;
const PASTED = /\[Pasted text #\d+ (?:\+\d+ lines|\d+ chars)\]/g;

/** 长列表只显示 size 项时，为了让第 selected 项在中间附近，从第几项开始显示 */
function around(selected: number, total: number, size: number): number {
  return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

/** 用户上一次在输入框里打字的时间；发送之后清零 */
let typedAt = 0;
/** 打字停下这么久之后，对话框才把回车和字符当成回答 */
const TYPING_GRACE = 500;

/**
 * 对话框弹出时用户正在输入框里打字（例如在排下一条消息时弹出审批）：接着打出来的回车、数字不能当成回答。
 * 返回 true 表示这个键要丢掉。方向键、Esc 说明用户已经看到对话框了，不再拦
 */
function typedThrough(input: string, key: Key): boolean {
  if (Date.now() - typedAt >= TYPING_GRACE) return false;
  if (key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown || (key.ctrl && input === "c") || MOUSE.test(input)) {
    typedAt = 0;
    return false;
  }
  typedAt = Date.now();
  return true;
}

/** 选择框一次最多显示几项 */
const VISIBLE = 10;
/** 选项多于这么多时可以打字筛选（这时 j/k 和数字键不再是快捷键） */
const FILTER_FROM = 10;

function SelectDialog({
  dialog,
}: {
  dialog: Extract<Dialog, { kind: "select" }>;
}) {
  const selection = useContext(SelectionContext);
  const [getSelected, setSelected] = useLive(0);
  const [getQuery, setQuery] = useLive("");
  /** 预览从第几行开始显示，以及它能翻到哪里、一页几行（放得下时 maxTop 是 0） */
  const [getTop, setTop] = useLive(0);
  const scrolling = useRef({ maxTop: 0, page: 1 });
  const { rows, columns } = useScreenSize();
  const filtering = dialog.choices.length > FILTER_FROM;
  const query = getQuery();
  /** 筛选后的选项和它们原来的序号 */
  const filtered = () => {
    const q = getQuery().toLowerCase();
    return dialog.choices
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !q || `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q));
  };
  const items = filtered();
  const n = items.length;
  const selected = Math.min(getSelected(), Math.max(0, n - 1));
  // 终端矮时少显示几项，加上预览一起不超过终端的高度
  const visible = roomFor(rows, VISIBLE);
  // 预览（例如要写入的文件）过长时截断：整个界面高过终端时 Ink 会每帧清屏重画，底部的选项和提示也会被裁掉。
  // 按折行后的屏幕行数截断（一行长代码会占好几行），每一行单独显示、不再折行
  const lines = !dialog.body ? [] : wrap(dialog.body, Math.max(1, columns - 4)).map(visibleRow);
  const room = Math.max(3, rows - Math.min(n, visible) - 16);
  // 放不下时 PgUp/PgDn 翻看预览（批准之前要能看完整个 diff），最后一行说明还有多少
  const page = room - 1;
  const maxTop = Math.max(0, lines.length - page);
  const top = Math.min(getTop(), maxTop);
  scrolling.current = { maxTop, page };
  const body =
    lines.length > room
      ? [
          ...lines.slice(top, top + page),
          dim(
            top < maxTop
              ? `… ${lines.length - top - page} more lines · PgDn/PgUp to scroll`
              : `end of ${lines.length} lines · PgUp to scroll back`,
          ),
        ]
      : lines;
  useInput((input, key) => {
    if (key.ctrl && input === "c" && selection.active()) return selection.clear();
    if (typedThrough(input, key)) return;
    const items = filtered();
    const n = items.length;
    const selected = Math.min(getSelected(), Math.max(0, n - 1));
    if (key.upArrow || (!filtering && input === "k"))
      return n && setSelected((selected - 1 + n) % n);
    if (key.downArrow || (!filtering && input === "j"))
      return n && setSelected((selected + 1) % n);
    if (key.return) {
      if (n) dialog.resolve(items[selected]!.c.value);
      return;
    }
    if (key.escape && filtering && getQuery()) {
      setQuery("");
      return setSelected(0);
    }
    if (key.escape || (key.ctrl && input === "c"))
      return dialog.resolve(undefined);
    // 预览放不下时翻预览，否则翻选项
    const { maxTop, page } = scrolling.current;
    if (maxTop > 0 && (key.pageDown || key.pageUp)) {
      return setTop(Math.max(0, Math.min(maxTop, Math.min(getTop(), maxTop) + (key.pageDown ? page : -page))));
    }
    if (key.pageDown) return setSelected(Math.min(n - 1, selected + visible));
    if (key.pageUp) return setSelected(Math.max(0, selected - visible));
    if (filtering) {
      if (key.backspace || key.delete) {
        setQuery([...getQuery()].slice(0, -1).join(""));
        return setSelected(0);
      }
      if (key.ctrl || key.meta || key.tab || MOUSE.test(input)) return;
      const text = input.replace(/[\x00-\x1f\x7f]/g, "");
      if (text) {
        setQuery(getQuery() + text);
        setSelected(0);
      }
      return;
    }
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= Math.min(n, 9))
      dialog.resolve(items[digit - 1]!.c.value);
  });
  // 选项多时只显示选中项附近的一段
  const start = around(selected, n, visible);
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, marginTop: 1 },
    h(Text, { bold: true, wrap: "truncate-end" }, dialog.title),
    body.map((l, i) => h(Text, { key: i, wrap: "truncate-end" }, l || " ")),
    filtering
      ? h(
          Text,
          { wrap: "truncate-end" },
          h(Text, { color: "cyan" }, "filter› "),
          query ? h(Text, null, query) : h(Text, { dimColor: true }, `type to filter ${dialog.choices.length} items`),
        )
      : null,
    h(
      Box,
      { flexDirection: "column", marginTop: filtering ? 0 : 1 },
      start > 0 ? h(Text, { dimColor: true }, ` ↑ ${start} more`) : null,
      n === 0 ? h(Text, { dimColor: true }, " no match") : null,
      items.slice(start, start + visible).map(({ c, i }, j) => {
        const on = start + j === selected;
        return h(
          Text,
          { key: i, wrap: "truncate-end" },
          h(Text, { color: on ? "cyan" : undefined, bold: on }, on ? "❯ " : "  ", filtering ? "" : `${i + 1}. `, c.label),
          c.hint ? h(Text, { dimColor: true }, ` ${c.hint}`) : null,
        );
      }),
      start + visible < n ? h(Text, { dimColor: true }, ` ↓ ${n - start - visible} more`) : null,
    ),
    h(Hint, {
      width: Math.max(10, columns - 4),
      variants: filtering
        ? ["↑↓ select · type to filter · enter confirm · esc clear/cancel", "↑↓ · enter · esc"]
        : ["↑↓ select · enter confirm · esc cancel", "↑↓ · enter · esc"],
    }),
  );
}

function InputDialog({
  dialog,
}: {
  dialog: Extract<Dialog, { kind: "input" }>;
}) {
  const selection = useContext(SelectionContext);
  const initial = dialog.initial ?? "";
  const [current, setState] = useLive<EditState>({
    value: initial,
    cursor: initial.length,
  });
  const state = current();
  const { columns } = useScreenSize();
  usePaste((text) =>
    setState(edit.insert(current(), text.replace(/\r?\n/g, ""))),
  );
  useInput((input, key) => {
    if (key.ctrl && input === "c" && selection.active()) return selection.clear();
    if (typedThrough(input, key)) return;
    const state = current();
    if (key.return) return dialog.resolve(state.value.trim());
    if (key.escape || (key.ctrl && input === "c"))
      return dialog.resolve(undefined);
    const next = editKey(state, input, key);
    if (next) setState(next);
  });
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, marginTop: 1 },
    h(Text, { bold: true }, dialog.title),
    h(EditableText, {
      state,
      width: Math.max(10, columns - 6),
      prefix: "› ",
      mask: dialog.mask,
      placeholder: dialog.placeholder,
      active: true,
    }),
    h(Text, { dimColor: true }, "enter confirm · esc cancel"),
  );
}
