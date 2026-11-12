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
  type Session,
  type SessionContext,
  type SessionManager,
  type SessionTool,
  type SessionUI,
  type StatusSegment,
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
  kernel: Plugin;
}

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

  readonly #store: LogStore;

  constructor(id: string, store: LogStore, report: (m: string) => void, attended: () => boolean) {
    this.id = id;
    this.#store = store;
    this.#report = report;
    this.#attended = attended;
  }

  history(): Promise<LogEvent[]> {
    return readAll(this.#store, this.id);
  }

  tool(name: string): SessionTool | undefined {
    for (const p of this.parts) {
      const t = p.kernel.tools?.find((x) => x.name === name) as (Tool & { meta?: ToolMeta }) | undefined;
      if (!t) continue;
      const { name: n, description, inputSchema, effect, concurrency, idempotent, meta } = t;
      return { name: n, description, inputSchema, effect, concurrency, idempotent, ...(meta ? { meta: { ...meta } } : {}) };
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
      this.#kick();
    });
  }

  afterTurn(fn: () => void | Promise<void>, owner: Owner): void {
    if (this.#left) return;
    this.#after.push({ fn, owner });
    this.#kick();
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

  /** Runtime 建好之后调用一次：把通知转给订阅的插件，以插件身份执行，出错只报告 */
  attach(): void {
    this.rt.subscribe((n) => {
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

  abort(reason?: unknown): void {
    this.rt.abort(reason);
    // 停在等待人工审批时内核没有在跑，信号结束不了这一轮
    if (this.#turn) {
      this.#turn.stop = { reason };
      this.#turn.wake?.();
    }
  }

  subscribe(fn: (n: RuntimeNotice) => void): () => void {
    return this.rt.subscribe(fn);
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
  #store: LogStore | undefined;
  /** 换会话串行进行 */
  #switching: Promise<unknown> = Promise.resolve();

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

  /** 当前会话离开（detach，仍可恢复） */
  async close(): Promise<void> {
    await this.#switching;
    const old = this.#current;
    this.#current = undefined;
    if (old) await this.#leave(old);
  }

  async #open(opts: OpenOptions): Promise<Session> {
    const host = this.#host;
    const provider = host.service<Provider>("provider@1", host.core);
    if (!provider) throw new ServiceUnavailable("provider@1", "(none): no active plugin provides a model");
    const store = host.service<LogStore>("store@1", host.core) ?? (this.#store ??= new JsonlLogStore(path.join(host.home, "sessions")));

    if (opts.fork && opts.resume !== undefined) throw new Error("sessions.open: resume and fork cannot be used together");
    const s: LiveSession = new LiveSession(opts.resume ?? crypto.randomUUID(), store, host.report, () => this.#guarded(s));
    // 复制出的会话：先写好日志，再和恢复一样打开。打开失败时留下的日志没人引用，不影响原会话
    if (opts.fork) await copyLog(store, opts.fork.session, opts.fork.before, s.id);
    try {
      for (const p of host.active()) if (p.module.session) await this.#join(s, p);
      const plugins = [this.#corePlugin(s), ...s.parts.map((p) => p.kernel)];
      s.rt = opts.resume !== undefined || opts.fork
        ? await Runtime.resume({ store, provider, plugins, sessionId: s.id })
        : await Runtime.create({ store, provider, plugins, sessionId: s.id });
    } catch (e) {
      await this.#closeParts(s);
      throw e;
    }
    s.attach();
    s.rt.subscribe((n) => {
      if (n.type === "hook-error") host.report(`plugin ${n.info.plugin} failed at ${n.info.point}: ${n.info.error instanceof Error ? n.info.error.message : String(n.info.error)}`);
    });
    // 提交：新会话成为当前会话，然后旧会话离开
    const old = this.#current;
    this.#current = s;
    if (old) await this.#leave(old);
    return s;
  }

  /** 一个插件加入会话：执行它的 session()，失败就撤销它这次的注册 */
  async #join(s: LiveSession, p: { source: PluginSource; module: PluginModule; owner: Owner; mark?: (p: Plugin) => Plugin }): Promise<void> {
    const host = this.#host;
    const { manifest, layer } = p.source;
    const id = manifest.id;
    const scope = new Scope(id);
    const owner: Owner = { plugin: id, scope };
    const tools: Tool[] = [];
    const hooks: (LocalHookSpec | RemoteHookSpec)[] = [];
    let open = true;
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
            ...(sessionUI.panel ? { panel: (text: string | undefined) => uiCall(() => sessionUI.panel!(text === undefined ? undefined : String(text))) } : {}),
            // 项目层插件拿不到输入框（第 7 节）：克隆的仓库不能替用户写字
            ...(sessionUI.draft && layer !== "project" ? { input: sessionUI.draft } : {}),
          }
        : {}),
      require: <T extends object>(name: string): T => {
        declared(name, [manifest.requires]);
        const h = host.service<T>(name, owner);
        if (!h) throw new ServiceUnavailable(name, "(none)");
        return h;
      },
      service: <T extends object>(name: string): T | undefined => {
        declared(name, [manifest.requires, manifest.optional]);
        return host.service<T>(name, owner);
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
          s.abort(new Error(reason ?? `stopped by plugin ${id}`));
        },
        state: () => {
          if (scope.closed) throw new StaleContext(id);
          // session() 执行期间 Runtime 还没建（全部插件加入之后才建）
          if (!s.rt) throw new Error(`plugin ${id}: the session's state is not available while session() runs`);
          return s.rt.state;
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
      },
      kernel: {
        tool: (t) => {
          if (!open) throw new Error(`plugin ${id}: tools can only be registered while session() runs`);
          tools.push({ ...t, ...toolMeta(id, t) });
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
    const taken = new Set(s.parts.flatMap((x) => x.kernel.tools?.map((t) => t.name) ?? []));
    const clash = tools.find((t) => taken.has(t.name));
    const problem = clash
      ? `tool ${clash.name} is already registered by ${s.parts.find((x) => x.kernel.tools?.some((t) => t.name === clash.name))!.source.manifest.id}`
      : compatProblem(id, manifest.version, hooks);
    if (problem) {
      host.untrack(id, scope);
      await scope.close();
      host.report(`plugin ${id} did not join session ${s.id}: ${problem}`);
      return;
    }
    const part: Part = {
      source: p.source,
      owner,
      gates: hooks.filter((h) => h.kind === "gate" && h.point === "tool.gate").length,
      kernel: this.#confirmed(p, kernelPlugin({
        id,
        version: manifest.version,
        layer: KERNEL_LAYER[layer],
        // 写日志的能力调用时才检查，推不出来（definePlugin 只补 hook 用到的）；jade 的插件都可以写
        needs: ["log:record", "log:emit"],
        tools: tools.map((t) => liveTool(t, owner)),
        hooks: hooks.map((h) => liveHook(h, owner)),
      })),
    };
    s.parts.push(part);
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

  /** approval@1 的提供者（不能是项目层插件）在这个会话里有仍然有效的 tool.gate */
  #guarded(s: LiveSession): boolean {
    const approval = this.#host.provider("approval@1");
    return s.parts.some((p) => p.gates > 0 && !p.owner.scope.closed && p.source.manifest.id === approval && p.source.layer !== "project");
  }

  /** 离开会话：中止正在跑的工作，等它停下，detach，关闭插件的会话作用域 */
  async #leave(s: LiveSession): Promise<void> {
    s.leave();
    await s.idle();
    try {
      await s.rt.detach();
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

/** 工具的 meta 只留认得的字段（字段名都是字符串），写错了抛错：插件加入会话失败，比别的插件悄悄认不出这个工具好查 */
function toolMeta(plugin: string, t: { name: string; meta?: unknown }): { meta?: ToolMeta } {
  if (t.meta === undefined) return {};
  const m = t.meta as Record<string, unknown> | null;
  if (typeof m !== "object" || m === null) throw new Error(`plugin ${plugin}: tool ${t.name}: meta must be an object`);
  const meta: ToolMeta = {};
  for (const k of ["writes", "shell"] as const) {
    if (m[k] === undefined) continue;
    if (typeof m[k] !== "string" || !m[k]) throw new Error(`plugin ${plugin}: tool ${t.name}: meta.${k} must be the name of an input field`);
    meta[k] = m[k];
  }
  return { meta };
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
