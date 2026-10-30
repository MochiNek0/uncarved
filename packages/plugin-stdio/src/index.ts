// 进程外插件的 stdio 传输：JSON-RPC 2.0，一行一条消息。
// 设计见 docs/design/5.5-out-of-process-hooks.md。字段裁剪、超时等约束由内核保证，这里只负责传输。

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  asProjectPlugin,
  checkCompat,
  KERNEL_VERSION,
  hashDir,
  requireTrust,
  type HookContext,
  type Layer,
  type Plugin,
  type RemoteHookSpec,
  type TrustGrant,
  type TrustOptions,
} from "uncarved";

export interface SpawnOptions {
  command: string;
  args?: string[];
  /** 追加到当前进程环境变量之上；inheritEnv 为 false 时就是插件的全部环境变量 */
  env?: Record<string, string>;
  /**
   * 默认 true：插件继承宿主的全部环境变量，包括 API key 之类的密钥。
   * false 时只传 env 里的变量，需要的 PATH 等要自己放进 env
   */
  inheritEnv?: boolean;
  cwd?: string;
  /** 默认 "distro"。"project" 时必须提供 trust，启动前先确认（7.1） */
  layer?: Layer;
  /** 确认的内容：启动规格 + dir 目录的内容哈希 */
  trust?: TrustOptions & { dir: string };
  /** 等待 initialize 回复的时间，默认 10 秒 */
  initTimeoutMs?: number;
  /**
   * 插件发来的单条消息（一行）的上限，超过时结束插件进程。默认 64 MiB。
   * 也是发给插件、插件还没读走的数据的上限：插件不读 stdin 时数据会堆在宿主内存里，超过时同样结束进程
   */
  maxMessageBytes?: number;
  /** 插件进程的 stderr，不属于协议 */
  onStderr?: (text: string) => void;
}

export interface StdioPlugin extends Plugin {
  /** 进程退出时 resolve。内核不自动重启，是否重新启动由发行版决定 */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  close(): Promise<void>;
}

export class PluginProcessError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PluginProcessError";
  }
}

const SHUTDOWN_GRACE_MS = 2_000;
/** 进程退出后等 stdout 读完的最长时间：孙进程可能继承了 stdout，管道迟迟不关 */
const EXIT_DRAIN_MS = 1_000;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export async function spawnPlugin(opts: SpawnOptions): Promise<StdioPlugin> {
  const layer = opts.layer ?? "distro";
  let grant: TrustGrant | undefined;
  if (layer === "project") {
    if (!opts.trust) throw new PluginProcessError("project-layer plugins require trust options");
    const described = await describeForTrust(opts, opts.trust.dir);
    grant = await requireTrust(described, opts.trust);
    // 等用户确认可能要很久，期间目录可能被改：确认的必须就是要启动的内容
    if ((await describeForTrust(opts, opts.trust.dir)).hash !== described.hash) {
      throw new PluginProcessError(`plugin directory ${described.path} changed while waiting for confirmation`);
    }
  }

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.inheritEnv === false ? { ...opts.env } : mergeEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // POSIX 上让插件自成一个进程组，结束时连同它启动的子进程一起结束（见 terminate）
    detached: process.platform !== "win32",
  });
  const conn = new Connection(child, opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, opts.onStderr);

  try {
    const manifest = parseManifest(await conn.request("initialize", { kernel: KERNEL_VERSION }, AbortSignal.timeout(opts.initTimeoutMs ?? 10_000)).result);

    const plugin: StdioPlugin = {
      id: manifest.id,
      version: manifest.version,
      kernel: manifest.kernel,
      needs: manifest.needs,
      resume: manifest.resume,
      layer,
      hooks: manifest.hooks.map(
        // 声明原样交给内核检查（包括 optional 这类不允许的字段），传输层不替插件"修正"声明
        ({ name, ...declared }): RemoteHookSpec => ({
          ...declared,
          remote: true,
          call: async (payload, ctx) => {
            const { id, result } = conn.request("hook", { hook: name, sessionId: ctx.sessionId, payload }, ctx.signal);
            conn.active.set(id, ctx);
            try {
              return await result;
            } finally {
              conn.active.delete(id);
            }
          },
        }),
      ),
      exited: conn.exited,
      close: () => conn.close(),
    };
    checkCompat(plugin);
    return (grant ? asProjectPlugin(plugin, grant) : plugin) as StdioPlugin;
  } catch (err) {
    terminate(child);
    throw err;
  }
}

/** Windows 的环境变量名不区分大小写：覆盖 PATH 时要去掉 process.env 里写作 Path 的那一项，否则哪个生效取决于顺序 */
function mergeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") {
    const keys = new Set(Object.keys(extra).map((k) => k.toUpperCase()));
    for (const k of Object.keys(env)) if (keys.has(k.toUpperCase())) delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * 先 SIGTERM，宽限期后还没退出就 SIGKILL：插件可能忽略 SIGTERM（Windows 上本来就是直接结束）。
 * 信号发给整个进程树：插件经 sh -c、npx 这类包装命令启动时，只结束直接子进程会留下真正的插件进程
 */
function terminate(child: ChildProcess): void {
  killTree(child, "SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
  }, SHUTDOWN_GRACE_MS).unref();
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill /T 按父子关系结束整棵树，必须在直接子进程退出之前执行
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  try {
    // 负的 pid 表示进程组（spawn 时 detached，插件是组长）
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** 启动规格（命令、参数、按键排序的环境变量、是否继承宿主环境变量、工作目录）与插件目录内容一起计算哈希 */
async function describeForTrust(opts: SpawnOptions, dir: string) {
  const root = path.resolve(dir);
  const content = await hashDir(root);
  const env = Object.fromEntries(Object.entries(opts.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // 工作目录决定命令和参数里的相对路径指向哪里
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  // 继承宿主环境变量意味着插件能拿到宿主的密钥，确认的内容要包括这一点
  const spec = JSON.stringify({ command: opts.command, args: opts.args ?? [], env, inheritEnv: opts.inheritEnv !== false, cwd });
  const hash = createHash("sha256").update(spec).update("\0").update(content.hash).digest("hex");
  return { path: root, hash, files: content.files };
}

// ---------- 插件清单 ----------

interface Manifest {
  id: string;
  version: string;
  kernel: string;
  needs?: string[];
  resume?: Plugin["resume"];
  hooks: Array<Pick<RemoteHookSpec, "kind" | "point" | "reads" | "writes" | "timeoutMs" | "order"> & { name: string }>;
}

function parseManifest(v: unknown): Manifest {
  const m = v as Manifest;
  const strings = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === "string");
  const ok =
    m !== null &&
    typeof m === "object" &&
    typeof m.id === "string" &&
    typeof m.version === "string" &&
    typeof m.kernel === "string" &&
    (m.needs === undefined || strings(m.needs)) &&
    Array.isArray(m.hooks) &&
    m.hooks.every(
      (h) =>
        h !== null &&
        typeof h === "object" &&
        typeof h.name === "string" &&
        typeof h.kind === "string" &&
        typeof h.point === "string" &&
        strings(h.reads) &&
        strings(h.writes) &&
        typeof h.timeoutMs === "number" &&
        (h.order === undefined || typeof h.order === "number"),
    );
  if (!ok) throw new PluginProcessError("invalid initialize reply");
  return m;
}

// ---------- JSON-RPC 连接 ----------

type Id = number | string;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

class Connection {
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /** 进行中的 hook 调用；插件只能在调用期间使用 log/record、log/emit（7.3），能力由内核检查（8.2） */
  readonly active = new Map<Id, HookContext>();

  #child: ChildProcess;
  #maxBytes: number;
  /** 管道写满（write 返回 false）后、drain 之前写入的字节数。不用 writableLength：Bun 上它一直是 0 */
  #backlog = 0;
  #nextId = 1;
  #pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #dead: Error | undefined;

  constructor(child: ChildProcess, maxMessageBytes: number, onStderr?: (text: string) => void) {
    this.#child = child;
    this.#maxBytes = maxMessageBytes;
    child.stdin!.on("error", () => {}); // 进程退出后写入失败，由 exit 统一处理
    child.stdin!.on("drain", () => (this.#backlog = 0));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => onStderr?.(text));

    this.exited = new Promise((resolve) => {
      const done = (code: number | null, signal: string | null, why: string) => {
        if (this.#dead) return;
        this.#dead = new PluginProcessError(why);
        for (const p of this.#pending.values()) p.reject(this.#dead);
        this.#pending.clear();
        resolve({ code, signal });
      };
      const exited = (code: number | null, signal: string | null) => done(code, signal, `plugin process exited (code ${code}, signal ${signal})`);
      // exit 可能先于 stdout 读完：等 close（stdio 都已关闭），最后一条回复才不会丢
      child.on("close", exited);
      child.on("exit", (code, signal) => setTimeout(() => exited(code, signal), EXIT_DRAIN_MS).unref());
      child.on("error", (err) => done(null, null, `plugin process failed: ${err.message}`));
    });

    // 按行切分。不用 readline：它会无限缓存一条没有换行的消息
    let pending: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        const end = nl < 0 ? chunk.length : nl;
        size += end - start;
        if (size > maxMessageBytes) {
          // 流已经不可信：结束进程，进行中的调用随 exit 一起失败
          overflowed = true;
          pending = [];
          terminate(this.#child);
          return;
        }
        pending.push(chunk.subarray(start, end));
        if (nl < 0) return;
        const line = Buffer.concat(pending).toString("utf8");
        pending = [];
        size = 0;
        start = nl + 1;
        this.#receive(line);
      }
    });
    // 流结束时最后一条消息可能没有换行
    child.stdout!.on("end", () => {
      if (overflowed || pending.length === 0) return;
      const line = Buffer.concat(pending).toString("utf8");
      pending = [];
      if (line.trim()) this.#receive(line);
    });
  }

  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): { id: Id; result: Promise<unknown> } {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      if (this.#dead) return reject(this.#dead);
      if (signal?.aborted) return reject(signal.reason);
      // 先序列化：payload 无法序列化时直接失败，不留下等不到回复的调用
      const line = JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies RpcMessage);
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        this.#send({ jsonrpc: "2.0", method: "$/cancel", params: { id } });
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.#write(line);
    });
    return { id, result };
  }

  async close(): Promise<void> {
    if (!this.#dead) {
      await this.request("shutdown", {}, AbortSignal.timeout(SHUTDOWN_GRACE_MS)).result.catch(() => {});
      this.#child.stdin!.end();
      const timer = setTimeout(() => terminate(this.#child), SHUTDOWN_GRACE_MS);
      await this.exited;
      clearTimeout(timer);
    }
  }

  #send(msg: RpcMessage): void {
    this.#write(JSON.stringify(msg));
  }

  #write(line: string): void {
    if (this.#dead) return;
    // 之前写的还堆着没被读走：插件已经不读 stdin，结束它，进行中的调用随 exit 一起失败
    if (this.#backlog > this.#maxBytes) {
      terminate(this.#child);
      return;
    }
    const data = line + "\n";
    if (!this.#child.stdin!.write(data) || this.#backlog > 0) this.#backlog += Buffer.byteLength(data);
  }

  #receive(line: string): void {
    // 空行（例如插件多输出了一个换行）不是消息，也不说明流坏了
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // 不是 JSON-RPC 消息（包括 null、数字这类合法 JSON），流已经不可信：结束进程，进行中的调用随 exit 一起失败
      terminate(this.#child);
      return;
    }
    const msg = parsed as RpcMessage;
    if (msg.method === undefined) {
      const p = msg.id === undefined ? undefined : this.#pending.get(msg.id);
      if (!p) return; // 已取消或超时的调用，迟到的回复直接丢弃
      this.#pending.delete(msg.id!);
      if (msg.error) p.reject(new PluginProcessError(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) void this.#serve(msg.id, msg.method, msg.params ?? {});
  }

  /** 插件 → 内核的请求，只有 log/record 和 log/emit */
  async #serve(id: Id, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      if (method !== "log/record" && method !== "log/emit") throw new Error(`unknown method ${method}`);
      const ctx = this.active.get(params.call as Id);
      if (!ctx) throw new Error("no active hook call");
      if (method === "log/record") await ctx.record(String(params.key), params.value);
      else await ctx.emit(String(params.type), params.data);
      this.#send({ jsonrpc: "2.0", id, result: {} });
    } catch (err) {
      this.#send({ jsonrpc: "2.0", id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
