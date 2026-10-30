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

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
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
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
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
            // 没有 index 时：带着新的 id 就是新的调用；也没有 id 时，最后一个调用已经开始接收参数后又来了 name，
            // 也是新的调用；否则接在最后一个调用后面
            const last = calls.length - 1;
            const prev = calls[last];
            const fresh = !prev || (tc.id ? tc.id !== prev.id : !!tc.function?.name && prev.arguments !== "");
            const index = tc.index ?? (fresh ? last + 1 : last);
            const c = (calls[index] ??= { id: "", name: "", arguments: "" });
            if (tc.id) c.id = tc.id;
            // 名字一般只在第一块里给出；部分服务端每一块都重复完整的名字，不能再拼上去
            if (tc.function?.name && tc.function.name !== c.name) c.name += tc.function.name;
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
        // prompt_tokens 已经包含命中缓存的部分
        usage: usage
          ? {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
            }
          : undefined,
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
  const status = res.status;
  // 读错误响应体失败（例如连接被重置）时只报状态码
  const body = async () => (await res.text().catch(() => "")).slice(0, 500);
  if (res.ok && res.body) {
    // 代理或服务端没有理会 stream: true，返回了普通 JSON 或网页：再试一次也一样
    const type = res.headers.get("content-type") ?? "";
    if (!/^(application\/json|text\/html)\b/i.test(type)) return res as Response & { body: ReadableStream<Uint8Array> };
    throw new ProviderError(`${PROVIDER_ID} expected an event stream, got ${type}: ${await body()}`, { retryable: false, status });
  }
  throw new ProviderError(`${PROVIDER_ID} HTTP ${status}: ${await body()}`, {
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
            // 参数解析失败时 input 是原始字符串，原样回传，不再序列化一层
            function: { name: b.name, arguments: rawArgs(b) ?? (typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {})) },
          },
        ]
      : [],
  );
  // 思考块和 opaque 块在这个格式里无法回传，省略；省略后什么都不剩时整条省略，内容为空的 assistant 消息会被拒绝
  if (!text && toolCalls.length === 0) return [];
  return [{ role: "assistant", content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
}

function fromUser(m: Message): ChatMessage[] {
  const out: ChatMessage[] = [];
  const parts: ContentPart[] = [];
  for (const b of m.content) {
    if (b.kind === "tool_result") {
      // tool 消息只能是文本：图片、文档换成占位说明，让模型知道少了内容
      const body = b.content
        .flatMap((c) => (c.kind === "text" ? [c.text] : c.kind === "image" || c.kind === "document" ? [omitted(c.kind)] : []))
        .join("\n");
      // 这个格式没有 is_error 字段，错误结果加前缀，否则模型会把拒绝理由当成正常输出；
      // 空的结果给一个最小占位，否则部分服务端会拒绝空内容
      out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.isError ? errorText(body) : body || "(no output)" });
    } else if (b.kind === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.kind === "image") {
      const url = sourceURL(b.source);
      parts.push(url ? { type: "image_url", image_url: { url } } : { type: "text", text: omitted("image") });
    } else if (b.kind === "document") {
      // 兼容服务端普遍不支持文件输入
      parts.push({ type: "text", text: omitted("document") });
    }
  }
  if (parts.length > 0) {
    // 只有文本时仍发字符串：不支持多段内容的服务端也能用
    const texts = parts.flatMap((p) => (p.type === "text" ? [p.text] : []));
    out.push({ role: "user", content: texts.length === parts.length ? texts.join("\n") : parts });
  }
  return out;
}

/** image 块的 source 按 Anthropic Messages API 的格式解释：{ type: "base64", media_type, data } 或 { type: "url", url } */
function sourceURL(source: unknown): string | undefined {
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown } | null | undefined;
  if (s?.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string") return `data:${s.media_type};base64,${s.data}`;
  if (s?.type === "url" && typeof s.url === "string") return s.url;
  return undefined;
}

function omitted(kind: "image" | "document"): string {
  return `[${kind} omitted: not supported by ${PROVIDER_ID}]`;
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
  for await (const data of sseData(body)) {
    if (data.trim() === "[DONE]") {
      onDone();
      return;
    }
    yield JSON.parse(data) as StreamChunk;
  }
}

/**
 * 按 SSE 规范切分事件，返回每个事件的 data：一个事件的多行 data 以换行拼接，空行结束一个事件。
 * 部分服务端事件之间不空行：已攒下的 data 本身是完整的 JSON 时，新的 data 行视为下一个事件
 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let data: string[] = [];
  const complete = (text: string) => {
    if (text.trim() === "[DONE]") return true;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  for await (const line of sseLines(body)) {
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) {
      if (data.length > 0 && complete(data.join("\n"))) {
        yield data.join("\n");
        data = [];
      }
      data.push(line.slice(line[5] === " " ? 6 : 5));
    }
    // event:、id:、retry: 和注释行（以 : 开头）都不需要
  }
}

/** 逐行读取（去掉行尾的 \r）。部分服务端最后一个事件后面没有空行：流结束时补一个空行 */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) yield buffer.replace(/\r$/, "");
  yield "";
}

function errorText(body: string): string {
  return body ? `[error] ${body}` : "error";
}
