// 会话级的插件作用域（SessionScope）：一套插件实例，加上绑定到这套实例的 ctx.status、ctx.input、ctx.send、ctx.signal。
//
//   preparing ──activate──▶ active ──close──▶ closing ──dispose──▶ closed
//       └──────────────────close──────────────────┘
//
// 换会话是一个事务：先在 preparing 里创建新的一套（工厂函数这时运行），成功了才关闭旧的、激活新的；
// 失败了只关闭新的，旧的一直是 active，不用恢复任何东西。见 docs/design/jade-plugin-lifecycle.md 第 3.2、5 节。

import type { Jade } from "./distro.ts";

export type ScopeState = "preparing" | "active" | "closing" | "closed";

/** 宿主的界面：作用域经它显示状态栏、改输入框、替用户发送、提示问题 */
export interface ScopeHost {
  /** 换掉状态栏上插件的段落（按插件的 id） */
  showStatus(segments: { plugin: string; text: string }[]): void;
  /** 终端界面的输入框；-p 时没有 */
  input?: { text(): string; insert(text: string): void; set(text: string): void; hint(text: string | undefined): void };
  /** 替用户提交一行；-p 时没有 */
  send?(plugin: string, text: string): void;
  warn(text: string): void;
  /** 状态栏一段的整理（去掉控制字符、截断）；返回空字符串表示去掉 */
  tidy?(text: string): string;
}

export class SessionScope {
  #state: ScopeState = "preparing";
  readonly #host: ScopeHost;
  readonly #abort = new AbortController();
  /** 插件设置的状态栏段落；preparing 时先存着，activate 时显示 */
  readonly #status = new Map<string, string>();
  /** 已经提示过过期调用的插件，每个只提示一次 */
  readonly #warned = new Set<string>();
  #jade: Jade | undefined;
  #disposing: Promise<string[]> | undefined;

  constructor(host: ScopeHost) {
    this.#host = host;
  }

  get state(): ScopeState {
    return this.#state;
  }

  /** 关闭时中止：交给插件的 ctx.signal、快捷键的 signal 都是它 */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** 这个作用域的插件实例；attach 之前不能用 */
  get jade(): Jade {
    if (!this.#jade) throw new Error("the session scope has no plugins yet");
    return this.#jade;
  }

  /** 交给 createJade 的回调：插件的 ctx 都经过这里，按作用域的状态决定是否生效 */
  get hooks() {
    const host = this.#host;
    return {
      signal: this.signal,
      onStatus: (plugin: string, text: string | undefined) => this.#setStatus(plugin, text),
      input: host.input && {
        text: (plugin?: string) => (this.#live(plugin, "ctx.input") ? host.input!.text() : ""),
        insert: (text: string, plugin?: string) => void (this.#live(plugin, "ctx.input") && host.input!.insert(String(text))),
        set: (text: string, plugin?: string) => void (this.#live(plugin, "ctx.input") && host.input!.set(String(text))),
        hint: (text: string | undefined, plugin?: string) => void (this.#live(plugin, "ctx.input") && host.input!.hint(text === undefined ? undefined : String(text))),
      },
      send: host.send && ((plugin: string, text: string) => void (this.#live(plugin, "ctx.send") && host.send!(plugin, text))),
    };
  }

  /** 创建好插件实例后挂上 */
  attach(jade: Jade): void {
    this.#jade = jade;
  }

  /** preparing → active：显示插件在准备期间设置的状态 */
  activate(): void {
    if (this.#state !== "preparing") throw new Error(`cannot activate the session scope: it is ${this.#state}`);
    this.#state = "active";
    this.#show();
  }

  /**
   * → closing：中止 signal（进行中的快捷键等随之中止），之后 ctx.status、ctx.input、ctx.send 不再生效；
   * dispose 完成（closed）之后还调用的才提示，那是插件忘了在 dispose 里停掉的定时器、监听。
   * 不清状态栏：接着激活的作用域会换掉它；回滚时没激活过，也就没显示过
   */
  close(reason: string): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#state = "closing";
    this.#abort.abort(new Error(reason));
  }

  /** 调用插件的 dispose（见 Jade.dispose），→ closed。先 close；只执行一次，返回要告诉用户的问题 */
  dispose(): Promise<string[]> {
    this.close("the session ended");
    return (this.#disposing ??= (this.#jade ? this.#jade.dispose() : Promise.resolve([])).then((warnings) => {
      this.#state = "closed";
      return warnings;
    }));
  }

  #setStatus(plugin: string, text: string | undefined) {
    const line = text === undefined ? "" : (this.#host.tidy ?? ((t: string) => t.trim()))(String(text));
    if (this.#state === "closing" || this.#state === "closed") {
      // closing 时插件还没轮到 dispose（会话收尾还在进行），定时器再触发一次是正常的；dispose 里去掉自己的段落也正常
      if (line && this.#state === "closed") this.#stale(plugin, "ctx.status", "after its session ended");
      return;
    }
    if (line) this.#status.set(plugin, line);
    else this.#status.delete(plugin);
    if (this.#state === "active") this.#show();
  }

  #show() {
    this.#host.showStatus([...this.#status].map(([plugin, text]) => ({ plugin, text })));
  }

  /** 是否 active。preparing 和 closed 时提示一次；closing 时插件还没轮到 dispose，不提示 */
  #live(plugin: string | undefined, what: string): boolean {
    if (this.#state === "active") return true;
    if (this.#state === "preparing") this.#stale(plugin, what, "before its session started");
    else if (this.#state === "closed") this.#stale(plugin, what, "after its session ended");
    return false;
  }

  #stale(plugin: string | undefined, what: string, when: string) {
    const key = plugin ?? "";
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    const who = plugin ? `plugin ${plugin}` : "a plugin";
    const fix = when.startsWith("after") ? "; stop timers and listeners in dispose, or when ctx.signal aborts" : "";
    this.#host.warn(`${who} used ${what} ${when}, so it was ignored${fix}`);
  }
}
