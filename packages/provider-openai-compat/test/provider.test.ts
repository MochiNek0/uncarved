import { expect, test } from "bun:test";
import { MemoryLogStore, Runtime, type Tool } from "uncarved";
import { openaiCompatProvider } from "../src/index.ts";

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
    plugins: [{ id: "p", version: "1", kernel: "^1", tools: [echo] }],
  });
  const deltas: string[] = [];
  rt.subscribe((n) => n.type === "delta" && deltas.push(n.delta.text));

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

test("HTTP 错误会让本轮失败，并带上服务端返回的信息", async () => {
  const fetchFn = (async () => new Response('{"error":"Token not provided"}', { status: 401 })) as unknown as typeof fetch;
  const provider = openaiCompatProvider({ baseURL: "https://example.test/v1", model: "m", fetch: fetchFn });
  await expect(
    provider.complete({ system: [], tools: [], messages: [] }, { signal: new AbortController().signal }),
  ).rejects.toThrow("HTTP 401");
});
