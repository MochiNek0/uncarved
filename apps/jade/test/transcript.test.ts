import { expect, test } from "bun:test";
import { MemoryLogStore, type LogEvent } from "uncarved";
import type { Screen, StatusInfo } from "../src/ui/screen.ts";
import { transcript } from "../src/ui/transcript.ts";

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

/** 记下 log / amend / progress 的屏幕，用来看工具调用那一行和进度行 */
function recording() {
  const lines = new Map<string, { text: string; details?: string }>();
  const progress = new Map<string, string>();
  const noop = () => {};
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const screen = {
    interactive: false,
    log: (text: string, o?: { id?: string; details?: string }) => o?.id && lines.set(o.id, { text: plain(text), details: o.details && plain(o.details) }),
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
  const t = transcript({ screen, cwd: "/", store: new MemoryLogStore(), contextWindow: () => 100_000, canRetry: () => false });
  const event = (type: string, data: unknown) => t.onNotice({ type: "event", event: { type, data, origin: { by: "kernel" } } as unknown as LogEvent });
  const use = (id: string, name: string, input: unknown) => {
    event("model.responded", { content: [{ kind: "tool_use", id, name, input }], usage: {} });
    event("tool.decided", { toolUseId: id, input, decision: "allow", decidedBy: "policy" });
  };
  return { t, event, use, lines, progress };
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
