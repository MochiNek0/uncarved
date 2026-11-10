// 宿主的输出与交互接口。两种实现：
// - 终端界面（tui.tsx）：全屏，标题在顶部，对话在中间自己滚动，输入框、状态栏固定在底部，运行中也能输入
// - 纯文本（这里）：-p 和非交互运行时使用，逐行输出，提问用 readline

import { createInterface, type Interface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";

export interface Choice<T> {
  label: string;
  value: T;
  /** 选项后面的灰色说明 */
  hint?: string;
}

export interface StatusInfo {
  /** 插件用 ctx.status 设置的段落（已经是一行、截断过） */
  plugins?: { plugin: string; text: string }[];
  cwd: string;
  branch?: string;
  model: string;
  mode: string;
  session?: string;
  /** 上一次请求的上下文用量，limit 是模型的上下文窗口 */
  context?: { used: number; limit: number; /** 超过这个 token 数会自动压缩 */ compactAt?: number };
  /** 本会话累计的用量（含子 Agent 和压缩） */
  spent?: { input: number; output: number };
  /** 上一次请求的输入中命中缓存的比例（0–1）；服务不报告缓存用量时为 undefined */
  cache?: number;
  /** 输出速度（token/秒）：live 为 true 时是正在输出的这次回复按字数估的，否则是上一次回复按服务端报的用量算的 */
  speed?: { tps: number; live?: boolean };
}

export interface CommandInfo {
  name: string;
  args?: string;
  about: string;
}

export interface Screen {
  /** 能向用户提问；为 false 时 select / input 直接返回 undefined */
  readonly interactive: boolean;
  /**
   * 追加已经完成的输出，可以带 ANSI 颜色。
   * details：折叠起来的完整内容，终端界面里点击 text 展开；纯文本输出不显示。
   * id：之后用 amend 给这一项补充内容（工具调用的结果）；终端界面里这一项收起时只占一行
   */
  log(text: string, opts?: { details?: string; id?: string }): void;
  /**
   * 给之前用 id 记下的一项补充内容：终端界面里接在那一项后面合成一项（details 替换原来的），
   * 纯文本输出另起一行缩进显示。找不到那一项时也是另起一行
   */
  amend(id: string, text: string, opts?: { details?: string }): void;
  /**
   * 正在运行的工具 id 的一行进度（已经排好版）；undefined 表示工具结束了。
   * 终端界面只在对话最后显示每个工具最新的一行，结束时去掉；纯文本输出逐行打印。
   * output 表示是工具自己的输出，纯文本输出里每个工具最多打印 20 行
   */
  progress(id: string, line: string | undefined, opts?: { output?: boolean }): void;
  /** 流式输出模型的正文或思考 */
  stream(kind: "text" | "thinking", text: string): void;
  /** 结束当前的流式块 */
  endStream(): void;
  /** 正在进行的活动；undefined 表示空闲 */
  busy(label: string | undefined): void;
  status(info: Partial<StatusInfo>): void;
  /** 排队等待发送的输入 */
  queued(items: string[]): void;
  /** 让用户从几项里选一项；取消时返回 undefined。signal 中止时关掉对话框，也返回 undefined */
  select<T>(title: string, choices: Choice<T>[], opts?: { body?: string; signal?: AbortSignal }): Promise<T | undefined>;
  /** 让用户输入一行；取消时返回 undefined。signal 同 select */
  input(title: string, opts?: { initial?: string; mask?: boolean; placeholder?: string; signal?: AbortSignal }): Promise<string | undefined>;
  /** 输入框里还没提交的文字和灰色提示（插件的 ctx.input 用）；只有终端界面有 */
  readonly draft?: { text(): string; insert(text: string): void; set(text: string): void; hint(text: string | undefined): void };
  /** 把文字放进系统剪贴板（OSC 52）；只有终端界面有 */
  copy?(text: string): void;
  /** 把终端让出来执行 fn（例如启动 $EDITOR），结束后重新接管、重画界面；只有终端界面有 */
  suspend?<T>(fn: () => T | Promise<T>): Promise<T>;
  /** 清空已经显示的对话（开始新会话时） */
  clear(): void;
  close(): Promise<void>;
}

// ---------- 颜色 ----------

// 设了 NO_COLOR（非空）时不输出颜色，见 https://no-color.org
const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
/**
 * 每种样式用自己的关闭码，不用 \x1b[0m 全部重置：粗体里套着行内代码、链接时，后面的文字仍是粗体。
 * 里面出现同一个关闭码（例如 dim 里套 bold，两者都用 22 关闭）时紧接着重新打开外层的样式
 */
const paint = (open: string, close: string) => (s: string) =>
  colors ? `\x1b[${open}m${s.replaceAll(`\x1b[${close}m`, `\x1b[${close}m\x1b[${open}m`)}\x1b[${close}m` : s;
export const dim = paint("2", "22");
export const red = paint("31", "39");
export const green = paint("32", "39");
export const yellow = paint("33", "39");
export const cyan = paint("36", "39");
export const bold = paint("1", "22");
export const italic = paint("3", "23");
export const underline = paint("4", "24");
export const strike = paint("9", "29");

// ---------- 过滤控制字符 ----------

/** 转义序列（CSI、OSC、DCS 这类字符串、其余 ESC 开头的）和换行、制表符之外的控制字符（含 C1） */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P^_X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]P^_X]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const SGR = /^\x1b\[[0-9;:]*m$/;
/** 文字末尾还没写完的转义序列：单独的 ESC、没有结束字节的 CSI、没有结束符的 OSC/DCS 这类字符串 */
const UNFINISHED = /\x1b(?:\[[0-?]*[ -/]*|[\]P^_X][^\x07\x1b]*)?$/;
/** 最多为一个没写完的序列留这么多字符 */
const MAX_HELD = 256;

/**
 * 去掉可能搅乱终端的东西，只留颜色（SGR）、换行和制表符：插件、工具输出和模型的文字里可能有移动光标、清屏、
 * 改窗口标题、写剪贴板之类的序列。单独的 \r（进度条）按终端的效果处理：每行只留最后一段
 */
export function terminalSafe(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  return lines
    .map((l) => (l.includes("\r") ? (l.split("\r").filter(Boolean).at(-1) ?? "") : l).replace(CONTROL, (m) => (SGR.test(m) ? m : "")))
    .join("\n");
}

/** 让显示到屏幕上的每一段文字都经过 terminalSafe */
export function safeScreen(screen: Screen): Screen {
  const s = terminalSafe;
  const opt = (v: string | undefined) => (v === undefined ? undefined : s(v));
  const lf = (t: string) => t.replace(/\r\n?/g, "\n");
  const plain = (t: string) => stripVTControlCharacters(s(t));
  /** 流式文字末尾还没写完的转义序列，等下一段 */
  let held: { kind: "text" | "thinking"; text: string } | undefined;
  return {
    interactive: screen.interactive,
    log: (text, o) => screen.log(s(text), o && { ...o, details: opt(o.details) }),
    amend: (id, text, o) => screen.amend(id, s(text), o && { ...o, details: opt(o.details) }),
    progress: (id, line, o) => screen.progress(id, opt(line), o),
    stream: (kind, text) => {
      // 上一段末尾没完的转义序列接到这一段前面再过滤，不然它被拆成两半，后一半当成文字显示出来
      if (held && held.kind !== kind) held = undefined;
      const whole = (held?.text ?? "") + text;
      // 很长还没结束的（OSC 之类的字符串一直不给结束符）不再等，按现在的样子过滤
      const found = whole.search(UNFINISHED);
      const cut = found >= 0 && whole.length - found <= MAX_HELD ? found : -1;
      held = cut >= 0 ? { kind, text: whole.slice(cut) } : undefined;
      const shown = s(cut >= 0 ? whole.slice(0, cut) : whole);
      if (shown) screen.stream(kind, shown);
    },
    endStream: () => {
      // 到结束都没写完的序列不完整，丢掉
      held = undefined;
      screen.endStream();
    },
    busy: (label) => screen.busy(opt(label)),
    status: (info) => {
      const out: Partial<StatusInfo> = { ...info };
      for (const k of ["cwd", "branch", "model", "mode", "session"] as const) if (typeof info[k] === "string") out[k] = s(info[k]);
      if (info.plugins) out.plugins = info.plugins.map((p) => ({ plugin: p.plugin, text: s(p.text) }));
      screen.status(out);
    },
    queued: (items) => screen.queued(items.map(s)),
    select: (title, choices, o) =>
      screen.select(
        s(title),
        choices.map((c) => ({ ...c, label: s(c.label), hint: opt(c.hint) })),
        o && { ...o, body: opt(o.body) },
      ),
    input: (title, o) => screen.input(s(title), o && { ...o, initial: opt(o.initial), placeholder: opt(o.placeholder) }),
    // 输入框里的 \r 是换行（旧 Mac 的换行符），不是进度条：先换成 \n，terminalSafe 才不会只留最后一段。
    // 输入框里是要发给模型的纯文字，颜色也去掉
    draft: screen.draft && {
      text: () => screen.draft!.text(),
      insert: (t) => screen.draft!.insert(plain(lf(t))),
      set: (t) => screen.draft!.set(plain(lf(t))),
      hint: (t) => screen.draft!.hint(t === undefined ? undefined : plain(lf(t))),
    },
    ...(screen.copy ? { copy: (t: string) => screen.copy!(t) } : {}),
    ...(screen.suspend ? { suspend: <T>(fn: () => T | Promise<T>) => screen.suspend!(fn) } : {}),
    clear: () => screen.clear(),
    close: () => screen.close(),
  };
}

// ---------- 纯文本实现 ----------

const MAX_OUTPUT_LINES = 20;

export function plainScreen(opts: { interactive: boolean }): Screen {
  let atLineStart = true;
  let streaming: "text" | "thinking" | undefined;
  let rl: Interface | undefined;
  /** 每个工具已经打印了多少行输出 */
  const outputLines = new Map<string, number>();

  const write = (s: string) => {
    if (!s) return;
    process.stdout.write(s);
    atLineStart = s.endsWith("\n");
  };
  const line = (s: string) => {
    if (!atLineStart) write("\n");
    write(s + "\n");
  };
  /** 中止时返回 undefined */
  const ask = async (q: string, signal?: AbortSignal) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
      return (await rl.question(q, { signal })).trim();
    } catch (err) {
      if (!signal?.aborted) throw err;
      write("\n");
      return undefined;
    }
  };

  return {
    interactive: opts.interactive,
    log: (text) => {
      streaming = undefined;
      line(text);
    },
    amend: (_id, text) => {
      streaming = undefined;
      line(`  ${text}`);
    },
    progress: (id, text, o) => {
      if (text === undefined) return void outputLines.delete(id);
      streaming = undefined;
      if (o?.output) {
        const shown = outputLines.get(id) ?? 0;
        if (shown > MAX_OUTPUT_LINES) return;
        outputLines.set(id, shown + 1);
        if (shown === MAX_OUTPUT_LINES) return line(dim("  │ …"));
      }
      line(text);
    },
    stream: (kind, text) => {
      if (kind !== streaming) {
        // 不少模型的正文以空行开头；整块都是换行时等下一块
        if (kind === "text") text = text.replace(/^\n+/, "");
        if (!text) return;
        if (kind === "thinking") line(dim("thinking…"));
        else if (!atLineStart) write("\n");
        streaming = kind;
      }
      write(kind === "thinking" ? dim(text) : text);
    },
    endStream: () => {
      streaming = undefined;
      if (!atLineStart) write("\n");
    },
    busy: () => {},
    status: () => {},
    queued: () => {},
    async select(title, choices, o) {
      if (!opts.interactive) return undefined;
      line(yellow(title));
      if (o?.body) line(o.body);
      choices.forEach((c, i) => line(`  ${i + 1}. ${c.label}${c.hint ? dim(`  ${c.hint}`) : ""}`));
      if (o?.signal?.aborted) return undefined;
      const n = Number(await ask(`Choose 1-${choices.length} (empty to cancel): `, o?.signal));
      return Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1]!.value : undefined;
    },
    async input(title, o) {
      if (!opts.interactive) return undefined;
      if (o?.signal?.aborted) return undefined;
      const answer = await ask(`${title}${o?.initial ? ` [${o.initial}]` : ""}: `, o?.signal);
      return answer === undefined ? undefined : answer || o?.initial || "";
    },
    clear: () => {},
    async close() {
      rl?.close();
    },
  };
}
