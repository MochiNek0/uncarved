// OpenAI Responses 格式（/responses）的 provider，零依赖，基于 fetch + SSE。
//
// - 无状态：默认 store: false，每次发送完整历史（I-4：投影由日志计算，不依赖服务端保存的历史）
// - 模型输出的每个 item 原样存进块的 ext，回传时原样发回（I-6），
//   推理模型的 encrypted_content 因此能跨轮保留

import { ProviderError, type Block, type Message, type ModelRequest, type Origin, type Provider, type StopReason, type Usage } from "uncarved";

export const PROVIDER_ID = "openai-responses";

/** ModelRequest.ext[PROVIDER_ID] 的格式（4.7） */
export interface OpenAIResponsesExt {
  /** 合并进请求体 */
  body?: Record<string, unknown>;
  /** 合并进请求头 */
  headers?: Record<string, string>;
}

// 由 ModelRequest 生成、或决定如何回传历史和解析响应的字段，不能通过 extraBody / ext 覆盖
const RESERVED = ["input", "instructions", "tools", "stream", "store", "include"];

export interface OpenAIResponsesOptions {
  /** 例如 https://api.openai.com/v1 */
  baseURL: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" };
  /** 默认 false。为 true 时服务端保存响应，回传的 item 保留 id */
  store?: boolean;
  /** 每次请求都合并进请求体，ext 中的 body 覆盖它 */
  extraBody?: Record<string, unknown>;
  /** 每次请求都合并进请求头，ext 中的 headers 覆盖它 */
  headers?: Record<string, string>;
  /** 可替换，便于测试 */
  fetch?: typeof fetch;
}

/** 服务端返回的 output item，字段按原样保留 */
interface Item {
  type: string;
  id?: string;
  [key: string]: unknown;
}

interface StreamEvent {
  type: string;
  delta?: string;
  item?: Item;
  output_index?: number;
  response?: {
    model?: string;
    status?: string;
    output?: Item[];
    incomplete_details?: { reason?: string } | null;
    error?: { code?: string; message?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    } | null;
  };
  message?: string;
}

export function openaiResponsesProvider(opts: OpenAIResponsesOptions): Provider {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseURL.replace(/\/$/, "")}/responses`;
  const store = opts.store ?? false;

  return {
    id: PROVIDER_ID,
    async complete(req, { signal, onDelta }) {
      const ext = (req.ext?.[PROVIDER_ID] ?? {}) as OpenAIResponsesExt;
      const extra = { ...opts.extraBody, ...ext.body };
      const reserved = RESERVED.find((k) => k in extra);
      if (reserved) throw new Error(`${PROVIDER_ID}: extra body must not set "${reserved}"`);

      const instructions = req.system.map((s) => s.text).join("\n\n");
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
          store,
          // 不在服务端保存时，推理内容只能以加密形式带回来再发回去
          ...(store ? {} : { include: ["reasoning.encrypted_content"] }),
          ...(instructions ? { instructions } : {}),
          ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens } : {}),
          ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
          ...extra,
          input: toInput(req, store),
          ...(req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: "function",
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                  // Responses API 默认 strict，会拒绝大多数普通的 JSON Schema
                  strict: false,
                })),
              }
            : {}),
        }),
      });

      let model = (extra.model as string | undefined) ?? opts.model;
      const done: Item[] = [];
      let final: StreamEvent["response"];

      for await (const ev of readSSE(res.body)) {
        switch (ev.type) {
          case "response.created":
            if (ev.response?.model) model = ev.response.model;
            break;
          case "response.output_text.delta":
            if (ev.delta) onDelta?.({ kind: "text", text: ev.delta });
            break;
          case "response.reasoning_summary_text.delta":
            if (ev.delta) onDelta?.({ kind: "thinking", text: ev.delta });
            break;
          case "response.output_item.done":
            if (ev.item) done[ev.output_index ?? done.length] = ev.item;
            break;
          case "response.completed":
          case "response.incomplete":
            final = ev.response;
            break;
          case "response.failed": {
            const code = ev.response?.error?.code;
            throw new ProviderError(`${PROVIDER_ID} response failed: ${ev.response?.error?.message ?? "unknown error"}`, {
              retryable: code === "server_error" || code === "rate_limit_exceeded",
            });
          }
          case "error":
            throw new ProviderError(`${PROVIDER_ID} stream error: ${ev.message ?? "unknown error"}`, { retryable: false });
        }
      }
      // 没有收到最终响应就断开，多半是连接中断
      if (!final) throw new ProviderError(`${PROVIDER_ID} stream ended without a final response`, { retryable: true });
      if (final.model) model = final.model;

      const items = done.filter(Boolean);
      const origin: Origin = { by: "model", provider: PROVIDER_ID, model };
      const content = (items.length > 0 ? items : (final.output ?? [])).flatMap((item) => toBlocks(item, origin));
      const u = final.usage;
      const usage: Usage | undefined = u
        ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.input_tokens_details?.cached_tokens }
        : undefined;

      return { provider: PROVIDER_ID, model, content, stopReason: toStopReason(final, content), usage };
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

// ---------- 输出 item → 内容块 ----------

function toBlocks(item: Item, origin: Origin): Block[] {
  const ext = { [PROVIDER_ID]: { item } };
  const base = { origin, trust: "trusted" as const, ext };
  switch (item.type) {
    case "reasoning": {
      const summary = (item.summary as Array<{ text?: string }> | undefined) ?? [];
      return [{ ...base, kind: "thinking", text: summary.map((s) => s.text ?? "").join("\n\n") }];
    }
    case "message": {
      const parts = (item.content as Array<{ type: string; text?: string; refusal?: string }> | undefined) ?? [];
      const text = parts.map((p) => (p.type === "output_text" ? (p.text ?? "") : p.type === "refusal" ? (p.refusal ?? "") : "")).join("");
      return [{ ...base, kind: "text", text }];
    }
    case "function_call":
      return [
        {
          ...base,
          kind: "tool_use",
          id: String(item.call_id),
          name: String(item.name),
          input: parseArgs(String(item.arguments ?? "")),
        },
      ];
    default:
      // 内置工具调用等内核不认识的 item，原样保留，回传时原样发回
      return [{ ...base, kind: "opaque" }];
  }
}

function toStopReason(final: NonNullable<StreamEvent["response"]>, content: Block[]): StopReason {
  if (final.status === "incomplete") {
    const reason = final.incomplete_details?.reason;
    return reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : "other";
  }
  const hasRefusal = content.some((b) => {
    const item = ownItem(b);
    return item?.type === "message" && (item.content as Array<{ type: string }> | undefined)?.some((p) => p.type === "refusal");
  });
  if (hasRefusal) return "refusal";
  return content.some((b) => b.kind === "tool_use") ? "tool_use" : "end";
}

// ---------- 历史 → input ----------

function toInput(req: ModelRequest, store: boolean): Item[] {
  const out: Item[] = [];
  for (const m of req.messages) out.push(...(m.role === "assistant" ? fromAssistant(m, store) : fromUser(m)));
  return out;
}

function fromAssistant(m: Message, store: boolean): Item[] {
  const out: Item[] = [];
  for (const b of m.content) {
    const item = ownItem(b);
    if (item) {
      // 不在服务端保存时，id 指向的 item 并不存在，只发内容。
      // function_call 例外：它的 id 只是 item 自身的标识（规范中可选），部分兼容服务端要求必填
      if (store || item.type === "function_call") {
        out.push(item);
      } else {
        const { id: _id, ...rest } = item;
        // 没有加密内容的推理 item 无法在无状态模式下回传
        if (rest.type !== "reasoning" || rest.encrypted_content) out.push(rest);
      }
      continue;
    }
    // 来自其他 provider 的历史：能表达的部分按本格式重建，其余省略
    if (b.kind === "text") {
      out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] });
    } else if (b.kind === "tool_use") {
      out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    }
  }
  return out;
}

function fromUser(m: Message): Item[] {
  const out: Item[] = [];
  const texts: Array<{ type: "input_text"; text: string }> = [];
  for (const b of m.content) {
    if (b.kind === "tool_result") {
      const body = b.content.flatMap((c) => (c.kind === "text" ? [c.text] : [])).join("\n");
      // 这个格式没有 is_error 字段，错误结果加前缀，否则模型会把拒绝理由当成正常输出；空的错误结果给一个最小占位
      out.push({ type: "function_call_output", call_id: b.toolUseId, output: b.isError ? errorText(body) : body });
    } else if (b.kind === "text") {
      texts.push({ type: "input_text", text: b.text });
    }
  }
  if (texts.length > 0) out.push({ type: "message", role: "user", content: texts });
  return out;
}

function ownItem(b: Block): Item | undefined {
  return (b.ext?.[PROVIDER_ID] as { item?: Item } | undefined)?.item;
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

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      // event: 行与 data 中的 type 重复，只看 data
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data) as StreamEvent;
    }
  }
}

function errorText(body: string): string {
  return body ? `[error] ${body}` : "error";
}
