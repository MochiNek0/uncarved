import { expect, test } from "bun:test";
import type { LogEvent } from "uncarved";
import type { EventRenderer, ToolRenderer } from "../plugins/renderers/index.ts";
import type { Screen, StatusInfo } from "../plugins/tui/screen.ts";
import { transcript, type TranscriptOptions } from "../plugins/tui/transcript.ts";
import { clipStyled } from "../plugins/tui/render.ts";

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
  const t = transcript({ screen, cwd: "/", contextWindow: () => 100_000, canRetry: () => false });
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
  const t = transcript({ screen, cwd: "/", contextWindow: () => 100_000, canRetry: () => false });
  const reply = (model: string, usage: object) =>
    t.onNotice({ type: "event", event: { type: "model.responded", data: { content: [], usage }, origin: { by: "model", provider: "p", model } } as unknown as LogEvent });
  reply("a", { inputTokens: 100, cacheReadTokens: 80 });
  reply("a", { inputTokens: 100 });
  reply("b", { inputTokens: 100 });
  expect(caches).toEqual([0.8, 0, undefined]);
});

/** 像 jade/shell 的 bash：摘要是命令的第一行（截断），完整的命令在 details 里 */
const shellLike: ToolRenderer = {
  tool: "bash",
  summary: (input) => {
    const c = (input as { command: string }).command;
    return c.length > 100 || c.includes("\n") ? c.split("\n")[0]!.slice(0, 100) + "…" : c;
  },
  details: (input) => {
    const c = (input as { command: string }).command;
    return c.length > 100 || c.includes("\n") ? `$ ${c.replace(/\n/g, "\n  ")}` : undefined;
  },
};
/** 像 todo_write：自己画调用行和下面的清单；成功时不显示结果 */
const todoLike: ToolRenderer = {
  tool: "todo_write",
  call: (input) => ["Todos", ...(input as { todos: { content: string }[] }).todos.map((t) => `  ${t.content}`)].join("\n"),
  result: ({ isError }) => (isError ? undefined : null),
};
/** 像 jade/compact 的 compacted 事件 */
const compactLike: EventRenderer = {
  event: "compacted",
  render: (data) => {
    const d = data as { upTo: number; before: number };
    return { line: `[compacted ${d.upTo} messages, ~${d.before} tokens before]` };
  },
};

/** 记下 log / amend / progress 的屏幕，用来看工具调用那一行和进度行 */
function recording(cwd = "/", renderer?: TranscriptOptions["renderer"], eventRenderer?: TranscriptOptions["eventRenderer"]) {
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
  // 旧 jade 的内置 renderer 现在在各自的插件里；这里放几个最小的，测 transcript 怎么用 renderer。传进来的优先
  const own = new Map([shellLike, todoLike].map((r) => [r.tool, { plugin: "x/builtin", renderer: r }]));
  const events = new Map<string, { plugin: string; renderer: EventRenderer }>([[`jade/compact/${compactLike.event}`, { plugin: "jade/compact", renderer: compactLike }]]);
  const t = transcript({
    screen,
    cwd,
    contextWindow: () => 100_000,
    canRetry: () => false,
    renderer: (tool) => renderer?.(tool) ?? own.get(tool),
    eventRenderer: (type) => eventRenderer?.(type) ?? events.get(type),
  });
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

test("a renderer's call replaces the call line and shows the rest unfolded; a null result hides the result, errors still show", () => {
  const { event, use, lines, logged } = recording();
  use("w1", "todo_write", { todos: [{ content: "read", status: "completed" }, { content: "edit", status: "in_progress" }] });
  expect(lines.get("w1")!.text).toBe("● Todos");
  expect(logged.at(-1)).toContain("edit");
  event("tool.completed", { toolUseId: "w1", content: [{ kind: "text", text: "Todo list updated" }], isError: false });
  expect(lines.get("w1")!.text).toBe("● Todos");
  use("w2", "todo_write", { todos: [] });
  event("tool.completed", { toolUseId: "w2", content: [{ kind: "text", text: "todos must be an array" }], isError: true });
  expect(lines.get("w2")!.text).toBe("● Todos ⎿ todos must be an array");
});

test("plugin events show through the plugin's event renderer; their usage counts whether or not they are shown", () => {
  let broken = false;
  const deploy: EventRenderer = {
    event: "deployed",
    render: (data) => {
      if (broken) throw new Error("boom");
      return { line: `deployed ${(data as { env: string }).env}` };
    },
  };
  const { t, logged } = recording("/", undefined, (type) => (type === "x/deploy/deployed" ? { plugin: "x/deploy", renderer: deploy } : undefined));
  const emit = (type: string, data: unknown, id = "x/deploy") => t.onNotice({ type: "event", event: { type, data, origin: { by: "plugin", id } } } as never);
  emit("x/deploy/deployed", { env: "prod" });
  emit("jade/compact/compacted", { from: 0, upTo: 12, before: 9000, usage: { inputTokens: 900, outputTokens: 100 } }, "jade/compact");
  // 没有渲染器的事件不显示，只统计用量；usage 里不是数字的字段不算
  emit("x/deploy/billed", { usage: { inputTokens: 5, outputTokens: "lots" } });
  expect(logged).toEqual(["deployed prod", "[compacted 12 messages, ~9000 tokens before]"]);
  expect(t.usage).toMatchObject({ inputTokens: 905, outputTokens: 100 });
  broken = true;
  emit("x/deploy/deployed", { env: "qa" });
  emit("x/deploy/deployed", { env: "qa" });
  expect(logged.filter((l) => l.includes("plugin x/deploy: showing x/deploy/deployed failed"))).toHaveLength(1);
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
  // 没有 renderer 的工具不受影响：默认摘要是 path 参数（工作目录里的显示成相对路径）
  use("r1", "read_file", { path: "/a.ts" });
  expect(lines.get("r1")!.text).toBe("● read_file(a.ts)");
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
  const t = transcript({ screen, cwd: "/", contextWindow: () => 100_000, canRetry: () => false, renderer: (tool) => (tool === "deploy" ? { plugin: "x/deploy", renderer } : undefined) });
  const event = (type: string, data: unknown) => t.onNotice({ type: "event", event: { type, data, origin: { by: "kernel" } } as unknown as LogEvent });
  event("model.responded", { content: [{ kind: "tool_use", id: "d1", name: "deploy", input: {} }], usage: {} });
  event("tool.decided", { toolUseId: "d1", input: {}, decision: "allow", decidedBy: "policy" });
  event("tool.completed", { toolUseId: "d1", content: [{ kind: "text", text: "ok" }], isError: false });
  expect(amended.at(-1)).toContain(`${"x".repeat(198)}\x1b[32mhe…\x1b[0m`);
});

test("a sub-agent's usage is read from its own log when readLog is given, and skipped without it", async () => {
  const child: LogEvent[] = [
    { type: "model.responded", data: { content: [], usage: { inputTokens: 40, outputTokens: 4 } }, origin: { by: "kernel" } } as unknown as LogEvent,
  ];
  const noop = () => {};
  const screen = { interactive: false, log: noop, amend: noop, progress: noop, stream: noop, endStream: noop, busy: noop, status: noop } as unknown as Screen;
  const run = async (opts: Partial<TranscriptOptions>) => {
    const t = transcript({ screen, cwd: "/", contextWindow: () => 100_000, canRetry: () => false, ...opts });
    const event = { type: "tool.completed", data: { toolUseId: "t1", content: [], child: { sessionId: "child-1" } }, origin: { by: "kernel" } } as unknown as LogEvent;
    await t.replay([event], false);
    return t.usage;
  };
  const read: string[] = [];
  expect(await run({ readLog: async (id) => (read.push(id), child) })).toMatchObject({ inputTokens: 40, outputTokens: 4 });
  expect(read).toEqual(["child-1"]);
  expect(await run({})).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  // 读不到子会话的日志时不算，也不抛
  expect(await run({ readLog: async () => Promise.reject(new Error("gone")) })).toMatchObject({ inputTokens: 0 });
});
