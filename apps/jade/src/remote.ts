// 进程外插件的桥（第 6 节）：启动插件进程，把它包成一个普通的 PluginModule。
// 核心的其余部分不知道插件在进程外：服务、注册、作用域、膜、隔离都和进程内插件一样。
//
// 协议方法和具体服务无关：
//   宿主 → 插件：initialize、scope/open、scope/close、call，通知 caller/open、caller/close、$/cancel
//   插件 → 宿主：provide、kernel/tool、kernel/hook、secrets/get、secrets/set、call（target 是服务名、"$session" 或函数句柄）
// 值里的函数表示成句柄 { "$fn": id }，对方用 call 调用它。句柄属于一个作用域，作用域关闭后失效。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookContext, RemoteHookSpec, ToolResult } from "uncarved";
import { API_VERSION, type Caller, type PluginModule, type PluginSource, type ProcessContext, type ScopeContext, type SessionContext } from "./api.ts";
import { ambient, type Owner } from "./membrane.ts";
import { Rpc } from "./rpc.ts";

/** 插件进程启动后多久内要回复 initialize */
export const INIT_TIMEOUT_MS = 10_000;
/** 关闭时等插件进程自己退出的时间，之后强制结束 */
const EXIT_GRACE_MS = 2000;
/** Python SDK（单文件 jade_plugin.py）所在目录，加进插件进程的 PYTHONPATH */
const PYTHON_SDK = fileURLToPath(new URL("../sdk/python", import.meta.url));
/** 插件进程退出时附在原因后面的 stderr 行数 */
const STDERR_TAIL = 5;

export interface RemoteOptions {
  report(message: string): void;
  /** 插件进程意外退出（不是宿主关闭它） */
  exited(reason: string): void;
}

type Fn = (...args: unknown[]) => unknown;
type Handle = { $fn: string };
const isHandle = (v: unknown): v is Handle =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as Handle).$fn === "string" && Object.keys(v).length === 1;

/** 插件在 initialize 里的回复 */
interface InitReply {
  id?: string;
  /** 插件有会话级部分；没有就不为它打开会话作用域 */
  session?: boolean;
}

export async function startRemote(source: PluginSource, owner: Owner, opts: RemoteOptions): Promise<PluginModule> {
  const { manifest, dir } = source;
  const id = manifest.id;
  const { command, args = [] } = manifest.runtime!;
  const env = { ...process.env, PYTHONPATH: [PYTHON_SDK, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
  // 插件进程的工作目录是插件目录，所以清单里可以写 "args": ["main.py"]；jade 的工作目录在 scope/open 里给
  const child = spawn(/^\.\.?[\\/]/.test(command) ? path.resolve(dir, command) : command, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  /** 打开的作用域：id → ctx。进程级的 id 是 "process" */
  const scopes = new Map<string, ScopeContext>();
  /** 交给插件的宿主函数：句柄 → 函数；按作用域分组，作用域关闭时释放 */
  const local = new Map<string, Fn>();
  const buckets = new Map<string, Set<string>>();
  let next = 1;
  let closing = false;
  const stderr: string[] = [];

  const encode = (v: unknown, scope: string, depth = 0): unknown => {
    if (typeof v === "function") {
      const h = `h${next++}`;
      local.set(h, v as Fn);
      buckets.get(scope)?.add(h);
      return { $fn: h };
    }
    if (depth > 32 || typeof v !== "object" || v === null) return v;
    if (Array.isArray(v)) return v.map((x) => encode(x, scope, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v; // class 实例按 JSON 序列化
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x, scope, depth + 1)]));
  };
  const decode = (v: unknown, scope: string): unknown => {
    if (isHandle(v)) return remoteFn(v.$fn, scope);
    if (typeof v !== "object" || v === null) return v;
    if (Array.isArray(v)) return v.map((x) => decode(x, scope));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, scope)]));
  };
  /** 插件的函数：调用时经 call 发给插件 */
  const remoteFn = (fn: string, scope: string): Fn => {
    return (...a: unknown[]) => {
      if (!scopes.has(scope)) throw new Error(`a function of plugin ${id} was called after its scope closed`);
      return rpc.request("call", { scope, target: { $fn: fn }, args: encode(a, scope) }).then((r) => decode(r, scope));
    };
  };

  const rpc = new Rpc(
    (line) => child.stdin.write(line),
    (method, params, signal) => ambient.run(owner, () => serve(method, (params ?? {}) as Record<string, unknown>, signal)),
  );
  rpc.onGarbage = (line) => opts.report(`plugin ${id}: ignored a line on stdout that is not a protocol message (write logs to stderr): ${line.slice(0, 200)}`);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => rpc.feed(d));
  child.stdin.on("error", () => {}); // 进程已退出时写入失败，由 exit 处理
  let errBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    errBuf += d;
    for (let i = errBuf.indexOf("\n"); i !== -1; i = errBuf.indexOf("\n")) {
      const line = errBuf.slice(0, i).replace(/\r$/, "");
      errBuf = errBuf.slice(i + 1);
      if (!line.trim()) continue;
      stderr.push(line);
      if (stderr.length > STDERR_TAIL) stderr.shift();
      opts.report(`plugin ${id}: ${line}`);
    }
  });
  const exited = new Promise<void>((resolve) => {
    child.on("error", (e) => {
      rpc.close(new Error(`cannot start "${command}": ${e.message}`));
      resolve();
    });
    child.on("exit", (code, signal) => {
      const reason = `its process exited (${signal ?? `code ${code}`})`;
      rpc.close(new Error(stderr.length > 0 ? `${reason}; stderr: ${stderr.join(" | ")}` : reason));
      if (!closing) opts.exited(reason);
      resolve();
    });
  });

  // 宿主关闭插件（退出、隔离、激活失败）时结束进程。最先登记，所以在进程级作用域里最后执行
  owner.scope.add(async () => {
    closing = true;
    await closeScope("process");
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), EXIT_GRACE_MS);
    await exited;
    clearTimeout(timer);
  });

  async function openScope(scope: string, kind: "process" | "session", ctx: ScopeContext, extra: object): Promise<void> {
    scopes.set(scope, ctx);
    buckets.set(scope, new Set());
    await rpc.request("scope/open", { scope, kind, cwd: ctx.cwd, home: ctx.home, config: ctx.config, ...extra });
  }

  async function closeScope(scope: string): Promise<void> {
    if (!scopes.delete(scope)) return;
    for (const h of buckets.get(scope) ?? []) local.delete(h);
    buckets.delete(scope);
    try {
      await rpc.request("scope/close", { scope });
    } catch {
      // 进程已经退出，或者插件清理时出错：作用域在宿主这边已经关了
    }
  }

  /** 插件发来的请求 */
  async function serve(method: string, p: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const scope = String(p.scope);
    const ctx = scopes.get(scope);
    if (!ctx) throw new Error(`scope ${scope} is not open`);
    switch (method) {
      case "provide": {
        if (scope !== "process") throw new Error("services can only be provided in the process scope");
        const service = String(p.service);
        const methods = p.methods;
        if (!Array.isArray(methods) || methods.some((m) => typeof m !== "string" || m === "then")) throw new Error("provide: methods must be a list of method names");
        const build = (caller?: string) =>
          Object.fromEntries(
            (methods as string[]).map((m) => [
              m,
              (...a: unknown[]) => rpc.request("call", { scope, target: service, method: m, args: encode(a, scope), ...(caller ? { caller } : {}) }).then((r) => decode(r, scope)),
            ]),
          );
        // 按调用方创建实例：插件那边收到 caller/open 时用工厂创建，caller/close 时撤销这个调用方的注册
        const perCaller = (caller: Caller) => {
          const c = `c${next++}`;
          rpc.notify("caller/open", { service, caller: { id: c, plugin: caller.plugin, layer: caller.layer } });
          caller.onDispose(() => rpc.notify("caller/close", { caller: c }));
          return build(c);
        };
        (ctx as ProcessContext).provide(service, p.perCaller === true ? perCaller : build());
        return null;
      }
      case "kernel/tool": {
        const t = (p.tool ?? {}) as Record<string, unknown>;
        if (!isHandle(p.execute)) throw new Error("kernel/tool: execute must be a function handle");
        if (t.effect !== "read" && t.effect !== "write" && t.effect !== "external") throw new Error(`kernel/tool ${String(t.name)}: effect must be "read", "write" or "external"`);
        const fn = p.execute.$fn;
        (ctx as SessionContext).kernel.tool({
          name: String(t.name),
          description: String(t.description ?? ""),
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
          effect: t.effect,
          concurrency: t.concurrency === "safe" ? "safe" : "exclusive",
          idempotent: t.idempotent === true,
          execute: async (input, tctx) => {
            const r = await rpc.request("call", { scope, target: { $fn: fn }, args: [input, { sessionId: tctx.sessionId, toolUseId: tctx.toolUseId }] }, tctx.signal);
            return (typeof r === "string" ? { content: r } : r) as ToolResult;
          },
        });
        return null;
      }
      case "kernel/hook": {
        const h = (p.hook ?? {}) as Record<string, unknown>;
        if (!isHandle(p.fn)) throw new Error("kernel/hook: fn must be a function handle");
        const fn = p.fn.$fn;
        // 字段裁剪、回复检查、超时由内核保证（RemoteHookSpec）
        const spec = {
          kind: h.kind,
          point: h.point,
          remote: true,
          reads: h.reads,
          writes: h.writes ?? [],
          timeoutMs: h.timeoutMs,
          ...(typeof h.order === "number" ? { order: h.order } : {}),
          call: (payload: Record<string, unknown>, hctx: HookContext) => rpc.request("call", { scope, target: { $fn: fn }, args: [payload] }, hctx.signal),
        } as RemoteHookSpec;
        (ctx as SessionContext).kernel.hook(spec);
        return null;
      }
      case "secrets/get": {
        if (typeof p.key !== "string") throw new Error("secrets/get: key must be a string");
        return (await ctx.secrets.get(p.key)) ?? null;
      }
      case "secrets/set": {
        if (typeof p.key !== "string") throw new Error("secrets/set: key must be a string");
        if (p.value !== null && typeof p.value !== "string") throw new Error("secrets/set: value must be a string or null");
        await ctx.secrets.set(p.key, p.value === null ? undefined : p.value);
        return null;
      }
      case "call": {
        const a = decode(p.args ?? [], scope);
        if (!Array.isArray(a)) throw new Error("call: args must be a list");
        const target = p.target;
        let result: unknown;
        if (isHandle(target)) {
          const f = local.get(target.$fn);
          if (!f) throw new Error(`function ${target.$fn} is no longer valid`);
          result = await f(...a);
        } else if (target === "$session") {
          const session = (ctx as SessionContext).session;
          if (!session) throw new Error("$session is only available in a session scope");
          if (p.method === "send") result = await session.send(a[0] as Parameters<typeof session.send>[0]);
          else if (p.method === "afterTurn") session.afterTurn(a[0] as () => void);
          else throw new Error(`$session has no method ${String(p.method)}`);
        } else if (typeof target === "string") {
          const service = ctx.service<Record<string, unknown>>(target);
          if (!service) throw new Error(`service ${target} is not available`);
          const m = service[String(p.method)];
          if (typeof m !== "function") throw new Error(`service ${target} has no method ${String(p.method)}`);
          result = await (m as Fn)(...a);
        } else {
          throw new Error("call: target must be a service name, \"$session\" or a function handle");
        }
        if (signal.aborted) throw signal.reason;
        return encode(result, scope);
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  let init: InitReply;
  try {
    init = ((await rpc.request("initialize", { plugin: id, version: manifest.version, api: API_VERSION }, AbortSignal.timeout(INIT_TIMEOUT_MS))) ?? {}) as InitReply;
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new Error(`"${command}" did not answer initialize within ${INIT_TIMEOUT_MS / 1000} s`);
    throw e;
  }
  if (init.id !== undefined && init.id !== id) throw new Error(`the process says it is plugin ${init.id}, but plugin.json says ${id}`);

  let sessions = 0;
  return {
    async process(ctx) {
      await openScope("process", "process", ctx, {});
    },
    ...(init.session
      ? {
          async session(ctx: SessionContext) {
            const scope = `s${++sessions}`;
            // 先登记关闭：插件在 scope/open 里出错时，宿主撤销这个作用域，插件那边也要清理
            await ctx.effect(() => () => closeScope(scope));
            await openScope(scope, "session", ctx, { session: { id: ctx.session.id } });
          },
        }
      : {}),
  };
}
