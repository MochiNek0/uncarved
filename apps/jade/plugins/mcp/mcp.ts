// MCP（Model Context Protocol）客户端：连接 MCP 服务，把它们的工具变成 jade 的工具。
//
// 配置兼容 Claude Code 的 .mcp.json：{ "mcpServers": { "<name>": { command, args, env } | { type: "http", url, headers } } }。
// 读取顺序（同名时后面的覆盖前面的）：
//   $JADE_HOME/mcp.json（用户层）、<仓库根目录>/.mcp.json、仓库根目录到工作目录每一级的 .jade/mcp.json（项目层）。
// 项目层的服务随仓库分发，启动它就是执行仓库指定的命令，所以第一次启动前要用户确认（按配置内容记录，见 index.ts）。
//
// 传输：stdio（一行一条 JSON-RPC 消息）和 Streamable HTTP（POST，回复是 JSON 或 SSE）。旧的 HTTP+SSE 传输不支持。
// 从旧 jade 的 src/mcp.ts 移植；旧 jade 的"插件自带 MCP 配置"（PluginBundle）没有移植：新的插件宿主没有内容包的概念。

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Block, Tool } from "uncarved";
import { projectDirs } from "./project.ts";

export const PROTOCOL_VERSION = "2025-06-18";
/** 告诉服务端的客户端版本：jade 的版本（和 jade/tui 一样从 apps/jade/package.json 读） */
const CLIENT_INFO = {
  name: "jade",
  version: (() => {
    try {
      return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
    } catch {
      return "0.0.0";
    }
  })(),
};
/** 一次工具调用结果里文本的上限，超过时保留开头 */
const MAX_RESULT_CHARS = 60_000;
const STDERR_LINES = 20;
/** 工具名的上限：OpenAI 的接口要求不超过 64 个字符 */
const MAX_TOOL_NAME = 64;

export interface McpServerConfig {
  /** 缺省时有 command 就是 stdio，有 url 就是 http */
  type?: "stdio" | "http" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** stdio 的工作目录，默认 jade 的工作目录；相对路径相对于配置文件所在目录 */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** jade 的扩展：true 时不连接 */
  disabled?: boolean;
  /** jade 的扩展：连接（启动 + 初始化 + 列出工具）的超时，默认 30 秒 */
  startupTimeoutMs?: number;
  /** jade 的扩展：一次工具调用的超时，默认 10 分钟 */
  toolTimeoutMs?: number;
}

export interface McpServerEntry {
  name: string;
  layer: "user" | "project";
  /** 配置文件的绝对路径 */
  file: string;
  config: McpServerConfig;
}

/** MCP 服务声明的工具 */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

type Json = Record<string, unknown>;

// ---------- 配置 ----------

/** 用户层在前，项目层从仓库根目录往下；同名的后面覆盖前面 */
export async function loadMcpConfig(opts: {
  home: string;
  root: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}): Promise<{ servers: McpServerEntry[]; warnings: string[] }> {
  const env = opts.env ?? process.env;
  const files: { file: string; layer: McpServerEntry["layer"] }[] = [
    { file: path.join(opts.home, "mcp.json"), layer: "user" },
    { file: path.join(opts.root, ".mcp.json"), layer: "project" },
    ...projectDirs(opts.root, opts.cwd).map((d) => ({ file: path.join(d, ".jade", "mcp.json"), layer: "project" as const })),
  ];
  const out = new Map<string, McpServerEntry>();
  const warnings: string[] = [];
  for (const { file, layer } of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let json: { mcpServers?: unknown };
    try {
      json = JSON.parse(text);
    } catch (err) {
      warnings.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const servers = json?.mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      warnings.push(`${file}: expected { "mcpServers": { ... } }`);
      continue;
    }
    for (const [name, raw] of Object.entries(servers)) {
      const problem = checkConfig(name, raw);
      if (problem) {
        warnings.push(`${file}: MCP server ${JSON.stringify(name)}: ${problem}`);
        continue;
      }
      const missing: string[] = [];
      const config = expandConfig(raw as McpServerConfig, env, missing);
      if (missing.length) {
        warnings.push(`${file}: MCP server ${name} is skipped: environment variable ${[...new Set(missing)].join(", ")} is not set`);
        out.delete(name);
        continue;
      }
      // 地址里可以有 ${VAR}，展开之后再检查格式
      if (config.command === undefined && !/^https?:\/\//.test(config.url!)) {
        warnings.push(`${file}: MCP server ${name}: "url" must start with http:// or https://`);
        out.delete(name);
        continue;
      }
      if (config.cwd && !path.isAbsolute(config.cwd)) config.cwd = path.resolve(path.dirname(file), config.cwd);
      out.set(name, { name, layer, file, config });
    }
  }
  return { servers: [...out.values()], warnings };
}

const SERVER_NAME = /^[A-Za-z0-9_.-]+$/;

function checkConfig(name: string, raw: unknown): string | undefined {
  if (!SERVER_NAME.test(name)) return "the name may only contain letters, digits, '.', '_' and '-'";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "must be an object";
  const c = raw as McpServerConfig;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const stringMap = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
  if (c.type === "sse") return 'the legacy "sse" transport is not supported; use a streamable HTTP endpoint ("type": "http")';
  if (c.type !== undefined && !["stdio", "http", "streamable-http"].includes(c.type)) return `unknown type ${JSON.stringify(c.type)}`;
  const http = c.type === "http" || c.type === "streamable-http" || (c.type === undefined && c.command === undefined);
  if (http) {
    if (typeof c.url !== "string" || !c.url) return 'needs "command" (stdio) or an http(s) "url"';
    if (c.headers !== undefined && !stringMap(c.headers)) return '"headers" must map names to strings';
  } else {
    if (typeof c.command !== "string" || !c.command) return '"command" must be a non-empty string';
    if (c.args !== undefined && !strings(c.args)) return '"args" must be an array of strings';
    if (c.env !== undefined && !stringMap(c.env)) return '"env" must map names to strings';
    if (c.cwd !== undefined && typeof c.cwd !== "string") return '"cwd" must be a string';
  }
  for (const k of ["startupTimeoutMs", "toolTimeoutMs"] as const) {
    if (c[k] !== undefined && !(typeof c[k] === "number" && c[k]! > 0)) return `"${k}" must be a positive number`;
  }
  return undefined;
}

/** ${VAR} 和 ${VAR:-默认值}，和 Claude Code 一样；没有设置又没有默认值的变量记进 missing */
export function expandEnv(text: string, env: Record<string, string | undefined>, missing: string[]): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return "";
  });
}

function expandConfig(c: McpServerConfig, env: Record<string, string | undefined>, missing: string[]): McpServerConfig {
  const s = (v: string) => expandEnv(v, env, missing);
  const map = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, s(v)])) : undefined);
  return {
    ...c,
    command: c.command === undefined ? undefined : s(c.command),
    args: c.args?.map(s),
    env: map(c.env),
    cwd: c.cwd === undefined ? undefined : s(c.cwd),
    url: c.url === undefined ? undefined : s(c.url),
    headers: map(c.headers),
  };
}

/** 项目层服务的确认记录：同一个仓库里同样的配置只问一次。配置变了（包括展开后的环境变量）就要重新确认 */
export function mcpTrustHash(root: string, entry: McpServerEntry): string {
  const { command, args, env, cwd, url, headers, type } = entry.config;
  // 请求头里通常是密钥，只记名字
  const spec = JSON.stringify({ type, command, args, env, cwd, url, headers: headers ? Object.keys(headers).sort() : undefined });
  return createHash("sha256").update(`jade-mcp\0${root}\0${entry.name}\0${spec}`).digest("hex");
}

/** 给用户看的启动方式 */
export function describeServer(c: McpServerConfig): string {
  return c.command !== undefined ? [c.command, ...(c.args ?? [])].join(" ") : `${c.url}`;
}

// ---------- 连接 ----------

interface Transport {
  request(method: string, params: Json | undefined, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params?: Json): Promise<void>;
  close(): Promise<void>;
  /** 连接断开时 resolve */
  readonly closed: Promise<string>;
}

export class McpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export type McpStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface McpClientOptions {
  /** stdio 服务的默认工作目录 */
  cwd: string;
  /** 连接断开（进程退出等），不包括主动关闭 */
  onDisconnect?(client: McpClient, why: string): void;
  fetch?: typeof fetch;
}

/** 一个 MCP 服务的连接 */
export class McpClient {
  readonly entry: McpServerEntry;
  status: McpStatus = "disconnected";
  error?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  tools: McpToolInfo[] = [];
  readonly stderr: string[] = [];

  #opts: McpClientOptions;
  #transport?: Transport;
  #connecting?: Promise<void>;
  #closing = false;

  constructor(entry: McpServerEntry, opts: McpClientOptions) {
    this.entry = entry;
    this.#opts = opts;
  }

  get name(): string {
    return this.entry.name;
  }

  /** 启动、初始化并列出工具；已经在连接时等同一次连接 */
  connect(): Promise<void> {
    this.#connecting ??= this.#connect().finally(() => (this.#connecting = undefined));
    return this.#connecting;
  }

  async #connect(): Promise<void> {
    this.status = "connecting";
    this.error = undefined;
    this.#closing = false;
    const c = this.entry.config;
    const signal = AbortSignal.timeout(c.startupTimeoutMs ?? 30_000);
    try {
      const t = c.command !== undefined ? stdioTransport(c, this.#opts.cwd, this.stderr) : httpTransport(c, this.#opts.fetch ?? fetch);
      this.#transport = t;
      void t.closed.then((why) => {
        if (this.#transport !== t) return;
        this.#transport = undefined;
        if (this.#closing) return;
        this.status = "failed";
        this.error = why;
        this.#opts.onDisconnect?.(this, why);
      });
      const init = (await t.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        signal,
      )) as { serverInfo?: { name?: string; version?: string }; instructions?: unknown; capabilities?: { tools?: unknown } };
      this.serverInfo = init?.serverInfo;
      this.instructions = typeof init?.instructions === "string" && init.instructions.trim() ? init.instructions.trim() : undefined;
      await t.notify("notifications/initialized");
      this.tools = init?.capabilities?.tools === undefined ? [] : await this.#listTools(t, signal);
      this.status = "connected";
    } catch (err) {
      const why = signal.aborted ? `did not finish starting within ${(c.startupTimeoutMs ?? 30_000) / 1000}s` : errorText(err);
      this.status = "failed";
      this.error = why;
      await this.close().catch(() => {});
      this.status = "failed";
      throw new McpError(why);
    }
  }

  async #listTools(t: Transport, signal: AbortSignal): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = (await t.request("tools/list", cursor ? { cursor } : undefined, signal)) as { tools?: McpToolInfo[]; nextCursor?: string };
      for (const tool of r?.tools ?? []) if (tool && typeof tool.name === "string") tools.push(tool);
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** 调用工具。连接断了先重连一次 */
  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ content?: unknown[]; isError?: boolean; structuredContent?: unknown }> {
    if (this.status !== "connected" || !this.#transport) await this.connect();
    const t = this.#transport!;
    const limit = AbortSignal.timeout(this.entry.config.toolTimeoutMs ?? 600_000);
    const both = AbortSignal.any([signal, limit]);
    try {
      return (await t.request("tools/call", { name, arguments: args ?? {} }, both)) as never;
    } catch (err) {
      if (limit.aborted && !signal.aborted) throw new McpError(`timed out after ${(this.entry.config.toolTimeoutMs ?? 600_000) / 1000}s`);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    const t = this.#transport;
    this.#transport = undefined;
    if (this.status !== "failed") this.status = "disconnected";
    await t?.close();
  }
}

// ---------- 传输：stdio ----------

function stdioTransport(c: McpServerConfig, cwd: string, stderr: string[]): Transport {
  const { file, args, verbatim } = resolveCommand(c.command!, c.args ?? []);
  const child = spawn(file, args, {
    cwd: c.cwd ?? cwd,
    env: mergeEnv(c.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    detached: process.platform !== "win32",
  });
  const rpc = new Rpc((msg) => {
    if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + "\n");
  });
  let partialErr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (text: string) => {
    const lines = (partialErr + text).split(/\r?\n/);
    partialErr = lines.pop() ?? "";
    stderr.push(...lines.filter((l) => l.trim()));
    stderr.splice(0, Math.max(0, stderr.length - STDERR_LINES));
  });
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (text: string) => {
    buf += text;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        rpc.receive(JSON.parse(line));
      } catch {
        // 有的服务往 stdout 打日志；不是 JSON 的行忽略
      }
    }
  });
  child.stdin!.on("error", () => {});
  const closed = new Promise<string>((resolve) => {
    child.on("error", (err) => resolve(`could not start ${c.command}: ${err.message}`));
    child.on("close", (code, sig) => resolve(`exited (${sig ?? `code ${code}`})${stderr.length ? `: ${stderr.at(-1)}` : ""}`));
  });
  void closed.then((why) => rpc.fail(new McpError(`server ${why}`)));
  return {
    request: (method, params, signal) => rpc.request(method, params, signal),
    notify: async (method, params) => rpc.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    closed,
    async close() {
      child.stdin?.end();
      const done = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2_000).unref())]);
      if (!done) killTree(child);
    },
  };
}

/**
 * Windows 上 npx、npm 这类命令是 .cmd 脚本，不经过 shell 无法启动：找到它时改用 cmd.exe /c 启动。
 * MCP 的配置里大多写的是 "command": "npx"
 */
function resolveCommand(command: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32" || /[\\/]/.test(command) || /\.(exe|com)$/i.test(command)) return { file: command, args, verbatim: false };
  const exts = /\.(cmd|bat)$/i.test(command) ? [""] : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, command + ext.toLowerCase());
      let isFile = false;
      try {
        isFile = statSync(full).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
      if (/\.(exe|com)$/i.test(full)) return { file: full, args, verbatim: false };
      if (/\.(cmd|bat)$/i.test(full)) {
        const line = [full, ...args].map(cmdQuote).join(" ");
        return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
      }
    }
  }
  return { file: command, args, verbatim: false };
}

/** cmd.exe 的引号规则：含空格或特殊字符的参数用双引号括起来，里面的双引号写两次 */
function cmdQuote(arg: string): string {
  if (arg && !/[\s"&|<>^%!(),;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function mergeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") {
    const keys = new Set(Object.keys(extra).map((k) => k.toUpperCase()));
    for (const k of Object.keys(env)) if (keys.has(k.toUpperCase())) delete env[k];
  }
  return { ...env, ...extra };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

// ---------- 传输：Streamable HTTP ----------

function httpTransport(c: McpServerConfig, doFetch: typeof fetch): Transport {
  let session: string | undefined;
  let protocol: string | undefined;
  let nextId = 1;
  const abort = new AbortController();
  let markClosed!: (why: string) => void;
  const closed = new Promise<string>((r) => (markClosed = r));
  const headers = () => ({
    ...c.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session ? { "mcp-session-id": session } : {}),
    ...(protocol ? { "mcp-protocol-version": protocol } : {}),
  });

  async function post(body: Json, signal: AbortSignal): Promise<Response> {
    const res = await doFetch(c.url!, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.any([signal, abort.signal]) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    return res;
  }

  return {
    async request(method, params, signal) {
      const id = nextId++;
      const res = await post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, signal);
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 500);
        throw new McpError(`HTTP ${res.status}${res.status === 401 ? " (unauthorized: check the headers in the MCP config)" : ""}${text ? `: ${text}` : ""}`);
      }
      const type = res.headers.get("content-type") ?? "";
      const reply = type.includes("text/event-stream") ? await fromSse(res, id, signal) : ((await res.json()) as RpcMessage);
      const result = unwrap(reply);
      if (method === "initialize") protocol = (result as { protocolVersion?: string })?.protocolVersion ?? PROTOCOL_VERSION;
      return result;
    },
    async notify(method, params) {
      const res = await post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, AbortSignal.timeout(10_000));
      await res.body?.cancel().catch(() => {});
    },
    closed,
    async close() {
      if (session) {
        await doFetch(c.url!, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(2_000) }).catch(() => {});
      }
      abort.abort();
      markClosed("closed");
    },
  };
}

/** 从 SSE 流里找到 id 对应的回复；流里其他的消息（通知、服务端的请求）忽略 */
async function fromSse(res: Response, id: number, signal: AbortSignal): Promise<RpcMessage> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const event = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as RpcMessage;
          if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) return msg;
        } catch {
          // 不是 JSON 的事件忽略
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new McpError(signal.aborted ? "request aborted" : "the server closed the stream without replying");
}

// ---------- JSON-RPC ----------

interface RpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function unwrap(msg: RpcMessage): unknown {
  if (msg?.error) throw new McpError(msg.error.message ?? "error", msg.error.code);
  return msg?.result;
}

class Rpc {
  #send: (msg: RpcMessage) => void;
  #nextId = 1;
  #pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #dead?: Error;

  constructor(send: (msg: RpcMessage) => void) {
    this.#send = send;
  }

  send(msg: RpcMessage): void {
    this.#send(msg);
  }

  request(method: string, params: Json | undefined, signal: AbortSignal): Promise<unknown> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        this.#send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled by the client" } });
        reject(signal.reason ?? new McpError("aborted"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
        reject: (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
      });
      this.#send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  receive(msg: RpcMessage): void {
    if (msg.method !== undefined) {
      // 服务端发来的请求：只支持 ping，其他的回复"不支持"，免得服务端一直等
      if (msg.id === undefined) return;
      if (msg.method === "ping") this.#send({ jsonrpc: "2.0", id: msg.id, result: {} });
      else this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `jade does not support ${msg.method}` } });
      return;
    }
    if (msg.id === undefined) return;
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new McpError(msg.error.message ?? "error", msg.error.code));
    else p.resolve(msg.result);
  }

  fail(err: Error): void {
    this.#dead = err;
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
}

// ---------- 工具 ----------

/** mcp__<服务>__<工具>，和 Claude Code 一样；只保留字母数字、_、-，超长时截断并加上哈希避免重名 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

/** 把已连接的服务的工具变成 jade 的工具；readOnly 为 true 时只要声明了只读的工具（给子 Agent） */
export function mcpTools(clients: McpClient[], opts: { readOnly?: boolean } = {}): Tool[] {
  const out: Tool[] = [];
  const names = new Set<string>();
  for (const client of clients) {
    if (client.status !== "connected") continue;
    for (const info of client.tools) {
      const readOnly = info.annotations?.readOnlyHint === true;
      if (opts.readOnly && !readOnly) continue;
      const name = mcpToolName(client.name, info.name);
      if (names.has(name)) continue;
      names.add(name);
      const schema = info.inputSchema && typeof info.inputSchema === "object" ? info.inputSchema : { type: "object" };
      out.push({
        name,
        description: `${(info.description ?? info.title ?? info.annotations?.title ?? info.name).trim()}\n\n(Tool "${info.name}" from the MCP server "${client.name}".)`,
        inputSchema: { type: "object", ...schema },
        // 服务没有声明只读的，都按有外部副作用处理：ask 模式下先问，auto 模式下先交给审查
        effect: readOnly ? "read" : "external",
        concurrency: readOnly ? "safe" : "exclusive",
        idempotent: readOnly || info.annotations?.idempotentHint === true,
        async execute(input, ctx) {
          try {
            const r = await client.callTool(info.name, input, ctx.signal);
            return { content: toBlocks(name, r), isError: r?.isError === true };
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            return { content: `MCP server "${client.name}" failed: ${errorText(err)}`, isError: true };
          }
        },
      });
    }
  }
  return out;
}

/** MCP 的内容转成内容块：文本、图片照搬；音频、二进制资源只说明；没有内容时用 structuredContent */
export function toBlocks(tool: string, r: { content?: unknown[]; structuredContent?: unknown } | undefined): Block[] {
  const origin = { by: "tool" as const, name: tool };
  const blocks: Block[] = [];
  let chars = 0;
  const text = (t: string) => {
    if (chars >= MAX_RESULT_CHARS) return;
    const room = MAX_RESULT_CHARS - chars;
    const shown = t.length > room ? `${t.slice(0, room)}\n[… ${t.length - room} more characters omitted]` : t;
    chars += shown.length;
    blocks.push({ kind: "text", text: shown, origin, trust: "untrusted" });
  };
  for (const raw of r?.content ?? []) {
    const c = raw as { type?: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } };
    switch (c?.type) {
      case "text":
        if (typeof c.text === "string") text(c.text);
        break;
      case "image":
        if (typeof c.data === "string" && typeof c.mimeType === "string") {
          blocks.push({ kind: "image", source: { type: "base64", media_type: c.mimeType, data: c.data }, origin, trust: "untrusted" });
        }
        break;
      case "resource": {
        const res = c.resource;
        if (typeof res?.text === "string") text(`${res.uri ?? "resource"}:\n${res.text}`);
        else text(`[binary resource ${res?.uri ?? ""}${res?.mimeType ? ` (${res.mimeType})` : ""} omitted]`);
        break;
      }
      case "resource_link":
        text(`[resource ${c.name ? `${c.name} ` : ""}${c.uri ?? ""}]`);
        break;
      case "audio":
        text(`[audio${c.mimeType ? ` (${c.mimeType})` : ""} omitted]`);
        break;
    }
  }
  if (blocks.length === 0 && r?.structuredContent !== undefined) text(JSON.stringify(r.structuredContent, null, 2));
  if (blocks.length === 0) text("(no output)");
  return blocks;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
