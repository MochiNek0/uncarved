import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Block, ModelRequest } from "uncarved";
import { anthropicProvider } from "../src/index.ts";

// 假的 SDK client：记录请求参数，按脚本回放流式事件和最终消息
function fakeClient(final: Record<string, unknown>, events: unknown[] = []) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => final,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const user = { by: "user" as const };
const plugin = { by: "plugin" as const, id: "p" };

test("请求翻译：缓存标记打在最后一个 stable 段，空的 system 和 tools 不发送", async () => {
  const { client, calls } = fakeClient({
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const provider = anthropicProvider({ client });
  const base: ModelRequest = {
    system: [],
    tools: [],
    messages: [{ role: "user", content: [{ kind: "text", text: "hi", origin: user, trust: "trusted" }] }],
  };

  await provider.complete(base, { signal: new AbortController().signal });
  expect(calls[0]).not.toHaveProperty("system");
  expect(calls[0]).not.toHaveProperty("tools");
  expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });

  await provider.complete(
    {
      ...base,
      system: [
        { text: "a", stability: "stable", origin: plugin, trust: "trusted" },
        { text: "b", stability: "stable", origin: plugin, trust: "trusted" },
        { text: "c", stability: "volatile", origin: plugin, trust: "trusted" },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect(calls[1]!.system).toEqual([
    { type: "text", text: "a" },
    { type: "text", text: "b", cache_control: { type: "ephemeral" } },
    { type: "text", text: "c" },
  ]);
});

test("模型输出的块原样回传，包括思考块的签名（I-6）", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-123" };
  const toolUse = { type: "tool_use", id: "tu1", name: "echo", input: { x: 1 } };
  const fallback = { type: "fallback", from: { model: "a" }, to: { model: "b" } };
  const { client, calls } = fakeClient(
    {
      model: "claude-opus-5-5",
      content: [thinking, fallback, toolUse],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    },
    [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "he" } }],
  );
  const provider = anthropicProvider({ client });
  const deltas: string[] = [];

  const res = await provider.complete(
    { system: [], tools: [], messages: [{ role: "user", content: [{ kind: "text", text: "hi", origin: user, trust: "trusted" }] }] },
    { signal: new AbortController().signal, onDelta: (d) => deltas.push(d.text) },
  );

  expect(deltas).toEqual(["he"]);
  expect(res.stopReason).toBe("tool_use");
  expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
  expect(res.content.map((b) => b.kind)).toEqual(["thinking", "opaque", "tool_use"]);

  // 第二轮：把回复和工具结果发回去
  const result: Block = {
    kind: "tool_result",
    toolUseId: "tu1",
    isError: false,
    origin: { by: "tool", name: "echo" },
    trust: "untrusted",
    content: [{ kind: "text", text: "ok", origin: { by: "tool", name: "echo" }, trust: "untrusted" }],
  };
  await provider.complete(
    {
      system: [],
      tools: [],
      messages: [
        { role: "user", content: [{ kind: "text", text: "hi", origin: user, trust: "trusted" }] },
        { role: "assistant", content: res.content },
        { role: "user", content: [result] },
      ],
    },
    { signal: new AbortController().signal },
  );

  const sent = calls[1]!.messages as Array<{ content: unknown[] }>;
  expect(sent[1]!.content).toEqual([thinking, fallback, toolUse]);
  expect(sent[2]!.content).toEqual([
    { type: "tool_result", tool_use_id: "tu1", is_error: false, content: [{ type: "text", text: "ok" }] },
  ]);
});

test("没有原始数据的思考块和空的错误结果", async () => {
  const { client, calls } = fakeClient({ model: "m", content: [], stop_reason: "pause_turn", usage: { input_tokens: 0, output_tokens: 0 } });
  const res = await anthropicProvider({ client }).complete(
    {
      system: [],
      tools: [],
      messages: [
        {
          role: "assistant",
          content: [{ kind: "thinking", text: "no signature", origin: { by: "model", provider: "other", model: "x" }, trust: "trusted" }],
        },
        {
          role: "user",
          content: [{ kind: "tool_result", toolUseId: "t", isError: true, content: [], origin: { by: "runtime" }, trust: "trusted" }],
        },
      ],
    },
    { signal: new AbortController().signal },
  );

  expect(res.stopReason).toBe("pause");
  const sent = calls[0]!.messages as Array<{ content: unknown[] }>;
  expect(sent[0]!.content).toEqual([]);
  expect(sent[1]!.content).toEqual([{ type: "tool_result", tool_use_id: "t", is_error: true }]);
});
