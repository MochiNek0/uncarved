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
