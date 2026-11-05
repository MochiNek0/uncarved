// JSON-RPC 2.0，一行一条（第 6 节）。按 LF 切分，不用 readline：它会在 U+2028/2029 处切开。
// 双向：两边都可以发请求。传输（子进程的管道）由调用方接上。

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 收到的请求或通知的处理函数。signal 在对方发来 $/cancel 或连接关闭时中止 */
export type RpcHandler = (method: string, params: unknown, signal: AbortSignal) => unknown;

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

export class Rpc {
  readonly #write: (line: string) => void;
  readonly #handle: RpcHandler;
  readonly #pending = new Map<number, Pending>();
  readonly #incoming = new Map<number | string, AbortController>();
  #next = 1;
  #buf = "";
  #closed: Error | undefined;
  /** 对方发来的不是协议消息的行 */
  onGarbage: ((line: string) => void) | undefined;

  constructor(write: (line: string) => void, handle: RpcHandler) {
    this.#write = write;
    this.#handle = handle;
  }

  /** 喂进对方发来的文本（已按 UTF-8 解码） */
  feed(chunk: string): void {
    this.#buf += chunk;
    for (let i = this.#buf.indexOf("\n"); i !== -1; i = this.#buf.indexOf("\n")) {
      const line = this.#buf.slice(0, i).replace(/\r$/, "");
      this.#buf = this.#buf.slice(i + 1);
      if (line.trim()) this.#receive(line);
    }
  }

  /** 发请求；signal 中止时发 $/cancel，并以 signal.reason 拒绝 */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        this.#send({ jsonrpc: "2.0", method: "$/cancel", params: { id } });
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#closed) this.#send({ jsonrpc: "2.0", method, params });
  }

  /** 连接断了：在途的请求全部以 reason 拒绝，对方的请求全部中止 */
  close(reason: Error): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const p of this.#pending.values()) p.reject(reason);
    this.#pending.clear();
    for (const c of this.#incoming.values()) c.abort(reason);
    this.#incoming.clear();
  }

  #send(msg: object): void {
    if (this.#closed) return;
    try {
      this.#write(`${JSON.stringify(msg)}\n`);
    } catch (e) {
      this.close(e instanceof Error ? e : new Error(String(e)));
    }
  }

  #receive(line: string): void {
    let msg: { id?: number | string | null; method?: unknown; params?: unknown; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(line);
    } catch {
      this.onGarbage?.(line);
      return;
    }
    if (typeof msg !== "object" || msg === null) return this.onGarbage?.(line);
    if (typeof msg.method === "string") {
      if (msg.method === "$/cancel") {
        const id = (msg.params as { id?: number | string } | undefined)?.id;
        if (id !== undefined) this.#incoming.get(id)?.abort(new Error("cancelled by the plugin"));
        return;
      }
      void this.#serve(msg.id ?? undefined, msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return this.onGarbage?.(line);
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new RemoteError(msg.error));
    else p.resolve(msg.result ?? null);
  }

  async #serve(id: number | string | undefined, method: string, params: unknown): Promise<void> {
    const ctrl = new AbortController();
    if (id !== undefined) this.#incoming.set(id, ctrl);
    try {
      const result = await this.#handle(method, params, ctrl.signal);
      if (id !== undefined) this.#send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      if (id !== undefined) this.#send({ jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
    } finally {
      if (id !== undefined) this.#incoming.delete(id);
    }
  }
}

/** 对方返回的错误 */
export class RemoteError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(e: RpcError) {
    super(typeof e?.message === "string" ? e.message : "remote error");
    this.name = "RemoteError";
    this.code = typeof e?.code === "number" ? e.code : -32000;
    this.data = e?.data;
  }
}
