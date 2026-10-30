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
      /** 部分服务端不给 index */
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** 部分服务端在流中途出错时发送的块 */
  error?: { message?: string; code?: number | string };
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
      let done = false;

      try {
        for await (const chunk of readSSE(res.body, () => (done = true))) {
          if (chunk.error) {
            const code = chunk.error.code;
            throw new ProviderError(`${PROVIDER_ID} stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, {
              // 部分服务端把 HTTP 状态码放在 code 里
              retryable: typeof code === "number" && (code === 408 || code === 429 || code >= 500),
              status: typeof code === "number" ? code : undefined,
            });
          }
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
            // 没有 index 时：带着新的 id 就是新的调用，否则接在最后一个调用后面
            const last = calls.length - 1;
            const index = tc.index ?? (last < 0 || (tc.id && tc.id !== calls[last]!.id) ? last + 1 : last);
            const c = (calls[index] ??= { id: "", name: "", arguments: "" });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.name += tc.function.name;
            if (tc.function?.arguments) c.arguments += tc.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (err) {
        throw streamError(err, signal);
      }
      // 既没有 finish_reason 也没有 [DONE]：连接中途断开，内容不完整
      if (finish === null && !done) {
        throw new ProviderError(`${PROVIDER_ID} stream ended before the response finished`, { retryable: true });
      }

      const origin: Origin = { by: "model", provider: PROVIDER_ID, model };
      const content: Block[] = [];
      if (reasoning) content.push({ kind: "thinking", text: reasoning, origin, trust: "trusted" });
      if (text) content.push({ kind: "text", text, origin, trust: "trusted" });
      for (const c of calls.filter(Boolean)) {
        content.push({
          kind: "tool_use",
          // 部分服务端不给 id；同一批里重复的 id 无法对应结果。生成的 id 随响应写入日志，重建时不受影响
          id: c.id || `call_${crypto.randomUUID()}`,
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

/** 读流过程中的错误：连接中断、数据损坏都转成可重试的 ProviderError；取消和已经分好类的错误照原样抛出 */
function streamError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || err instanceof ProviderError) return err;
  return new ProviderError(`${PROVIDER_ID} stream failed: ${err instanceof Error ? err.message : String(err)}`, {
    retryable: true,
    cause: err,
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
      // 这个格式没有 is_error 字段，错误结果加前缀，否则模型会把拒绝理由当成正常输出；
      // 空的错误结果给一个最小占位，否则部分服务端会拒绝空内容
      out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.isError ? errorText(body) : body });
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

/** onDone：收到 [DONE] 时调用，用来区分正常结束和连接断开 */
async function* readSSE(body: ReadableStream<Uint8Array>, onDone: () => void): AsyncGenerator<StreamChunk> {
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
      if (data === "[DONE]") {
        onDone();
        return;
      }
      yield JSON.parse(data) as StreamChunk;
    }
  }
}

function errorText(body: string): string {
  return body ? `[error] ${body}` : "error";
}
