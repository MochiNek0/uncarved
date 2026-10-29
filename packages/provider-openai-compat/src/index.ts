// OpenAI 兼容格式（/chat/completions）的 provider，零依赖，基于 fetch + SSE。

import { ProviderError, type Block, type Message, type ModelRequest, type Origin, type Provider, type StopReason } from "uncarved";

export const PROVIDER_ID = "openai-compat";

/** ModelRequest.ext[PROVIDER_ID] 的格式（4.7） */
export interface OpenAICompatExt {
  /** 合并进请求体 */
  body?: Record<string, unknown>;
  /** 合并进请求头 */
  headers?: Record<string, string>;
}

// 由 ModelRequest 生成、或决定如何解析响应的字段，不能通过 extraBody / ext 覆盖
const RESERVED = ["messages", "tools", "stream", "stream_options"];

export interface OpenAICompatOptions {
  /** 例如 https://api.openai.com/v1 */
  baseURL: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  /** 每次请求都合并进请求体，ext 中的 body 覆盖它 */
  extraBody?: Record<string, unknown>;
  /** 每次请求都合并进请求头，ext 中的 headers 覆盖它 */
  headers?: Record<string, string>;
  /** 可替换，便于测试 */
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface StreamChunk {
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export function openaiCompatProvider(opts: OpenAICompatOptions): Provider {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseURL.replace(/\/$/, "")}/chat/completions`;

  return {
    id: PROVIDER_ID,
    async complete(req, { signal, onDelta }) {
      const ext = (req.ext?.[PROVIDER_ID] ?? {}) as OpenAICompatExt;
      const extra = { ...opts.extraBody, ...ext.body };
      const reserved = RESERVED.find((k) => k in extra);
      if (reserved) throw new Error(`${PROVIDER_ID}: extra body must not set "${reserved}"`);

      const res = await send(doFetch, url, signal, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          ...opts.headers,
          ...ext.headers,
        },
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          stream_options: { include_usage: true },
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...extra,
          messages: toMessages(req),
          ...(req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
              }
            : {}),
        }),
      });

      let model = (extra.model as string | undefined) ?? opts.model;
      let text = "";
      let reasoning = "";
      let finish: string | null = null;
      let usage: StreamChunk["usage"] = null;
      const calls: Array<{ id: string; name: string; arguments: string }> = [];

      for await (const chunk of readSSE(res.body)) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        if (d.content) {
          text += d.content;
          onDelta?.({ kind: "text", text: d.content });
        }
        if (d.reasoning_content) {
          reasoning += d.reasoning_content;
          onDelta?.({ kind: "thinking", text: d.reasoning_content });
        }
        for (const tc of d.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }

      const origin: Origin = { by: "model", provider: PROVIDER_ID, model };
      const content: Block[] = [];
      if (reasoning) content.push({ kind: "thinking", text: reasoning, origin, trust: "trusted" });
      if (text) content.push({ kind: "text", text, origin, trust: "trusted" });
      for (const c of calls.filter(Boolean)) {
        content.push({
          kind: "tool_use",
          id: c.id,
          name: c.name,
          input: parseArgs(c.arguments),
          origin,
          trust: "trusted",
          // 保留原始参数字符串，回传时不重新序列化（I-6）
          ext: { [PROVIDER_ID]: { arguments: c.arguments } },
        });
      }

      return {
        provider: PROVIDER_ID,
        model,
        content,
        stopReason: toStopReason(finish, calls.length > 0),
        usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
      };
    },
  };
}

/** 发送请求；网络错误和 HTTP 错误都转成 ProviderError，取消照原样抛出 */
async function send(doFetch: typeof fetch, url: string, signal: AbortSignal, init: RequestInit): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ProviderError(`${PROVIDER_ID} request failed: ${err instanceof Error ? err.message : String(err)}`, {
      retryable: true,
      cause: err,
    });
  }
  if (res.ok && res.body) return res as Response & { body: ReadableStream<Uint8Array> };
  const status = res.status;
  throw new ProviderError(`${PROVIDER_ID} HTTP ${status}: ${(await res.text()).slice(0, 500)}`, {
    retryable: status === 408 || status === 429 || status >= 500,
    status,
    retryAfterMs: retryAfter(res.headers.get("retry-after")),
  });
}

/** Retry-After 可以是秒数，也可以是 HTTP 日期 */
function retryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const seconds = Number(v);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function toMessages(req: ModelRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (req.system.length > 0) out.push({ role: "system", content: req.system.map((s) => s.text).join("\n\n") });
  for (const m of req.messages) out.push(...(m.role === "assistant" ? fromAssistant(m) : fromUser(m)));
  return out;
}

function fromAssistant(m: Message): ChatMessage[] {
  const text = m.content.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("");
  const toolCalls = m.content.flatMap((b) =>
    b.kind === "tool_use"
      ? [
          {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: rawArgs(b) ?? JSON.stringify(b.input ?? {}) },
          },
        ]
      : [],
  );
  // 思考块和 opaque 块在这个格式里无法回传，省略
  return [{ role: "assistant", content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
}

function fromUser(m: Message): ChatMessage[] {
  const out: ChatMessage[] = [];
  const texts: string[] = [];
  for (const b of m.content) {
    if (b.kind === "tool_result") {
      const body = b.content.flatMap((c) => (c.kind === "text" ? [c.text] : [])).join("\n");
      // 这个格式没有 is_error 字段；空的错误结果给一个最小占位，否则部分服务端会拒绝空内容
      out.push({ role: "tool", tool_call_id: b.toolUseId, content: body || (b.isError ? "error" : "") });
    } else if (b.kind === "text") {
      texts.push(b.text);
    }
  }
  if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
  return out;
}

function rawArgs(b: Block): string | undefined {
  const ext = b.ext?.[PROVIDER_ID] as { arguments?: string } | undefined;
  return ext?.arguments;
}

/** 解析失败时把原始字符串交给工具，由工具自己校验 */
function parseArgs(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toStopReason(finish: string | null, hasToolCalls: boolean): StopReason {
  // 部分兼容服务端在有工具调用时仍返回 stop
  if (hasToolCalls && (finish === "tool_calls" || finish === "stop" || finish === null)) return "tool_use";
  switch (finish) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data) as StreamChunk;
    }
  }
}
