// 模拟的公司模型网关。真实环境里它是公司的服务，这里用一个本地脚本演示它做的事：
//
// - 员工的 jade 只连网关，拿的是网关的令牌；真正的模型密钥只在网关上（GATEWAY_UPSTREAM_KEY）。
// - 每个请求必须带员工身份（jade 的 JADE_MODEL_HEADERS 加的 x-employee-id），没有就拒绝。
// - 可以限定能用哪些模型（GATEWAY_MODELS）。
// - 每个请求记一行：谁、什么模型、多少 token、多久，按员工累计；同时写进 JSONL 日志。
//
// 请求原样转发到 GATEWAY_UPSTREAM，流式响应边转发边从里面读出用量，不等它结束。
// 身份头和网关令牌不会转发给上游。OpenAI 兼容（/chat/completions）、OpenAI Responses（/responses）
// 和 Claude（/v1/messages）三种格式都能过。
//
// 运行：bun gateway.ts，或 node gateway.ts（Node ≥ 22.18）。配置见 README。

import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export interface GatewayOptions {
  /** 上游地址，例如 https://api.deepseek.com/v1、https://api.anthropic.com。客户端请求的路径接在它后面 */
  upstream: string;
  /** 上游的密钥；不设时转发客户端自己的认证头 */
  upstreamKey?: string;
  /** 员工连网关用的令牌；设了时客户端的 Authorization（或 x-api-key）必须是它 */
  token?: string;
  /** 允许的模型；空表示不限 */
  models?: string[];
  /** 员工身份的请求头，默认 x-employee-id */
  employeeHeader?: string;
  /** 每个请求追加一行 JSON 的日志文件；不设时不写 */
  logFile?: string;
  port?: number;
  host?: string;
  /** 每个请求结束时调用（打印用） */
  onRecord?: (r: GatewayRecord, totals: Totals) => void;
}

export interface GatewayRecord {
  at: string;
  employee?: string;
  method: string;
  path: string;
  model?: string;
  status: number;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 被网关拒绝时的原因 */
  rejected?: string;
}

/** 一个员工的累计 */
export interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

const MAX_BODY = 32 * 1024 * 1024;
/** 不转发给上游的请求头：逐跳的、要重算的、身份和网关自己的认证 */
const DROP_REQUEST = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding", "authorization", "x-api-key"]);
/** 转发给客户端的响应头 */
const KEEP_RESPONSE = ["content-type", "retry-after", "request-id", "x-request-id", "anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining-requests"];

export async function startGateway(opts: GatewayOptions): Promise<{ server: Server; url: string; totals: Map<string, Totals>; close(): Promise<void> }> {
  const upstream = opts.upstream.replace(/\/+$/, "");
  const employeeHeader = (opts.employeeHeader ?? "x-employee-id").toLowerCase();
  const totals = new Map<string, Totals>();

  const record = (r: GatewayRecord) => {
    let t = totals.get(r.employee ?? "?");
    if (!t) totals.set(r.employee ?? "?", (t = { requests: 0, inputTokens: 0, outputTokens: 0 }));
    t.requests++;
    t.inputTokens += r.inputTokens ?? 0;
    t.outputTokens += r.outputTokens ?? 0;
    if (opts.logFile) appendFileSync(opts.logFile, JSON.stringify(r) + "\n");
    opts.onRecord?.(r, t);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) fail(res, 502, `gateway error: ${(err as Error).message}`);
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    const path = req.url ?? "/";
    const employee = header(req, employeeHeader);
    const base = { at: new Date().toISOString(), employee, method: req.method ?? "GET", path };
    const reject = (status: number, why: string, model?: string) => {
      record({ ...base, model, status, ms: Date.now() - started, rejected: why });
      fail(res, status, why);
    };

    if (opts.token) {
      const given = header(req, "x-api-key") ?? header(req, "authorization")?.replace(/^Bearer\s+/i, "");
      if (given !== opts.token) return reject(401, "acme gateway: invalid gateway token");
    }
    if (!employee) return reject(401, `acme gateway: requests must say which employee sends them (header ${employeeHeader}); set JADE_MODEL_HEADERS in jade`);

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    let model: string | undefined;
    if (body?.length) {
      try {
        const m = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
        if (typeof m === "string") model = m;
      } catch {
        // 不是 JSON：照转
      }
    }
    if (opts.models?.length && model !== undefined && !opts.models.includes(model)) {
      return reject(403, `acme gateway: model ${model} is not approved for company use; allowed: ${opts.models.join(", ")}`, model);
    }

    const headers: Record<string, string> = { "accept-encoding": "identity" };
    for (const [k, v] of Object.entries(req.headers)) {
      if (DROP_REQUEST.has(k) || k === employeeHeader || v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const key = opts.upstreamKey;
    if (key) {
      // Claude 的接口用 x-api-key，其余用 Bearer
      if (path.includes("/messages")) headers["x-api-key"] = key;
      else headers.authorization = `Bearer ${key}`;
    } else {
      for (const k of ["authorization", "x-api-key"]) {
        const v = header(req, k);
        if (v) headers[k] = v;
      }
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const up = await fetch(upstream + path, { method: req.method, headers, body: body?.length ? new Uint8Array(body) : undefined, signal: abort.signal });
    const out: Record<string, string> = {};
    for (const k of KEEP_RESPONSE) {
      const v = up.headers.get(k);
      if (v) out[k] = v;
    }
    res.writeHead(up.status, out);

    // 边转发边找用量：流式的每个 data: 行、非流式的整个 JSON 里，都可能有 usage
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    const decoder = new TextDecoder();
    let pending = "";
    const scan = (text: string) => {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) readUsage(line, usage);
    };
    try {
      if (up.body) {
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          scan(decoder.decode(chunk, { stream: true }));
        }
      }
      scan(decoder.decode() + "\n");
    } finally {
      res.end();
      record({ ...base, model, status: up.status, ms: Date.now() - started, ...usage });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { address: string; port: number };
  return {
    server,
    url: `http://${opts.host ?? "127.0.0.1"}:${addr.port}`,
    totals,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 从一行（SSE 的 data: 行，或整个 JSON 响应）里读用量，取见到的最大值 */
export function readUsage(line: string, usage: { inputTokens?: number; outputTokens?: number }) {
  const text = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  if (!text.startsWith("{")) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  // OpenAI 兼容：usage；Responses：response.usage；Claude：message.usage（message_start）和 usage（message_delta）
  for (const u of [obj.usage, (obj.response as { usage?: unknown } | undefined)?.usage, (obj.message as { usage?: unknown } | undefined)?.usage]) {
    if (!u || typeof u !== "object") continue;
    const x = u as Record<string, unknown>;
    const input = num(x.prompt_tokens) ?? num(x.input_tokens);
    const output = num(x.completion_tokens) ?? num(x.output_tokens);
    if (input !== undefined) usage.inputTokens = Math.max(usage.inputTokens ?? 0, input);
    if (output !== undefined) usage.outputTokens = Math.max(usage.outputTokens ?? 0, output);
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

/** 两种客户端都能读懂的错误：OpenAI 读 error.message，Claude 读 type + error */
function fail(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: status === 403 ? "permission_error" : "authentication_error", message } }));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

// ---------- 命令行 ----------

const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const color = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

async function main() {
  const env = process.env;
  const upstream = env.GATEWAY_UPSTREAM;
  if (!upstream) {
    console.error("GATEWAY_UPSTREAM is required, e.g. GATEWAY_UPSTREAM=https://api.deepseek.com/v1 (see README.md)");
    process.exit(2);
  }
  const gw = await startGateway({
    upstream,
    upstreamKey: env.GATEWAY_UPSTREAM_KEY || undefined,
    token: env.GATEWAY_TOKEN || undefined,
    models: env.GATEWAY_MODELS ? env.GATEWAY_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    logFile: env.GATEWAY_LOG ?? "gateway-log.jsonl",
    port: env.GATEWAY_PORT ? Number(env.GATEWAY_PORT) : 8787,
    host: env.GATEWAY_HOST,
    onRecord(r, t) {
      const time = new Date(r.at).toLocaleTimeString();
      const who = (r.employee ?? "(no employee)").padEnd(12);
      const status = r.status < 300 ? color(32, String(r.status)) : color(31, String(r.status));
      const tokens = r.inputTokens !== undefined || r.outputTokens !== undefined ? `in ${fmt(r.inputTokens ?? 0)} out ${fmt(r.outputTokens ?? 0)}` : "";
      const line = [time, color(36, who), `${r.method} ${r.path}`, r.model ?? "", status, `${(r.ms / 1000).toFixed(1)}s`, tokens].filter(Boolean).join("  ");
      console.log(line + (r.rejected ? `  ${color(31, r.rejected)}` : ""));
      if (r.employee) console.log(color(2, `          ${r.employee} so far: ${t.requests} requests, ${fmt(t.inputTokens)} tokens in, ${fmt(t.outputTokens)} out`));
    },
  });
  console.log(`acme gateway on ${gw.url} → ${upstream}`);
  console.log(`  upstream key: ${env.GATEWAY_UPSTREAM_KEY ? "held by the gateway" : "forwarded from the client"}; gateway token: ${env.GATEWAY_TOKEN ? "required" : "not required"}`);
  if (env.GATEWAY_MODELS) console.log(`  allowed models: ${env.GATEWAY_MODELS}`);
  console.log(`  log: ${env.GATEWAY_LOG ?? "gateway-log.jsonl"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
