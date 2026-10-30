// 宿主的输出与交互接口。两种实现：
// - 终端界面（tui.tsx）：全屏，标题在顶部，对话在中间自己滚动，输入框、状态栏固定在底部，运行中也能输入
// - 纯文本（这里）：-p 和非交互运行时使用，逐行输出，提问用 readline

import { createInterface, type Interface } from "node:readline/promises";

export interface Choice<T> {
  label: string;
  value: T;
  /** 选项后面的灰色说明 */
  hint?: string;
}

export interface StatusInfo {
  cwd: string;
  branch?: string;
  model: string;
  mode: string;
  session?: string;
  /** 上一次请求的上下文用量，limit 是模型的上下文窗口 */
  context?: { used: number; limit: number };
  /** 上一次请求的输入中命中缓存的比例（0–1）；服务不报告缓存用量时为 undefined */
  cache?: number;
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
   * details：折叠起来的完整内容，终端界面里点击 text 展开；纯文本输出不显示
   */
  log(text: string, opts?: { details?: string }): void;
  /** 流式输出模型的正文或思考 */
  stream(kind: "text" | "thinking", text: string): void;
  /** 结束当前的流式块 */
  endStream(): void;
  /** 正在进行的活动；undefined 表示空闲 */
  busy(label: string | undefined): void;
  status(info: Partial<StatusInfo>): void;
  /** 排队等待发送的输入 */
  queued(items: string[]): void;
  /** 让用户从几项里选一项；取消时返回 undefined */
  select<T>(title: string, choices: Choice<T>[], opts?: { body?: string }): Promise<T | undefined>;
  /** 让用户输入一行；取消时返回 undefined */
  input(title: string, opts?: { initial?: string; mask?: boolean; placeholder?: string }): Promise<string | undefined>;
  /** 清空已经显示的对话（开始新会话时） */
  clear(): void;
  close(): Promise<void>;
}

// ---------- 颜色 ----------

const colors = Boolean(process.stdout.isTTY);
const paint = (code: string) => (s: string) => (colors ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");
export const bold = paint("1");

// ---------- 纯文本实现 ----------

export function plainScreen(opts: { interactive: boolean }): Screen {
  let atLineStart = true;
  let streaming: "text" | "thinking" | undefined;
  let rl: Interface | undefined;

  const write = (s: string) => {
    if (!s) return;
    process.stdout.write(s);
    atLineStart = s.endsWith("\n");
  };
  const line = (s: string) => {
    if (!atLineStart) write("\n");
    write(s + "\n");
  };
  const ask = async (q: string) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    return (await rl.question(q)).trim();
  };

  return {
    interactive: opts.interactive,
    log: (text) => {
      streaming = undefined;
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
      const n = Number(await ask(`Choose 1-${choices.length} (empty to cancel): `));
      return Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1]!.value : undefined;
    },
    async input(title, o) {
      if (!opts.interactive) return undefined;
      return (await ask(`${title}${o?.initial ? ` [${o.initial}]` : ""}: `)) || o?.initial || "";
    },
    clear: () => {},
    async close() {
      rl?.close();
    },
  };
}
