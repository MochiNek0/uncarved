import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, type Block, type ModelRequest } from "uncarved";
import { anthropicProvider, PROVIDER_ID } from "../src/index.ts";

// 假的 SDK client：记录请求参数，按脚本回放流式事件和最终消息；final 是函数时可以抛错
function fakeClient(final: Record<string, unknown> | (() => never), events: unknown[] = []) {
  const calls: Record<string, unknown>[] = [];
  const options: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, opts: Record<string, unknown>) {
          calls.push(params);
          options.push(opts);
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => (typeof final === "function" ? final() : final),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls, options };
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
    { signal: new AbortController().signal, onDelta: (d) => d.kind !== "reset" && deltas.push(d.text) },
  );

  expect(deltas).toEqual(["he"]);
  expect(res.stopReason).toBe("tool_use");
  // inputTokens 是输入总量：API 的 input_tokens 加上缓存部分
  expect(res.usage).toMatchObject({ inputTokens: 13, outputTokens: 5, cacheReadTokens: 3 });
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
  // 思考块没有原始数据无法回传，整条 assistant 消息因此没有内容，被省略
  const sent = calls[0]!.messages as Array<{ content: unknown[] }>;
  expect(sent).toHaveLength(1);
  expect(sent[0]!.content).toEqual([{ type: "tool_result", tool_use_id: "t", is_error: true }]);
});

const hi: ModelRequest = {
  system: [],
  tools: [],
  messages: [{ role: "user", content: [{ kind: "text", text: "hi", origin: user, trust: "trusted" }] }],
};

test("流里拿不到 stop_reason 但有 tool_use 时，按 tool_use 处理", async () => {
  const toolOnly = { model: "m", content: [{ type: "tool_use", id: "tu1", name: "echo", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } };
  // SDK 拼出的消息里没有 stop_reason 字段，或者为 null
  for (const final of [toolOnly, { ...toolOnly, stop_reason: null }]) {
    const res = await anthropicProvider({ client: fakeClient(final).client }).complete(hi, { signal: new AbortController().signal });
    expect(res.stopReason).toBe("tool_use");
    expect(res.provider).toBe(PROVIDER_ID);
  }
});

test("ext 与构造参数：body、headers 按 默认值 < ext 合并，保留字段不能覆盖（4.7）", async () => {
  const { client, calls, options } = fakeClient({ model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  const provider = anthropicProvider({ client, extraBody: { temperature: 1 }, headers: { "x-a": "default" } });
  const signal = new AbortController().signal;
  await provider.complete({ ...hi, ext: { [PROVIDER_ID]: { body: { temperature: 0, model: "claude-haiku-5-5" }, headers: { "x-b": "ext" } } } }, { signal });
  expect(calls[0]).toMatchObject({ model: "claude-haiku-5-5", temperature: 0 });
  expect(options[0]).toMatchObject({ signal, headers: { "x-a": "default", "x-b": "ext" } });

  await expect(provider.complete({ ...hi, ext: { [PROVIDER_ID]: { body: { messages: [] } } } }, { signal })).rejects.toThrow(
    'must not set "messages"',
  );
  expect(calls).toHaveLength(1);
});

test("SDK 的错误转成 ProviderError；取消照原样抛出", async () => {
  const signal = new AbortController().signal;
  const fail = (err: unknown) => anthropicProvider({ client: fakeClient(() => { throw err; }).client }).complete(hi, { signal }).catch((e) => e);

  const limited = await fail(new Anthropic.APIError(429, {}, "rate limited", new Headers({ "retry-after": "2" })));
  expect(limited).toBeInstanceOf(ProviderError);
  expect(limited).toMatchObject({ retryable: true, status: 429, retryAfterMs: 2000 });
  // Retry-After 也可以是 HTTP 日期
  const at = new Date(Date.now() + 60_000).toUTCString();
  const dated = await fail(new Anthropic.APIError(503, {}, "busy", new Headers({ "retry-after": at })));
  expect(dated.retryAfterMs).toBeGreaterThan(50_000);
  expect(dated.retryAfterMs).toBeLessThanOrEqual(60_000);

  expect(await fail(new Anthropic.APIError(400, {}, "bad", new Headers()))).toMatchObject({ retryable: false, status: 400 });
  expect(await fail(new Anthropic.APIConnectionError({ message: "reset" }))).toMatchObject({ retryable: true, status: undefined });
  expect(await fail(new Anthropic.APIUserAbortError())).not.toBeInstanceOf(ProviderError);
});

test("其他 provider 的工具调用参数不是对象（解析失败的原始字符串）：包成对象发送，API 只接受对象", async () => {
  const { client, calls } = fakeClient({ model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } });
  const other = { by: "model" as const, provider: "openai-compat", model: "x" };
  await anthropicProvider({ client }).complete(
    {
      system: [],
      tools: [],
      messages: [
        {
          role: "assistant",
          content: [
            { kind: "tool_use", id: "a", name: "echo", input: '{"x": ', origin: other, trust: "trusted" },
            { kind: "tool_use", id: "b", name: "echo", input: { x: 1 }, origin: other, trust: "trusted" },
          ],
        },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect((calls[0]!.messages as Array<{ content: unknown }>)[0]!.content).toEqual([
    { type: "tool_use", id: "a", name: "echo", input: { raw_arguments: '{"x": ' } },
    { type: "tool_use", id: "b", name: "echo", input: { x: 1 } },
  ]);
});

test("空的 text 块不发送；没有内容的消息整条省略", async () => {
  const { client, calls } = fakeClient({ model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } });
  const toolOrigin = { by: "tool" as const, name: "sh" };
  await anthropicProvider({ client }).complete(
    {
      system: [],
      tools: [],
      messages: [
        { role: "user", content: [{ kind: "text", text: "", origin: user, trust: "trusted" }] },
        {
          role: "assistant",
          content: [{ kind: "thinking", text: "no signature", origin: { by: "model", provider: "other", model: "x" }, trust: "trusted" }],
        },
        {
          role: "user",
          content: [
            {
              kind: "tool_result",
              toolUseId: "t",
              isError: false,
              content: [{ kind: "text", text: "", origin: toolOrigin, trust: "untrusted" }],
              origin: toolOrigin,
              trust: "untrusted",
            },
            { kind: "text", text: "go on", origin: user, trust: "trusted" },
          ],
        },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect(calls[0]!.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t", is_error: false },
        { type: "text", text: "go on" },
      ],
    },
  ]);
});

test("流读取中出现的非 SDK 错误：转成可重试的 ProviderError", async () => {
  const signal = new AbortController().signal;
  const err = await anthropicProvider({ client: fakeClient(() => { throw new TypeError("terminated"); }).client })
    .complete(hi, { signal })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ retryable: true, message: expect.stringContaining("terminated") });
});

test("只有空白的 text 块也不发送：API 同样拒绝（例如工具只输出了换行）", async () => {
  const { client, calls } = fakeClient({ model: "m", content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } });
  const toolOrigin = { by: "tool" as const, name: "sh" };
  await anthropicProvider({ client }).complete(
    {
      system: [],
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            {
              kind: "tool_result",
              toolUseId: "t",
              isError: false,
              content: [{ kind: "text", text: "\n", origin: toolOrigin, trust: "untrusted" }],
              origin: toolOrigin,
              trust: "untrusted",
            },
            { kind: "text", text: "  ", origin: user, trust: "trusted" },
          ],
        },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect(calls[0]!.messages).toEqual([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: false }] }]);
});
