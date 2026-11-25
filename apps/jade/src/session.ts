// 会话：uncarved Runtime 的创建、恢复、切换（4.2），会话级作用域，afterTurn / send（4.3），兜底关卡（第 7 节）。

import path from "node:path";
import { JsonlLogStore } from "@uncarved/store-jsonl";
import {
  checkCompat,
  readAll,
  definePlugin as kernelPlugin,
  InvalidTransition,
  Runtime,
  type GateResult,
  type Layer,
  type LocalHookSpec,
  type LogEvent,
  type LogStore,
  type Plugin,
  type Provider,
  type RemoteHookSpec,
  type RuntimeNotice,
  type SessionRef,
  type State,
  type Tool,
  type UserInput,
} from "uncarved";
import {
  API_VERSION,
  PluginError,
  ServiceUnavailable,
  StaleContext,
  type OpenOptions,
  type PluginModule,
  type PluginSource,
  type Secrets,
  type ChildSession,
  type Session,
  type SessionContext,
  type SessionManager,
  type StartedSession,
  type SessionTool,
  type SessionUI,
  type SpawnOptions,
  type StatusSegment,
  type Text,
  type ToolMeta,
  type UI,
} from "./api.ts";
import { ambient, invoke, Scope, type Owner } from "./membrane.ts";
import { scopedSecrets } from "./secrets.ts";

/** 核心自己交给内核的插件：兜底关卡 */
export const CORE_PLUGIN_ID = "jade/core";

/** 兜底关卡拒绝时给模型看的话 */
export const NO_APPROVAL_REASON =
  "No permission plugin is active in this session, so only read-only tools may run. Ask the user to enable an approval plugin.";

/** 有插件要人工审批、但没有审批插件来问时，这一轮结束的原因 */
export const NO_APPROVER_ERROR = "A plugin asked for the user's approval, but no approval plugin is active in this session to ask.";

/** 会话管理器向宿主要的东西 */
export interface SessionHost {
  home: string;
  cwd: string;
  config(source: PluginSource): Readonly<Record<string, unknown>>;
  /** 当前激活的插件，按激活顺序 */
  active(): { source: PluginSource; module: PluginModule; owner: Owner; mark?: (p: Plugin) => Plugin }[];
  /** 以 owner 的身份取服务；核心自己取时 owner 是核心 */
  service<T extends object>(name: string, caller: Owner): T | undefined;
  /** 服务的提供者 id */
  provider(name: string): string | undefined;
  /** 核心自己的配置：用户 config.json 里的 "jade/core"（项目层的配置不能放宽这些上限） */
  coreConfig(): Readonly<Record<string, unknown>>;
  /** 一个插件的密钥（第 8 节）；会话 ctx 和进程 ctx 共享同一份 */
  secrets(plugin: string): Secrets;
  core: Owner;
  /** 插件的会话作用域：宿主隔离插件时一并关闭 */
  track(plugin: string, scope: Scope): void;
  untrack(plugin: string, scope: Scope): void;
  fault(plugin: string, reason: string): void;
  report(message: string): void;
}

const KERNEL_LAYER: Record<PluginSource["layer"], Layer> = { bundled: "distro", user: "user", project: "project" };

interface Part {
  source: PluginSource;
  owner: Owner;
  gates: number;
  /** 现在的工具（已包装成以插件身份执行）。session() 返回之后注册、撤销的也改在这里，下一项工作开始前重挂 Runtime 生效 */
  tools: Tool[];
  /** 按现在的工具表生成交给内核的插件。插件被隔离后不再交出工具；id、版本不变，所以重挂不算插件变化 */
  kernel(): Plugin;
}

/** 子会话：谁开的、开它时要的东西（SpawnOptions） */
interface Child {
  session: LiveSession;
  ref: SessionRef;
  /** 开它的插件 */
  by: string;
  label?: string;
  tools?: (t: SessionTool) => boolean;
  system?: string;
}

/** 核心放在子会话系统提示词最前面的委派说明（设计稿 live-tools-and-child-sessions 7.3） */
export const DELEGATION =
  "You are a sub-agent: another agent delegated a task to you. You cannot see its conversation, so the task you are given is all you know about it. " +
  "Nobody reads your intermediate messages; when you are done, reply with a self-contained report of what you did and found, including anything you could not do.";

/** 子会话的层数、同时数量的默认上限（7.2） */
export const DEFAULT_MAX_DEPTH = 1;
export const DEFAULT_MAX_ACTIVE = 8;

interface Turn {
  stop?: { reason: unknown };
  wake?: () => void;
}

class LiveSession implements Session {
  readonly id: string;
  readonly parts: Part[] = [];
  rt!: Runtime;
  /** 排队的工作：一条输入，或者恢复（recover）。一次只跑一项，Runtime 同一时间只接受一个调用 */
  #queue: { run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void }[] = [];
  #after: { fn: () => void | Promise<void>; owner: Owner }[] = [];
  #pump: Promise<void> | undefined;
  /** 离开时的原因；有了以后不再接受输入 */
  #left: Error | undefined;
  #report: (m: string) => void;
  /** 正在跑的这一轮（包括停下来等人工审批的时候）：stop 是要它结束的原因，wake 叫醒等审批的循环 */
  #turn: Turn | undefined;
  /** 交进来、还没交给内核的审批回答 */
  #answers: { input: UserInput; resolve: () => void; reject: (e: unknown) => void }[] = [];
  /** 审批插件是不是守着这个会话（第 7 节）：不是的话没有人会回答审批 */
  #attended: () => boolean;
  /** 插件订阅的运行时通知（ctx.session.subscribe） */
  #watchers = new Set<{ fn: (n: RuntimeNotice) => void; owner: Owner }>();
  /** 前端和核心订阅的运行时通知（Session.subscribe）。由会话自己持有、从当前的 Runtime 转发，重挂时不丢 */
  #listeners = new Set<(n: RuntimeNotice) => void>();
  #unsubscribe: (() => void) | undefined;
  /** Runtime 建好了（attach 之后）：session() 里登记的 afterTurn 等到这时才执行，那时 state() 才有 */
  #attached = false;
  /** 工具表变了，下一项工作开始前要重挂 Runtime */
  #stale = false;
  /** 重挂时旧实例已经 detach、新实例没建成：下次重挂不再 detach，离开时也不用 */
  #loose = false;
  #provider!: Provider;
  #plugins!: () => Plugin[];

  readonly #store: LogStore;
  /** 子会话的信息；顶层会话没有 */
  readonly child: Child | undefined;
  /** 第几层：顶层会话是 0 */
  depth = 0;
  /** 本会话开的、还没结束的子会话 */
  readonly children = new Set<LiveSession>();
  /** 子会话结束（Sessions.#end）的结果；结束时调用 onEnd（让出同时数量的名额） */
  ended: Promise<{ sessionId: string; seq: number }> | undefined;
  onEnd: (() => void) | undefined;

  constructor(id: string, store: LogStore, report: (m: string) => void, attended: () => boolean, child?: Child) {
    this.id = id;
    this.#store = store;
    this.#report = report;
    this.#attended = attended;
    this.child = child;
    if (child) this.depth = child.session.depth + 1;
  }

  get store(): LogStore {
    return this.#store;
  }

  get provider(): Provider {
    return this.#provider;
  }

  get left(): boolean {
    return this.#left !== undefined;
  }

  /** 子会话只保留开它的插件要的工具（SpawnOptions.tools） */
  keeps(t: Tool): boolean {
    const keep = this.child?.tools;
    if (!keep) return true;
    try {
      return keep(sessionTool(t)) === true;
    } catch {
      return false;
    }
  }

  history(): Promise<LogEvent[]> {
    return readAll(this.#store, this.id);
  }

  tool(name: string): SessionTool | undefined {
    for (const p of this.parts) {
      if (p.owner.scope.closed) continue;
      const t = p.tools.find((x) => x.name === name);
      if (!t || !this.keeps(t)) continue;
      return sessionTool(t);
    }
    return undefined;
  }

  get state(): State {
    return this.rt.state;
  }

  send(input: UserInput): Promise<void> {
    // 对插件变化的确认不开始一轮（内核只记录结果）
    if (input.kind === "plugins") return this.#enqueue(() => this.rt.send(input));
    if (input.kind !== "approval") return this.#enqueue(() => this.#drive(() => this.rt.send(input)));
    // 审批的回答属于正在跑的这一轮，不排到它后面
    if (this.#left) return Promise.reject(this.#left);
    const turn = this.#turn;
    if (!turn) return Promise.reject(new Error(`session ${this.id}: no turn is waiting for approval`));
    return new Promise((resolve, reject) => {
      this.#answers.push({ input, resolve, reject });
      turn.wake?.();
    });
  }

  /**
   * 跑完一轮。内核停在等待人工审批（awaiting）时这一轮还没完：在这里等审批的回答交给内核，直到这一轮结束。
   * 等的时候被中止，或者没有审批插件来问，就结束这一轮（内核的 endTurn）
   */
  async #drive(start: () => Promise<void>): Promise<void> {
    const turn: Turn = {};
    this.#turn = turn;
    try {
      await start();
      while (this.rt.phase === "awaiting") {
        const stop = turn.stop ?? (this.#attended() ? undefined : { reason: new Error(NO_APPROVER_ERROR) });
        if (stop) {
          const reason = stop.reason ?? new Error("aborted");
          await this.rt.endTurn(reason);
          throw reason;
        }
        const next = this.#answers.shift();
        if (!next) {
          await new Promise<void>((wake) => (turn.wake = wake));
          turn.wake = undefined;
          continue;
        }
        try {
          await this.rt.send(next.input);
          next.resolve();
        } catch (e) {
          // 内核不认的回答（没有这个待批的调用）：只是这个回答作废，这一轮照常等
          if (e instanceof InvalidTransition && this.rt.phase === "awaiting") {
            next.reject(e);
            continue;
          }
          next.resolve();
          throw e;
        }
      }
    } finally {
      this.#turn = undefined;
      for (const a of this.#answers.splice(0)) a.reject(new Error(`session ${this.id}: the turn ended before this approval was used`));
    }
  }

  #enqueue(run: () => Promise<void>): Promise<void> {
    if (this.#left) return Promise.reject(this.#left);
    return new Promise((resolve, reject) => {
      this.#queue.push({ run, resolve, reject });
      // session() 执行期间（Runtime 还没建）排进来的等 attach 再开始
      if (this.#attached) this.#kick();
    });
  }

  afterTurn(fn: () => void | Promise<void>, owner: Owner): void {
    if (this.#left) return;
    this.#after.push({ fn, owner });
    if (this.#attached) this.#kick();
  }

  /** 离开会话：还没开始的输入全部拒绝、afterTurn 不再执行，再中止正在跑的一轮。之后的 send 直接拒绝 */
  leave(): void {
    this.#left ??= new Error(`session ${this.id} was closed before this input ran`);
    for (const job of this.#queue.splice(0)) job.reject(this.#left);
    this.#after.length = 0;
    this.abort(this.#left);
  }

  async idle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  /**
   * 和输入排同一个队：恢复可能要跑完一整轮，这期间插件发来的输入排在它后面，而不是撞上 RuntimeBusy。
   * 上次停在等待人工审批的（进程被杀、崩溃）：内核再发一次 awaiting 通知，审批插件据此重新问（ctx.session.subscribe），
   * 这一轮接着等回答；没有审批插件守着时和平时一样直接结束
   */
  recover(): Promise<void> {
    return this.#enqueue(() => this.#drive(() => this.rt.recover()));
  }

  /** 插件订阅运行时通知，返回取消订阅。Runtime 建好之前就可以订阅（session() 里） */
  watch(fn: (n: RuntimeNotice) => void, owner: Owner): () => void {
    const w = { fn, owner };
    this.#watchers.add(w);
    return () => void this.#watchers.delete(w);
  }

  /** Runtime 建好之后调用一次。provider、plugins 留着给重挂用：plugins 每次按现在的工具表生成内核插件 */
  attach(rt: Runtime, provider: Provider, plugins: () => Plugin[]): void {
    this.#provider = provider;
    this.#plugins = plugins;
    this.#use(rt);
    this.#attached = true;
    if (this.#queue.length > 0 || this.#after.length > 0) this.#kick();
  }

  /** 换上一个 Runtime：通知从它转给订阅者。插件的回调以插件身份执行；出错只报告 */
  #use(rt: Runtime): void {
    this.#unsubscribe?.();
    this.rt = rt;
    this.#unsubscribe = rt.subscribe((n) => {
      for (const fn of this.#listeners) {
        try {
          fn(n);
        } catch {
          // 和内核一样：订阅者的错误不影响运行
        }
      }
      for (const w of this.#watchers) {
        if (w.owner.scope.closed) continue;
        try {
          invoke(w.owner, "session.subscribe", () => w.fn(n));
        } catch (e) {
          this.#report(e instanceof Error ? e.message : String(e));
        }
      }
    });
  }

  /** 工具表变了（会话中途注册、撤销工具，插件被隔离）：下一项工作开始前重挂。几次改动合并成一次 */
  invalidate(): void {
    if (this.#attached && !this.#left) this.#stale = true;
  }

  /**
   * 重挂：detach 旧实例，按现在的工具表 resume 同一个会话（设计稿 live-tools-and-child-sessions 3.2）。
   * 只在两项工作之间执行，内核这时不在跑。插件清单（id、版本）不变，内核不写 plugins.changed。
   * 失败时这项工作失败，下一项工作再试
   */
  async #remount(): Promise<void> {
    this.#stale = false;
    if (this.rt.phase === "ended") return;
    try {
      if (!this.#loose) {
        await this.rt.detach();
        this.#loose = true;
      }
      const rt = await Runtime.resume({ store: this.#store, provider: this.#provider, plugins: this.#plugins(), sessionId: this.id });
      this.#loose = false;
      this.#use(rt);
    } catch (e) {
      this.#stale = true;
      throw new Error(`session ${this.id}: could not update its tools: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 结束会话（session.ended），子会话用完时。重挂到一半（旧实例已经 detach）时先恢复一个实例来写 */
  async close(): Promise<void> {
    if (this.#loose) {
      this.#use(await Runtime.resume({ store: this.#store, provider: this.#provider, plugins: this.#plugins(), sessionId: this.id }));
      this.#loose = false;
    }
    if (this.rt.phase !== "ended") await this.rt.close();
  }

  /** 宿主离开会话时 detach；重挂到一半（旧实例已经 detach）时不用再写 */
  async detach(): Promise<void> {
    if (!this.#loose) await this.rt.detach();
  }

  abort(reason?: unknown): void {
    // Runtime 还没建（session() 执行期间、打开失败时）：没有在跑的
    this.rt?.abort(reason);
    // 停在等待人工审批时内核没有在跑，信号结束不了这一轮
    if (this.#turn) {
      this.#turn.stop = { reason };
      this.#turn.wake?.();
    }
  }

  subscribe(fn: (n: RuntimeNotice) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  #kick(): void {
    this.#pump ??= this.#run().finally(() => {
      this.#pump = undefined;
      // #run 决定退出到这里之间排进来的输入：那时 #pump 还在，send 没有启动新的处理
      if (this.#queue.length > 0 || this.#after.length > 0) this.#kick();
    });
  }

  /** 一次处理一项排队的工作；每轮之后执行 afterTurn，它们可能又排进新的输入 */
  async #run(): Promise<void> {
    await null; // 让调用方先拿到 send 的 Promise
    for (;;) {
      const job = this.#queue.shift();
      if (job) {
        try {
          if (this.#stale) {
            await this.#remount();
            // 重挂期间离开了会话：中止落在旧实例上，这项工作不再开始
            if (this.#left) throw this.#left;
          }
          await job.run();
          job.resolve();
        } catch (e) {
          job.reject(e);
        }
      }
      if (this.#after.length > 0) await this.#runAfter();
      else if (!job) return;
    }
  }

  async #runAfter(): Promise<void> {
    const batch = this.#after.splice(0);
    for (const { fn, owner } of batch) {
      if (owner.scope.closed) continue;
      try {
        await invoke(owner, "afterTurn", fn);
      } catch (e) {
        this.#report(e instanceof Error ? e.message : String(e));
      }
    }
  }
}

export class Sessions implements SessionManager {
  readonly #host: SessionHost;
  #current: LiveSession | undefined;
  /** start 开的会话和交出去的句柄 */
  #started = new Map<LiveSession, StartedSession>();
  #store: LogStore | undefined;
  /** 换会话串行进行 */
  #switching: Promise<unknown> = Promise.resolve();
  /** 正在运行的子会话数，和等着开的 */
  #running = 0;
  #waiting: (() => void)[] = [];
  /** 子会话的对话框排成一队，一次一个（7.4） */
  #dialogs: Promise<unknown> = Promise.resolve();

  constructor(host: SessionHost) {
    this.#host = host;
  }

  get current(): Session | undefined {
    return this.#current;
  }

  /**
   * 新建或恢复一个会话，成功后它成为当前会话，旧会话离开（detach，仍可恢复）。
   * 是一个事务：任何一步失败，新会话的作用域全部撤销，旧会话不受影响（4.2）。
   * 单个插件的 session() 失败不算：这个插件不参加本会话，会话照常打开
   */
  open(opts: OpenOptions = {}): Promise<Session> {
    const run = this.#switching.then(() => this.#open(opts));
    this.#switching = run.catch(() => {});
    return run;
  }

  /** 当前会话离开（detach，仍可恢复）；start 开的会话一并离开 */
  async close(): Promise<void> {
    await this.#switching;
    const old = this.#current;
    this.#current = undefined;
    if (old) await this.#leave(old);
    for (const h of [...this.#started.values()]) await h.close();
  }

  /** 和当前会话并存的会话（无头前端同时跑多个会话）：不成为当前会话，各自 close */
  start(opts: OpenOptions = {}): Promise<StartedSession> {
    const run = this.#switching.then(() => this.#start(opts));
    this.#switching = run.catch(() => {});
    return run;
  }

  async #start(opts: OpenOptions): Promise<StartedSession> {
    // 同一个会话的日志不能同时挂两个 Runtime
    if (opts.resume !== undefined && (opts.resume === this.#current?.id || this.#isStarted(opts.resume))) {
      throw new Error(`session ${opts.resume} is already open`);
    }
    const s = await this.#build(opts);
    let closing: Promise<void> | undefined;
    const handle: StartedSession = {
      id: s.id,
      get state() {
        return s.state;
      },
      send: (input) => s.send(input),
      idle: () => s.idle(),
      recover: () => s.recover(),
      abort: (reason) => s.abort(reason),
      subscribe: (fn) => s.subscribe(fn),
      history: () => s.history(),
      tool: (name) => s.tool(name),
      close: () =>
        (closing ??= (async () => {
          this.#started.delete(s);
          await this.#leave(s);
        })()),
    };
    this.#started.set(s, handle);
    return handle;
  }

  #isStarted(id: string): boolean {
    return [...this.#started.keys()].some((s) => s.id === id);
  }

  async #open(opts: OpenOptions): Promise<Session> {
    // 同一个会话的日志不能同时挂两个 Runtime：start 开着的不能再成为当前会话
    if (opts.resume !== undefined && this.#isStarted(opts.resume)) throw new Error(`session ${opts.resume} is already open`);
    const s = await this.#build(opts);
    // 提交：新会话成为当前会话，然后旧会话离开
    const old = this.#current;
    this.#current = s;
    if (old) await this.#leave(old);
    return s;
  }

  /** 建好一个会话（全部插件加入、Runtime 建好）。任何一步失败，新会话的作用域全部撤销 */
  async #build(opts: OpenOptions): Promise<LiveSession> {
    const host = this.#host;
    const provider = host.service<Provider>("provider@1", host.core);
    if (!provider) throw new ServiceUnavailable("provider@1", "(none): no active plugin provides a model");
    const store = host.service<LogStore>("store@1", host.core) ?? (this.#store ??= new JsonlLogStore(path.join(host.home, "sessions")));

    if (opts.fork && opts.resume !== undefined) throw new Error("sessions.open: resume and fork cannot be used together");
    const s: LiveSession = new LiveSession(opts.resume ?? crypto.randomUUID(), store, host.report, () => this.#guarded(s));
    // 复制出的会话：先写好日志，再和恢复一样打开。打开失败时留下的日志没人引用，不影响原会话
    if (opts.fork) await copyLog(store, opts.fork.session, opts.fork.before, s.id);
    // 直接恢复一个子会话（例如按 id）：层数从日志里的 parent 往上数
    if (opts.resume !== undefined || opts.fork) s.depth = await depthOf(store, s.id);
    let rt: Runtime;
    const core = this.#corePlugin(s);
    const kernelPlugins = () => [core, ...s.parts.map((p) => p.kernel())];
    try {
      for (const p of host.active()) if (p.module.session) await this.#join(s, p);
      const plugins = kernelPlugins();
      rt = opts.resume !== undefined || opts.fork
        ? await Runtime.resume({ store, provider, plugins, sessionId: s.id })
        : await Runtime.create({ store, provider, plugins, sessionId: s.id });
    } catch (e) {
      // session() 里排进来的输入不会再执行了
      s.leave();
      await this.#closeParts(s);
      throw e;
    }
    s.attach(rt, provider, kernelPlugins);
    s.subscribe((n) => {
      if (n.type === "hook-error") host.report(`plugin ${n.info.plugin} failed at ${n.info.point}: ${n.info.error instanceof Error ? n.info.error.message : String(n.info.error)}`);
    });
    return s;
  }

  /** 子会话的上限（7.2）：用户 config.json 的 "jade/core" */
  #limits(): { maxDepth: number; maxActive: number } {
    const c = this.#host.coreConfig();
    const n = (v: unknown, d: number, min: number) => (typeof v === "number" && Number.isInteger(v) && v >= min ? v : d);
    return { maxDepth: n(c.maxDepth, DEFAULT_MAX_DEPTH, 0), maxActive: n(c.maxActive, DEFAULT_MAX_ACTIVE, 1) };
  }

  /** 开子会话（ctx.session.spawn）：所有插件照常加入，Runtime.create 带 parent。不会成为当前会话 */
  async #spawn(parent: LiveSession, opts: SpawnOptions, by: string): Promise<ChildSession> {
    if (!opts || typeof opts !== "object" || opts.parent?.sessionId !== parent.id || typeof opts.parent.eventId !== "string") {
      throw new Error(`plugin ${by}: spawn needs parent: the ToolContext.parent of a tool call in this session`);
    }
    if (parent.left) throw new Error(`session ${parent.id} was closed`);
    const { maxDepth, maxActive } = this.#limits();
    if (parent.depth + 1 > maxDepth) {
      throw new Error(
        maxDepth === 0
          ? `sub-agents are turned off ("jade/core": { "maxDepth": 0 } in config.json)`
          : `sub-agents can be nested at most ${maxDepth} level${maxDepth > 1 ? "s" : ""} deep; this session is already at level ${parent.depth} (raise "jade/core": { "maxDepth" } in config.json)`,
      );
    }
    const signal = opts.signal instanceof AbortSignal ? opts.signal : undefined;
    // 同时数量的上限：顶层会话开的等前面的结束；子会话开的直接报错，它自己占着名额，等下去可能谁都等不到
    while (this.#running >= maxActive) {
      if (parent.depth > 0) throw new Error(`${maxActive} sub-agents are already running; a sub-agent cannot wait for a slot (raise "jade/core": { "maxActive" } in config.json)`);
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          const i = this.#waiting.indexOf(wake);
          if (i >= 0) this.#waiting.splice(i, 1);
          reject(signal!.reason);
        };
        if (signal?.aborted) return stop();
        signal?.addEventListener("abort", stop, { once: true });
        this.#waiting.push(wake);
      });
    }
    if (signal?.aborted) {
      // 被叫醒时已经中止：名额让给下一个等着的
      this.#waiting.shift()?.();
      throw signal.reason;
    }
    this.#running++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#running--;
      this.#waiting.shift()?.();
    };
    if (parent.left) {
      release();
      throw new Error(`session ${parent.id} was closed`);
    }
    const host = this.#host;
    const provider = opts.provider ?? parent.provider;
    const child: Child = {
      session: parent,
      ref: { sessionId: opts.parent.sessionId, eventId: opts.parent.eventId },
      by,
      ...(typeof opts.label === "string" && opts.label ? { label: opts.label } : {}),
      ...(typeof opts.tools === "function" ? { tools: opts.tools } : {}),
      ...(typeof opts.system === "string" && opts.system ? { system: opts.system } : {}),
    };
    const s: LiveSession = new LiveSession(crypto.randomUUID(), parent.store, host.report, () => this.#guarded(s), child);
    const core = this.#corePlugin(s);
    const delegation = this.#delegation(child);
    const kernelPlugins = () => [core, ...s.parts.map((p) => p.kernel()), delegation];
    let rt: Runtime;
    try {
      for (const p of host.active()) if (p.module.session) await this.#join(s, p);
      rt = await Runtime.create({ store: s.store, provider, plugins: kernelPlugins(), sessionId: s.id, parent: child.ref });
    } catch (e) {
      s.leave();
      await this.#closeParts(s);
      release();
      throw e;
    }
    s.attach(rt, provider, kernelPlugins);
    s.subscribe((n) => {
      if (n.type === "hook-error") host.report(`plugin ${n.info.plugin} failed at ${n.info.point} in a sub-agent: ${n.info.error instanceof Error ? n.info.error.message : String(n.info.error)}`);
    });
    s.onEnd = release;
    // Runtime 建好了才算父会话的子会话：父会话离开时结束它要用 Runtime。开的期间父会话离开了：马上结束
    parent.children.add(s);
    if (parent.left) {
      await this.#end(s);
      throw new Error(`session ${parent.id} was closed`);
    }
    let closing: Promise<{ sessionId: string; seq: number }> | undefined;
    return {
      id: s.id,
      send: (input) => s.send(input),
      get state() {
        return s.state;
      },
      subscribe: (fn) => s.subscribe(fn),
      abort: (reason) => s.abort(new Error(reason ?? `stopped by plugin ${by}`)),
      close: () => (closing ??= this.#end(s)),
    };
  }

  /** 结束子会话：先结束它的子会话，中止正在跑的工作，写 session.ended，关闭插件的作用域。返回 ChildRef */
  async #end(s: LiveSession): Promise<{ sessionId: string; seq: number }> {
    if (s.ended) return s.ended;
    s.ended = (async () => {
      s.leave();
      for (const c of [...s.children]) await this.#end(c);
      await s.idle();
      try {
        await s.close();
      } catch (e) {
        this.#host.report(`sub-agent session ${s.id}: could not end it: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.#closeParts(s);
      s.child?.session.children.delete(s);
      s.onEnd?.();
      return { sessionId: s.id, seq: s.rt.state.lastSeq };
    })();
    return s.ended;
  }

  /**
   * 子会话里的 ui@1：没有会话界面（状态栏、输入框）；对话框在整个进程里排成一队，一次一个，标题前标上是哪个子 Agent（7.4）
   */
  #childUI(ui: UI, s: LiveSession): UI {
    const name = s.child?.label ?? "sub-agent";
    const queued = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = this.#dialogs.then(fn);
      this.#dialogs = run.catch(() => {});
      return run;
    };
    return new Proxy(ui, {
      get: (target, prop) => {
        if (prop === "session") return undefined;
        if (prop === "select") {
          return (req: Parameters<UI["select"]>[0], signal?: AbortSignal) =>
            queued(() => (signal?.aborted ? Promise.resolve(undefined) : target.select({ ...req, title: `[${name}] ${req.title}` }, signal)));
        }
        if (prop === "input") {
          return (req: Parameters<UI["input"]>[0], signal?: AbortSignal) =>
            queued(() => (signal?.aborted ? Promise.resolve(undefined) : target.input({ ...req, title: `[${name}] ${req.title}` }, signal)));
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /** 一个插件加入会话：执行它的 session()，失败就撤销它这次的注册 */
  async #join(s: LiveSession, p: { source: PluginSource; module: PluginModule; owner: Owner; mark?: (p: Plugin) => Plugin }): Promise<void> {
    const host = this.#host;
    const { manifest, layer } = p.source;
    const id = manifest.id;
    const scope = new Scope(id);
    const owner: Owner = { plugin: id, scope };
    /** 这个插件的工具，已包装；加入成功后就是 part.tools */
    const tools: Tool[] = [];
    const hooks: (LocalHookSpec | RemoteHookSpec)[] = [];
    let open = true;
    let part: Part | undefined;
    /** 现在交给内核的工具里叫这个名字的是谁的（被隔离的插件的工具已经不交给内核，不算） */
    const holder = (name: string) => s.parts.find((x) => !x.owner.scope.closed && x.tools.some((t) => t.name === name));
    const declared = (name: string, lists: (readonly string[] | undefined)[]) => {
      if (scope.closed) throw new StaleContext(id);
      if (!lists.some((l) => l?.includes(name))) throw new Error(`plugin ${id}: ${name} is not declared in plugin.json`);
    };
    // 前端给这个插件在这个会话里的状态栏段落和输入框（4.3）。界面的东西出问题不连累插件：调用失败当作没有
    const sessionUI = this.#sessionUI(s, id, owner);
    if (sessionUI) {
      try {
        scope.add(() => sessionUI.dispose());
      } catch {
        // 作用域已经关了：没有要清理的
      }
    }
    /** 子会话里的 ui@1 换成排队、标名字的那份 */
    const forSession = <T extends object>(name: string, h: T | undefined): T | undefined =>
      h && s.child && name === "ui@1" ? (this.#childUI(h as unknown as UI, s) as unknown as T) : h;
    const uiCall = (fn: () => void) => {
      try {
        fn();
      } catch {
        // 前端不在了（例如它的作用域已关闭）
      }
    };
    const ctx: SessionContext = {
      plugin: id,
      signal: scope.signal,
      cwd: host.cwd,
      home: host.home,
      config: host.config(p.source),
      secrets: scopedSecrets(host.secrets(id), () => scope.closed, id),
      ...(sessionUI
        ? {
            status: (text: string | StatusSegment | undefined) => uiCall(() => sessionUI.status(statusSegment(text))),
            // 带样式的文字（Text）原样交给前端，由它决定怎么画
            ...(sessionUI.panel ? { panel: (text: Text | undefined) => uiCall(() => sessionUI.panel!(text)) } : {}),
            // 项目层插件拿不到输入框（第 7 节）：克隆的仓库不能替用户写字
            ...(sessionUI.draft && layer !== "project" ? { input: sessionUI.draft } : {}),
          }
        : {}),
      require: <T extends object>(name: string): T => {
        declared(name, [manifest.requires]);
        const h = forSession<T>(name, host.service<T>(name, owner));
        if (!h) throw new ServiceUnavailable(name, "(none)");
        return h;
      },
      service: <T extends object>(name: string): T | undefined => {
        declared(name, [manifest.requires, manifest.optional]);
        return forSession<T>(name, host.service<T>(name, owner));
      },
      effect: async (start) => {
        if (scope.closed) throw new StaleContext(id);
        const d = await ambient.run(owner, start);
        if (typeof d === "function") scope.add(d);
      },
      report: (message) => {
        if (scope.closed) throw new StaleContext(id);
        host.report(`${id}: ${String(message)}`);
      },
      session: {
        id: s.id,
        afterTurn: (fn) => {
          if (scope.closed) throw new StaleContext(id);
          s.afterTurn(fn, owner);
        },
        send: (input) => {
          if (scope.closed) throw new StaleContext(id);
          if (layer === "project") throw new Error(`plugin ${id}: project plugins cannot send input on the user's behalf`);
          return s.send(input);
        },
        abort: (reason) => {
          if (scope.closed) throw new StaleContext(id);
          if (layer === "project") throw new Error(`plugin ${id}: project plugins cannot stop turns on the user's behalf`);
          const why = new Error(reason ?? `stopped by plugin ${id}`);
          s.abort(why);
          // 子会话里替用户喊停（例如审批时按 Esc）：用户要停的是整件事，顶层会话这一轮也停，不让父会话拿着结果接着干
          let top = s;
          while (top.child) top = top.child.session;
          if (top !== s) top.abort(why);
        },
        state: () => {
          if (scope.closed) throw new StaleContext(id);
          // session() 执行期间 Runtime 还没建（全部插件加入之后才建）
          if (!s.rt) throw new Error(`plugin ${id}: the session's state is not available while session() runs`);
          return s.rt.state;
        },
        phase: () => {
          if (scope.closed) throw new StaleContext(id);
          if (!s.rt) throw new Error(`plugin ${id}: the session's phase is not available while session() runs`);
          return s.rt.phase;
        },
        subscribe: (fn) => {
          if (scope.closed) throw new StaleContext(id);
          const off = s.watch(fn, owner);
          scope.add(off);
          return off;
        },
        tool: (name) => {
          if (scope.closed) throw new StaleContext(id);
          return s.tool(name);
        },
        ...(s.child ? { parent: { ...s.child.ref } } : {}),
        depth: s.depth,
        canSpawn: layer !== "project" && s.depth < this.#limits().maxDepth,
        spawn: (opts) => {
          if (scope.closed) return Promise.reject(new StaleContext(id));
          if (layer === "project") return Promise.reject(new Error(`plugin ${id}: project plugins cannot open sub-agent sessions`));
          return this.#spawn(s, opts, id);
        },
      },
      kernel: {
        tool: (t) => {
          if (scope.closed) throw new StaleContext(id);
          const tool = liveTool({ ...t, ...toolMeta(id, layer, t) }, owner);
          if (!open) {
            // session() 返回之后注册的从下一项工作起生效（重挂 Runtime）。重名的在这里拒绝，不能让重挂失败
            if (!part) throw new Error(`plugin ${id}: did not join session ${s.id}`);
            const other = holder(tool.name);
            if (other) throw new Error(`plugin ${id}: tool ${tool.name} is already registered by ${other.source.manifest.id}`);
          }
          tools.push(tool);
          if (!open) s.invalidate();
          let done = false;
          return () => {
            if (done) return;
            done = true;
            const i = tools.indexOf(tool);
            if (i < 0) return;
            tools.splice(i, 1);
            if (part) s.invalidate();
          };
        },
        hook: (h) => {
          if (!open) throw new Error(`plugin ${id}: hooks can only be registered while session() runs`);
          hooks.push(h);
        },
      },
    };
    host.track(id, scope);
    try {
      await invoke(owner, "session", () => p.module.session!(ctx));
    } catch (e) {
      open = false;
      host.untrack(id, scope);
      await scope.close();
      const reason = e instanceof PluginError && e.plugin === id ? String((e.cause as Error)?.message ?? e.message) : e instanceof Error ? e.message : String(e);
      host.report(`plugin ${id} did not join session ${s.id}: ${reason}`);
      host.fault(id, reason);
      return;
    }
    open = false;
    // 内核构造 Runtime 时会因为重名工具、不合法的 hook 拒绝整个会话：提前检查，只排除这一个插件
    const clash = tools.find((t) => holder(t.name));
    const problem = clash ? `tool ${clash.name} is already registered by ${holder(clash.name)!.source.manifest.id}` : compatProblem(id, manifest.version, hooks);
    if (problem) {
      host.untrack(id, scope);
      await scope.close();
      host.report(`plugin ${id} did not join session ${s.id}: ${problem}`);
      return;
    }
    const live = hooks.map((h) => liveHook(h, owner));
    part = {
      source: p.source,
      owner,
      gates: hooks.filter((h) => h.kind === "gate" && h.point === "tool.gate").length,
      tools,
      kernel: () =>
        this.#confirmed(p, kernelPlugin({
          id,
          version: manifest.version,
          layer: KERNEL_LAYER[layer],
          // 写日志的能力调用时才检查，推不出来（definePlugin 只补 hook 用到的）；jade 的插件都可以写
          needs: ["log:record", "log:emit"],
          tools: scope.closed ? [] : tools.filter((t) => s.keeps(t)),
          hooks: live,
        })),
    };
    s.parts.push(part);
    // 插件被隔离（作用域关闭）：它的工具从下一项工作起不再给模型看
    scope.add(() => s.invalidate());
  }

  /** 项目层插件交给内核的插件要用确认时拿到的 mark 标记，否则内核拒绝整个会话 */
  #confirmed(p: { source: PluginSource; mark?: (p: Plugin) => Plugin }, plugin: Plugin): Plugin {
    if (p.source.layer !== "project") return plugin;
    if (!p.mark) throw new Error(`plugin ${p.source.manifest.id}: project plugin was not confirmed`);
    return p.mark(plugin);
  }

  /**
   * 前端给这个插件在这个会话里的状态栏段落和输入框（4.3）。没有 ui@1、或前端不提供会话界面时没有；
   * 获取失败也只当作没有：界面上的东西坏了不该让插件加入不了会话
   */
  #sessionUI(s: LiveSession, plugin: string, owner: Owner): SessionUI | undefined {
    // 子会话不是当前会话，没有自己的界面（4.2）
    if (s.child) return undefined;
    try {
      const ui = this.#host.service<UI>("ui@1", owner);
      return ui?.session?.({ session: s.id, plugin });
    } catch {
      return undefined;
    }
  }

  /**
   * 兜底关卡（第 7 节）：approval@1 的提供者没有在本会话里注册仍然有效的 tool.gate 时，拒绝非只读工具。
   * 只认审批插件：其他插件的 gate（例如拒绝重复调用）全部弃权时内核会放行，不能让兜底关卡因此让开。
   * 项目层的提供者也不算：克隆的仓库不能放宽审批
   */
  #corePlugin(s: LiveSession): Plugin {
    const gate = (call: { tool: { effect: string } }): GateResult =>
      this.#guarded(s) || call.tool.effect === "read" ? { decision: "abstain" } : { decision: "deny", reason: NO_APPROVAL_REASON };
    return kernelPlugin({ id: CORE_PLUGIN_ID, version: API_VERSION, layer: "distro", hooks: [{ kind: "gate", point: "tool.gate", fn: gate }] });
  }

  /**
   * 子会话的委派说明和开它的插件给的系统提示词（7.3）。context.build 按顺序执行，别的插件（jade/prompts）
   * 把自己的段落放在已有段落之前，最后执行的才能放在最前面：所以单独一个插件，hook 的 order 设得很大
   */
  #delegation(child: Child): Plugin {
    const seg = (text: string, by: string) => ({ text, stability: "stable" as const, origin: { by: "plugin" as const, id: by }, trust: "trusted" as const });
    const head = [seg(DELEGATION, CORE_PLUGIN_ID), ...(child.system ? [seg(child.system, child.by)] : [])];
    return kernelPlugin({
      id: `${CORE_PLUGIN_ID}/delegation`,
      version: API_VERSION,
      layer: "distro",
      // order 大：任何层的插件之后执行
      hooks: [{ kind: "transform", point: "context.build", order: 1_000_000, fn: (req) => ({ ...req, system: [...head, ...req.system] }) }],
    });
  }

  /** approval@1 的提供者（不能是项目层插件）在这个会话里有仍然有效的 tool.gate */
  #guarded(s: LiveSession): boolean {
    const approval = this.#host.provider("approval@1");
    return s.parts.some((p) => p.gates > 0 && !p.owner.scope.closed && p.source.manifest.id === approval && p.source.layer !== "project");
  }

  /** 离开会话：中止正在跑的工作，等它停下，detach，关闭插件的会话作用域 */
  async #leave(s: LiveSession): Promise<void> {
    s.leave();
    // 它开的子会话一并结束：正在等子会话的工具调用随之结束
    for (const c of [...s.children]) await this.#end(c);
    await s.idle();
    try {
      await s.detach();
    } catch (e) {
      this.#host.report(`session ${s.id}: detach failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.#closeParts(s);
  }

  async #closeParts(s: LiveSession): Promise<void> {
    for (const p of [...s.parts].reverse()) {
      this.#host.untrack(p.owner.plugin, p.owner.scope);
      for (const e of await p.owner.scope.close()) this.#host.report(e instanceof Error ? e.message : String(e));
    }
  }
}

function compatProblem(id: string, version: string, hooks: (LocalHookSpec | RemoteHookSpec)[]): string | undefined {
  try {
    checkCompat(kernelPlugin({ id, version, hooks }));
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 状态栏的一段只留认得的字段：文字都换成字符串，不认得的 tone 去掉 */
function statusSegment(s: string | StatusSegment | undefined): string | StatusSegment | undefined {
  if (s === undefined || typeof s !== "object" || s === null) return s === undefined ? undefined : String(s);
  const tones = ["ok", "warn", "error", "accent"];
  return {
    text: String(s.text ?? ""),
    ...(s.short !== undefined ? { short: String(s.short) } : {}),
    ...(tones.includes(s.tone as string) ? { tone: s.tone } : {}),
    ...(s.keep === true ? { keep: true } : {}),
  };
}

/**
 * 工具的 meta 只留认得的字段（字段名都是字符串），写错了抛错：插件加入会话失败，比别的插件悄悄认不出这个工具好查。
 * 项目层插件的 shell 不算：审批按它把只读命令直接放行、只读的子 Agent 也留着这个工具，克隆的仓库不能自己声明这个。
 * 去掉之后它就是普通的工具，照常经过审批
 */
function toolMeta(plugin: string, layer: PluginSource["layer"], t: { name: string; meta?: unknown }): { meta?: ToolMeta } {
  if (t.meta === undefined) return {};
  const m = t.meta as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) throw new Error(`plugin ${plugin}: tool ${t.name}: meta must be an object`);
  const meta: ToolMeta = {};
  for (const k of ["writes", "shell"] as const) {
    if (m[k] === undefined) continue;
    if (typeof m[k] !== "string" || !m[k]) throw new Error(`plugin ${plugin}: tool ${t.name}: meta.${k} must be the name of an input field`);
    if (k === "shell" && layer === "project") continue;
    meta[k] = m[k];
  }
  return { meta };
}

/** 工具的声明部分（给插件看的 SessionTool），meta 是拷贝 */
function sessionTool(t: Tool & { meta?: ToolMeta }): SessionTool {
  const { name, description, inputSchema, effect, concurrency, idempotent, meta } = t;
  return { name, description, inputSchema, effect, concurrency, idempotent, ...(meta ? { meta: { ...meta } } : {}) };
}

/** 插件的工具：以插件身份执行；插件被隔离后返回错误结果（由内核转成 tool_result） */
function liveTool(t: Tool, owner: Owner): Tool {
  return { ...t, execute: (input, ctx) => invoke(owner, `tool ${t.name}`, () => t.execute(input, ctx)) };
}

/**
 * 插件的 hook：以插件身份执行。插件被隔离（作用域关闭）后这个 hook 视为不存在：gate 弃权、transform 不改、
 * observe 不做事。审批插件被隔离时，兜底关卡随之生效，所以弃权不会放行写操作
 */
function liveHook(h: LocalHookSpec | RemoteHookSpec, owner: Owner): LocalHookSpec | RemoteHookSpec {
  if ("remote" in h && h.remote) {
    // 进程外：transform 回复空对象表示不改
    const call = h.call;
    const gone = h.kind === "gate" ? { decision: "abstain" } : h.kind === "transform" ? {} : undefined;
    return { ...h, call: (payload, ctx) => (owner.scope.closed ? Promise.resolve(gone) : ambient.run(owner, () => call(payload, ctx))) };
  }
  const fn = (h as LocalHookSpec).fn as (payload: unknown, ctx: unknown) => unknown;
  const wrapped = (payload: unknown, ctx: unknown) => {
    if (owner.scope.closed) return h.kind === "gate" ? { decision: "abstain" } : undefined;
    return ambient.run(owner, () => fn(payload, ctx));
  };
  return { ...h, fn: wrapped } as LocalHookSpec;
}

/** 会话是第几层子会话：沿着 session.started 里的 parent 往上数（内核保证引用能解析到，宪法 3.4） */
async function depthOf(store: LogStore, sessionId: string): Promise<number> {
  let depth = 0;
  let id: string | undefined = sessionId;
  const seen = new Set<string>();
  while (id && !seen.has(id) && depth < 100) {
    seen.add(id);
    let parent: string | undefined;
    for await (const e of store.read(id)) {
      if (e.type === "session.started") parent = (e.data as { parent?: SessionRef }).parent?.sessionId;
      break;
    }
    if (!parent) break;
    depth++;
    id = parent;
  }
  return depth;
}

/**
 * 把 from 的日志里 seq 小于 before 的事件写成新会话 to 的日志（OpenOptions.fork）。before 要是一条消息输入的 seq：
 * 这样复制出的会话停在一轮结束之后、下一条消息之前，恢复时没有没做完的一轮
 */
async function copyLog(store: LogStore, from: string, before: number, to: string): Promise<void> {
  const events = await readAll(store, from);
  const at = events.find((e) => e.seq === before);
  if (!at || at.type !== "input.received" || (at.data as UserInput).kind !== "message") {
    throw new Error(`sessions.open: seq ${before} of session ${from} is not a message from the user`);
  }
  await store.append(to, events.filter((e) => e.seq < before));
}
