// Anthropic provider：把内核的 ModelRequest 翻译成 Claude Messages API 请求。

import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type Block, type Message, type Origin, type Provider, type StopReason, type SystemSegment } from "uncarved";

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type TextBlockParam = Anthropic.Beta.BetaTextBlockParam;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export const PROVIDER_ID = "anthropic";

/** ModelRequest.ext[PROVIDER_ID] 的格式（4.7） */
export interface AnthropicExt {
  /** 合并进请求参数 */
  body?: Record<string, unknown>;
  /** 合并进请求头 */
  headers?: Record<string, string>;
}

// 由 ModelRequest 生成的字段，不能通过 extraBody / ext 覆盖
const RESERVED = ["messages", "system", "tools", "stream"];

export interface AnthropicProviderOptions {
  client?: Anthropic;
  /** 默认 claude-opus-5-5 */
  model?: string;
  /** 默认 64000 */
  maxTokens?: number;
  /** 默认 high（claude-opus-5-5 的服务端默认值是 medium） */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** 默认 summarized，这样流式输出时能看到思考摘要 */
  thinkingDisplay?: "summarized" | "omitted";
  /** 模型因安全策略拒绝时，由服务端自动换模型重试。默认开启 */
  fallbacks?: boolean;
  /** 每次请求都合并进请求参数，ext 中的 body 覆盖它 */
  extraBody?: Record<string, unknown>;
  /** 每次请求都合并进请求头，ext 中的 headers 覆盖它 */
  headers?: Record<string, string>;
}

export function anthropicProvider(opts: AnthropicProviderOptions = {}): Provider {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? "claude-opus-5-5";

  return {
    id: PROVIDER_ID,
    async complete(req, { signal, onDelta }) {
      const ext = (req.ext?.[PROVIDER_ID] ?? {}) as AnthropicExt;
      const extra = { ...opts.extraBody, ...ext.body };
      const reserved = RESERVED.find((k) => k in extra);
      if (reserved) throw new Error(`${PROVIDER_ID}: extra body must not set "${reserved}"`);

      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: opts.maxTokens ?? 64000,
          thinking: { type: "adaptive", display: opts.thinkingDisplay ?? "summarized" },
          output_config: { effort: opts.effort ?? "high" },
          ...(opts.fallbacks === false
            ? {}
            : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
          // 自动在最后一个可缓存的块上打缓存标记，覆盖整段历史
          cache_control: { type: "ephemeral" },
          ...extra,
          ...(req.system.length > 0 ? { system: toSystem(req.system) } : {}),
          ...(req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
                })),
              }
            : {}),
          messages: req.messages.map(toParam),
        },
        { signal, headers: { ...opts.headers, ...ext.headers } },
      );

      let msg: Anthropic.Beta.BetaMessage;
      try {
        for await (const ev of stream) {
          if (ev.type !== "content_block_delta") continue;
          if (ev.delta.type === "text_delta") onDelta?.({ kind: "text", text: ev.delta.text });
          else if (ev.delta.type === "thinking_delta") onDelta?.({ kind: "thinking", text: ev.delta.thinking });
        }
        msg = await stream.finalMessage();
      } catch (err) {
        throw toProviderError(err, signal);
      }

      const origin: Origin = { by: "model", provider: PROVIDER_ID, model: msg.model };
      const content = msg.content.map((b) => fromBlock(b, origin));
      return {
        provider: PROVIDER_ID,
        model: msg.model,
        content,
        stopReason: toStopReason(msg.stop_reason, content.some((b) => b.kind === "tool_use")),
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? undefined,
        },
      };
    },
  };
}

/** SDK 的错误转成 ProviderError；取消和非 SDK 错误照原样抛出 */
function toProviderError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || !(err instanceof Anthropic.APIError) || err instanceof Anthropic.APIUserAbortError) return err;
  const status = err.status;
  const retryAfter = Number(err.headers?.get("retry-after"));
  return new ProviderError(`${PROVIDER_ID} ${status === undefined ? "request failed" : `HTTP ${status}`}: ${err.message}`, {
    // 没有状态码的是连接错误
    retryable: status === undefined || status === 408 || status === 429 || status >= 500,
    status,
    retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    cause: err,
  });
}

/** 缓存标记打在最后一个 stable 段上 */
function toSystem(segments: SystemSegment[]): TextBlockParam[] {
  const lastStable = segments.findLastIndex((s) => s.stability === "stable");
  return segments.map((s, i) => ({
    type: "text",
    text: s.text,
    ...(i === lastStable ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/** 原始块整块放进 ext，回传时原样还原（I-6） */
function fromBlock(b: ContentBlock, origin: Origin): Block {
  const base = { origin, trust: "trusted" as const, ext: { [PROVIDER_ID]: b } };
  switch (b.type) {
    case "text":
      return { ...base, kind: "text", text: b.text };
    case "thinking":
      return { ...base, kind: "thinking", text: b.thinking };
    case "tool_use":
      return { ...base, kind: "tool_use", id: b.id, name: b.name, input: b.input };
    default:
      return { ...base, kind: "opaque" };
  }
}

function toParam(m: Message): MessageParam {
  return { role: m.role, content: m.content.flatMap(toBlockParam) };
}

function toBlockParam(b: Block): ContentBlockParam[] {
  const raw = b.ext?.[PROVIDER_ID];
  if (raw) return [raw as ContentBlockParam];

  switch (b.kind) {
    case "text":
      return [{ type: "text", text: b.text }];
    case "image":
      return [{ type: "image", source: b.source } as ContentBlockParam];
    case "document":
      return [{ type: "document", source: b.source } as ContentBlockParam];
    case "tool_use":
      return [{ type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> }];
    case "tool_result": {
      const inner = b.content.flatMap(toBlockParam) as ToolResultBlockParam["content"] & unknown[];
      return [
        {
          type: "tool_result",
          tool_use_id: b.toolUseId,
          is_error: b.isError,
          ...(inner.length > 0 ? { content: inner } : {}),
        },
      ];
    }
    case "thinking":
    case "opaque":
      // 没有原始数据（签名等）就无法回传，只能省略
      return [];
  }
}

function toStopReason(r: string | null | undefined, hasToolUse: boolean): StopReason {
  // 部分兼容服务端的流里没有 message_delta，拿不到 stop_reason（SDK 拼出的消息里没有这个字段）
  if (r == null && hasToolUse) return "tool_use";
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause";
    default:
      return "other";
  }
}
