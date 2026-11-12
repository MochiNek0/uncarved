// 状态栏上的模式、压缩阈值是 jade/modes、jade/compact 自己的段落（ctx.status），前端不认识它们。

import { afterEach, describe, expect, test } from "bun:test";
import type { Modes } from "@uncarved/jade-api/services";
import { cleanup, say, scriptedHost } from "./scripted-ui.ts";

afterEach(cleanup);

const last = (statuses: { plugin: string; segment: unknown }[], plugin: string) => statuses.findLast((s) => s.plugin === plugin)?.segment;

describe("plugins put their own status segments", () => {
  test("jade/modes shows the mode, kept when narrow, with a tone for how much it allows", async () => {
    const { host, shared } = await scriptedHost();
    await host.sessions.open();
    // scriptedHost 配的是 yolo
    expect(last(shared.statuses, "jade/modes")).toEqual({ text: "yolo (shift+tab)", short: "yolo", tone: "error", keep: true });
    host.service<Modes>("modes@1")!.set("plan");
    expect(last(shared.statuses, "jade/modes")).toEqual({ text: "plan (shift+tab)", short: "plan", tone: "accent", keep: true });
    host.service<Modes>("modes@1")!.set("ask");
    expect(last(shared.statuses, "jade/modes")).toEqual({ text: "ask (shift+tab)", short: "ask", tone: "ok", keep: true });
  });

  test("jade/compact shows where it compacts, and turns to a warning near it", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/compact": { thresholdTokens: 1000 } } });
    const s = await host.sessions.open();
    expect(last(shared.statuses, "jade/compact")).toEqual({ text: "compacts at 1.0k" });
    shared.script.push(say("short"));
    await send(s, "hi");
    expect(last(shared.statuses, "jade/compact")).toEqual({ text: "compacts at 1.0k" });
    // 投影快到阈值（85%）：变成警告
    shared.script.push(say("ok"));
    await send(s, "x".repeat(3500));
    expect(last(shared.statuses, "jade/compact")).toEqual({ text: "compacts at 1.0k", tone: "warn" });
  });
});
