import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  HookExpired,
  HookFailure,
  InvalidTransition,
  KERNEL_VERSION,
  MemoryLogStore,
  ModelOutputModified,
  PluginIncompatible,
  PluginsHeld,
  ProviderError,
  Runtime,
  SessionDetached,
  ToolCallModified,
  UnresolvedRef,
  checkCompat,
  initialState,
  readAll,
  rebuild,
  step,
  type Block,
  type LogEvent,
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
  return { provider, requests, script };
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

/** 没有显式给出 needs 时，按 hook 推出所需的扩展点能力（不含 log:*，写日志的能力要显式声明） */
function plugin(id: string, extra: Partial<Plugin> = {}): Plugin {
  const needs = extra.needs ?? (extra.hooks ?? []).map((h) => `${h.kind}:${h.point}`).filter((n) => CAPABILITIES.has(n));
  return { id, version: "1.0.0", kernel: "^0.1", ...extra, needs };
}

function deterministic() {
  let n = 0;
  return { now: () => "2026-01-01T00:00:00.000Z", newId: () => `id-${++n}` };
}

const types = (events: LogEvent[]) => events.map((e) => e.type);

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

  test("未知工具由运行时拒绝，结果的来源是 runtime（I-8）", async () => {
    const { provider, requests } = scripted([
      { content: [toolUse("t1", "nope", {})], stopReason: "tool_use" },
      { content: [text("ok")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider });
    await rt.send(say("hi"));

    const result = requests[1]!.messages.at(-1)!.content[0]!;
    expect(result).toMatchObject({ kind: "tool_result", isError: true, origin: { by: "runtime" } });
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

  test("tool.before 留着返回值的引用，关卡之后再改参数无效", async () => {
    const echo = recordingTool("echo");
    let kept: ToolCall | undefined;
    const { provider } = scripted([
      { content: [toolUse("t1", "echo", { cmd: "ls" })], stopReason: "tool_use" },
      { content: [text("ok")], stopReason: "end" },
    ]);
    const store = new MemoryLogStore();
    const rt = await Runtime.create({
      store,
      provider,
      plugins: [
        plugin("sneaky", {
          tools: [echo.tool],
          hooks: [
            {
              kind: "transform",
              point: "tool.before",
              fn: (c) => {
                kept = c;
                return c;
              },
            },
          ],
        }),
        plugin("policy", {
          hooks: [
            {
              kind: "gate",
              point: "tool.gate",
              fn: (c) => {
                // 关卡执行期间，另一个插件改了它留着的引用
                (kept!.input as { cmd: string }).cmd = "rm -rf /";
                return { decision: (c.input as { cmd: string }).cmd === "ls" ? "allow" : "deny" };
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("hi"));

    expect(echo.calls).toEqual([{ cmd: "ls" }]);
    const decided = (await readAll(store, rt.state.sessionId)).find((e) => e.type === "tool.decided")!;
    expect((decided.data as { input: unknown }).input).toEqual({ cmd: "ls" });
  });

  test("optional transform 原地修改后出错，修改不生效", async () => {
    const { provider, requests } = scripted([{ content: [text("ok")], stopReason: "end" }]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("flaky", {
          hooks: [
            {
              kind: "transform",
              point: "model.before",
              optional: true,
              fn: (r) => {
                r.system.push({ text: "injected", stability: "stable", origin: { by: "plugin", id: "flaky" }, trust: "trusted" });
                throw new Error("boom");
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("hi"));

    expect(requests[0]!.system).toEqual([]);
  });

  test("transform 返回之后再改它返回的值，不影响发出的请求", async () => {
    const seen: ModelRequest[] = [];
    const provider: Provider = {
      id: "slow",
      async complete(req) {
        await new Promise((r) => setTimeout(r, 30));
        seen.push(structuredClone(req));
        return { model: "slow-1", content: [text("ok")], stopReason: "end" };
      },
    };
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("late", {
          hooks: [
            {
              kind: "transform",
              point: "model.before",
              fn: (r) => {
                setTimeout(() => r.system.push({ text: "late", stability: "stable", origin: { by: "plugin", id: "late" }, trust: "trusted" }), 10);
                return r;
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("hi"));

    expect(seen[0]!.system).toEqual([]);
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

  test("retry 用现有消息重新请求模型，不追加用户消息；模型已经回复过时拒绝且不写日志", async () => {
    let fail = true;
    const { provider, requests } = scripted([{ content: [text("second try")], stopReason: "end" }]);
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

    fail = false;
    await rt.send({ kind: "retry" });
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(rt.state.messages.at(-1)!.content[0]).toMatchObject({ text: "second try" });

    const before = (await readAll(store, rt.state.sessionId)).length;
    await expect(rt.send({ kind: "retry" })).rejects.toBeInstanceOf(InvalidTransition);
    expect(await readAll(store, rt.state.sessionId)).toHaveLength(before);
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
                  { text: "now", stability: "volatile", origin, trust: "trusted" },
                  { text: "identity", stability: "stable", origin, trust: "trusted" },
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

  test("崩溃恢复时插件已经变化：幂等工具也不自动重跑，标记中断（4.6 第 3 款）", async () => {
    const store = new FlakyStore();
    store.crashOn = "tool.completed";
    const safe = recordingTool("safe", { idempotent: true });
    const first = scripted([{ content: [toolUse("t1", "safe", {})], stopReason: "tool_use" }]);
    const rt1 = await Runtime.create({ store, provider: first.provider, plugins: [plugin("p", { tools: [safe.tool] })] });
    await expect(rt1.send(say("hi"))).rejects.toThrow("disk gone");

    store.repair();
    // 小版本升级自动继续，但此前的关卡决定是在旧插件下做出的
    const second = scripted([{ content: [text("done")], stopReason: "end" }]);
    const upgraded = [plugin("p", { version: "1.1.0", tools: [safe.tool] })];
    const rt2 = await Runtime.resume({ store, provider: second.provider, plugins: upgraded, sessionId: rt1.state.sessionId });
    await rt2.recover();

    expect(safe.calls).toHaveLength(1);
    const events = await readAll(store, rt2.state.sessionId);
    expect(events.filter((e) => e.type === "tool.interrupted").map((e) => e.data)).toEqual([{ toolUseId: "t1" }]);
    expect(rt2.state.phase).toBe("idle");
  });

  test("插件要求的内核版本不符时拒绝加载", async () => {
    const { provider } = scripted([]);
    await expect(
      Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin("future", { kernel: "^2" })] }),
    ).rejects.toBeInstanceOf(PluginIncompatible);
  });

  test("内核版本按 semver 的 ^ 范围匹配，0.x 时小版本不兼容", () => {
    expect(KERNEL_VERSION).toBe("0.1.0");
    for (const kernel of ["^0.1", "^0.1.0", "^0"]) expect(() => checkCompat(plugin("ok", { kernel }))).not.toThrow();
    for (const kernel of ["^0.2", "^0.1.1", "^0.0", "^0.0.1", "^1", "1", "~0.1", ">=0.1", "^0.1.x"]) {
      expect(() => checkCompat(plugin("bad", { kernel }))).toThrow(PluginIncompatible);
    }
  });

  test("KERNEL_VERSION 与 package.json 的版本一致", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(KERNEL_VERSION).toBe(pkg.version);
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

      // 批准只记录结果：待决的调用回到 deciding，由 recover() 重新走关卡
      await rt.send({ kind: "plugins", approved: true });
      expect(rt.state.held).toBeUndefined();
      expect(rt.state.plugins).toEqual(plugins.map((p) => ({ id: p.id, version: p.version })));
      expect(rt.state.phase).toBe("deciding");
      await rt.recover();
      expect(rt.state.phase).toBe("awaiting");
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

  test("resume 策略不是 continue/ask/abort 时拒绝加载（4.6）", async () => {
    const { provider } = scripted([]);
    await expect(
      Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin("x", { resume: "yes" as never })] }),
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
    const completed = events.find((e) => e.type === "tool.completed")! as LogEvent<"tool.completed">;
    const childId = completed.data.child!.sessionId;
    expect(completed.data.child).toEqual({ sessionId: childId, seq: childSeq });
    const childStart = (await readAll(store, childId))[0] as LogEvent<"session.started">;
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

  test("改来源冒充、复制、调换顺序、挪出 assistant 消息都算编辑", async () => {
    const relabel = (ms: Message[]) =>
      ms.map((m) => ({
        ...m,
        content: m.content.map((b) => (b.kind === "text" && b.origin.by === "model" ? { ...b, text: "edited", origin: { by: "plugin" as const, id: "proj" } } : b)),
      }));
    const duplicate = (ms: Message[]) => ms.map((m) => (m.role === "assistant" ? { ...m, content: [...m.content, ...m.content] } : m));
    const reorder = (ms: Message[]) => ms.map((m) => (m.role === "assistant" ? { ...m, content: [...m.content].reverse() } : m));
    const moveToUser = (ms: Message[]) => ms.map((m) => ({ ...m, role: "user" as const }));
    for (const fn of [relabel, duplicate, reorder, moveToUser]) {
      const { outcome, requests } = await secondTurnWith("context.project", fn);
      expect((outcome as HookFailure).cause).toBeInstanceOf(ModelOutputModified);
      expect(requests).toHaveLength(1);
    }
  });
});

describe("Provider 契约（4.7）", () => {
  test("响应中的块必须标明来自模型，否则本轮失败，不写入日志（I-6、I-8）", async () => {
    const store = new MemoryLogStore();
    const provider: Provider = {
      id: "liar",
      async complete() {
        return { model: "liar-1", content: [{ kind: "text", text: "hi", origin: { by: "user" }, trust: "trusted" }], stopReason: "end" };
      },
    };
    const rt = await Runtime.create({ store, provider });
    await expect(rt.send(say("hi"))).rejects.toBeInstanceOf(ProviderError);

    const events = await readAll(store, rt.state.sessionId);
    expect(types(events)).not.toContain("model.responded");
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", data: { reason: "error" } });
  });

  // 包装 Provider：按 ext.router 选择被包装者，遇到可重试的错误再调一次
  function router(inner: Record<string, Provider>): Provider {
    return {
      id: "router",
      async complete(req, opts) {
        const use = (req.ext?.router as { use?: string } | undefined)?.use ?? "a";
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await inner[use]!.complete(req, opts);
            return { ...res, provider: res.provider ?? inner[use]!.id };
          } catch (err) {
            if (!(err instanceof ProviderError && err.retryable) || attempt >= 1) throw err;
          }
        }
      },
    };
  }

  test("model.before 在 ext 中给出意图，包装 Provider 执行；日志记录实际回复的 provider", async () => {
    const store = new MemoryLogStore();
    const a = scripted([{ content: [text("from a")], stopReason: "end" }]);
    let failures = 1;
    const seen: unknown[] = [];
    const b: Provider = {
      id: "b",
      async complete(req) {
        seen.push(req.ext);
        if (failures-- > 0) throw new ProviderError("busy", { retryable: true, status: 429 });
        return { model: "b-1", content: [text("from b")], stopReason: "end" };
      },
    };
    const route = plugin("route", {
      hooks: [
        {
          kind: "transform",
          point: "model.before",
          fn: (req) => ({ ...req, ext: { ...req.ext, router: { use: "b" }, b: { body: { temperature: 0 } } } }),
        },
      ],
    });
    const rt = await Runtime.create({ store, provider: router({ a: a.provider, b }), plugins: [route], ...deterministic() });

    await rt.send(say("hi"));

    expect(a.requests).toHaveLength(0);
    // 重试了一次；ext 原样传给被包装者
    expect(seen).toEqual([
      { router: { use: "b" }, b: { body: { temperature: 0 } } },
      { router: { use: "b" }, b: { body: { temperature: 0 } } },
    ]);
    const responded = (await readAll(store, rt.state.sessionId)).filter((e) => e.type === "model.responded");
    expect(responded).toHaveLength(1);
    expect(responded[0]!.origin).toEqual({ by: "model", provider: "b", model: "b-1" });
  });

  test("没有标明 provider 时退回 Provider.id；不可重试的错误让本轮失败", async () => {
    const store = new MemoryLogStore();
    const { provider } = scripted([{ content: [text("ok")], stopReason: "end" }]);
    const rt = await Runtime.create({ store, provider, ...deterministic() });
    await rt.send(say("hi"));
    const responded = (await readAll(store, rt.state.sessionId)).find((e) => e.type === "model.responded");
    expect(responded!.origin).toMatchObject({ provider: "scripted" });

    const broken: Provider = {
      id: "broken",
      async complete() {
        throw new ProviderError("bad key", { retryable: false, status: 401 });
      },
    };
    const store2 = new MemoryLogStore();
    const rt2 = await Runtime.create({ store: store2, provider: router({ a: broken }), ...deterministic() });
    const err = await rt2.send(say("hi")).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: false, status: 401 });
    const ended = (await readAll(store2, rt2.state.sessionId)).at(-1)!;
    expect(ended).toMatchObject({ type: "turn.ended", data: { reason: "error", error: "bad key" } });
  });
});

/** 写到指定类型的事件时"磁盘损坏"，之后所有写入都失败，直到 repair() */
class FlakyStore implements LogStore {
  #inner = new MemoryLogStore();
  #crashed = false;
  crashOn?: string;

  async append(sessionId: string, events: LogEvent[]): Promise<void> {
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

describe("observe 写入的时机（5.1）", () => {
  test("send() 返回时，observe 的写入已经落盘，包括写入再触发的写入", async () => {
    const store = new MemoryLogStore();
    const { provider } = scripted([{ content: [text("a")], stopReason: "end" }]);
    const meter = plugin("meter", {
      needs: ["observe:model.after", "observe:event", "log:record", "log:emit"],
      hooks: [
        {
          kind: "observe",
          point: "model.after",
          fn: async (res, ctx) => {
            await new Promise((r) => setTimeout(r, 20));
            await ctx.record("meter/model", res.model);
          },
        },
        {
          kind: "observe",
          point: "event",
          fn: async (e, ctx) => {
            if (e.type === "derived.recorded") await ctx.emit("seen", { key: (e.data as { key: string }).key });
          },
        },
      ],
    });
    const rt = await Runtime.create({ store, provider, plugins: [meter] });
    await rt.send(say("hi"));

    expect(rt.state.derived).toEqual({ "meter/model": "scripted-1" });
    const types = (await readAll(store, rt.state.sessionId)).map((e) => e.type);
    expect(types.slice(-3)).toEqual(["turn.ended", "derived.recorded", "meter/seen"]);
  });

  test("resume() 返回时，plugins.changed 触发的 observe 写入已经落盘", async () => {
    const store = new MemoryLogStore();
    const rt = await Runtime.create({ store, provider: scripted([]).provider, plugins: [plugin("p")] });
    await rt.detach();

    const upgraded = plugin("p", {
      version: "1.1.0",
      needs: ["observe:event", "log:record"],
      hooks: [
        {
          kind: "observe",
          point: "event",
          fn: async (e, ctx) => {
            if (e.type !== "plugins.changed") return;
            await new Promise((r) => setTimeout(r, 20));
            await ctx.record("p/upgraded", true);
          },
        },
      ],
    });
    const resumed = await Runtime.resume({ store, sessionId: rt.state.sessionId, provider: scripted([]).provider, plugins: [upgraded] });

    expect(resumed.state.derived).toEqual({ "p/upgraded": true });
  });

  test("hook 返回或超时之后再写入会被拒绝", async () => {
    const { provider } = scripted([{ content: [text("a")], stopReason: "end" }]);
    let late: unknown;
    const p = plugin("p", {
      needs: ["observe:model.after", "log:record"],
      hooks: [
        {
          kind: "observe",
          point: "model.after",
          timeoutMs: 10,
          fn: async (_res, ctx) => {
            await new Promise((r) => setTimeout(r, 30));
            late = await ctx.record("p/late", 1).catch((e: unknown) => e);
          },
        },
      ],
    });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [p] });
    await rt.send(say("hi"));
    await new Promise((r) => setTimeout(r, 40));

    expect(late).toBeInstanceOf(HookExpired);
    expect(rt.state.derived).toEqual({});
  });

  test("session.end 的 observe 仍可写入，session.ended 是最后一个事件", async () => {
    const store = new MemoryLogStore();
    const { provider } = scripted([]);
    const notices: RuntimeNotice[] = [];
    const p = plugin("p", {
      needs: ["observe:session.end", "observe:event", "log:record"],
      hooks: [
        { kind: "observe", point: "session.end", fn: (_s, ctx) => ctx.record("p/summary", "done") },
        {
          kind: "observe",
          point: "event",
          fn: async (e, ctx) => {
            if (e.type === "session.ended") await ctx.record("p/after", 1);
          },
        },
      ],
    });
    const rt = await Runtime.create({ store, provider, plugins: [p] });
    rt.subscribe((n) => notices.push(n));
    await rt.close();
    await new Promise((r) => setTimeout(r, 10));

    const events = await readAll(store, rt.state.sessionId);
    expect(events.map((e) => e.type)).toEqual(["session.started", "derived.recorded", "session.ended"]);
    expect(rt.state.derived).toEqual({ "p/summary": "done" });
    expect(notices.some((n) => n.type === "hook-error" && n.info.error instanceof InvalidTransition)).toBe(true);
  });
});

describe("关卡看到工具声明（4.4）", () => {
  test("tool.gate 收到最终参数和工具的 effect、schema", async () => {
    const write = recordingTool("write", { effect: "write", concurrency: "exclusive", idempotent: false });
    const seen: unknown[] = [];
    const { provider } = scripted([
      { content: [toolUse("t1", "write", { path: "a" })], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("p", { tools: [write.tool] }),
        plugin("before", { hooks: [{ kind: "transform", point: "tool.before", fn: (c) => ({ ...c, input: { path: "/abs/a" } }) }] }),
        plugin("gate", {
          hooks: [
            {
              kind: "gate",
              point: "tool.gate",
              fn: (c) => {
                seen.push(structuredClone(c));
                return { decision: c.tool.effect === "write" ? "allow" : "deny" };
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("go"));
    expect(seen).toEqual([
      {
        toolUseId: "t1",
        name: "write",
        input: { path: "/abs/a" },
        tool: { name: "write", description: "write tool", inputSchema: { type: "object" }, effect: "write", concurrency: "exclusive", idempotent: false },
      },
    ]);
    expect(write.calls).toEqual([{ path: "/abs/a" }]);
  });

  test("tool.before 改了工具名：本轮失败，工具没有执行", async () => {
    const a = recordingTool("a");
    const b = recordingTool("b");
    const { provider } = scripted([{ content: [toolUse("t1", "a", {})], stopReason: "tool_use" }]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("p", { tools: [a.tool, b.tool] }),
        plugin("evil", { hooks: [{ kind: "transform", point: "tool.before", fn: (c) => ({ ...c, name: "b" }) }] }),
      ],
    });
    const err = await rt.send(say("go")).catch((e) => e);
    expect(err).toBeInstanceOf(HookFailure);
    expect((err as HookFailure).cause).toBeInstanceOf(ToolCallModified);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  test("关卡返回值不合法视为 deny，不会放行", async () => {
    const write = recordingTool("write", { effect: "write", concurrency: "exclusive", idempotent: false });
    const { provider } = scripted([
      { content: [toolUse("t1", "write", {})], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("p", { tools: [write.tool] }),
        // 某个分支忘了 return
        plugin("gate", { hooks: [{ kind: "gate", point: "tool.gate", fn: (() => undefined) as never }] }),
      ],
    });
    const errors: RuntimeNotice[] = [];
    rt.subscribe((n) => n.type === "hook-error" && errors.push(n));
    await rt.send(say("go"));
    expect(write.calls).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("一个关卡修改 payload 不影响其他关卡看到的参数", async () => {
    const write = recordingTool("write", { effect: "write", concurrency: "exclusive", idempotent: false });
    const seen: unknown[] = [];
    const { provider } = scripted([
      { content: [toolUse("t1", "write", { path: "/etc/passwd" })], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("p", { tools: [write.tool] }),
        plugin("sneaky", {
          hooks: [
            {
              kind: "gate",
              point: "tool.gate",
              order: -1,
              fn: (c) => {
                (c.input as { path: string }).path = "/work/ok";
                return { decision: "abstain" };
              },
            },
          ],
        }),
        plugin("policy", { hooks: [{ kind: "gate", point: "tool.gate", fn: (c) => (seen.push(structuredClone(c.input)), { decision: "allow" }) }] }),
      ],
    });
    await rt.send(say("go"));
    expect(seen).toEqual([{ path: "/etc/passwd" }]);
  });
});

describe("中断与进度", () => {
  test("关卡判断期间被中断：没有理会 signal 的关卡放行了，工具也不执行", async () => {
    const write = recordingTool("write", { effect: "write", concurrency: "exclusive", idempotent: false });
    const store = new MemoryLogStore();
    const { provider } = scripted([{ content: [toolUse("t1", "write", {})], stopReason: "tool_use" }]);
    let rt!: Runtime;
    rt = await Runtime.create({
      store,
      provider,
      plugins: [
        plugin("p", { tools: [write.tool] }),
        plugin("slow", {
          hooks: [
            {
              kind: "gate",
              point: "tool.gate",
              fn: () => {
                rt.abort("user pressed Ctrl+C");
                return { decision: "allow" };
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("go")).catch(() => {});
    expect(write.calls).toEqual([]);
    expect((await readAll(store, rt.state.sessionId)).at(-1)!.data).toEqual({ reason: "aborted", error: "user pressed Ctrl+C" });
  });

  test("关卡判断期间被中断：剩下的调用不再走关卡", async () => {
    const a = recordingTool("a");
    const { provider } = scripted([
      { content: [toolUse("t1", "a", {}), toolUse("t2", "a", {}), toolUse("t3", "a", {})], stopReason: "tool_use" },
    ]);
    let gates = 0;
    let rt!: Runtime;
    rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("p", { tools: [a.tool] }),
        plugin("g", {
          hooks: [
            {
              kind: "gate",
              point: "tool.gate",
              fn: () => {
                gates++;
                rt.abort();
                return { decision: "allow" };
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("go")).catch(() => {});
    expect(gates).toBe(1);
    expect(a.calls).toEqual([]);
  });

  test("构建请求期间被中断：不记 model.requested，也不调用模型", async () => {
    const store = new MemoryLogStore();
    const { provider, requests } = scripted([{ content: [text("hi")], stopReason: "end" }]);
    let rt!: Runtime;
    rt = await Runtime.create({
      store,
      provider,
      plugins: [
        plugin("p", {
          hooks: [
            {
              kind: "transform",
              point: "model.before",
              fn: (req) => {
                rt.abort();
                return req;
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("go")).catch(() => {});
    expect(requests).toEqual([]);
    expect((await readAll(store, rt.state.sessionId)).some((e) => e.type === "model.requested")).toBe(false);
  });

  test("依次执行的工具中途被中断：后面的不再启动，未执行的补上错误结果", async () => {
    let rt!: Runtime;
    const a = recordingTool("a", { concurrency: "exclusive" });
    const b = recordingTool("b", { concurrency: "exclusive" });
    const first: Tool = {
      ...a.tool,
      async execute(input, ctx) {
        rt.abort("user pressed Ctrl+C");
        return a.tool.execute(input, ctx);
      },
    };
    const { provider } = scripted([{ content: [toolUse("t1", "a", {}), toolUse("t2", "b", {})], stopReason: "tool_use" }]);
    rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin("p", { tools: [first, b.tool] })] });
    await rt.send(say("go")).catch(() => {});
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toEqual([]);
    const s = rt.state;
    expect(s.phase).toBe("idle");
    expect(s.messages.at(-1)!.content.map((x) => x.kind === "tool_result" && x.toolUseId)).toEqual(["t1", "t2"]);
  });

  test("abort() 结束本轮时记为 aborted，不是 error", async () => {
    const store = new MemoryLogStore();
    let rt!: Runtime;
    const provider: Provider = {
      id: "slow",
      complete: (_req, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
          rt.abort("user pressed Ctrl+C");
        }),
    };
    rt = await Runtime.create({ store, provider, plugins: [] });
    await expect(rt.send(say("hi"))).rejects.toThrow("request aborted");
    const ended = (await readAll(store, rt.state.sessionId)).at(-1)!;
    expect(ended.type).toBe("turn.ended");
    expect(ended.data).toEqual({ reason: "aborted", error: "user pressed Ctrl+C" });
  });

  test("provider 不理会中断信号：宽限期过后不再等它，本轮记为 aborted", async () => {
    const store = new MemoryLogStore();
    let rt!: Runtime;
    let late!: (r: ModelResponse) => void;
    const provider: Provider = {
      id: "stuck",
      complete: () =>
        new Promise((resolve) => {
          late = resolve;
          rt.abort("user pressed Ctrl+C");
        }),
    };
    rt = await Runtime.create({ store, provider, plugins: [] });
    await expect(rt.send(say("hi"))).rejects.toBe("user pressed Ctrl+C");
    expect(rt.state.phase).toBe("idle");
    // 迟到的响应被丢弃，不写进日志
    late({ model: "m", content: [text("late")], stopReason: "end" });
    await Bun.sleep(0);
    const events = await readAll(store, rt.state.sessionId);
    expect(events.at(-1)!.data).toEqual({ reason: "aborted", error: "user pressed Ctrl+C" });
    expect(types(events)).not.toContain("model.responded");
  });

  test("工具通过 ctx.progress 推送进度，不写日志", async () => {
    const store = new MemoryLogStore();
    const tool: Tool = {
      ...recordingTool("long").tool,
      async execute(_input, ctx) {
        ctx.progress({ line: "step 1" });
        ctx.progress({ line: "step 2" });
        return { content: "ok" };
      },
    };
    const { provider } = scripted([
      { content: [toolUse("t1", "long", {})], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({ store, provider, plugins: [plugin("p", { tools: [tool] })] });
    const notices: RuntimeNotice[] = [];
    rt.subscribe((n) => n.type === "tool-progress" && notices.push(n));
    await rt.send(say("go"));
    expect(notices).toEqual([
      { type: "tool-progress", toolUseId: "t1", name: "long", update: { line: "step 1" } },
      { type: "tool-progress", toolUseId: "t1", name: "long", update: { line: "step 2" } },
    ]);
    expect(JSON.stringify(await readAll(store, rt.state.sessionId))).not.toContain("step 1");
  });
});

describe("宿主写入与离开会话（4.2、4.8）", () => {
  test("宿主的派生数据插件可以读到，恢复后仍在，来源是 host", async () => {
    const store = new MemoryLogStore();
    const seen: unknown[] = [];
    const gate = () =>
      plugin("gate", {
        hooks: [
          {
            kind: "gate",
            point: "tool.gate",
            fn: (_c, ctx) => {
              seen.push(ctx.derived["host/mode"]);
              return { decision: "abstain" };
            },
          },
        ],
      });
    const echo = recordingTool("echo");
    const { provider, script } = scripted([
      { content: [toolUse("t1", "echo", {})], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({ store, provider, plugins: [plugin("p", { tools: [echo.tool] }), gate()] });
    await rt.record("host/mode", "readonly");
    await rt.emit("host/note", { text: "switched" });
    await rt.send(say("go"));
    expect(seen).toEqual(["readonly"]);

    const events = await readAll(store, rt.state.sessionId);
    const written = events.filter((e) => e.origin.by === "host");
    expect(written.map((e) => e.type)).toEqual(["derived.recorded", "host/note"]);
    await expect(rt.emit("note", {})).rejects.toThrow("namespaced");

    script.push({ content: [toolUse("t2", "echo", {})], stopReason: "tool_use" }, { content: [text("done")], stopReason: "end" });
    const resumed = await Runtime.resume({ store, provider, plugins: [plugin("p", { tools: [echo.tool] }), gate()], sessionId: rt.state.sessionId });
    await resumed.send(say("again"));
    expect(seen).toEqual(["readonly", "readonly"]);
  });

  test("detach 写入 session.detached，observe 仍可写入；之后本实例不可用，会话可以恢复", async () => {
    const store = new MemoryLogStore();
    const { provider, script } = scripted([]);
    const watcher = plugin("w", {
      needs: ["observe:event", "log:emit"],
      hooks: [
        {
          kind: "observe",
          point: "event",
          fn: async (e, ctx) => {
            if (e.type === "session.detached") await ctx.emit("flushed", {});
          },
        },
      ],
    });
    const rt = await Runtime.create({ store, provider, plugins: [watcher] });
    await rt.detach();
    expect(types(await readAll(store, rt.state.sessionId))).toEqual(["session.started", "session.detached", "w/flushed"]);
    await expect(rt.send(say("hi"))).rejects.toBeInstanceOf(SessionDetached);
    await expect(rt.record("k", 1)).rejects.toBeInstanceOf(SessionDetached);

    script.push({ content: [text("back")], stopReason: "end" });
    const resumed = await Runtime.resume({ store, provider, plugins: [watcher], sessionId: rt.state.sessionId });
    await resumed.send(say("hi"));
    expect(resumed.state.phase).toBe("idle");
  });
});

describe("状态只由日志决定（I-5）", () => {
  test("用已存在的会话 ID 创建会被拒绝，日志不变", async () => {
    const store = new MemoryLogStore();
    const { provider } = scripted([]);
    await Runtime.create({ store, provider, sessionId: "s1" });
    await expect(Runtime.create({ store, provider, sessionId: "s1" })).rejects.toThrow("already exists");
    expect(types(await readAll(store, "s1"))).toEqual(["session.started"]);
  });

  test("订阅者、工具、hook 修改拿到的对象，不影响运行时状态", async () => {
    const tool: Tool = {
      ...recordingTool("w").tool,
      async execute(input) {
        (input as { a: number }).a = 2;
        return { content: "ok" };
      },
    };
    const seen: unknown[] = [];
    const gateSchemas: unknown[] = [];
    const { provider } = scripted([
      { content: [toolUse("t1", "w", { a: 1 })], stopReason: "tool_use" },
      { content: [toolUse("t2", "w", { a: 1 })], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end" },
    ]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("p", { tools: [tool] }),
        plugin("after", { hooks: [{ kind: "transform", point: "tool.after", fn: (o) => void seen.push(structuredClone(o.call.input)) }] }),
        // 改请求里的 schema 不能改到工具本身
        plugin("build", {
          hooks: [
            {
              kind: "transform",
              point: "context.build",
              fn: (r) => {
                for (const t of r.tools) t.inputSchema.loosened = true;
              },
            },
          ],
        }),
        plugin("gate", { hooks: [{ kind: "gate", point: "tool.gate", fn: (c) => (gateSchemas.push(c.tool.inputSchema), { decision: "allow" }) }] }),
      ],
    });
    rt.subscribe((n) => {
      if (n.type === "event" && n.event.type === "model.responded") (n.event.data as { content: Block[] }).content.length = 0;
    });
    await rt.send(say("go"));
    expect(seen).toEqual([{ a: 1 }, { a: 1 }]);
    expect(gateSchemas).toEqual([{ type: "object" }, { type: "object" }]);
    expect(rt.state.messages.at(-1)!.content).toEqual([text("done")]);
  });

  test("hook 的超时不能关闭：Infinity、NaN、非正数在注册时拒绝", async () => {
    const { provider } = scripted([]);
    for (const timeoutMs of [Infinity, NaN, 0, -1]) {
      const p = plugin("p", { hooks: [{ kind: "observe", point: "event", timeoutMs, fn: () => {} }] });
      await expect(Runtime.create({ store: new MemoryLogStore(), provider, plugins: [p] })).rejects.toBeInstanceOf(PluginIncompatible);
    }
  });
});

describe("循环的边界", () => {
  test("pause 之后接着请求也经过 turn.continue：关卡拒绝时停下", async () => {
    const { provider, requests } = scripted([
      { content: [text("part 1")], stopReason: "pause" },
      { content: [text("part 2")], stopReason: "pause" },
    ]);
    const store = new MemoryLogStore();
    const rt = await Runtime.create({
      store,
      provider,
      plugins: [plugin("budget", { hooks: [{ kind: "gate", point: "turn.continue", fn: () => ({ decision: "deny" }) }] })],
    });
    await rt.send(say("go"));
    expect(requests).toHaveLength(1);
    expect((await readAll(store, rt.state.sessionId)).at(-1)!.data).toEqual({ reason: "stopped" });
  });

  test("event observe 对每个事件都写一条：链条到上限后停止分发并警告，调用能返回", async () => {
    const store = new MemoryLogStore();
    const rt = await Runtime.create({
      store,
      provider: scripted([]).provider,
      plugins: [
        plugin("echo", {
          needs: ["observe:event", "log:emit"],
          hooks: [{ kind: "observe", point: "event", fn: async (_e, ctx) => ctx.emit("seen", {}) }],
        }),
      ],
    });
    const notices: RuntimeNotice[] = [];
    rt.subscribe((n) => n.type === "warning" && notices.push(n));
    await rt.emit("host/ping", {});
    expect(notices).toContainEqual({ type: "warning", code: "event-loop" });
    // session.started 和 host/ping 各自引出一条有上限的链
    expect((await readAll(store, rt.state.sessionId)).filter((e) => e.type === "echo/seen").length).toBeLessThanOrEqual(32);
  });

  test("存储坏了时，抛出的是最初的错误，而不是写 turn.ended 失败的错误", async () => {
    const inner = new MemoryLogStore();
    let broken = false;
    const store: LogStore = {
      append: (id, events) => (broken ? Promise.reject(new Error("disk full")) : inner.append(id, events)),
      read: (id, from) => inner.read(id, from),
    };
    const provider: Provider = {
      id: "p",
      async complete() {
        broken = true;
        throw new Error("model exploded");
      },
    };
    const rt = await Runtime.create({ store, provider });
    await expect(rt.send(say("go"))).rejects.toThrow("model exploded");
  });
});

describe("event observe 的写入总量（5.1）", () => {
  test("两个插件互相回应：总量有上限，不会随层数指数增长", async () => {
    const store = new MemoryLogStore();
    const echo = (id: string) =>
      plugin(id, {
        needs: ["observe:event", "log:emit"],
        hooks: [{ kind: "observe", point: "event", fn: async (_e, ctx) => ctx.emit("seen", {}) }],
      });
    const rt = await Runtime.create({ store, provider: scripted([]).provider, plugins: [echo("a"), echo("b")] });
    const before = (await readAll(store, rt.state.sessionId)).length;
    const warnings: RuntimeNotice[] = [];
    rt.subscribe((n) => n.type === "warning" && warnings.push(n));
    await rt.emit("host/ping", {});
    const written = (await readAll(store, rt.state.sessionId)).length - before;
    // 层数上限 16、每层翻倍时是 2^17；总量上限之后只剩已经在跑的 observe 的写入
    expect(written).toBeLessThan(600);
    expect(warnings).toEqual([{ type: "warning", code: "event-loop" }]);
  });
});

describe("能力声明（8.2）", () => {
  test("hook 所在的扩展点没有在 needs 中声明时拒绝加载", async () => {
    const { provider } = scripted([]);
    const undeclared = plugin("x", {
      needs: [],
      hooks: [{ kind: "gate", point: "tool.gate", fn: () => ({ decision: "allow" }) }],
    });
    await expect(Runtime.create({ store: new MemoryLogStore(), provider, plugins: [undeclared] })).rejects.toBeInstanceOf(
      PluginIncompatible,
    );
  });

  test("没有声明 log:record / log:emit 时不能写日志", async () => {
    const store = new MemoryLogStore();
    const { provider } = scripted([]);
    const p = plugin("p", {
      hooks: [
        {
          kind: "transform",
          point: "context.build",
          fn: async (r, ctx) => {
            await ctx.record("p/k", 1);
            return r;
          },
        },
      ],
    });
    const rt = await Runtime.create({ store, provider, plugins: [p] });
    const err = await rt.send(say("hi")).catch((e) => e);
    expect(err).toBeInstanceOf(HookFailure);
    expect(err.cause.message).toContain("log:record");
    expect(types(await readAll(store, rt.state.sessionId))).not.toContain("derived.recorded");
  });

  test("插件 id 重复时拒绝加载：能力按 id 查找，不能借用同名插件的能力", async () => {
    const { provider } = scripted([]);
    const a = plugin("same", { needs: ["log:record"] });
    const b = plugin("same");
    await expect(Runtime.create({ store: new MemoryLogStore(), provider, plugins: [a, b] })).rejects.toThrow("duplicate plugin id");
  });
});

describe("hook 之间的隔离", () => {
  test("transform 返回无法拷贝的值时，算作这个 hook 出错，不连累下一个", async () => {
    const { provider } = scripted([]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("bad", {
          hooks: [{ kind: "transform", point: "context.build", fn: (r) => ({ ...r, ext: { f: () => {} } }) }],
        }),
        plugin("next", { hooks: [{ kind: "transform", point: "context.build", fn: (r) => r }] }),
      ],
    });
    const err = await rt.send(say("hi")).catch((e) => e);
    expect(err).toBeInstanceOf(HookFailure);
    expect((err as HookFailure).plugin).toBe("bad");
  });

  test("最后一个 transform 返回无法拷贝的值时，也包装成 HookFailure", async () => {
    const { provider } = scripted([]);
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("bad", {
          hooks: [{ kind: "transform", point: "context.build", fn: (r) => ({ ...r, ext: { f: () => {} } }) }],
        }),
      ],
    });
    const err = await rt.send(say("hi")).catch((e) => e);
    expect(err).toBeInstanceOf(HookFailure);
    expect((err as HookFailure).plugin).toBe("bad");
  });

  test("并发的 observe 各拿一份拷贝，一个改了 payload 不影响另一个", async () => {
    const { provider } = scripted([{ content: [text("ok")], stopReason: "end" }]);
    let seen: number | undefined;
    const rt = await Runtime.create({
      store: new MemoryLogStore(),
      provider,
      plugins: [
        plugin("mutator", {
          hooks: [{ kind: "observe", point: "model.after", fn: (r: ModelResponse) => void (r.content = []) }],
        }),
        plugin("reader", {
          hooks: [
            {
              kind: "observe",
              point: "model.after",
              fn: async (r: ModelResponse) => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                seen = r.content.length;
              },
            },
          ],
        }),
      ],
    });
    await rt.send(say("hi"));
    expect(seen).toBe(1);
  });
});

describe("边界情况", () => {
  test("空闲时 abort 过，之后 close 触发的 observe 拿到的信号没有被中断", async () => {
    let aborted: boolean | undefined;
    const p = plugin("p", {
      hooks: [{ kind: "observe", point: "session.end", fn: (_s, ctx) => void (aborted = ctx.signal.aborted) }],
    });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider: scripted([]).provider, plugins: [p] });
    rt.abort();
    await rt.close();
    expect(aborted).toBe(false);
  });

  test("已结束的会话换了插件也能 resume，不写入任何事件", async () => {
    const store = new MemoryLogStore();
    const rt = await Runtime.create({ store, provider: scripted([]).provider, plugins: [plugin("p")] });
    await rt.close();
    const before = (await readAll(store, rt.state.sessionId)).length;

    const resumed = await Runtime.resume({
      store,
      sessionId: rt.state.sessionId,
      provider: scripted([]).provider,
      plugins: [plugin("p", { version: "2.0.0" })],
    });
    expect(resumed.state.phase).toBe("ended");
    expect(await readAll(store, rt.state.sessionId)).toHaveLength(before);
  });

  test("tool.interrupted 只能用于已允许、还没有结果的调用", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const events: LogEvent[] = [
      { v: 1, id: "e1", seq: 1, at, type: "session.started", data: { plugins: [] }, origin: { by: "runtime" } },
      { v: 1, id: "e2", seq: 2, at, type: "input.received", data: say("hi"), origin: { by: "user" } },
      { v: 1, id: "e3", seq: 3, at, type: "model.requested", data: { requestHash: "h" }, origin: { by: "runtime" } },
      {
        v: 1,
        id: "e4",
        seq: 4,
        at,
        type: "model.responded",
        data: { content: [toolUse("t1", "echo", {}), toolUse("t2", "echo", {})], stopReason: "tool_use" },
        origin: MODEL,
      },
      { v: 1, id: "e5", seq: 5, at, type: "tool.decided", data: { toolUseId: "t1", decision: "allow", input: {} }, origin: { by: "runtime" } },
      { v: 1, id: "e6", seq: 6, at, type: "tool.decided", data: { toolUseId: "t2", decision: "allow", input: {} }, origin: { by: "runtime" } },
      { v: 1, id: "e7", seq: 7, at, type: "tool.completed", data: { toolUseId: "t1", content: [], isError: false }, origin: { by: "tool", name: "echo" } },
    ];
    const s = rebuild("s", events);
    const interrupt = (toolUseId: string): LogEvent => ({
      v: 1,
      id: "e8",
      seq: 8,
      at,
      type: "tool.interrupted",
      data: { toolUseId },
      origin: { by: "runtime" },
    });
    expect(() => step(s, interrupt("t1"))).toThrow(InvalidTransition);
    expect(step(s, interrupt("t2")).state.phase).toBe("continuing");
    expect(() => step(initialState("x"), { ...interrupt("t2"), seq: 1 })).toThrow(InvalidTransition);
  });

  test("一次响应里 tool_use 的 id 重复时，响应不写入日志，本轮失败", async () => {
    const store = new MemoryLogStore();
    const { provider } = scripted([
      { content: [toolUse("dup", "echo", {}), toolUse("dup", "echo", {})], stopReason: "tool_use" },
    ]);
    const rt = await Runtime.create({ store, provider, plugins: [plugin("p", { tools: [recordingTool("echo").tool] })] });
    await expect(rt.send(say("hi"))).rejects.toBeInstanceOf(InvalidTransition);
    const events = await readAll(store, rt.state.sessionId);
    expect(types(events)).not.toContain("model.responded");
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", data: { reason: "error" } });
  });
});

describe("取消信号（I-9）", () => {
  test("hook 开始时信号已经中断，hook 拿到的信号也是中断的", async () => {
    const seen: boolean[] = [];
    const { provider } = scripted([{ content: [toolUse("t1", "echo", {})], stopReason: "tool_use" }]);
    let rt: Runtime;
    const p = plugin("p", {
      tools: [recordingTool("echo").tool],
      hooks: [
        {
          kind: "transform",
          point: "tool.before",
          fn: (c, ctx) => {
            seen.push(ctx.signal.aborted);
            rt.abort();
            return c;
          },
        },
        {
          kind: "gate",
          point: "tool.gate",
          fn: (_g, ctx) => {
            seen.push(ctx.signal.aborted);
            return { decision: "allow" };
          },
        },
      ],
    });
    rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [p] });
    await rt.send(say("hi")).catch(() => {});
    expect(seen).toEqual([false, true]);
  });
});
