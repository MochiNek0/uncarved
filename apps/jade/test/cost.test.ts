// jade/cost：按配置的单价把用量换算成钱。

import { afterEach, describe, expect, test } from "bun:test";
import type { UI } from "../src/index.ts";
import type { CommandContext, Commands } from "../plugins/commands/index.ts";
import { costOf, parsePrices, priceOf } from "../plugins/cost/index.ts";
import { cleanup, say, scriptedHost } from "./scripted-ui.ts";

afterEach(cleanup);

describe("jade/cost", () => {
  test("prices: bad entries are dropped, the longest prefix wins, cached input has its own price", () => {
    const prices = parsePrices({ claude: { input: 3, output: 15 }, "claude-opus": { input: 15, output: 75, cacheRead: 1.5 }, broken: { input: "x" } });
    expect(Object.keys(prices)).toEqual(["claude", "claude-opus"]);
    expect(priceOf(prices, "claude-opus-5-5")!.input).toBe(15);
    expect(priceOf(prices, "claude-haiku")!.input).toBe(3);
    expect(priceOf(prices, "gpt-x")).toBeUndefined();
    // 100 万输入里 40 万命中缓存、10 万写入缓存（没有单价，按输入算）；10 万输出
    const u = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 };
    expect(costOf(u, prices["claude-opus"]!)).toBeCloseTo(0.5 * 15 + 0.4 * 1.5 + 0.1 * 15 + 0.1 * 75, 6);
  });

  test("/cost adds up the session's usage per model; the running total is kept in the log", async () => {
    const { host, shared, send } = await scriptedHost({ config: { "jade/cost": { prices: { s1: { input: 10, output: 20 } } } } });
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    const cost = () => host.service<Commands>("commands@1")!.get("cost")!.command.run("", c);
    const s = await host.sessions.open();
    expect(await cost()).toBe("No model usage in this session yet.");
    shared.script.push(say("one", { inputTokens: 100_000, outputTokens: 10_000 }), say("two", { inputTokens: 200_000, outputTokens: 20_000 }));
    await send(s, "first");
    await send(s, "second");
    // 30 万输入 × $10 + 3 万输出 × $20，每百万
    expect(await cost()).toBe("s1: 300.0k in, 30.0k out · $3.60\nTotal: $3.60");
    expect(s.state.derived["jade/cost/usage"]).toEqual({ s1: { inputTokens: 300_000, outputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  });

  test("without a price /cost shows tokens and says how to configure one", async () => {
    const { host, shared, send } = await scriptedHost();
    const c: CommandContext = { signal: new AbortController().signal, ui: host.service<UI>("ui@1")!, sessions: host.sessions, print: () => {} };
    const s = await host.sessions.open();
    shared.script.push(say("one", { inputTokens: 1500, outputTokens: 10 }));
    await send(s, "first");
    const out = String(await host.service<Commands>("commands@1")!.get("cost")!.command.run("", c));
    expect(out).toStartWith("s1: 1.5k in, 10 out\nNo price is configured for these models");
  });
});
