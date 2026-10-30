import { expect, test } from "bun:test";
import { MemoryLogStore, ProviderError, Runtime, type Block, type Tool } from "uncarved";
import { openaiCompatProvider, PROVIDER_ID } from "../src/index.ts";

// 假的服务端：按顺序返回 SSE 响应，并记录请求体
function fakeServer(responses: string[][]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const chunks = responses.shift() ?? [];
    const sse = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    // 故意切成小段，验证跨段拼接
    const bytes = new TextEncoder().encode(sse);
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let i = 0; i < bytes.length; i += 7) ctrl.enqueue(bytes.slice(i, i + 7));
        ctrl.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

const chunk = (delta: object, finish: string | null = null) =>
  JSON.stringify({ model: "fake-1", choices: [{ delta, finish_reason: finish }] });

test("在完整的内核循环里跑通：流式文本、分段的工具参数、工具结果回传", async () => {
  const { fetchFn, bodies } = fakeServer([
    [
      chunk({ content: "let me " }),
      chunk({ content: "check" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: '{"x"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ": 1}" } }] }, "tool_calls"),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    ],
    [chunk({ content: "done" }, "stop")],
  ]);

  const seen: unknown[] = [];
  const echo: Tool = {
    name: "echo",
    description: "echo",
    inputSchema: { type: "object" },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input) {
      seen.push(input);
      return { content: "echoed" };
    },
  };

  const rt = await Runtime.create({
    store: new MemoryLogStore(),
    provider: openaiCompatProvider({ baseURL: "https://example.test/v1/", model: "fake-1", apiKey: "k", fetch: fetchFn }),
    plugins: [{ id: "p", version: "1", kernel: "^0.1", tools: [echo] }],
  });
  const deltas: string[] = [];
  rt.subscribe((n) => n.type === "delta" && n.delta.kind !== "reset" && deltas.push(n.delta.text));

  await rt.send({ kind: "message", content: [{ kind: "text", text: "hi", origin: { by: "user" }, trust: "trusted" }] });

  expect(deltas.join("")).toBe("let me checkdone");
  expect(seen).toEqual([{ x: 1 }]);
  expect(rt.state.messages.at(-1)!.content[0]).toMatchObject({ kind: "text", text: "done" });

  expect(bodies[0]).toMatchObject({ model: "fake-1", stream: true, tools: [{ type: "function", function: { name: "echo" } }] });
  expect(bodies[0]).not.toHaveProperty("messages.0.role", "system");
  expect(bodies[1]!.messages).toEqual([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "let me check",
      // 原始参数字符串原样回传
      tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"x": 1}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "echoed" },
  ]);
});

test("HTTP 错误会让本轮失败，并带上服务端返回的信息和能否重试（4.7）", async () => {
  const req = { system: [], tools: [], messages: [] };
  const signal = new AbortController().signal;
  const denied = (async () => new Response('{"error":"Token not provided"}', { status: 401 })) as unknown as typeof fetch;
  const err = await openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: denied })
    .complete(req, { signal })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ retryable: false, status: 401, message: expect.stringContaining("Token not provided") });

  const busy = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
  const err2 = await openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: busy })
    .complete(req, { signal })
    .catch((e) => e);
  expect(err2).toMatchObject({ retryable: true, status: 503 });
});

test("ext 与构造参数：body、headers 按 默认值 < ext 合并，保留字段不能覆盖（4.7）", async () => {
  const { fetchFn, bodies } = fakeServer([[chunk({ content: "ok" }, "stop")]]);
  const headers: unknown[] = [];
  const spy = ((url: string, init: RequestInit) => {
    headers.push(init.headers);
    return fetchFn(url, init);
  }) as unknown as typeof fetch;
  const provider = openaiCompatProvider({
    baseURL: "https://example.test/v1",
    model: "m",
    apiKey: "k",
    fetch: spy,
    extraBody: { temperature: 1 },
    headers: { authorization: "Token custom" },
  });
  const signal = new AbortController().signal;
  await provider.complete(
    { system: [], tools: [], messages: [], ext: { [PROVIDER_ID]: { body: { temperature: 0, enable_thinking: false } } } },
    { signal },
  );
  expect(bodies[0]).toMatchObject({ model: "m", temperature: 0, enable_thinking: false, stream: true });
  // 构造参数中的 headers 可以替换默认的认证方式
  expect(headers[0]).toMatchObject({ authorization: "Token custom" });

  await expect(
    provider.complete({ system: [], tools: [], messages: [], ext: { [PROVIDER_ID]: { body: { stream: false } } } }, { signal }),
  ).rejects.toThrow('must not set "stream"');
});

test("错误的工具结果加上 [error] 前缀，这个格式没有 is_error 字段", async () => {
  const { fetchFn, bodies } = fakeServer([[chunk({ content: "ok" }, "stop")]]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const origin = { by: "plugin" as const, id: "policy" };
  const result = (toolUseId: string, text: string | undefined, isError: boolean): Block => ({
    kind: "tool_result",
    toolUseId,
    content: text === undefined ? [] : [{ kind: "text", text, origin, trust: "trusted" }],
    isError,
    origin,
    trust: "trusted",
  });
  await provider.complete(
    {
      system: [],
      tools: [],
      messages: [{ role: "user", content: [result("c1", "denied by policy", true), result("c2", undefined, true), result("c3", "fine", false)] }],
    },
    { signal: new AbortController().signal },
  );
  expect(bodies[0]!.messages).toEqual([
    { role: "tool", tool_call_id: "c1", content: "[error] denied by policy" },
    { role: "tool", tool_call_id: "c2", content: "error" },
    { role: "tool", tool_call_id: "c3", content: "fine" },
  ]);
});

// 原样返回给定的 SSE 文本，不自动补 [DONE]
const rawSSE = (sse: string) => (async () => new Response(sse, { status: 200 })) as unknown as typeof fetch;

test("流在 finish_reason 和 [DONE] 之前断开：抛出可重试的 ProviderError，不当成正常回复", async () => {
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: rawSSE(`data: ${chunk({ content: "half" })}\n\n`) });
  const err = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal }).catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.retryable).toBe(true);
});

test("流里的 error 块：抛出 ProviderError，不返回空回复", async () => {
  const sse = `data: ${JSON.stringify({ error: { message: "overloaded", code: 529 } })}\n\ndata: [DONE]\n\n`;
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: rawSSE(sse) });
  const err = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal }).catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ retryable: true, message: expect.stringContaining("overloaded") });
});

test("服务端没给 tool call id 时生成唯一的 id", async () => {
  const { fetchFn } = fakeServer([
    [
      chunk({ tool_calls: [{ index: 0, function: { name: "a", arguments: "{}" } }, { index: 1, function: { name: "b", arguments: "{}" } }] }, "tool_calls"),
    ],
  ]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const res = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal });
  const ids = res.content.flatMap((b) => (b.kind === "tool_use" ? [b.id] : []));
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(2);
});

test("tool call 缺少 index 时按 id 区分调用，不丢弃", async () => {
  const { fetchFn } = fakeServer([
    [
      chunk({ tool_calls: [{ id: "a", function: { name: "x", arguments: '{"n":' } }] }),
      chunk({ tool_calls: [{ function: { arguments: "1}" } }] }),
      chunk({ tool_calls: [{ id: "b", function: { name: "y", arguments: "{}" } }] }, "tool_calls"),
    ],
  ]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const res = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal });
  expect(res.content.map((b) => (b.kind === "tool_use" ? [b.id, b.name, b.input] : null))).toEqual([
    ["a", "x", { n: 1 }],
    ["b", "y", {}],
  ]);
  expect(res.stopReason).toBe("tool_use");
});

test("流读到一半连接出错：抛出可重试的 ProviderError", async () => {
  const fetchFn = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(`data: ${chunk({ content: "half" })}\n\n`));
          ctrl.error(new TypeError("socket hang up"));
        },
      }),
    )) as unknown as typeof fetch;
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const err = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal }).catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err).toMatchObject({ retryable: true, message: expect.stringContaining("socket hang up") });
});

test("tool call 既没有 index 也没有 id 时，按新出现的 name 区分调用，不拼成一个", async () => {
  const { fetchFn } = fakeServer([
    [
      chunk({ tool_calls: [{ function: { name: "read", arguments: '{"a":' } }] }),
      chunk({ tool_calls: [{ function: { arguments: "1}" } }] }),
      chunk({ tool_calls: [{ function: { name: "read", arguments: '{"b":2}' } }] }, "tool_calls"),
    ],
  ]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const res = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal });
  expect(res.content.map((b) => (b.kind === "tool_use" ? [b.name, b.input] : null))).toEqual([
    ["read", { a: 1 }],
    ["read", { b: 2 }],
  ]);
});

test("SSE：一个事件的多行 data 按换行拼接；事件之间不空行、CRLF 换行、末尾没有空行也能解析", async () => {
  const multiLine = `data: {"model":"fake-1","choices":[{"delta":\r\ndata: {"content":"a"}}]}\r\n\r\n`;
  const noBlank = `data: ${chunk({ content: "b" })}\ndata: ${chunk({ content: "c" }, "stop")}\n`;
  const sse = `: keep-alive\n\nevent: message\n${multiLine}${noBlank}data: [DONE]`;
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: rawSSE(sse) });
  const res = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal });
  expect(res.content).toMatchObject([{ kind: "text", text: "abc" }]);
  expect(res.stopReason).toBe("end");
});

test("用户消息里的图片转成 image_url；无法表达的图片、文档和工具结果里的图片换成占位说明，不静默丢弃", async () => {
  const { fetchFn, bodies } = fakeServer([[chunk({ content: "ok" }, "stop")]]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const user = { by: "user" as const };
  const tool = { by: "tool" as const, name: "shot" };
  await provider.complete(
    {
      system: [],
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            {
              kind: "tool_result",
              toolUseId: "c1",
              content: [
                { kind: "text", text: "captured", origin: tool, trust: "untrusted" },
                { kind: "image", source: { type: "base64", media_type: "image/png", data: "AAA" }, origin: tool, trust: "untrusted" },
              ],
              isError: false,
              origin: tool,
              trust: "untrusted",
            },
            { kind: "text", text: "look", origin: user, trust: "trusted" },
            { kind: "image", source: { type: "base64", media_type: "image/png", data: "AAA" }, origin: user, trust: "trusted" },
            { kind: "image", source: { type: "url", url: "https://example.test/a.png" }, origin: user, trust: "trusted" },
            { kind: "image", source: { type: "file", file_id: "f1" }, origin: user, trust: "trusted" },
            { kind: "document", source: { type: "base64", media_type: "application/pdf", data: "AAA" }, origin: user, trust: "trusted" },
          ],
        },
        { role: "user", content: [{ kind: "text", text: "plain", origin: user, trust: "trusted" }] },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect(bodies[0]!.messages).toEqual([
    { role: "tool", tool_call_id: "c1", content: "captured\n[image omitted: not supported by openai-compat]" },
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "https://example.test/a.png" } },
        { type: "text", text: "[image omitted: not supported by openai-compat]" },
        { type: "text", text: "[document omitted: not supported by openai-compat]" },
      ],
    },
    // 只有文本时仍是字符串
    { role: "user", content: "plain" },
  ]);
});

test("每一块都重复完整的工具名：不拼成重复的名字", async () => {
  const { fetchFn } = fakeServer([
    [
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"n":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "1}" } }] }, "tool_calls"),
    ],
  ]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const res = await provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal });
  expect(res.content.map((b) => (b.kind === "tool_use" ? [b.name, b.input] : null))).toEqual([["read", { n: 1 }]]);
});

test("服务端没有理会 stream: true，返回普通 JSON 或网页：不可重试", async () => {
  const req = { system: [], tools: [], messages: [] };
  for (const [body, type] of [
    ['{"choices":[]}', "application/json"],
    ["<html>login</html>", "text/html; charset=utf-8"],
  ]) {
    const fetchFn = (async () => new Response(body, { status: 200, headers: { "content-type": type! } })) as unknown as typeof fetch;
    const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
    const err = await provider.complete(req, { signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: false, message: expect.stringContaining("expected an event stream") });
  }
});

test("只有思考块的 assistant 消息整条省略，不发内容为空的消息", async () => {
  const { fetchFn, bodies } = fakeServer([[chunk({ content: "ok" }, "stop")]]);
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const model = { by: "model" as const, provider: "other", model: "x" };
  await provider.complete(
    {
      system: [],
      tools: [],
      messages: [
        { role: "user", content: [{ kind: "text", text: "a", origin: { by: "user" }, trust: "trusted" }] },
        { role: "assistant", content: [{ kind: "thinking", text: "hmm", origin: model, trust: "trusted" }] },
        { role: "user", content: [{ kind: "text", text: "b", origin: { by: "user" }, trust: "trusted" }] },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect(bodies[0]!.messages).toEqual([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
});
