import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryLogStore, type LogEvent } from "uncarved";
import type { ToolRenderer } from "../src/plugins/loader.ts";
import type { Screen, StatusInfo } from "../src/ui/screen.ts";
import { fsRenderers, shellRenderers, taskRenderers } from "../src/ui/renderers.ts";
import { transcript, type TranscriptOptions } from "../src/ui/transcript.ts";
import { clipStyled } from "../src/ui/render.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const speeds: NonNullable<StatusInfo["speed"]>[] = [];
  const streamed: string[] = [];
  const noop = () => {};
  const screen = {
    interactive: false,
    log: noop,
    amend: noop,
    progress: noop,
    stream: (_kind: string, text: string) => streamed.push(text),
    endStream: noop,
    busy: noop,
    status: (s: Partial<StatusInfo>) => s.speed && speeds.push(s.speed),
    queued: noop,
    select: async () => undefined,
    input: async () => undefined,
    clear: noop,
    close: async () => {},
  } as unknown as Screen;
  const t = transcript({ screen, cwd: "/", store: new MemoryLogStore(), contextWindow: () => 100_000, canRetry: () => false });
  const event = (type: string, data: unknown) => t.onNotice({ type: "event", event: { type, data, origin: { by: "kernel" } } as unknown as LogEvent });
  return { t, event, speeds, streamed };
}

test("output speed counts from the first delta, including tool input, not from the request", async () => {
  const { t, event, speeds, streamed } = setup();
  event("model.requested", {});
  await sleep(300);
  t.onNotice({ type: "delta", delta: { kind: "tool_input", text: '{"path":' } });
  await sleep(300);
  event("model.responded", { content: [], usage: { outputTokens: 30 } });
  // 30 token 在第一个增量之后的约 0.3 秒里输出；从发请求算会只有一半左右
  expect(speeds.at(-1)!.tps).toBeGreaterThan(70);
  expect(streamed).toEqual([]);
});

test("a reply with no deltas at all does not update the speed", async () => {
  const { event, speeds } = setup();
  event("model.requested", {});
  await sleep(250);
  event("model.responded", { content: [], usage: { outputTokens: 30 } });
  expect(speeds).toEqual([]);
});

test("cache hit rate: a missing field after a report means 0%, but a different model has to report on its own", () => {
  const caches: (number | undefined)[] = [];
  const noop = () => {};
  const screen = { busy: noop, stream: noop, endStream: noop, status: (s: Partial<StatusInfo>) => "cache" in s && caches.push(s.cache) } as unknown as Screen;
  const t = transcript({ screen, cwd: "/", store: new MemoryLogStore(), contextWindow: () => 100_000, canRetry: () => false });
  const reply = (model: string, usage: object) =>
    t.onNotice({ type: "event", event: { type: "model.responded", data: { content: [], usage }, origin: { by: "model", provider: "p", model } } as unknown as LogEvent });
  reply("a", { inputTokens: 100, cacheReadTokens: 80 });
  reply("a", { inputTokens: 100 });
  reply("b", { inputTokens: 100 });
  expect(caches).toEqual([0.8, 0, undefined]);
});

/** 记下 log / amend / progress 的屏幕，用来看工具调用那一行和进度行 */
function recording(cwd = "/", renderer?: TranscriptOptions["renderer"]) {
  const lines = new Map<string, { text: string; details?: string }>();
  /** 不属于某个工具调用的输出（警告等） */
  const logged: string[] = [];
  const progress = new Map<string, string>();
  const noop = () => {};
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const screen = {
    interactive: false,
    log: (text: string, o?: { id?: string; details?: string }) =>
      o?.id ? lines.set(o.id, { text: plain(text), details: o.details && plain(o.details) }) : logged.push(plain(text)),
    amend: (id: string, text: string, o?: { details?: string }) => {
      const l = lines.get(id)!;
      l.text += ` ${plain(text)}`;
      if (o?.details !== undefined) l.details = plain(o.details);
    },
    progress: (id: string, line: string | undefined) => (line === undefined ? progress.delete(id) : progress.set(id, plain(line))),
    stream: noop,
    endStream: noop,
    busy: noop,
    status: noop,
  } as unknown as Screen;
  // 和 jade 里一样带上内置工具的 renderer；传进来的（插件的）优先
  const own = new Map([...fsRenderers(cwd), ...shellRenderers, ...taskRenderers].map((r) => [r.tool, { plugin: "jade/builtin", renderer: r }]));
  const t = transcript({ screen, cwd, store: new MemoryLogStore(), contextWindow: () => 100_000, canRetry: () => false, renderer: (tool) => renderer?.(tool) ?? own.get(tool) });
  const event = (type: string, data: unknown) => t.onNotice({ type: "event", event: { type, data, origin: { by: "kernel" } } as unknown as LogEvent });
  const use = (id: string, name: string, input: unknown) => {
    event("model.responded", { content: [{ kind: "tool_use", id, name, input }], usage: {} });
    event("tool.decided", { toolUseId: id, input, decision: "allow", decidedBy: "policy" });
  };
  return { t, event, use, lines, progress, logged };
}

test("a long or multi-line command is shown in full when its call is expanded", () => {
  const { event, use, lines } = recording();
  const command = `echo ${"x".repeat(150)} &&\n  ls`;
  use("b1", "bash", { command });
  expect(lines.get("b1")!.text).not.toContain("ls");
  expect(lines.get("b1")!.details).toBe(`    $ echo ${"x".repeat(150)} &&\n        ls`);
  // 结果只有一行时折叠内容只有命令；结果接在后面
  event("tool.completed", { toolUseId: "b1", content: [{ kind: "text", text: "ok" }], isError: false });
  expect(lines.get("b1")!.details).toBe(`    $ echo ${"x".repeat(150)} &&\n        ls`);
  // 短命令不用折叠
  use("b2", "bash", { command: "ls" });
  event("tool.completed", { toolUseId: "b2", content: [{ kind: "text", text: "a\nb" }], isError: false });
  expect(lines.get("b2")!.details).toBe("    a\n    b");
});

test("each sub-agent keeps one progress line with its label and what it is doing", () => {
  const { t, event, use, lines, progress } = recording();
  use("t1", "task", { description: "find config", prompt: "…" });
  const p = (update: unknown) => t.onNotice({ type: "tool-progress", toolUseId: "t1", update } as never);
  p({ kind: "task-start", sessionId: "s", description: "find config" });
  expect(progress.get("t1")).toBe("  ↳ find config · starting");
  p({ kind: "task-model" });
  expect(progress.get("t1")).toBe("  ↳ find config · thinking");
  p({ kind: "task-tool", name: "grep", input: { pattern: "port" }, decision: "allow" });
  expect(progress.get("t1")).toBe("  ↳ find config (1 tool call) · · grep(port)");
  p({ kind: "task-model" });
  expect(progress.get("t1")).toBe("  ↳ find config (1 tool call) · thinking");
  event("tool.completed", { toolUseId: "t1", content: [{ kind: "text", text: "in a.ts" }], isError: false });
  expect(progress.has("t1")).toBe(false);
  expect(lines.get("t1")!.details).toContain("sub-agent ran 1 tool call:");
});

test("a plugin's renderer shows its tool's summary, preview and result; failures fall back to the default once warned", async () => {
  let broken = false;
  const renderer: ToolRenderer = {
    tool: "deploy",
    summary: (input) => {
      if (broken) throw new Error("boom");
      return `${(input as { env: string }).env}\nignored second line`;
    },
    preview: async (input) => `will deploy to ${(input as { env: string }).env}`,
    result: ({ text, isError }) => (isError ? undefined : { line: `deployed (${text.length} chars)`, details: "step 1\nstep 2" }),
  };
  const { t, event, use, lines, logged } = recording("/", (tool) => (tool === "deploy" ? { plugin: "x/deploy", renderer } : undefined));
  use("d1", "deploy", { env: "staging" });
  expect(lines.get("d1")!.text).toBe("● deploy(staging)");
  event("tool.completed", { toolUseId: "d1", content: [{ kind: "text", text: "ok\nlog" }], isError: false });
  expect(lines.get("d1")!.text).toBe("● deploy(staging) ⎿ deployed (6 chars)");
  expect(lines.get("d1")!.details).toBe("    step 1\n    step 2");
  expect(await t.preview({ toolUseId: "d2", name: "deploy", input: { env: "prod" } } as never)).toBe("will deploy to prod");

  // result 返回 undefined：默认显示
  use("d3", "deploy", { env: "dev" });
  event("tool.completed", { toolUseId: "d3", content: [{ kind: "text", text: "failed" }], isError: true });
  expect(lines.get("d3")!.text).toBe("● deploy(dev) ⎿ failed");
  // 出错：默认显示，同一个插件的同一个工具只提示一次
  broken = true;
  use("d4", "deploy", { env: "qa" });
  use("d5", "deploy", { env: "qa" });
  expect(lines.get("d4")!.text).toContain('deploy({"env":"qa"})');
  expect(logged.filter((l) => l.includes("plugin x/deploy: showing deploy failed"))).toHaveLength(1);
  // 没有 renderer 的工具不受影响
  use("b1", "bash", { command: "ls" });
  expect(lines.get("b1")!.text).toBe("● bash(ls)");
});

test("an edit shows +added -removed on its result line and the diff in its details, also without an approval", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jade-diff-"));
  await writeFile(path.join(dir, "a.ts"), "one\ntwo\nthree\n");
  const { event, use, lines } = recording(dir);
  // auto/yolo 模式下没有审批框：调用行由 tool.decided 显示
  use("e1", "edit_file", { path: "a.ts", old_string: "two", new_string: "TWO\nmore" });
  // 工具执行后文件变了；diff 是执行前算的
  await writeFile(path.join(dir, "a.ts"), "one\nTWO\nmore\nthree\n");
  event("tool.completed", { toolUseId: "e1", content: [{ kind: "text", text: "Edited a.ts (1 replacement)" }] });
  const l = lines.get("e1")!;
  expect(l.text).toContain("Edited a.ts (1 replacement) +2 -1");
  expect(l.details).toContain("2 - two");
  expect(l.details).toContain("2 + TWO");
  expect(l.details).toContain("3 + more");

  // 失败的修改不显示 diff
  use("e2", "edit_file", { path: "a.ts", old_string: "missing", new_string: "x" });
  event("tool.completed", { toolUseId: "e2", isError: true, content: [{ kind: "text", text: "old_string not found" }] });
  expect(lines.get("e2")!.text).not.toContain("+");
});

test("clipStyled counts only visible characters and resets colors it cuts off", () => {
  const g = (t: string) => `\x1b[32m${t}\x1b[39m`;
  expect(clipStyled(g("ab") + g("cd"), 4)).toBe(g("ab") + g("cd"));
  // 不在序列中间切开，截断后复位颜色
  expect(clipStyled(g("abc") + g("def"), 4)).toBe(`${g("abc")}\x1b[32md…\x1b[0m`);
  expect(clipStyled("abcdef", 3)).toBe("abc…");
});

test("a plugin's colored result line is clipped by visible characters, never inside a color sequence", () => {
  const amended: string[] = [];
  const noop = () => {};
  const screen = { interactive: false, log: noop, amend: (_id: string, text: string) => amended.push(text), progress: noop, stream: noop, endStream: noop, busy: noop, status: noop } as unknown as Screen;
  const g = (s: string) => `\x1b[32m${s}\x1b[39m`;
  const renderer: ToolRenderer = { tool: "deploy", result: () => ({ line: "x".repeat(198) + g("hello") }) };
  const t = transcript({ screen, cwd: "/", store: new MemoryLogStore(), contextWindow: () => 100_000, canRetry: () => false, renderer: (tool) => (tool === "deploy" ? { plugin: "x/deploy", renderer } : undefined) });
  const event = (type: string, data: unknown) => t.onNotice({ type: "event", event: { type, data, origin: { by: "kernel" } } as unknown as LogEvent });
  event("model.responded", { content: [{ kind: "tool_use", id: "d1", name: "deploy", input: {} }], usage: {} });
  event("tool.decided", { toolUseId: "d1", input: {}, decision: "allow", decidedBy: "policy" });
  event("tool.completed", { toolUseId: "d1", content: [{ kind: "text", text: "ok" }], isError: false });
  expect(amended.at(-1)).toContain(`${"x".repeat(198)}\x1b[32mhe…\x1b[0m`);
});
