// 膜：所有跨插件的调用都经过这里（5.2）。负责归属、过期检查、错误包装。
// 作用域：所有注册都挂在作用域上，关闭时逆序撤销（4.1）。

import { AsyncLocalStorage } from "node:async_hooks";
import { PluginError, ServiceUnavailable, StaleContext, type Disposer } from "./api.ts";

export const DISPOSE_TIMEOUT_MS = 5000;

export class Scope {
  readonly plugin: string;
  #ctrl = new AbortController();
  /** owner：以谁的身份执行（提供者挂在调用方作用域上的清理函数属于提供者） */
  #disposers: { d: Disposer; owner?: Owner }[] = [];
  #closed = false;

  constructor(plugin: string) {
    this.plugin = plugin;
  }

  get signal(): AbortSignal {
    return this.#ctrl.signal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 登记清理函数，默认以本作用域的插件身份执行。作用域已关闭时抛 StaleContext */
  add(d: Disposer, owner?: Owner): void {
    if (this.#closed) throw new StaleContext(this.plugin);
    this.#disposers.push(owner ? { d, owner } : { d });
  }

  /** 中止 signal，逆序执行清理函数；每个最多等 DISPOSE_TIMEOUT_MS。返回清理时的错误，不抛出 */
  async close(timeoutMs = DISPOSE_TIMEOUT_MS): Promise<unknown[]> {
    if (this.#closed) return [];
    this.#closed = true;
    this.#ctrl.abort(new StaleContext(this.plugin));
    const errors: unknown[] = [];
    const self: Owner = { plugin: this.plugin, scope: this };
    for (const { d, owner = self } of this.#disposers.reverse()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const done = ambient.run(owner, d);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`dispose timed out after ${timeoutMs} ms`)), timeoutMs);
        });
        await Promise.race([done, timeout]);
      } catch (e) {
        errors.push(new PluginError(owner.plugin, "dispose", e));
      } finally {
        clearTimeout(timer);
      }
    }
    this.#disposers = [];
    return errors;
  }
}

/** 一段代码属于哪个插件的哪个作用域 */
export interface Owner {
  plugin: string;
  scope: Scope;
}

/** 当前正在执行的插件代码的归属；定时器、Promise 回调会继承它（node 下可靠，bun 下只有定时器可靠，见 5.3） */
export const ambient = new AsyncLocalStorage<Owner>();

const PASS_THROUGH = (e: unknown) => e instanceof PluginError || e instanceof StaleContext || e instanceof ServiceUnavailable;

/** 以 owner 的身份执行 fn：过期检查、归属、把错误包成 PluginError。结果里的函数和普通对象也归 owner */
export function invoke<T>(owner: Owner, where: string, fn: () => T): T {
  if (owner.scope.closed) throw new StaleContext(owner.plugin);
  const fail = (e: unknown) => {
    throw PASS_THROUGH(e) ? e : new PluginError(owner.plugin, where, e);
  };
  let result: T;
  try {
    result = ambient.run(owner, fn);
  } catch (e) {
    return fail(e);
  }
  if (result instanceof Promise) return result.then((v) => wrap(v, owner), fail) as T;
  return wrap(result, owner);
}

const MAX_DEPTH = 4;
const wrapped = new WeakSet<object>();

/**
 * 把值里的函数包成"属于 owner 的函数"：被别人调用时以 owner 身份执行，出错归 owner，owner 关闭后失效。
 * 只深入普通对象和数组；class 实例、Promise 等原样返回（对象的身份会变，见 5.2）
 */
export function wrap<T>(value: T, owner: Owner, depth = 0): T {
  if (typeof value === "function") {
    if (wrapped.has(value)) return value;
    const fn = value as unknown as (...args: unknown[]) => unknown;
    const out = function (this: unknown, ...args: unknown[]) {
      // 参数里的回调属于调用方
      const caller = ambient.getStore();
      const a = caller ? args.map((x) => wrap(x, caller)) : args;
      return invoke(owner, fn.name || "callback", () => fn.apply(this, a));
    };
    wrapped.add(out);
    return out as T;
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object" || wrapped.has(value)) return value;
  if (Array.isArray(value)) return value.map((x) => wrap(x, owner, depth + 1)) as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value)) out[k] = wrap(x, owner, depth + 1);
  return out as T;
}

/**
 * 调用方 caller 手里的服务句柄。每次访问检查：调用方没有过期、提供者仍然有效。
 * 方法以提供者身份执行，参数里的回调归调用方
 */
export function serviceHandle<T extends object>(service: string, impl: object, provider: Owner, caller: Owner, isLive: () => boolean): T {
  return new Proxy(Object.create(null) as T, {
    get(_, prop) {
      if (caller.scope.closed) throw new StaleContext(caller.plugin);
      if (!isLive()) throw new ServiceUnavailable(service, provider.plugin);
      const v = (impl as Record<string | symbol, unknown>)[prop];
      if (typeof v !== "function") return wrap(v, provider);
      const method = v as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (caller.scope.closed) throw new StaleContext(caller.plugin);
        if (!isLive()) throw new ServiceUnavailable(service, provider.plugin);
        const a = args.map((x) => wrap(x, caller));
        return invoke(provider, `${service}.${String(prop)}`, () => method.apply(impl, a));
      };
    },
    has(_, prop) {
      return prop in impl;
    },
    set() {
      throw new TypeError(`service ${service} is read-only`);
    },
  });
}
