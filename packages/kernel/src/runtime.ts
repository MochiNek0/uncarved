// 内存运行时：执行 Effect，把结果作为事件写回日志。对应宪法 4.2 ~ 4.5。

import { createHash } from "node:crypto";
import {
  HookBus,
  type GatePayloads,
  type GatePoint,
  type HookContextFor,
  type HookErrorInfo,
  type TransformPayloads,
  type TransformPoint,
} from "./hooks.ts";
import { checkCompat, PluginIncompatible, resumePolicy, type Plugin } from "./plugin.ts";
import { ProviderError } from "./provider.ts";
import { initialState, rebuild, step } from "./step.ts";
import { isConfirmed, UntrustedPlugin } from "./trust.ts";
import { readAll, type LogStore } from "./store.ts";
import type {
  Block,
  ChildRef,
  CoreEventType,
  Delta,
  Effect,
  LogEvent,
  EventDataMap,
  Message,
  ModelRequest,
  Origin,
  PendingCall,
  PluginManifestEntry,
  Provider,
  SessionRef,
  State,
  SystemSegment,
  Tool,
  ToolInfo,
  UserInput,
} from "./types.ts";

export type RuntimeNotice =
  | { type: "event"; event: LogEvent }
  | { type: "delta"; delta: Delta }
  /** 工具通过 ctx.progress 推送的进度，不记入日志 */
  | { type: "tool-progress"; toolUseId: string; name: string; update: unknown }
  | { type: "awaiting"; toolUseIds: string[] }
  /** event-loop：event observe 引发的写入超过上限（链太深或总数太多），之后的事件不再分发给 event observe */
  | { type: "warning"; code: "cache-order" | "event-loop" }
  | { type: "hook-error"; info: HookErrorInfo };

export interface RuntimeOptions {
  store: LogStore;
  provider: Provider;
  plugins?: Plugin[];
  now?: () => string;
  newId?: () => string;
}

export class RuntimeBusy extends Error {
  constructor() {
    super("runtime is already driving this session");
    this.name = "RuntimeBusy";
  }
}

/** 插件清单变化尚未被接受，会话暂停（4.6） */
export class PluginsHeld extends Error {
  readonly resolution: "ask" | "abort";
  constructor(resolution: "ask" | "abort") {
    super(`plugin change not accepted (${resolution})`);
    this.name = "PluginsHeld";
    this.resolution = resolution;
  }
}

/** 投影中带模型来源的块与日志中的任何模型块都不一致（I-6） */
export class ModelOutputModified extends Error {
  constructor() {
    super("model output block was modified");
    this.name = "ModelOutputModified";
  }
}

/** 本实例已经 detach，要继续这个会话请用 Runtime.resume（4.2） */
export class SessionDetached extends Error {
  constructor() {
    super("runtime has detached from the session; use Runtime.resume to continue it");
    this.name = "SessionDetached";
  }
}

/** tool.before 只能修改参数，不能修改 toolUseId 和 name（4.4） */
export class ToolCallModified extends Error {
  constructor(field: string) {
    super(`tool.before must not change ${field}`);
    this.name = "ToolCallModified";
  }
}

export class UnresolvedRef extends Error {
  constructor(detail: string) {
    super(`unresolved session reference: ${detail}`);
    this.name = "UnresolvedRef";
  }
}

/** event observe 写入链的最大层数 */
const MAX_EVENT_DEPTH = 16;
/**
 * 一次对外调用中，由 event observe 写入、还会再分发给 event observe 的事件总数上限。
 * 只限层数不够：两个插件互相回应时，事件数随层数指数增长
 */
const MAX_CASCADE_EVENTS = 256;

/** 中断后等 provider 自己结束的时间，超过就不再等它 */
const ABORT_GRACE_MS = 1_000;
const RUNTIME: Origin = { by: "runtime" };
const HOST: Origin = { by: "host" };

export class Runtime {
  #state: State;
  #store: LogStore;
  #provider: Provider;
  #hooks: HookBus;
  #tools = new Map<string, Tool>();
  #plugins: Plugin[];
  #manifest: PluginManifestEntry[];
  /** 每个插件声明的能力 */
  #needs: Map<string, Set<string>>;
  #now: () => string;
  #newId: () => string;

  #queue: Effect[] = [];
  #writes: Promise<void> = Promise.resolve();
  #listeners = new Set<(n: RuntimeNotice) => void>();
  #abort = new AbortController();
  #busy = false;
  #detached = false;
  /** 本次对外调用中 event observe 已写入的事件数，以及是否已经警告过 */
  #cascade = 0;
  #cascadeWarned = false;

  private constructor(opts: RuntimeOptions, state: State) {
    this.#state = state;
    this.#store = opts.store;
    this.#provider = opts.provider;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
    this.#hooks = new HookBus((info) => this.#notify({ type: "hook-error", info }));

    const plugins = opts.plugins ?? [];
    const ids = new Set<string>();
    for (const p of plugins) {
      // 能力（needs）按 id 查找，同 id 的插件会拿到彼此的能力（8.2）
      if (ids.has(p.id)) throw new Error(`duplicate plugin id ${p.id}`);
      ids.add(p.id);
      checkCompat(p);
      if (p.layer === "project" && !isConfirmed(p)) throw new UntrustedPlugin(p.id, "not loaded via loadProjectPlugin");
      for (const t of p.tools ?? []) {
        if (this.#tools.has(t.name)) throw new Error(`duplicate tool name ${t.name} (plugin ${p.id})`);
        this.#tools.set(t.name, t);
      }
      for (const h of p.hooks ?? []) this.#hooks.add(p.id, p.layer ?? "distro", h);
    }
    this.#plugins = plugins;
    this.#manifest = plugins.map((p) => ({ id: p.id, version: p.version }));
    this.#needs = new Map(plugins.map((p) => [p.id, new Set(p.needs ?? [])]));
  }

  static async create(opts: RuntimeOptions & { sessionId?: string; parent?: SessionRef }): Promise<Runtime> {
    const newId = opts.newId ?? (() => crypto.randomUUID());
    const parent = opts.parent;
    if (parent && !(await resolves(opts.store, parent.sessionId, (e) => e.id === parent.eventId))) {
      throw new UnresolvedRef(`parent ${parent.sessionId}#${parent.eventId}`);
    }
    // 已有日志的会话再写一条 session.started 会让它无法重建，继续已有会话要用 resume
    if (opts.sessionId && (await resolves(opts.store, opts.sessionId, () => true))) {
      throw new Error(`session ${opts.sessionId} already exists; use Runtime.resume`);
    }
    const rt = new Runtime(opts, initialState(opts.sessionId ?? newId()));
    await rt.#commit("session.started", { plugins: rt.#manifest, parent }, RUNTIME);
    rt.#hooks.observe("session.start", structuredClone(rt.#state), rt.#hookCtx);
    await rt.#settle();
    return rt;
  }

  /**
   * 只凭日志重建状态。插件清单与日志记录不同时写入 plugins.changed（4.6）。
   * 调用 recover() 才会继续执行未完成的工作
   */
  static async resume(opts: RuntimeOptions & { sessionId: string }): Promise<Runtime> {
    const events = await readAll(opts.store, opts.sessionId);
    if (events.length === 0) throw new Error(`session ${opts.sessionId} not found`);
    const rt = new Runtime(opts, rebuild(opts.sessionId, events));
    const s = rt.#state;
    const recorded = s.held?.plugins ?? s.plugins;
    // 已结束的会话不再接受任何事件（5.1），插件变化无需记录
    if (s.phase !== "ended" && JSON.stringify(recorded) !== JSON.stringify(rt.#manifest)) {
      const resolution = resumePolicy(s.plugins, rt.#plugins);
      await rt.#commit("plugins.changed", { plugins: rt.#manifest, resolution }, RUNTIME);
      // 返回前等它触发的 observe 及其写入完成（5.1）
      await rt.#settle();
      // 接下来该做什么一律由 recover() 根据状态决定
      rt.#queue.length = 0;
    }
    return rt;
  }

  get state(): State {
    return structuredClone(this.#state);
  }

  /** 某个扩展点上 hook 的实际执行顺序（5.3） */
  hookOrder(point: string): string[] {
    return this.#hooks.ordered(point).map((h) => h.plugin);
  }

  subscribe(fn: (n: RuntimeNotice) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  abort(reason?: unknown): void {
    this.#abort.abort(reason);
  }

  async send(input: UserInput): Promise<void> {
    this.#enter(input.kind === "plugins");
    try {
      await this.#commit("input.received", input, { by: "user" });
      // 插件变化的批准只记录结果，接下来做什么一律由 recover() 根据状态决定，与 resume() 一致（4.6）
      if (input.kind === "plugins") this.#queue.length = 0;
      else await this.#drive();
    } finally {
      await this.#settle();
      this.#busy = false;
    }
  }

  /** 崩溃或重启后，继续执行日志里尚未完成的工作（4.5） */
  async recover(): Promise<void> {
    this.#enter();
    try {
      this.#queue.length = 0;
      const s = this.#state;
      switch (s.phase) {
        case "model":
          this.#queue.push({ type: "CallModel" });
          break;
        case "deciding":
          this.#queue.push({
            type: "DecideTools",
            toolUseIds: s.batch.filter((c) => !c.decision).map((c) => c.toolUseId),
          });
          break;
        case "awaiting":
          this.#notify({
            type: "awaiting",
            toolUseIds: s.batch.filter((c) => c.decision === "ask").map((c) => c.toolUseId),
          });
          break;
        case "tools": {
          const rerun: string[] = [];
          for (const c of s.batch) {
            if (c.decision !== "allow" || c.result) continue;
            if (!c.stale && this.#tools.get(c.name)?.idempotent) rerun.push(c.toolUseId);
            else await this.#commit("tool.interrupted", { toolUseId: c.toolUseId }, RUNTIME);
          }
          if (rerun.length > 0) this.#queue.push({ type: "RunTools", toolUseIds: rerun });
          break;
        }
        case "continuing":
          this.#queue.push({ type: "DecideContinue" });
          break;
        case "ending":
          this.#queue.push({ type: "EndTurn", reason: s.ending ?? "end" });
          break;
      }
      await this.#drive();
    } finally {
      await this.#settle();
      this.#busy = false;
    }
  }

  /**
   * 结束会话。session.end 的 observe 在 session.ended 之前执行并等待完成，
   * 因此仍可写入；session.ended 之后日志不再接受任何事件（5.1）
   */
  async close(): Promise<void> {
    // 插件变化未被接受的会话也可以结束，所以不走 #enter
    await this.#exclusive(async () => {
      this.#hooks.observe("session.end", structuredClone(this.#state), this.#hookCtx);
      await this.#settle();
      await this.#commit("session.ended", {}, RUNTIME);
    });
  }

  /**
   * 宿主进程离开会话，会话保持可恢复：写入 session.detached，等它触发的 observe 及其写入完成。
   * 之后本实例不再可用（4.2）
   */
  async detach(): Promise<void> {
    await this.#exclusive(() => this.#commit("session.detached", {}, RUNTIME));
    this.#detached = true;
  }

  /** 宿主写入派生数据（derived.recorded），插件可以从 ctx.derived 读到，恢复后仍在（4.8） */
  async record(key: string, value: unknown): Promise<void> {
    await this.#exclusive(() => this.#commit("derived.recorded", { key, value }, HOST));
  }

  /** 宿主写入自定义事件，类型必须带命名空间 `<ns>/<type>`（3.2、4.8） */
  async emit(type: string, data: unknown): Promise<void> {
    if (!/^[^/]+\/./.test(type)) throw new Error(`host event type must be namespaced "<ns>/<type>": ${JSON.stringify(type)}`);
    await this.#exclusive(() => this.#append(type, data, HOST));
  }

  // ---------- 驱动 ----------

  /** 不驱动循环的对外调用：独占运行时，返回前等 observe 完成（5.1） */
  async #exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.#detached) throw new SessionDetached();
    if (this.#busy) throw new RuntimeBusy();
    this.#busy = true;
    this.#cascade = 0;
    this.#cascadeWarned = false;
    // 之前的中断只针对当时的那一轮，不能带进这次调用触发的 hook
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
    try {
      await this.#settle();
      await fn();
    } finally {
      await this.#settle();
      this.#busy = false;
    }
  }

  #enter(pluginApproval = false): void {
    if (this.#detached) throw new SessionDetached();
    if (this.#busy) throw new RuntimeBusy();
    const held = this.#state.held;
    if (held && !(pluginApproval && held.resolution === "ask")) throw new PluginsHeld(held.resolution);
    this.#busy = true;
    this.#cascade = 0;
    this.#cascadeWarned = false;
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
  }

  async #drive(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        // 中断后不再开始任何 Effect，即使上一步（例如关卡）没有理会 signal（4.4）
        this.#abort.signal.throwIfAborted();
        await this.#execute(this.#queue.shift()!);
      }
    } catch (err) {
      this.#queue.length = 0;
      const phase = this.#state.phase;
      if (phase !== "new" && phase !== "idle" && phase !== "ended") {
        const aborted = this.#abort.signal.aborted;
        const cause = aborted ? this.#abort.signal.reason : err;
        const error = cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
        try {
          await this.#commit("turn.ended", { reason: aborted ? "aborted" : "error", error }, RUNTIME);
        } catch {
          // 存储本身坏了时这次写入也会失败：抛出最初的错误，它才说明发生了什么。
          // 状态停在原阶段，之后可以用 recover() 继续
        }
      }
      throw err;
    }
  }

  async #execute(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "CallModel":
        return this.#callModel();
      case "DecideTools":
        for (const id of effect.toolUseIds) {
          // 中断后剩下的调用不再走 hook，否则中断要等每个关卡各自超时
          this.#abort.signal.throwIfAborted();
          await this.#decideTool(this.#call(id));
        }
        return;
      case "RunTools":
        return this.#runTools(effect.toolUseIds.map((id) => this.#call(id)));
      case "AwaitInput":
        this.#notify({ type: "awaiting", toolUseIds: effect.toolUseIds });
        return;
      case "DecideContinue": {
        const g = await this.#gate("turn.continue", structuredClone(this.#state));
        if (g.decision === "allow" || g.decision === "abstain") return this.#callModel();
        return this.#commit("turn.ended", { reason: "stopped" }, RUNTIME);
      }
      case "EndTurn":
        return this.#commit("turn.ended", { reason: effect.reason }, RUNTIME);
    }
  }

  async #callModel(): Promise<void> {
    const signal = this.#abort.signal;
    // 模型块只能整块省略，不能编辑（I-6）：每个 hook 的输出都要检查
    const logged = modelBlocks(this.#state.messages);
    const unmodified = (messages: Message[]) => {
      // 投影里的模型块必须是日志中模型块的子序列：不能编辑、复制、调换顺序，也不能挪出 assistant 消息。
      // assistant 消息里只能有模型块，否则把模型块改个来源就能绕过检查
      let next = 0;
      for (const m of messages) {
        for (const b of m.content) {
          if (b.origin.by !== "model") {
            if (m.role === "assistant") throw new ModelOutputModified();
            continue;
          }
          if (m.role !== "assistant") throw new ModelOutputModified();
          const at = logged.indexOf(canonical(b), next);
          if (at < 0) throw new ModelOutputModified();
          next = at + 1;
        }
      }
    };
    const messages = await this.#transform("context.project", structuredClone(this.#state.messages), unmodified);
    let request: ModelRequest = {
      system: [],
      messages,
      // 拷贝 schema：hook 改了请求里的 schema 不能影响工具本身（关卡按它校验参数）
      tools: [...this.#tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: structuredClone(t.inputSchema),
      })),
    };
    request = await this.#transform("context.build", request, (r) => unmodified(r.messages));
    if (cacheOrderBroken(request.system)) this.#notify({ type: "warning", code: "cache-order" });
    request = await this.#transform("model.before", request, (r) => unmodified(r.messages));

    signal.throwIfAborted();
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    await this.#commit("model.requested", { requestHash }, RUNTIME);

    // 不理会 signal 的 provider 不能让中断一直等下去（I-9）：模型调用没有副作用，宽限期过后直接放弃，迟到的结果丢弃。
    // 工具不这样处理：工具可能还在改动外部状态，提前结束会让下一轮和它同时运行
    const res = await abortable(
      this.#provider.complete(request, {
        signal,
        onDelta: (delta) => this.#notify({ type: "delta", delta }),
      }),
      signal,
    );
    // I-6 的检查靠 origin 认出模型块，来源不对的块写进日志后就再也认不出来了（I-8）
    if (res.content.some((b) => b.origin?.by !== "model")) {
      throw new ProviderError(`provider ${res.provider ?? this.#provider.id} returned a block not attributed to the model`, {
        retryable: false,
      });
    }
    await this.#commit(
      "model.responded",
      { content: res.content, stopReason: res.stopReason, usage: res.usage },
      { by: "model", provider: res.provider ?? this.#provider.id, model: res.model },
    );
    this.#hooks.observe("model.after", structuredClone(res), this.#hookCtx);
  }

  async #decideTool(call: PendingCall): Promise<void> {
    if (!this.#tools.has(call.name)) {
      // 未知工具：内核不写说明文字（I-1），需要说明的话由关卡插件提供
      await this.#commit("tool.decided", { toolUseId: call.toolUseId, decision: "deny", input: call.input }, RUNTIME);
      return;
    }
    // tool.before 必须在 tool.gate 之前：关卡审的是最终参数（4.4）
    const final = await this.#transform(
      "tool.before",
      { toolUseId: call.toolUseId, name: call.name, input: structuredClone(call.input) },
      (out) => {
        if (out.toolUseId !== call.toolUseId) throw new ToolCallModified("toolUseId");
        if (out.name !== call.name) throw new ToolCallModified("name");
      },
    );
    const g = await this.#gate("tool.gate", {
      toolUseId: call.toolUseId,
      name: call.name,
      input: structuredClone(final.input),
      tool: toolInfo(this.#tools.get(call.name)!),
    });
    await this.#commit(
      "tool.decided",
      {
        toolUseId: call.toolUseId,
        decision: g.decision === "abstain" ? "allow" : g.decision,
        input: final.input,
        reason: g.reason,
        decidedBy: g.by,
      },
      RUNTIME,
    );
  }

  async #runTools(calls: PendingCall[]): Promise<void> {
    const run = async (c: PendingCall) => {
      const tool = this.#tools.get(c.name)!;
      const origin: Origin = { by: "tool", name: c.name };
      const signal = this.#abort.signal;
      // 依次执行时，前一个工具执行期间被中断，后面的不再启动
      signal.throwIfAborted();
      const sessionId = this.#state.sessionId;
      let content: Block[];
      let isError: boolean;
      let child: ChildRef | undefined;
      try {
        // 工具拿到的是拷贝，修改参数不会改到状态里的调用记录
        const r = await tool.execute(structuredClone(c.input), {
          sessionId,
          toolUseId: c.toolUseId,
          signal,
          parent: { sessionId, eventId: c.decidedAt! },
          progress: (update) => this.#notify({ type: "tool-progress", toolUseId: c.toolUseId, name: c.name, update }),
        });
        content = typeof r.content === "string" ? [{ kind: "text", text: r.content, origin, trust: "untrusted" }] : r.content;
        isError = r.isError ?? false;
        child = r.child;
      } catch (err) {
        if (signal.aborted) throw err;
        const text = err instanceof Error ? err.message : String(err);
        content = [{ kind: "text", text, origin, trust: "untrusted" }];
        isError = true;
      }
      const out = await this.#transform("tool.after", {
        call: { toolUseId: c.toolUseId, name: c.name, input: structuredClone(c.input) },
        content,
        isError,
      });
      if (child && !(await resolves(this.#store, child.sessionId, (e) => e.seq === child.seq))) {
        throw new UnresolvedRef(`child ${child.sessionId}@${child.seq}`);
      }
      await this.#commit("tool.completed", { toolUseId: c.toolUseId, content: out.content, isError: out.isError, child }, origin);
    };

    // 全部是 safe 的工具才并发，否则按模型给出的顺序依次执行（第六章）
    if (calls.every((c) => this.#tools.get(c.name)?.concurrency === "safe")) {
      const settled = await Promise.allSettled(calls.map(run));
      const failed = settled.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    } else {
      for (const c of calls) await run(c);
    }
  }

  /** 等到没有未完成的 observe，也没有排队中的写入。observe 写入的事件会再触发 observe，所以要循环 */
  async #settle(): Promise<void> {
    do {
      await this.#hooks.idle();
      await this.#writes;
    } while (this.#hooks.busy);
  }

  // ---------- 写入（单写者队列，I-10） ----------

  #commit<T extends CoreEventType>(type: T, data: EventDataMap[T], origin: Origin, depth = 0): Promise<void> {
    return this.#append(type, data, origin, depth);
  }

  /** depth：这个事件是 event observe 写入链上的第几层，0 表示不是由 event observe 写入的 */
  #append(type: string, data: unknown, origin: Origin, depth = 0): Promise<void> {
    // 调用时立即拷贝：工具、provider、插件可能还留着 data 的引用，之后再改不能影响日志和状态（I-5）
    data = structuredClone(data);
    const run = async () => {
      const event = {
        v: 1,
        id: this.#newId(),
        seq: this.#state.lastSeq + 1,
        at: this.#now(),
        type,
        data,
        origin,
      } as LogEvent;
      // 先校验状态转换，再落盘，落盘成功后才更新状态、交出 Effect
      const next = step(this.#state, event);
      await this.#store.append(this.#state.sessionId, [event]);
      this.#state = next.state;
      this.#queue.push(...next.effects);
      // 事件的 data 被状态引用着，订阅者拿到的是拷贝
      this.#notify({ type: "event", event: structuredClone(event) });
      // event observe 的写入会再触发 event observe。链条过长（例如插件对每个事件都写一条）时不再分发，
      // 否则 #settle 永远等不完
      if (depth > 0) this.#cascade++;
      if (depth < MAX_EVENT_DEPTH && this.#cascade <= MAX_CASCADE_EVENTS) {
        this.#hooks.observe("event", structuredClone(event), this.#ctxAt(depth + 1));
      } else if (!this.#cascadeWarned) {
        this.#cascadeWarned = true;
        this.#notify({ type: "warning", code: "event-loop" });
      }
    };
    const p = this.#writes.then(run);
    this.#writes = p.catch(() => {});
    return p;
  }

  // ---------- 辅助 ----------

  #hookCtx: HookContextFor = (plugin) => this.#ctxAt(0)(plugin);

  /** hook 上下文，写入的事件记为第 depth 层（见 #append） */
  #ctxAt(depth: number): HookContextFor {
    return (plugin) => {
      const origin: Origin = { by: "plugin", id: plugin };
      // 写日志的能力必须在 needs 中声明（8.2）
      const declared = (need: string) =>
        this.#needs.get(plugin)?.has(need) ? Promise.resolve() : Promise.reject(new PluginIncompatible(plugin, `requires capability ${need}`));
      return {
        sessionId: this.#state.sessionId,
        signal: this.#abort.signal,
        derived: structuredClone(this.#state.derived),
        record: (key, value) =>
          declared("log:record").then(() => this.#commit("derived.recorded", { key, value }, origin, depth)),
        emit: (type, data) => declared("log:emit").then(() => this.#append(`${plugin}/${type}`, data, origin, depth)),
      };
    };
  }

  #transform<P extends TransformPoint>(
    point: P,
    value: TransformPayloads[P],
    check?: (value: TransformPayloads[P]) => void,
  ) {
    return this.#hooks.transform(point, value, this.#hookCtx, check);
  }

  #gate<P extends GatePoint>(point: P, payload: GatePayloads[P]) {
    return this.#hooks.gate(point, payload, this.#hookCtx);
  }

  #call(toolUseId: string): PendingCall {
    const c = this.#state.batch.find((x) => x.toolUseId === toolUseId);
    if (!c) throw new Error(`unknown toolUseId ${toolUseId}`);
    return c;
  }

  #notify(n: RuntimeNotice): void {
    for (const fn of this.#listeners) {
      try {
        fn(n);
      } catch {
        // 订阅者的错误不影响运行
      }
    }
  }
}

/** 工具的声明部分，深拷贝，插件改了也不影响执行 */
function toolInfo(t: Tool): ToolInfo {
  const { name, description, inputSchema, effect, concurrency, idempotent } = t;
  return structuredClone({ name, description, inputSchema, effect, concurrency, idempotent });
}

/**
 * 中断后 p 在宽限期内结束的，照常返回它的结果或错误；超过宽限期就以 signal.reason 拒绝，不再等 p，
 * p 之后的结果或错误被丢弃
 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      timer = setTimeout(() => reject(signal.reason), ABORT_GRACE_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function resolves(store: LogStore, sessionId: string, match: (e: LogEvent) => boolean): Promise<boolean> {
  for await (const e of store.read(sessionId)) if (match(e)) return true;
  return false;
}

/** 消息中所有模型来源的块，按出现顺序，规范化的 JSON 表示（键排序，忽略键的顺序） */
function modelBlocks(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) for (const b of m.content) if (b.origin.by === "model") out.push(canonical(b));
  return out;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function cacheOrderBroken(system: SystemSegment[]): boolean {
  let seenVolatile = false;
  for (const seg of system) {
    if (seg.stability === "volatile") seenVolatile = true;
    else if (seenVolatile) return true;
  }
  return false;
}
