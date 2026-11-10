// jade/steer：一轮中途对模型说的话，在下一次请求模型时附在工具结果后面，并记进日志。

import { afterEach, describe, expect, test } from "bun:test";
import type { Steer } from "@uncarved/jade-api/services";
import { MARKER } from "../plugins/steer/index.ts";
import { cleanup, say, scriptedHost, textOf, use } from "./scripted-ui.ts";

const g = globalThis as { __steer?: Steer; __steerLog?: unknown[] };
afterEach(async () => {
  await cleanup();
  delete g.__steer;
  delete g.__steerLog;
});

// 测试用的插件：把 steer@1 交给测试；hold 工具执行时说一句话；第二次请求模型之前（投影已经做完）再说一句
const HELPER = {
  "plugins/helper/plugin.json": JSON.stringify({ id: "test/helper", version: "1.0.0", api: "^1", entry: "index.mjs", requires: ["steer@1"] }),
  "plugins/helper/index.mjs": `export default { session(ctx) {
    const steer = ctx.require("steer@1");
    globalThis.__steer = steer;
    globalThis.__steerLog = [];
    ctx.kernel.tool({ name: "hold", effect: "read", description: "hold", inputSchema: { type: "object" }, concurrency: "safe", idempotent: true,
      async execute(input, t) {
        globalThis.__steerLog.push(steer.push(t.sessionId, "also check B"));
        return { content: "held" };
      } });
    let requests = 0;
    ctx.kernel.hook({ kind: "transform", point: "model.before", fn: (req) => {
      if (++requests === 2 && globalThis.__late) globalThis.__steerLog.push(steer.push(ctx.session.id, globalThis.__late));
      return req;
    } });
  } };`,
};

describe("jade/steer", () => {
  test("what the user says mid-turn reaches the model with the next request, after the tool results, and stays there", async () => {
    const { host, shared, send, restart } = await scriptedHost({ files: HELPER });
    shared.script.push(use("u1", "hold", {}), say("ok"), say("later"));
    const s = await host.sessions.open();
    // 空闲时不收：调用方照常发消息
    expect(g.__steer!.push(s.id, "nobody is working")).toBe(false);
    const changes: number[] = [];
    g.__steer!.subscribe(() => void changes.push(g.__steer!.pending(s.id).length));
    await send(s, "check A");

    expect(g.__steerLog).toEqual([true]);
    const last = shared.requests[1]!.messages.at(-1)!;
    expect(last.content.map((b) => b.kind)).toEqual(["tool_result", "text", "text"]);
    expect(last.content.slice(1).map((b) => [b.origin.by, b.kind === "text" ? b.text : ""])).toEqual([
      ["plugin", MARKER],
      ["user", "also check B"],
    ]);
    expect(g.__steer!.pending(s.id)).toEqual([]);
    // 加了一句、交给了模型
    expect(changes).toEqual([1, 0]);
    expect((await s.history()).filter((e) => e.type === "jade/steer/said").map((e) => e.data)).toEqual([{ text: "also check B" }]);

    // 恢复的会话里它还在同一个位置
    await host.close();
    const again = await restart();
    const r = await again.sessions.open({ resume: s.id });
    await r.recover();
    await send(r, "and then?");
    const replayed = shared.requests[2]!.messages;
    expect(textOf(replayed[2]!.content)).toContain("also check B");
    expect(replayed.filter((m) => textOf(m.content).includes("also check B"))).toHaveLength(1);
  });

  test("words that arrive after the turn's last request stay pending until the caller takes them back", async () => {
    const late = globalThis as { __late?: string };
    late.__late = "too late for this turn";
    try {
      const { host, shared, send } = await scriptedHost({ files: HELPER });
      shared.script.push(use("u1", "hold", {}), say("ok"));
      const s = await host.sessions.open();
      await send(s, "check A");
      expect(g.__steerLog).toEqual([true, true]);
      expect(shared.requests).toHaveLength(2);
      expect(g.__steer!.pending(s.id)).toEqual(["too late for this turn"]);
      expect(g.__steer!.take(s.id)).toEqual(["too late for this turn"]);
      expect(g.__steer!.pending(s.id)).toEqual([]);
    } finally {
      delete late.__late;
    }
  });
});
