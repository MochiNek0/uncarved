// 扩展点与组合规则。对应宪法第五章。

import { isRemote, toLocalHook, type RemoteHookSpec } from "./remote.ts";
import type { Awaitable, Event, GatedToolCall, Message, ModelRequest, ModelResponse, State, ToolCall, ToolOutcome } from "./types.ts";

export interface TransformPayloads {
  "context.project": Message[];
  "context.build": ModelRequest;
  "model.before": ModelRequest;
  "tool.before": ToolCall;
  "tool.after": ToolOutcome;
}

export interface GatePayloads {
  /** 最终参数和被调用工具的声明（effect、schema 等），供权限插件判断（4.4） */
  "tool.gate": GatedToolCall;
  "turn.continue": State;
}

export interface ObservePayloads {
  "session.start": State;
  "session.end": State;
  "model.after": ModelResponse;
  event: Event;
}

export type TransformPoint = keyof TransformPayloads;
export type GatePoint = keyof GatePayloads;
export type ObservePoint = keyof ObservePayloads;

export type GateDecision = "deny" | "ask" | "allow" | "abstain";

export interface GateResult {
  decision: GateDecision;
  /** 拒绝时交给模型看的说明，由插件提供（I-1） */
  reason?: string;
}

export interface HookContext {
  sessionId: string;
  signal: AbortSignal;
  /** derived.recorded 累积的派生数据快照 */
  derived: Readonly<Record<string, unknown>>;
  /** 把插件产生的派生数据写入日志（derived.recorded），resolve 之后才能使用它（I-5） */
  record(key: string, value: unknown): Promise<void>;
  /** 写入插件自定义事件，类型会加上 `<plugin-id>/` 前缀（3.2） */
  emit(type: string, data: unknown): Promise<void>;
}

/** 为某个插件生成它的 hook 上下文 */
export type HookContextFor = (plugin: string) => HookContext;

interface HookCommon {
  order?: number;
  timeoutMs?: number;
}

/** 进程内 hook */
export type LocalHookSpec =
  | {
      [P in TransformPoint]: HookCommon & {
        kind: "transform";
        point: P;
        /** 出错或超时时跳过，而不是让本轮失败 */
        optional?: boolean;
        fn: (value: TransformPayloads[P], ctx: HookContext) => Awaitable<TransformPayloads[P] | void>;
      };
    }[TransformPoint]
  | {
      [P in GatePoint]: HookCommon & {
        kind: "gate";
        point: P;
        fn: (payload: GatePayloads[P], ctx: HookContext) => Awaitable<GateResult>;
      };
    }[GatePoint]
  | {
      [P in ObservePoint]: HookCommon & {
        kind: "observe";
        point: P;
        fn: (payload: ObservePayloads[P], ctx: HookContext) => Awaitable<void>;
      };
    }[ObservePoint];

export type HookSpec = LocalHookSpec | RemoteHookSpec;

/** 配置层级，后面的覆盖前面的（5.3） */
export const LAYERS = ["builtin", "distro", "user", "project", "session"] as const;
export type Layer = (typeof LAYERS)[number];

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

export class HookTimeout extends Error {
  constructor() {
    super("hook timed out");
    this.name = "HookTimeout";
  }
}

export class HookFailure extends Error {
  readonly plugin: string;
  readonly point: string;
  constructor(plugin: string, point: string, cause: unknown) {
    super(`hook ${plugin} at ${point} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "HookFailure";
    this.plugin = plugin;
    this.point = point;
  }
}

/** hook 已返回或已超时之后才调用 record/emit（5.1） */
export class HookExpired extends Error {
  constructor() {
    super("hook already returned or timed out; record/emit must be awaited inside the hook");
    this.name = "HookExpired";
  }
}

export interface HookErrorInfo {
  plugin: string;
  point: string;
  error: unknown;
}

interface Registered {
  plugin: string;
  layer: Layer;
  index: number;
  spec: LocalHookSpec;
}

type AnyFn = (payload: unknown, ctx: HookContext) => Awaitable<unknown>;

const GATE_RANK: Record<GateDecision, number> = { deny: 3, ask: 2, allow: 1, abstain: 0 };

export class HookBus {
  #hooks: Registered[] = [];
  #onError: (info: HookErrorInfo) => void;
  #pending = new Set<Promise<void>>();

  constructor(onError: (info: HookErrorInfo) => void) {
    this.#onError = onError;
  }

  /** 进程外 hook 须先通过 checkRemoteHook（见 checkCompat），这里转成等价的进程内 hook */
  add(plugin: string, layer: Layer, spec: HookSpec): void {
    this.#hooks.push({ plugin, layer, index: this.#hooks.length, spec: isRemote(spec) ? toLocalHook(spec) : spec });
  }

  /** 某个扩展点上的实际执行顺序（5.3） */
  ordered(point: string): Registered[] {
    return this.#hooks
      .filter((h) => h.spec.point === point)
      .sort(
        (a, b) =>
          (a.spec.order ?? 0) - (b.spec.order ?? 0) ||
          LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) ||
          a.index - b.index,
      );
  }

  async transform<P extends TransformPoint>(
    point: P,
    value: TransformPayloads[P],
    ctx: HookContextFor,
    /** 对每个 hook 的输出做检查，抛错视同该 hook 出错 */
    check?: (value: TransformPayloads[P]) => void,
  ): Promise<TransformPayloads[P]> {
    // 每个 hook 拿到一份拷贝：出错被跳过的 hook 原地改过的值不会留下来，
    // 超时后仍在运行、或留着引用的 hook 也改不到之后的值
    let ran = false;
    for (const h of this.ordered(point)) {
      if (h.spec.kind !== "transform") continue;
      ran = true;
      try {
        const input = structuredClone(value);
        const out = await invoke(h.spec.fn as AnyFn, input, ctx(h.plugin), h.spec.timeoutMs);
        const next = out === undefined ? input : (out as TransformPayloads[P]);
        check?.(next);
        value = next;
      } catch (error) {
        if (h.spec.optional) {
          this.#onError({ plugin: h.plugin, point, error });
          continue;
        }
        throw new HookFailure(h.plugin, point, error);
      }
    }
    // 最后一个 hook 可能还留着它返回的值；check 与这里之间没有 await，拷贝的正是检查过的内容
    return ran ? structuredClone(value) : value;
  }

  /** 全部执行后合并：deny > ask > allow > abstain；出错、超时或返回值不合法视为 deny */
  async gate<P extends GatePoint>(
    point: P,
    payload: GatePayloads[P],
    ctx: HookContextFor,
  ): Promise<GateResult & { by?: string }> {
    const hooks = this.ordered(point).filter((h) => h.spec.kind === "gate");
    const results = await Promise.all(
      hooks.map(async (h) => {
        try {
          // 每个 gate 一份拷贝：并发执行时，一个 gate 改了 payload 不能影响其他 gate 看到的内容
          const r = (await invoke(h.spec.fn as AnyFn, structuredClone(payload), ctx(h.plugin), h.spec.timeoutMs)) as GateResult;
          if (!r || !Object.hasOwn(GATE_RANK, r.decision)) throw new Error(`invalid gate result ${JSON.stringify(r)}`);
          return { ...r, by: h.plugin };
        } catch (error) {
          this.#onError({ plugin: h.plugin, point, error });
          return { decision: "deny" as const, by: h.plugin };
        }
      }),
    );
    let best: GateResult & { by?: string } = { decision: "abstain" };
    for (const r of results) if (GATE_RANK[r.decision] > GATE_RANK[best.decision]) best = r;
    return best;
  }

  /** 并发执行，调用方不等待，错误只记录。未完成的 observe 由 idle() 等待 */
  observe<P extends ObservePoint>(point: P, payload: ObservePayloads[P], ctx: HookContextFor): void {
    for (const h of this.ordered(point)) {
      if (h.spec.kind !== "observe") continue;
      const p = invoke(h.spec.fn as AnyFn, payload, ctx(h.plugin), h.spec.timeoutMs).then(
        () => {},
        (error) => this.#onError({ plugin: h.plugin, point, error }),
      );
      this.#pending.add(p);
      void p.finally(() => this.#pending.delete(p));
    }
  }

  get busy(): boolean {
    return this.#pending.size > 0;
  }

  /** 等待当前所有 observe 结束（每个都受超时约束） */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }
}

async function invoke(fn: AnyFn, payload: unknown, ctx: HookContext, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {
  const ac = new AbortController();
  const forward = () => ac.abort(ctx.signal.reason);
  // 已经中断的信号不会再触发 abort 事件
  if (ctx.signal.aborted) forward();
  else ctx.signal.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // hook 返回或超时之后，它的写入一律拒绝：保证"所有 hook 结束"即"不会再有插件写入"
  let done = false;
  const live = <A extends unknown[]>(write: (...args: A) => Promise<void>) =>
    (...args: A) => (done ? Promise.reject(new HookExpired()) : write(...args));
  const scoped: HookContext = { ...ctx, signal: ac.signal, record: live(ctx.record), emit: live(ctx.emit) };
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(payload, scoped)),
      new Promise<never>((_, reject) => {
        // setTimeout 超过 2^31-1 毫秒会当成 1 毫秒，截到上限
        timer = setTimeout(() => {
          ac.abort();
          reject(new HookTimeout());
        }, Math.min(timeoutMs, MAX_TIMER_MS));
      }),
    ]);
  } finally {
    done = true;
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", forward);
  }
}
