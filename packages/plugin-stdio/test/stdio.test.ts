import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  HookFailure,
  HookTimeout,
  MemoryLogStore,
  MemoryTrustStore,
  PluginIncompatible,
  Runtime,
  UntrustedPlugin,
  readAll,
  type Block,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type Tool,
} from "uncarved";
import { PluginProcessError, spawnPlugin, type SpawnOptions, type StdioPlugin } from "../src/index.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MODEL = { by: "model" as const, provider: "scripted", model: "scripted-1" };
const text = (t: string): Block => ({ kind: "text", text: t, origin: MODEL, trust: "trusted" });
const say = (t: string) => ({
  kind: "message" as const,
  content: [{ kind: "text" as const, text: t, origin: { by: "user" as const }, trust: "trusted" as const }],
});

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

let dir: string;
const running: StdioPlugin[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "uncarved-stdio-"));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.close()));
  await rm(dir, { recursive: true, force: true });
});

function hook(name: string, kind: string, point: string, extra: object = {}) {
  return { name, kind, point, reads: [], writes: [], timeoutMs: 5000, ...extra };
}

/** 清单没有给出 needs 时，按 hook 推出所需的扩展点能力（不含 log:*） */
async function start(manifest: { hooks?: Array<{ kind: string; point: string }>; needs?: string[] }, extra: Partial<SpawnOptions> = {}) {
  const needs = manifest.needs ?? (manifest.hooks ?? []).map((h) => `${h.kind}:${h.point}`).filter((n) => CAPABILITIES.has(n));
  const p = await spawnPlugin({
    command: process.execPath,
    args: [path.join(fixtures, "plugin.ts")],
    env: { FIXTURE_MANIFEST: JSON.stringify({ id: "fixture", version: "1.0.0", kernel: "^1", ...manifest, needs }) },
    ...extra,
  });
  running.push(p);
  return p;
}

test("端到端：进程外 transform 改写系统提示词，进程外关卡拒绝工具；关闭后进程正常退出", async () => {
  const p = await start({
    hooks: [
      hook("append-system", "transform", "context.build", { reads: ["system"], writes: ["system"] }),
      hook("deny-danger", "gate", "tool.gate", { reads: ["name"] }),
    ],
  });
  const danger: Tool = {
    name: "danger",
    description: "d",
    inputSchema: { type: "object" },
    effect: "write",
    concurrency: "exclusive",
    idempotent: false,
    async execute() {
      throw new Error("must not run");
    },
  };
  const { provider, requests } = scripted([
    { content: [{ kind: "tool_use", id: "t1", name: "danger", input: {}, origin: MODEL, trust: "trusted" }], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end" },
  ]);
  const rt = await Runtime.create({
    store: new MemoryLogStore(),
    provider,
    plugins: [p, { id: "tools", version: "1.0.0", kernel: "^1", tools: [danger] }],
  });
  await rt.send(say("hi"));

  expect(requests[0]!.system).toEqual([
    { text: "from process", stability: "stable", origin: { by: "plugin", id: "fixture" }, trust: "untrusted" },
  ]);
  expect(requests[1]!.messages.at(-1)!.content[0]).toMatchObject({
    kind: "tool_result",
    isError: true,
    content: [{ text: "blocked by process", origin: { by: "plugin", id: "fixture" } }],
  });
  await p.close();
  expect(await p.exited).toEqual({ code: 0, signal: null });
});

test("超时：插件收到 $/cancel，本轮失败", async () => {
  let stderr = "";
  const p = await start(
    { hooks: [hook("hang", "transform", "context.build", { timeoutMs: 100 })] },
    { onStderr: (t) => (stderr += t) },
  );
  const { provider } = scripted([]);
  const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [p] });
  const err = await rt.send(say("hi")).catch((e) => e);
  expect(err).toBeInstanceOf(HookFailure);
  expect(err.cause).toBeInstanceOf(HookTimeout);

  for (let i = 0; i < 50 && !stderr.includes("cancel"); i++) await Bun.sleep(20);
  expect(stderr).toMatch(/cancel \d+/);
});

test("log/record 只在声明了能力时可用，记录带插件来源", async () => {
  const withNeed = await start({
    needs: ["transform:context.build", "log:record"],
    hooks: [hook("record", "transform", "context.build")],
  });
  const store = new MemoryLogStore();
  const ok = await Runtime.create({ store, provider: scripted([{ content: [text("ok")], stopReason: "end" }]).provider, plugins: [withNeed] });
  await ok.send(say("hi"));
  const recorded = (await readAll(store, ok.state.sessionId)).find((e) => e.type === "derived.recorded")!;
  expect(recorded.data).toEqual({ key: "fixture/k", value: 42 });
  expect(recorded.origin).toEqual({ by: "plugin", id: "fixture" });

  const without = await start({ hooks: [hook("record", "transform", "context.build")] });
  const denied = await Runtime.create({ store: new MemoryLogStore(), provider: scripted([]).provider, plugins: [without] });
  const err = await denied.send(say("hi")).catch((e) => e);
  expect(err).toBeInstanceOf(HookFailure);
  expect(err.cause.message).toContain("log:record");
});

test("进程崩溃：进行中和之后的调用都失败，exited 带上退出码，不自动重启", async () => {
  const p = await start({ hooks: [hook("crash", "transform", "context.build")] });
  const rt = await Runtime.create({ store: new MemoryLogStore(), provider: scripted([]).provider, plugins: [p] });
  const first = await rt.send(say("hi")).catch((e) => e);
  expect(first.cause).toBeInstanceOf(PluginProcessError);
  expect(await p.exited).toEqual({ code: 3, signal: null });

  const second = await rt.send(say("again")).catch((e) => e);
  expect(second.cause).toBeInstanceOf(PluginProcessError);
});

test("插件输出不是对象的 JSON：结束插件进程，宿主不受影响", async () => {
  const p = await start({ hooks: [hook("garbage", "transform", "context.build")] });
  const rt = await Runtime.create({ store: new MemoryLogStore(), provider: scripted([]).provider, plugins: [p] });
  const err = await rt.send(say("hi")).catch((e) => e);
  expect(err.cause).toBeInstanceOf(PluginProcessError);
  expect((await p.exited).code).not.toBe(0);
});

test("单条消息超过上限：结束插件进程，宿主不会无限缓存", async () => {
  const p = await start({ hooks: [hook("flood", "transform", "context.build")] }, { maxMessageBytes: 1024 });
  const rt = await Runtime.create({ store: new MemoryLogStore(), provider: scripted([]).provider, plugins: [p] });
  const err = await rt.send(say("hi")).catch((e) => e);
  expect(err.cause).toBeInstanceOf(PluginProcessError);
  expect((await p.exited).code).not.toBe(0);
});

test("最后一条消息没有换行：stdout 关闭时仍然处理", async () => {
  const p = await start({ hooks: [hook("no-newline", "transform", "context.build")] });
  const { provider, requests } = scripted([{ content: [text("ok")], stopReason: "end" }]);
  const rt = await Runtime.create({ store: new MemoryLogStore(), provider, plugins: [p] });
  await rt.send(say("hi"));
  expect(requests).toHaveLength(1);
  expect(await p.exited).toEqual({ code: 0, signal: null });
});

test("清单违反 5.5 时拒绝加载", async () => {
  await expect(start({ hooks: [hook("x", "transform", "context.build", { timeoutMs: 0 })] })).rejects.toBeInstanceOf(
    PluginIncompatible,
  );
  await expect(start({ hooks: [hook("x", "transform", "context.build", { optional: true })] })).rejects.toBeInstanceOf(
    PluginIncompatible,
  );
});

test("项目层：确认之前不启动进程；确认按启动规格和目录内容计算", async () => {
  const mark = path.join(dir, "started");
  const trust = new MemoryTrustStore();
  const asked: string[] = [];
  const opts = (answer: boolean, args: string[] = []): Partial<SpawnOptions> => ({
    layer: "project",
    args: [path.join(fixtures, "plugin.ts"), ...args],
    env: {
      FIXTURE_MANIFEST: JSON.stringify({ id: "fixture", version: "1.0.0", kernel: "^1", hooks: [] }),
      FIXTURE_MARK: mark,
    },
    trust: {
      dir: fixtures,
      trust,
      confirm: async (req) => {
        asked.push(req.hash);
        return answer;
      },
    },
  });

  await expect(start({}, opts(false))).rejects.toBeInstanceOf(UntrustedPlugin);
  expect(existsSync(mark)).toBe(false);

  const p = await start({}, opts(true));
  const rt = await Runtime.create({ store: new MemoryLogStore(), provider: scripted([]).provider, plugins: [p] });
  expect(rt.state.plugins).toEqual([{ id: "fixture", version: "1.0.0" }]);
  expect(p.layer).toBe("project");

  await start({}, opts(false)); // 同样的规格不再询问
  expect(asked).toHaveLength(2);
  await expect(start({}, opts(false, ["--extra"]))).rejects.toBeInstanceOf(UntrustedPlugin);
  expect(asked).toHaveLength(3);
  expect(asked[2]).not.toBe(asked[1]);
  // 工作目录决定相对路径指向哪里，换了工作目录也要重新确认
  await expect(start({}, { ...opts(false), cwd: dir })).rejects.toBeInstanceOf(UntrustedPlugin);
  expect(asked).toHaveLength(4);
});
