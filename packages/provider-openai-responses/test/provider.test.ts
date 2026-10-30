import { expect, test } from "bun:test";
import { MemoryLogStore, ProviderError, Runtime, type Block, type Tool } from "uncarved";
import { openaiResponsesProvider, PROVIDER_ID } from "../src/index.ts";

// 假的服务端：按顺序返回 SSE 事件，并记录请求体
function fakeServer(responses: object[][]) {
  const bodies: Record<string, any>[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const events = responses.shift() ?? [];
    const sse = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
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

const created = { type: "response.created", response: { model: "fake-1", status: "in_progress" } };
const completed = (usage?: object) => ({ type: "response.completed", response: { model: "fake-1", status: "completed", usage } });
const itemDone = (output_index: number, item: object) => ({ type: "response.output_item.done", output_index, item });

const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "think" }],
  encrypted_content: "ENC",
};
const message = (id: string, text: string) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: '{"x": 1}', status: "completed" };

const userSays = (text: string) => ({
  kind: "message" as const,
  content: [{ kind: "text" as const, text, origin: { by: "user" as const }, trust: "trusted" as const }],
});

test("在完整的内核循环里跑通：流式文本、推理、工具调用，输出 item 原样回传", async () => {
  const { fetchFn, bodies } = fakeServer([
    [
      created,
      { type: "response.reasoning_summary_text.delta", delta: "think" },
      itemDone(0, reasoning),
      { type: "response.output_text.delta", delta: "let me " },
      { type: "response.output_text.delta", delta: "check" },
      itemDone(1, message("msg_1", "let me check")),
      { type: "response.function_call_arguments.delta", delta: '{"x"' },
      itemDone(2, call),
      completed({ input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 8 } }),
    ],
    [created, { type: "response.output_text.delta", delta: "done" }, itemDone(0, message("msg_2", "done")), completed()],
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
  const prompt = {
    id: "prompt",
    version: "1",
    kernel: "^1",
    hooks: [
      {
        kind: "transform" as const,
        point: "context.build" as const,
        fn: (r: any) => ({
          ...r,
          system: [{ text: "be brief", stability: "stable", origin: { by: "plugin", id: "prompt" }, trust: "trusted" }],
        }),
      },
    ],
  };

  const rt = await Runtime.create({
    store: new MemoryLogStore(),
    provider: openaiResponsesProvider({ baseURL: "https://example.test/v1/", model: "fake-1", apiKey: "k", fetch: fetchFn }),
    plugins: [{ id: "p", version: "1", kernel: "^1", tools: [echo] }, prompt],
  });
  const deltas: string[] = [];
  rt.subscribe((n) => n.type === "delta" && n.delta.kind !== "reset" && deltas.push(`${n.delta.kind}:${n.delta.text}`));
  await rt.send(userSays("hi"));

  expect(deltas).toEqual(["thinking:think", "text:let me ", "text:check", "text:done"]);
  expect(seen).toEqual([{ x: 1 }]);
  const first = rt.state.messages[1]!.content;
  expect(first.map((b) => b.kind)).toEqual(["thinking", "text", "tool_use"]);
  expect(first[0]).toMatchObject({ text: "think", origin: { provider: "openai-responses", model: "fake-1" } });
  expect(first[2]).toMatchObject({ id: "call_1", name: "echo", input: { x: 1 } });

  expect(bodies[0]).toMatchObject({
    model: "fake-1",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    instructions: "be brief",
    tools: [{ type: "function", name: "echo", description: "echo", parameters: { type: "object" }, strict: false }],
  });
  // 无状态：去掉 id，其余字段（包括加密推理、原始参数字符串）原样回传；
  // function_call 保留 id，部分兼容服务端要求必填
  const { id: _r, ...reasoningNoId } = reasoning;
  const { id: _m, ...messageNoId } = message("msg_1", "let me check");
  expect(bodies[1]!.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    reasoningNoId,
    messageNoId,
    call,
    { type: "function_call_output", call_id: "call_1", output: "echoed" },
  ]);
  expect(rt.state.messages.at(-1)!.content[0]).toMatchObject({ kind: "text", text: "done" });
});

test("用量、截断与拒绝映射到内核的停止原因", async () => {
  const complete = async (events: object[]) => {
    const { fetchFn } = fakeServer([events]);
    const provider = openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
    return provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal });
  };

  const ok = await complete([itemDone(0, message("m1", "hi")), completed({ input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } })]);
  expect(ok.stopReason).toBe("end");
  expect(ok.usage).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 4 });

  const cut = await complete([
    itemDone(0, message("m1", "partial")),
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ]);
  expect(cut.stopReason).toBe("max_tokens");

  const refused = await complete([
    itemDone(0, { type: "message", id: "m1", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }),
    completed(),
  ]);
  expect(refused.stopReason).toBe("refusal");
  expect(refused.content[0]).toMatchObject({ kind: "text", text: "no" });

  // 内核不认识的 item 作为 opaque 块原样保留
  const builtin = await complete([itemDone(0, { type: "web_search_call", id: "ws_1", status: "completed" }), completed()]);
  expect(builtin.content[0]).toMatchObject({ kind: "opaque", ext: { "openai-responses": { item: { type: "web_search_call" } } } });
});

test("失败事件与 HTTP 错误会让调用失败，并带上服务端的信息和能否重试（4.7）", async () => {
  const { fetchFn } = fakeServer([
    [{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "overloaded" } } }],
  ]);
  const provider = openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const req = { system: [], tools: [], messages: [] };
  const failed = await provider.complete(req, { signal: new AbortController().signal }).catch((e) => e);
  expect(failed).toBeInstanceOf(ProviderError);
  expect(failed).toMatchObject({ retryable: true, message: expect.stringContaining("overloaded") });

  const http = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
  const denied = await openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: http })
    .complete(req, { signal: new AbortController().signal })
    .catch((e) => e);
  expect(denied).toBeInstanceOf(ProviderError);
  expect(denied).toMatchObject({ retryable: false, status: 401, message: expect.stringContaining("HTTP 401") });
});

test("ext 与构造参数：body、headers 按 默认值 < ext 合并，保留字段不能覆盖（4.7）", async () => {
  const seen: RequestInit[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push(init);
    const { fetchFn } = fakeServer([[itemDone(0, message("m1", "ok")), completed()]]);
    return fetchFn(url, init);
  }) as unknown as typeof fetch;
  const provider = openaiResponsesProvider({
    baseURL: "https://example.test/v1",
    model: "m",
    fetch: fetchFn,
    extraBody: { temperature: 1, top_p: 0.5 },
    headers: { "x-a": "default", "x-b": "default" },
  });
  const signal = new AbortController().signal;
  await provider.complete(
    {
      system: [],
      tools: [],
      messages: [],
      ext: { [PROVIDER_ID]: { body: { temperature: 0, model: "m-mini" }, headers: { "x-b": "ext" } }, other: { body: { x: 1 } } },
    },
    { signal },
  );
  expect(JSON.parse(seen[0]!.body as string)).toMatchObject({ model: "m-mini", temperature: 0, top_p: 0.5 });
  expect(JSON.parse(seen[0]!.body as string)).not.toHaveProperty("x");
  expect(seen[0]!.headers).toMatchObject({ "x-a": "default", "x-b": "ext" });

  await expect(
    provider.complete({ system: [], tools: [], messages: [], ext: { [PROVIDER_ID]: { body: { input: [] } } } }, { signal }),
  ).rejects.toThrow('must not set "input"');
  expect(seen).toHaveLength(1);
});

test("网络错误可以重试，取消照原样抛出；Retry-After 换算成毫秒", async () => {
  const req = { system: [], tools: [], messages: [] };
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const err = await openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: offline })
    .complete(req, { signal: new AbortController().signal })
    .catch((e) => e);
  expect(err).toMatchObject({ name: "ProviderError", retryable: true });

  const ac = new AbortController();
  ac.abort(new Error("stop"));
  const aborted = await openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: offline })
    .complete(req, { signal: ac.signal })
    .catch((e) => e);
  expect(aborted).not.toBeInstanceOf(ProviderError);

  const limited = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } })) as unknown as typeof fetch;
  const r = await openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: limited })
    .complete(req, { signal: new AbortController().signal })
    .catch((e) => e);
  expect(r).toMatchObject({ retryable: true, status: 429, retryAfterMs: 3000 });
});

test("来自其他 provider 的历史：文本和工具调用按本格式重建，无法表达的块省略", async () => {
  const { fetchFn, bodies } = fakeServer([[itemDone(0, message("m1", "ok")), completed()]]);
  const other = { by: "model" as const, provider: "anthropic", model: "claude" };
  const history: Block[] = [
    { kind: "thinking", text: "hidden", origin: other, trust: "trusted", ext: { anthropic: { signature: "s" } } },
    { kind: "text", text: "calling", origin: other, trust: "trusted" },
    { kind: "tool_use", id: "toolu_1", name: "echo", input: { x: 1 }, origin: other, trust: "trusted" },
  ];
  const provider = openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn, store: true });
  await provider.complete(
    {
      system: [],
      tools: [],
      messages: [
        { role: "assistant", content: history },
        {
          role: "user",
          content: [{ kind: "tool_result", toolUseId: "toolu_1", content: [], isError: true, origin: { by: "runtime" }, trust: "trusted" }],
        },
      ],
    },
    { signal: new AbortController().signal },
  );
  expect(bodies[0]).not.toHaveProperty("include");
  expect(bodies[0]!.input).toEqual([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "calling" }] },
    { type: "function_call", call_id: "toolu_1", name: "echo", arguments: '{"x":1}' },
    { type: "function_call_output", call_id: "toolu_1", output: "error" },
  ]);
});

test("错误的工具结果加上 [error] 前缀，这个格式没有 is_error 字段", async () => {
  const { fetchFn, bodies } = fakeServer([[itemDone(0, message("m1", "ok")), completed()]]);
  const provider = openaiResponsesProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  const origin = { by: "plugin" as const, id: "policy" };
  const result = (toolUseId: string, text: string, isError: boolean): Block => ({
    kind: "tool_result",
    toolUseId,
    content: [{ kind: "text", text, origin, trust: "trusted" }],
    isError,
    origin,
    trust: "trusted",
  });
  await provider.complete(
    { system: [], tools: [], messages: [{ role: "user", content: [result("c1", "denied by policy", true), result("c2", "fine", false)] }] },
    { signal: new AbortController().signal },
  );
  expect(bodies[0]!.input).toEqual([
    { type: "function_call_output", call_id: "c1", output: "[error] denied by policy" },
    { type: "function_call_output", call_id: "c2", output: "fine" },
  ]);
});
