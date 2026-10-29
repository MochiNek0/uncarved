import { describe, expect, test } from "bun:test";
import {
  HookFailure,
  MemoryLogStore,
  PluginIncompatible,
  Runtime,
  readAll,
  rebuild,
  type Block,
  type Event,
  type LogStore,
  type ModelRequest,
  type ModelResponse,
  type Plugin,
  type Provider,
  type RuntimeNotice,
  type Tool,
  type ToolCall,
  type UserInput,
} from "../src/index.ts";

// ---------- 测试辅助 ----------

const MODEL = { by: "model" as const, provider: "scripted", model: "scripted-1" };

type Script = Array<Omit<ModelResponse, "model">>;

function scripted(script: Script) {
  const requests: ModelRequest[] = [];
  const provider: Provider = {
    id: "scripted",
    async complete(req) {
      requests.push(structuredClone(req));
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return { model: "scripted-1", ...next };
    },
  };
  return { provider, requests };
}

const text = (t: string): Block => ({ kind: "text", text: t, origin: MODEL, trust: "trusted" });
const toolUse = (id: string, name: string, input: unknown): Block => ({
  kind: "tool_use",
  id,
  name,
  input,
  origin: MODEL,
  trust: "trusted",
});
const say = (t: string): UserInput => ({
  kind: "message",
  content: [{ kind: "text", text: t, origin: { by: "user" }, trust: "trusted" }],
});

function recordingTool(name: string, opts: Partial<Tool> = {}) {
  const calls: unknown[] = [];
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    effect: "read",
    concurrency: "safe",
    idempotent: true,
    async execute(input) {
      calls.push(input);
      return { content: `${name}:${JSON.stringify(input)}` };
    },
    ...opts,
  };
  return { tool, calls };
}

function plugin(id: string, extra: Partial<Plugin> = {}): Plugin {
  return { id, version: "1.0.0", kernel: "^1", ...extra };
}

function deterministic() {
  let n = 0;
  return { now: () => "2026-01-01T00:00:00.000Z", newId: () => `id-${++n}` };
}

const types = (events: Event[]) => events.map((e) => e.type);

// ---------- 测试 ----------

describe("基本循环", () => {
  test("工具调用后继续，直到模型结束", async () => {
    const store = new MemoryLogStore();
    const echo = recordingTool("echo");
    const { provider, requests } = scripted([
      { content: [toolUse("t1", "echo", { x: 1 }), toolUse("t2", "echo", { x: 2 })], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({ store, provider, plugins: [plugin("p", { tools: [echo.tool] })], ...deterministic() });

    await rt.send(say("hi"));

    expect(rt.state.phase).toBe("idle");
    expect(rt.state.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(echo.calls).toEqual([{ x: 1 }, { x: 2 }]);

    const results = rt.state.messages[2]!.content;
    expect(results.map((b) => b.kind === "tool_result" && b.toolUseId)).toEqual(["t1", "t2"]);
    expect(results.every((b) => b.trust === "untrusted")).toBe(true);

    expect(types(await readAll(store, rt.state.sessionId))).toEqual([
      "session.started",
      "input.received",
      "model.requested",
      "model.responded",
      "tool.decided",
      "tool.decided",
      "tool.completed",
      "tool.completed",
      "model.requested",
      "model.responded",
      "turn.ended",
    ]);

    // I-1：内核自己不产生任何系统提示词
    expect(requests[0]!.system).toEqual([]);
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  test("只凭日志就能重建出相同的状态（I-5）", async () => {
    const store = new MemoryLogStore();
    const echo = recordingTool("echo");
    const { provider } = scripted([
      { content: [toolUse("t1", "echo", {}), toolUse("t2", "echo", {})], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({ store, provider, plugins: [plugin("p", { tools: [echo.tool] })] });
    await rt.send(say("hi"));

    const events = await readAll(store, rt.state.sessionId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(rebuild(rt.state.sessionId, events)).toEqual(rt.state);
  });

  test("max_tokens 截断的工具调用不执行", async () => {
    const echo = recordingTool("echo");
    const { provider } = scripted([{ content: [toolUse("t1", "echo", {})], stopReason: "max_tokens" }]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [plugin("p", { tools: [echo.tool] })],
    });
    await rt.send(say("hi"));

    expect(echo.calls).toEqual([]);
    const last = rt.state.messages.at(-1)!;
    expect(last.content[0]).toMatchObject({ kind: "tool_result", toolUseId: "t1", isError: true });
    expect(rt.state.phase).toBe("idle");
  });
});

describe("关卡与变换", () => {
  test("拒绝优先（I-7），拒绝理由由插件提供", async () => {
    const echo = recordingTool("echo");
    const { provider, requests } = scripted([
      { content: [toolUse("t1", "echo", {})], stopReason: "tool_use" },
      { content: [text("ok")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("allower", { tools: [echo.tool], hooks: [{ kind: "gate", point: "tool.gate", fn: () => ({ decision: "allow" }) }] }),
        plugin("denier", {
          hooks: [{ kind: "gate", point: "tool.gate", fn: () => ({ decision: "deny", reason: "not today" }) }],
        }),
      ],
    });
    await rt.send(say("hi"));

    expect(echo.calls).toEqual([]);
    const result = requests[1]!.messages.at(-1)!.content[0]!;
    expect(result).toMatchObject({ kind: "tool_result", isError: true, origin: { by: "plugin", id: "denier" } });
    expect(result.kind === "tool_result" && result.content[0]).toMatchObject({ kind: "text", text: "not today" });
  });

  test("tool.before 在 tool.gate 之前执行，关卡审的是最终参数", async () => {
    const echo = recordingTool("echo");
    const seenByGate: ToolCall[] = [];
    const { provider } = scripted([
      { content: [toolUse("t1", "echo", { x: 1 })], stopReason: "tool_use" },
      { content: [text("ok")], stopReason: "end" },
    ]);
    const store = new MemoryLogStore();
    const rt = await Runtime.create({
      store,
      provider,
      plugins: [
        plugin("p", {
          tools: [echo.tool],
          hooks: [
            { kind: "transform", point: "tool.before", fn: (c) => ({ ...c, input: { x: 99 } }) },
            {
              kind: "gate",
              point: "tool.gate",
              fn: (c) => {
                seenByGate.push(c);
                return { decision: "allow" };
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("hi"));

    expect(seenByGate[0]!.input).toEqual({ x: 99 });
    expect(echo.calls).toEqual([{ x: 99 }]);
    const decided = (await readAll(store, rt.state.sessionId)).find((e) => e.type === "tool.decided")!;
    expect((decided.data as { input: unknown }).input).toEqual({ x: 99 });
  });

  test("transform 出错时本轮失败，会话仍可继续使用", async () => {
    let fail = true;
    const { provider } = scripted([{ content: [text("second try")], stopReason: "end" }]);
    const store = new MemoryLogStore();
    const rt = await Runtime.create({
      store,
      provider,
      plugins: [
        plugin("broken", {
          hooks: [
            {
              kind: "transform",
              point: "context.build",
              fn: () => {
                if (fail) throw new Error("boom");
              },
            },
          ],
        }),
      ],
    });

    await expect(rt.send(say("hi"))).rejects.toBeInstanceOf(HookFailure);
    const events = await readAll(store, rt.state.sessionId);
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", data: { reason: "error" } });
    expect(rt.state.phase).toBe("idle");

    fail = false;
    await rt.send(say("again"));
    expect(rt.state.messages.at(-1)!.content[0]).toMatchObject({ text: "second try" });
  });

  test("optional 的 transform 出错时跳过并通知", async () => {
    const { provider } = scripted([{ content: [text("ok")], stopReason: "end" }]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("flaky", {
          hooks: [
            {
              kind: "transform",
              point: "context.build",
              optional: true,
              fn: () => {
                throw new Error("boom");
              },
            },
          ],
        }),
      ],
    });
    const notices: RuntimeNotice[] = [];
    rt.subscribe((n) => notices.push(n));
    await rt.send(say("hi"));

    expect(rt.state.phase).toBe("idle");
    expect(notices.some((n) => n.type === "hook-error" && n.info.plugin === "flaky")).toBe(true);
  });

  test("stable 段排在 volatile 段之后时发出警告", async () => {
    const { provider } = scripted([{ content: [text("ok")], stopReason: "end" }]);
    const origin = { by: "plugin" as const, id: "prompts" };
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("prompts", {
          hooks: [
            {
              kind: "transform",
              point: "context.build",
              fn: (req) => ({
                ...req,
                system: [
                  { text: "now", stability: "volatile", origin },
                  { text: "identity", stability: "stable", origin },
                ],
              }),
            },
          ],
        }),
      ],
    });
    const notices: RuntimeNotice[] = [];
    rt.subscribe((n) => notices.push(n));
    await rt.send(say("hi"));

    expect(notices).toContainEqual({ type: "warning", code: "cache-order" });
  });

  test("hook 执行顺序：order，然后配置层级，然后注册顺序", async () => {
    const { provider } = scripted([]);
    const noop = { kind: "observe" as const, point: "event" as const, fn: () => {} };
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("project", { layer: "project", hooks: [noop] }),
        plugin("user", { layer: "user", hooks: [noop] }),
        plugin("early", { layer: "session", hooks: [{ ...noop, order: -1 }] }),
      ],
    });
    expect(rt.hookOrder("event")).toEqual(["early", "user", "project"]);
  });
});

describe("等待、恢复与兼容", () => {
  test("等待人工审批时可以释放进程，之后从日志恢复", async () => {
    const store = new MemoryLogStore();
    const echo = recordingTool("echo");
    const plugins = [
      plugin("p", { tools: [echo.tool], hooks: [{ kind: "gate", point: "tool.gate", fn: () => ({ decision: "ask" }) }] }),
    ];

    const first = scripted([{ content: [toolUse("t1", "echo", {})], stopReason: "tool_use" }]);
    const rt1 = await Runtime.create({ store, provider: first.provider, plugins });
    await rt1.send(say("hi"));
    expect(rt1.state.phase).toBe("awaiting");
    const sessionId = rt1.state.sessionId;

    // 模拟进程退出：换一个全新的 Runtime，只凭日志恢复
    const second = scripted([{ content: [text("done")], stopReason: "end" }]);
    const rt2 = await Runtime.resume({ store, provider: second.provider, plugins, sessionId });
    expect(rt2.state).toEqual(rt1.state);

    await rt2.send({ kind: "approval", toolUseId: "t1", approved: true });
    expect(echo.calls).toHaveLength(1);
    expect(rt2.state.phase).toBe("idle");
    expect(rt2.state.messages.at(-1)!.content[0]).toMatchObject({ text: "done" });
  });

  test("崩溃恢复：幂等工具重跑，非幂等工具标记中断（4.5）", async () => {
    const store = new FlakyStore();
    store.crashOn = "tool.completed";
    const safe = recordingTool("safe", { idempotent: true });
    const risky = recordingTool("risky", { idempotent: false });
    const plugins = [plugin("p", { tools: [safe.tool, risky.tool] })];

    const first = scripted([
      { content: [toolUse("t1", "safe", {}), toolUse("t2", "risky", {})], stopReason: "tool_use" },
    ]);
    const rt1 = await Runtime.create({ store, provider: first.provider, plugins });
    await expect(rt1.send(say("hi"))).rejects.toThrow("disk gone");

    store.repair();
    const second = scripted([{ content: [text("done")], stopReason: "end" }]);
    const rt2 = await Runtime.resume({ store, provider: second.provider, plugins, sessionId: rt1.state.sessionId });
    expect(rt2.state.phase).toBe("tools");
    await rt2.recover();

    expect(safe.calls).toHaveLength(2);
    expect(risky.calls).toHaveLength(1);
    const events = await readAll(store, rt2.state.sessionId);
    expect(events.filter((e) => e.type === "tool.interrupted").map((e) => e.data)).toEqual([{ toolUseId: "t2" }]);

    const results = second.requests[0]!.messages.at(-1)!.content;
    expect(results[0]).toMatchObject({ toolUseId: "t1", isError: false });
    expect(results[1]).toMatchObject({ toolUseId: "t2", isError: true });
    expect(rt2.state.phase).toBe("idle");
  });

  test("插件要求的内核版本不符时拒绝加载", async () => {
    const { provider } = scripted([]);
    await expect(
      Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin("future", { kernel: "^2" })] }),
    ).rejects.toBeInstanceOf(PluginIncompatible);
  });
});

/** 写到指定类型的事件时"磁盘损坏"，之后所有写入都失败，直到 repair() */
class FlakyStore implements LogStore {
  #inner = new MemoryLogStore();
  #crashed = false;
  crashOn?: string;

  async append(sessionId: string, events: Event[]): Promise<void> {
    if (this.#crashed || events.some((e) => e.type === this.crashOn)) {
      this.#crashed = true;
      throw new Error("disk gone");
    }
    return this.#inner.append(sessionId, events);
  }

  read(sessionId: string, fromSeq?: number) {
    return this.#inner.read(sessionId, fromSeq);
  }

  repair(): void {
    this.#crashed = false;
    this.crashOn = undefined;
  }
}
