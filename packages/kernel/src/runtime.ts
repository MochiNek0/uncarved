// 内存运行时：执行 Effect，把结果作为事件写回日志。对应宪法 4.2 ~ 4.5。

import { createHash } from "node:crypto";
import {
  HookBus,
  type GatePayloads,
  type GatePoint,
  type HookContext,
  type HookErrorInfo,
  type TransformPayloads,
  type TransformPoint,
} from "./hooks.ts";
import { checkCompat, type Plugin } from "./plugin.ts";
import { initialState, rebuild, step } from "./step.ts";
import { readAll, type LogStore } from "./store.ts";
import type {
  Block,
  CoreEventType,
  Delta,
  Effect,
  Event,
  EventDataMap,
  ModelRequest,
  Origin,
  PendingCall,
  PluginManifestEntry,
  Provider,
  SessionRef,
  State,
  SystemSegment,
  Tool,
  UserInput,
} from "./types.ts";

export type RuntimeNotice =
  | { type: "event"; event: Event }
  | { type: "delta"; delta: Delta }
  | { type: "awaiting"; toolUseIds: string[] }
  | { type: "warning"; code: "cache-order" }
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

const RUNTIME: Origin = { by: "runtime" };

export class Runtime {
  #state: State;
  #store: LogStore;
  #provider: Provider;
  #hooks: HookBus;
  #tools = new Map<string, Tool>();
  #manifest: PluginManifestEntry[];
  #now: () => string;
  #newId: () => string;

  #queue: Effect[] = [];
  #writes: Promise<void> = Promise.resolve();
  #listeners = new Set<(n: RuntimeNotice) => void>();
  #abort = new AbortController();
  #busy = false;

  private constructor(opts: RuntimeOptions, state: State) {
    this.#state = state;
    this.#store = opts.store;
    this.#provider = opts.provider;
    this.#now = opts.now ?? (() => new Date().toISOString());
    this.#newId = opts.newId ?? (() => crypto.randomUUID());
    this.#hooks = new HookBus((info) => this.#notify({ type: "hook-error", info }));

    const plugins = opts.plugins ?? [];
    for (const p of plugins) {
      checkCompat(p);
      for (const t of p.tools ?? []) {
        if (this.#tools.has(t.name)) throw new Error(`duplicate tool name ${t.name} (plugin ${p.id})`);
        this.#tools.set(t.name, t);
      }
      for (const h of p.hooks ?? []) this.#hooks.add(p.id, p.layer ?? "distro", h);
    }
    this.#manifest = plugins.map((p) => ({ id: p.id, version: p.version }));
  }

  static async create(opts: RuntimeOptions & { sessionId?: string; parent?: SessionRef }): Promise<Runtime> {
    const newId = opts.newId ?? (() => crypto.randomUUID());
    const rt = new Runtime(opts, initialState(opts.sessionId ?? newId()));
    await rt.#commit("session.started", { plugins: rt.#manifest, parent: opts.parent }, RUNTIME);
    rt.#hooks.observe("session.start", structuredClone(rt.#state), rt.#ctx());
    return rt;
  }

  /** 只凭日志重建状态。调用 recover() 才会继续执行未完成的工作 */
  static async resume(opts: RuntimeOptions & { sessionId: string }): Promise<Runtime> {
    const events = await readAll(opts.store, opts.sessionId);
    if (events.length === 0) throw new Error(`session ${opts.sessionId} not found`);
    return new Runtime(opts, rebuild(opts.sessionId, events));
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
    this.#enter();
    try {
      await this.#commit("input.received", input, { by: "user" });
      await this.#drive();
    } finally {
      this.#busy = false;
    }
  }

  /** 崩溃或重启后，继续执行日志里尚未完成的工作（4.5） */
  async recover(): Promise<void> {
    this.#enter();
    try {
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
            if (this.#tools.get(c.name)?.idempotent) rerun.push(c.toolUseId);
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
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    await this.#commit("session.ended", {}, RUNTIME);
    this.#hooks.observe("session.end", structuredClone(this.#state), this.#ctx());
  }

  // ---------- 驱动 ----------

  #enter(): void {
    if (this.#busy) throw new RuntimeBusy();
    this.#busy = true;
    if (this.#abort.signal.aborted) this.#abort = new AbortController();
  }

  async #drive(): Promise<void> {
    try {
      while (this.#queue.length > 0) await this.#execute(this.#queue.shift()!);
    } catch (err) {
      this.#queue.length = 0;
      const phase = this.#state.phase;
      if (phase !== "new" && phase !== "idle" && phase !== "ended") {
        const error = err instanceof Error ? err.message : String(err);
        await this.#commit("turn.ended", { reason: "error", error }, RUNTIME);
      }
      throw err;
    }
  }

  async #execute(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "CallModel":
        return this.#callModel();
      case "DecideTools":
        for (const id of effect.toolUseIds) await this.#decideTool(this.#call(id));
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
    const ctx = this.#ctx();
    const messages = await this.#transform("context.project", structuredClone(this.#state.messages));
    let request: ModelRequest = {
      system: [],
      messages,
      tools: [...this.#tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
    request = await this.#transform("context.build", request);
    if (cacheOrderBroken(request.system)) this.#notify({ type: "warning", code: "cache-order" });
    request = await this.#transform("model.before", request);

    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    await this.#commit("model.requested", { requestHash }, RUNTIME);

    const res = await this.#provider.complete(request, {
      signal: ctx.signal,
      onDelta: (delta) => this.#notify({ type: "delta", delta }),
    });
    await this.#commit(
      "model.responded",
      { content: res.content, stopReason: res.stopReason, usage: res.usage },
      { by: "model", provider: this.#provider.id, model: res.model },
    );
    this.#hooks.observe("model.after", structuredClone(res), ctx);
  }

  async #decideTool(call: PendingCall): Promise<void> {
    if (!this.#tools.has(call.name)) {
      // 未知工具：内核不写说明文字（I-1），需要说明的话由关卡插件提供
      await this.#commit("tool.decided", { toolUseId: call.toolUseId, decision: "deny", input: call.input }, RUNTIME);
      return;
    }
    // tool.before 必须在 tool.gate 之前：关卡审的是最终参数（4.4）
    const final = await this.#transform("tool.before", {
      toolUseId: call.toolUseId,
      name: call.name,
      input: structuredClone(call.input),
    });
    const g = await this.#gate("tool.gate", final);
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
      const ctx = this.#ctx();
      let content: Block[];
      let isError: boolean;
      try {
        const r = await tool.execute(c.input, { sessionId: this.#state.sessionId, toolUseId: c.toolUseId, signal: ctx.signal });
        content = typeof r.content === "string" ? [{ kind: "text", text: r.content, origin, trust: "untrusted" }] : r.content;
        isError = r.isError ?? false;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const text = err instanceof Error ? err.message : String(err);
        content = [{ kind: "text", text, origin, trust: "untrusted" }];
        isError = true;
      }
      const out = await this.#transform("tool.after", {
        call: { toolUseId: c.toolUseId, name: c.name, input: c.input },
        content,
        isError,
      });
      await this.#commit("tool.completed", { toolUseId: c.toolUseId, content: out.content, isError: out.isError }, origin);
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

  // ---------- 写入（单写者队列，I-10） ----------

  #commit<T extends CoreEventType>(type: T, data: EventDataMap[T], origin: Origin): Promise<void> {
    const run = async () => {
      const event = {
        v: 1,
        id: this.#newId(),
        seq: this.#state.lastSeq + 1,
        at: this.#now(),
        type,
        data,
        origin,
      } as Event;
      // 先校验状态转换，再落盘，落盘成功后才更新状态、交出 Effect
      const next = step(this.#state, event);
      await this.#store.append(this.#state.sessionId, [event]);
      this.#state = next.state;
      this.#queue.push(...next.effects);
      this.#notify({ type: "event", event });
      this.#hooks.observe("event", structuredClone(event), this.#ctx());
    };
    const p = this.#writes.then(run);
    this.#writes = p.catch(() => {});
    return p;
  }

  // ---------- 辅助 ----------

  #ctx(): HookContext {
    return { sessionId: this.#state.sessionId, signal: this.#abort.signal };
  }

  #transform<P extends TransformPoint>(point: P, value: TransformPayloads[P]) {
    return this.#hooks.transform(point, value, this.#ctx());
  }

  #gate<P extends GatePoint>(point: P, payload: GatePayloads[P]) {
    return this.#hooks.gate(point, payload, this.#ctx());
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

function cacheOrderBroken(system: SystemSegment[]): boolean {
  let seenVolatile = false;
  for (const seg of system) {
    if (seg.stability === "volatile") seenVolatile = true;
    else if (seenVolatile) return true;
  }
  return false;
}
