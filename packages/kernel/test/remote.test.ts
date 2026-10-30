import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  HookFailure,
  HookTimeout,
  MemoryLogStore,
  ModelOutputModified,
  PluginIncompatible,
  RemoteHookError,
  Runtime,
  readAll,
  type Block,
  type ModelRequest,
  type ModelResponse,
  type Plugin,
  type Provider,
  type RemoteHookSpec,
  type Tool,
} from "../src/index.ts";

const MODEL = { by: "model" as const, provider: "scripted", model: "scripted-1" };
const text = (t: string): Block => ({ kind: "text", text: t, origin: MODEL, trust: "trusted" });

function scripted(script: Array<Omit<ModelResponse, "model">>) {
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

const say = (t: string) => ({
  kind: "message" as const,
  content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }],
});

function remote(spec: Partial<RemoteHookSpec> & Pick<RemoteHookSpec, "kind" | "point" | "call">): RemoteHookSpec {
  return { remote: true, reads: [], writes: [], timeoutMs: 1000, ...spec };
}

const plugin = (hooks: RemoteHookSpec[], extra: Partial<Plugin> = {}): Plugin => ({
  id: "remote",
  version: "1.0.0",
  kernel: "^0.1",
  // 按 hook 声明所需能力，注册检查测的才是 hook 本身的问题
  needs: hooks.map((h) => `${h.kind}:${h.point}`).filter((n) => CAPABILITIES.has(n)),
  hooks,
  ...extra,
});

describe("注册检查（5.5）", () => {
  const call = async () => ({});
  const cases: Array<[string, RemoteHookSpec]> = [
    ["超时为无穷", remote({ kind: "gate", point: "tool.gate", call, timeoutMs: Infinity })],
    ["超时为 0", remote({ kind: "gate", point: "tool.gate", call, timeoutMs: 0 })],
    ["optional", { ...remote({ kind: "transform", point: "context.build", call }), optional: true } as RemoteHookSpec],
    ["读不存在的字段", remote({ kind: "transform", point: "context.build", call, reads: ["secrets"] })],
    ["写只读字段", remote({ kind: "transform", point: "tool.before", call, writes: ["name"] })],
    ["关卡声明写字段", remote({ kind: "gate", point: "tool.gate", call, writes: ["input"] })],
    ["种类与扩展点不符", remote({ kind: "observe", point: "tool.gate", call })],
    ["未知扩展点", remote({ kind: "observe", point: "nope" as "event", call })],
    ["缺少 reads", { ...remote({ kind: "observe", point: "event", call }), reads: undefined } as unknown as RemoteHookSpec],
  ];
  for (const [name, spec] of cases) {
    test(`拒绝：${name}`, async () => {
      const { provider } = scripted([]);
      await expect(
        Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin([spec])] }),
      ).rejects.toBeInstanceOf(PluginIncompatible);
    });
  }
});

describe("字段裁剪与合并", () => {
  test("只发送声明读取的字段，只合并声明写入的字段", async () => {
    const seen: Record<string, unknown>[] = [];
    const { provider, requests } = scripted([{ content: [text("ok")], stopReason: "end" }]);
    const hook = remote({
      kind: "transform",
      point: "context.build",
      reads: ["system", "derived"],
      writes: ["system"],
      call: async (payload) => {
        seen.push(payload);
        const seg = { text: "remote", stability: "stable", origin: { by: "plugin", id: "remote" }, trust: "untrusted" };
        return { system: [...(payload.system as unknown[]), seg] };
      },
    });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin([hook])] });
    await rt.send(say("hi"));

    expect(Object.keys(seen[0]!).sort()).toEqual(["derived", "system"]);
    expect(requests[0]!.system).toEqual([
      { text: "remote", stability: "stable", origin: { by: "plugin", id: "remote" }, trust: "untrusted" },
    ]);
    expect(requests[0]!.messages).toHaveLength(1);
  });

  test("回复修改了未声明的字段：视为出错，本轮失败", async () => {
    const { provider, requests } = scripted([]);
    const hook = remote({
      kind: "transform",
      point: "context.build",
      reads: ["system"],
      writes: ["system"],
      call: async () => ({ system: [], messages: [] }),
    });
    const store = new MemoryLogStore();
    const rt = await Runtime.create({ store, provider, plugins: [plugin([hook])] });
    const err = await rt.send(say("hi")).catch((e) => e);
    expect(err).toBeInstanceOf(HookFailure);
    expect(err.cause).toBeInstanceOf(RemoteHookError);
    expect(requests).toHaveLength(0);
    expect((await readAll(store, rt.state.sessionId)).at(-1)).toMatchObject({ type: "turn.ended", data: { reason: "error" } });
  });

  test("进程外 hook 同样受 I-6 约束", async () => {
    const { provider } = scripted([
      { content: [text("first")], stopReason: "end" },
      { content: [text("second")], stopReason: "end" },
    ]);
    let active = false;
    const hook = remote({
      kind: "transform",
      point: "context.project",
      reads: ["messages"],
      writes: ["messages"],
      call: async (payload) => {
        const messages = payload.messages as Array<{ role: string; content: Block[] }>;
        if (!active) return {};
        return { messages: messages.map((m) => ({ ...m, content: m.content.map((b) => (b.origin.by === "model" ? { ...b, text: "edited" } : b)) })) };
      },
    });
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin([hook])] });
    await rt.send(say("one"));
    active = true;
    const err = await rt.send(say("two")).catch((e) => e);
    expect(err.cause).toBeInstanceOf(ModelOutputModified);
  });
});

describe("关卡、超时与取消", () => {
  const danger: Tool = {
    name: "danger",
    description: "d",
    inputSchema: { type: "object" },
    effect: "write",
    concurrency: "exclusive",
    idempotent: false,
    async execute() {
      return { content: "ran" };
    },
  };
  const useDanger: Block = { kind: "tool_use", id: "t1", name: "danger", input: { x: 1 }, origin: MODEL, trust: "trusted" };

  test("关卡拒绝并给出理由；回复不合法时视为拒绝", async () => {
    for (const [reply, reason] of [
      [{ decision: "deny", reason: "no" }, "no"],
      [{ decision: "maybe" }, undefined],
    ] as const) {
      const { provider, requests } = scripted([
        { content: [useDanger], stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end" },
      ]);
      const seen: Record<string, unknown>[] = [];
      const gate = remote({
        kind: "gate",
        point: "tool.gate",
        reads: ["name"],
        call: async (payload) => {
          seen.push(payload);
          return reply;
        },
      });
      const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin([gate], { tools: [danger] })] });
      await rt.send(say("hi"));
      expect(seen).toEqual([{ name: "danger" }]);
      const result = requests[1]!.messages.at(-1)!.content[0]!;
      expect(result).toMatchObject({ kind: "tool_result", isError: true });
      expect((result as { content: Block[] }).content).toEqual(
        reason ? [{ kind: "text", text: reason, origin: { by: "plugin", id: "remote" }, trust: "trusted" }] : [],
      );
    }
  });

  test("超时时取消信号送达，本轮失败", async () => {
    let aborted = false;
    const hook = remote({
      kind: "transform",
      point: "context.build",
      timeoutMs: 20,
      call: (_payload, ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("cancelled"));
          });
        }),
    });
    const { provider } = scripted([]);
    const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [plugin([hook])] });
    const err = await rt.send(say("hi")).catch((e) => e);
    expect(err.cause).toBeInstanceOf(HookTimeout);
    expect(aborted).toBe(true);
  });
});
