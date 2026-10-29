// Anthropic provider：把内核的 ModelRequest 翻译成 Claude Messages API 请求。

import Anthropic from "@anthropic-ai/sdk";
import type { Block, Message, Origin, Provider, StopReason, SystemSegment } from "uncarved";

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type TextBlockParam = Anthropic.Beta.BetaTextBlockParam;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export const PROVIDER_ID = "anthropic";

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
}

export function anthropicProvider(opts: AnthropicProviderOptions = {}): Provider {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? "claude-opus-5-5";

  return {
    id: PROVIDER_ID,
    async complete(req, { signal, onDelta }) {
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
        { signal },
      );

      for await (const ev of stream) {
        if (ev.type !== "content_block_delta") continue;
        if (ev.delta.type === "text_delta") onDelta?.({ kind: "text", text: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") onDelta?.({ kind: "thinking", text: ev.delta.thinking });
      }

      const msg = await stream.finalMessage();
      const origin: Origin = { by: "model", provider: PROVIDER_ID, model: msg.model };
      return {
        model: msg.model,
        content: msg.content.map((b) => fromBlock(b, origin)),
        stopReason: toStopReason(msg.stop_reason),
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

function toStopReason(r: string | null): StopReason {
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
