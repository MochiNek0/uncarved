import { describe, expect, test } from "bun:test";
import {
  HookFailure,
  MemoryLogStore,
  ModelOutputModified,
  PluginIncompatible,
  PluginsHeld,
  Runtime,
  UnresolvedRef,
  readAll,
  rebuild,
  type Block,
  type Event,
  type LogStore,
  type Message,
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
        // 项目层插件必须经加载器确认（7.1），这里用会话层验证层级排序
        plugin("session", { layer: "session", hooks: [noop] }),
        plugin("user", { layer: "user", hooks: [noop] }),
        plugin("early", { layer: "session", hooks: [{ ...noop, order: -1 }] }),
      ],
    });
    expect(rt.hookOrder("event")).toEqual(["early", "user", "session"]);
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

describe("恢复时插件发生变化（4.6）", () => {
  /** 建一个停在等待人工审批的会话，返回 sessionId */
  async function awaitingSession(store: LogStore, plugins: Plugin[]) {
    const { provider } = scripted([{ content: [toolUse("t1", "echo", { n: 1 })], stopReason: "tool_use" }]);
    const rt = await Runtime.create({ store, provider, plugins });
    await rt.send(say("hi"));
    expect(rt.state.phase).toBe("awaiting");
    return rt.state.sessionId;
  }
  const askGate = { kind: "gate" as const, point: "tool.gate" as const, fn: () => ({ decision: "ask" as const }) };

  test("清单不变时不写事件；小版本升级自动继续", async () => {
    const store = new MemoryLogStore();
    const echo = recordingTool("echo");
    const sessionId = await awaitingSession(store, [plugin("p", { tools: [echo.tool], hooks: [askGate] })]);
    const { provider } = scripted([]);

    await Runtime.resume({ store, provider, sessionId, plugins: [plugin("p", { tools: [echo.tool], hooks: [askGate] })] });
    expect(types(await readAll(store, sessionId))).not.toContain("plugins.changed");

    const rt = await Runtime.resume({
      store,
      provider,
      sessionId,
      plugins: [plugin("p", { version: "1.2.0", tools: [echo.tool], hooks: [askGate] })],
    });
    const changed = (await readAll(store, sessionId)).filter((e) => e.type === "plugins.changed");
    expect(changed.map((e) => e.data)).toEqual([{ plugins: [{ id: "p", version: "1.2.0" }], resolution: "continue" }]);
    expect(rt.state.held).toBeUndefined();
  });

  test("主版本、新增、删除都暂停，确认之后才能继续", async () => {
    const echo = recordingTool("echo");
    const base = [plugin("p", { tools: [echo.tool], hooks: [askGate] }), plugin("q")];
    const cases: Plugin[][] = [
      [plugin("p", { version: "2.0.0", tools: [echo.tool], hooks: [askGate] }), plugin("q")],
      [...base, plugin("new")],
      [base[0]!],
    ];
    for (const plugins of cases) {
      const store = new MemoryLogStore();
      const sessionId = await awaitingSession(store, base);
      const { provider } = scripted([]);
      const rt = await Runtime.resume({ store, provider, sessionId, plugins });
      expect(rt.state.held?.resolution).toBe("ask");
      await expect(rt.send({ kind: "approval", toolUseId: "t1", approved: true })).rejects.toBeInstanceOf(PluginsHeld);
      await expect(rt.recover()).rejects.toBeInstanceOf(PluginsHeld);

      await rt.send({ kind: "plugins", approved: true });
      expect(rt.state.held).toBeUndefined();
      expect(rt.state.plugins).toEqual(plugins.map((p) => ({ id: p.id, version: p.version })));
    }
  });

  test("插件声明的 resume 覆盖默认处理，多个冲突时取最严格", async () => {
    const echo = recordingTool("echo");
    const store = new MemoryLogStore();
    const id = await awaitingSession(store, [plugin("p", { tools: [echo.tool], hooks: [askGate] }), plugin("q")]);
    const { provider } = scripted([]);
    const rt = await Runtime.resume({
      store,
      provider,
      sessionId: id,
      plugins: [
        plugin("p", { version: "9.0.0", resume: "continue", tools: [echo.tool] }),
        plugin("q", { version: "1.0.1", resume: "abort" }),
      ],
    });
    expect(rt.state.held?.resolution).toBe("abort");
    await expect(rt.send({ kind: "plugins", approved: true })).rejects.toBeInstanceOf(PluginsHeld);
  });

  test("拒绝或 abort 的变化在重启后仍然生效，换回原插件才解除", async () => {
    const store = new MemoryLogStore();
    const echo = recordingTool("echo");
    const original = [plugin("p", { tools: [echo.tool], hooks: [askGate] })];
    const sessionId = await awaitingSession(store, original);
    const { provider } = scripted([]);
    const upgraded = [plugin("p", { version: "2.0.0", tools: [echo.tool], hooks: [askGate] })];

    const rt1 = await Runtime.resume({ store, provider, sessionId, plugins: upgraded });
    await rt1.send({ kind: "plugins", approved: false });
    expect(rt1.state.held?.resolution).toBe("abort");

    // 同样的插件再启动一次：清单与日志里最近的记录相同，但变化仍未被接受
    const rt2 = await Runtime.resume({ store, provider, sessionId, plugins: upgraded });
    expect(rt2.state.held?.resolution).toBe("abort");
    await expect(rt2.recover()).rejects.toBeInstanceOf(PluginsHeld);

    const rt3 = await Runtime.resume({ store, provider, sessionId, plugins: original });
    expect(rt3.state.held).toBeUndefined();
    expect(rt3.state.phase).toBe("deciding");
  });

  test("未执行的工具调用重新经过 tool.before 和 tool.gate，此前的人工批准作废（I-7）", async () => {
    const store = new MemoryLogStore();
    const echo = recordingTool("echo");
    const other = recordingTool("other");
    // 两个调用：t1 先被人工批准，t2 仍在等待，此时进程退出
    const first = scripted([
      { content: [toolUse("t1", "echo", { n: 1 }), toolUse("t2", "other", {})], stopReason: "tool_use" },
    ]);
    const plugins = [plugin("p", { tools: [echo.tool, other.tool], hooks: [askGate] })];
    const rt1 = await Runtime.create({ store, provider: first.provider, plugins });
    await rt1.send(say("hi"));
    await rt1.send({ kind: "approval", toolUseId: "t1", approved: true });
    expect(rt1.state.phase).toBe("awaiting");

    // 新版本插件改写参数，并且拒绝 echo
    const seen: ToolCall[] = [];
    const v2 = plugin("p", {
      version: "1.1.0",
      tools: [echo.tool, other.tool],
      hooks: [
        { kind: "transform", point: "tool.before", fn: (c) => ({ ...c, input: { ...(c.input as object), v: 2 } }) },
        {
          kind: "gate",
          point: "tool.gate",
          fn: (c) => {
            seen.push(c);
            return c.name === "echo" ? { decision: "deny", reason: "echo disabled" } : { decision: "allow" };
          },
        },
      ],
    });
    const second = scripted([{ content: [text("done")], stopReason: "end" }]);
    const rt2 = await Runtime.resume({ store, provider: second.provider, sessionId: rt1.state.sessionId, plugins: [v2] });
    expect(rt2.state.phase).toBe("deciding");
    await rt2.recover();

    // 关卡看到的是从模型原始参数重新改写的结果，而不是旧插件改写过的
    expect(seen.map((c) => c.input)).toEqual([{ n: 1, v: 2 }, { v: 2 }]);
    expect(echo.calls).toHaveLength(0);
    expect(other.calls).toEqual([{ v: 2 }]);
    const results = second.requests[0]!.messages.at(-1)!.content;
    expect(results[0]).toMatchObject({ toolUseId: "t1", isError: true });
    expect(rt2.state.phase).toBe("idle");
  });
});

describe("插件写入日志（I-5）与会话引用（3.4）", () => {
  test("插件的派生数据先落盘再使用，重建时不需要插件", async () => {
    const store = new MemoryLogStore();
    const { provider, requests } = scripted([
      { content: [text("a")], stopReason: "end" },
      { content: [text("b")], stopReason: "end" },
    ]);
    let summaries = 0;
    const compactor = plugin("compact", {
      needs: ["transform:context.project", "log:record", "log:emit"],
      hooks: [
        {
          kind: "transform",
          point: "context.project",
          fn: async (messages, ctx) => {
            let summary = ctx.derived["compact/summary"] as string | undefined;
            if (summary === undefined) {
              summary = `summary-${++summaries}`;
              await ctx.record("compact/summary", summary);
              await ctx.emit("compacted", { kept: 1 });
            }
            return [{ role: "user", content: [{ kind: "text", text: summary, origin: { by: "plugin", id: "compact" }, trust: "trusted" }] }, ...messages.slice(-1)];
          },
        },
      ],
    });
    const rt = await Runtime.create({ store, provider, plugins: [compactor] });
    await rt.send(say("one"));
    await rt.send(say("two"));

    expect(summaries).toBe(1);
    expect(requests[1]!.messages[0]!.content[0]).toMatchObject({ text: "summary-1" });
    const events = await readAll(store, rt.state.sessionId);
    const custom = events.find((e) => e.type === "compact/compacted")!;
    expect(custom.origin).toEqual({ by: "plugin", id: "compact" });
    expect(rebuild(rt.state.sessionId, events).derived).toEqual({ "compact/summary": "summary-1" });
  });

  test("声明了内核不提供的能力时拒绝加载（8.2）", async () => {
    const { provider } = scripted([]);
    await expect(
      Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin("x", { needs: ["gate:teleport"] })] }),
    ).rejects.toBeInstanceOf(PluginIncompatible);
  });

  test("子会话双向引用，且引用必须能解析", async () => {
    const store = new MemoryLogStore();
    let childSeq = 0;
    const spawn = recordingTool("spawn", {
      async execute(_input, ctx) {
        const { provider } = scripted([{ content: [text("child done")], stopReason: "end" }]);
        const child = await Runtime.create({ store, provider, parent: ctx.parent });
        await child.send(say("go"));
        childSeq = child.state.lastSeq;
        return { content: "ok", child: { sessionId: child.state.sessionId, seq: child.state.lastSeq } };
      },
    });
    const { provider } = scripted([
      { content: [toolUse("t1", "spawn", {})], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({ store, provider, plugins: [plugin("p", { tools: [spawn.tool] })] });
    await rt.send(say("hi"));

    const events = await readAll(store, rt.state.sessionId);
    const decided = events.find((e) => e.type === "tool.decided")!;
    const completed = events.find((e) => e.type === "tool.completed")! as Event<"tool.completed">;
    const childId = completed.data.child!.sessionId;
    expect(completed.data.child).toEqual({ sessionId: childId, seq: childSeq });
    const childStart = (await readAll(store, childId))[0] as Event<"session.started">;
    expect(childStart.data.parent).toEqual({ sessionId: rt.state.sessionId, eventId: decided.id });

    await expect(
      Runtime.create({ store, provider, parent: { sessionId: "nope", eventId: "nope" } }),
    ).rejects.toBeInstanceOf(UnresolvedRef);
  });
});

describe("模型输出不可改写（I-6）", () => {
  const thinking: Block = {
    kind: "thinking",
    text: "hmm",
    origin: MODEL,
    trust: "trusted",
    ext: { scripted: { signature: "sig-1" } },
  };

  /** 第一轮产生模型输出，第二轮让 hook 处理带着这些输出的历史 */
  async function secondTurnWith(point: "context.project" | "model.before", fn: (m: Message[]) => Message[], optional = false) {
    const { provider, requests } = scripted([
      { content: [thinking, text("first")], stopReason: "end" },
      { content: [text("second")], stopReason: "end" },
    ]);
    let active = false;
    const hook =
      point === "context.project"
        ? { kind: "transform" as const, point, optional, fn: (m: Message[]) => (active ? fn(m) : m) }
        : { kind: "transform" as const, point, optional, fn: (r: ModelRequest) => (active ? { ...r, messages: fn(r.messages) } : r) };
    const store = new MemoryLogStore();
    const rt = await Runtime.create({ store, provider, plugins: [plugin("proj", { hooks: [hook] })] });
    await rt.send(say("one"));
    active = true;
    const notices: RuntimeNotice[] = [];
    rt.subscribe((n) => notices.push(n));
    const outcome = await rt.send(say("two")).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { outcome, requests, notices, events: await readAll(store, rt.state.sessionId) };
  }

  const editText = (ms: Message[]) =>
    ms.map((m) => ({ ...m, content: m.content.map((b) => (b.kind === "text" && b.origin.by === "model" ? { ...b, text: "edited" } : b)) }));

  test("省略整块或整条消息、复制时调换键顺序都允许", async () => {
    const { outcome, requests } = await secondTurnWith("context.project", (ms) =>
      ms.map((m) => ({
        ...m,
        content: m.content
          .filter((b) => b.kind !== "text" || b.origin.by !== "model")
          .map((b) => (b.kind === "thinking" ? { ext: b.ext, trust: b.trust, origin: b.origin, text: b.text, kind: b.kind } : b)),
      })),
    );
    expect(outcome).toBeUndefined();
    expect(requests[1]!.messages[1]!.content).toEqual([thinking]);
  });

  test("编辑模型文本：本轮失败，归咎于做出修改的插件，请求没有发出", async () => {
    const { outcome, requests, events } = await secondTurnWith("context.project", editText);
    expect(outcome).toBeInstanceOf(HookFailure);
    expect((outcome as HookFailure).plugin).toBe("proj");
    expect((outcome as HookFailure).cause).toBeInstanceOf(ModelOutputModified);
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", data: { reason: "error" } });
  });

  test("改写 ext 中的签名同样算编辑；model.before 也受约束", async () => {
    const { outcome } = await secondTurnWith("model.before", (ms) =>
      ms.map((m) => ({
        ...m,
        content: m.content.map((b) => (b.kind === "thinking" ? { ...b, ext: { scripted: { signature: "forged" } } } : b)),
      })),
    );
    expect((outcome as HookFailure).cause).toBeInstanceOf(ModelOutputModified);
  });

  test("optional 的 hook 违反时丢弃它的输出并通知，请求里仍是原文", async () => {
    const { outcome, requests, notices } = await secondTurnWith("context.project", editText, true);
    expect(outcome).toBeUndefined();
    expect(requests[1]!.messages[1]!.content[1]).toMatchObject({ text: "first" });
    expect(notices.some((n) => n.type === "hook-error" && n.info.error instanceof ModelOutputModified)).toBe(true);
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
